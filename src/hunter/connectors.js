import Parser from "rss-parser";

const parser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "Mozilla/5.0 HOI-LeadHunter/1.0" },
});

/* ───────────────────────────────────────────────────────
   ENV CONFIG
   Every URL / query / API key is loaded from environment
   variables here. Defaults are photography-focused so the
   system works even if env is empty — but you should
   override these in .env for production.
   ─────────────────────────────────────────────────────── */

function envList(name, fallback = []) {
  const v = process.env[name];
  if (!v) return fallback;
  return v.split(",").map(s => s.trim()).filter(Boolean);
}

const DEFAULT_PHOTO_QUERIES = [
  "wedding photographer",
  "product photography",
  "headshot photographer",
  "event photography",
  "real estate photography",
  "photo retouching",
];

/* ───────────────────────────────────────────────────────
   UPWORK CONNECTOR
   Public RSS feeds. You can either:
   - Paste full RSS URLs into UPWORK_RSS_URLS, or
   - Provide search keywords in UPWORK_QUERIES (we build URLs)
   ─────────────────────────────────────────────────────── */

function buildUpworkRssUrl(q) {
  const base = process.env.UPWORK_RSS_BASE || "https://www.upwork.com/ab/feed/jobs/rss";
  const params = new URLSearchParams({ q, sort: "recency", paging: "0;20" });
  return `${base}?${params.toString()}`;
}

function parseUpworkBudget(text) {
  if (!text) return { min: null, max: null, currency: "USD" };
  const fixed  = /Budget[^$]*\$?([0-9][\d,]*)/i.exec(text);
  const range  = /\$?([0-9][\d,]*)\s*(?:-|to|–)\s*\$?([0-9][\d,]*)/i.exec(text);
  const hourly = /\$?([0-9][\d,.]*)\s*(?:\/|per)\s*hr/i.exec(text);
  if (range)  return { min: numFrom(range[1]), max: numFrom(range[2]), currency: "USD" };
  if (fixed)  return { min: numFrom(fixed[1]), max: numFrom(fixed[1]), currency: "USD" };
  if (hourly) return { min: numFrom(hourly[1]) * 40, max: numFrom(hourly[1]) * 160, currency: "USD" };
  return { min: null, max: null, currency: "USD" };
}

function parseUpworkCountry(text) {
  const m = /Country\s*:?\s*([A-Za-z][A-Za-z\s]+)/i.exec(text || "");
  return m ? m[1].trim().split(/\s{2,}|\n|<|,/)[0].slice(0, 60) : "";
}

function parseUpworkSkills(text) {
  const m = /Skills\s*:?\s*([^<\n]+)/i.exec(text || "");
  if (!m) return [];
  return m[1].split(/[,;]/).map(s => s.trim()).filter(Boolean).slice(0, 10);
}

export async function fetchUpwork(customKeywords) {
  const explicitUrls = envList("UPWORK_RSS_URLS");
  const queries = customKeywords?.length
    ? customKeywords
    : (explicitUrls.length ? null : envList("UPWORK_QUERIES", DEFAULT_PHOTO_QUERIES));
  const urls = explicitUrls.length ? explicitUrls : queries.map(buildUpworkRssUrl);

  const all = [];
  const errors = [];
  for (const url of urls) {
    try {
      const feed = await parser.parseURL(url);
      for (const it of feed.items || []) {
        const text = stripHtml(it.contentSnippet || it.content || "");
        const fullText = (it.title || "") + " " + text;
        const { min, max, currency } = parseUpworkBudget(fullText);
        all.push({
          source: "Upwork",
          sourceLeadId: it.guid || it.link || it.title,
          sourceUrl: it.link || "",
          title: cleanTitle(it.title || ""),
          description: text,
          budgetMin: min,
          budgetMax: max,
          currency,
          country: parseUpworkCountry(text),
          skills: parseUpworkSkills(text),
          postedAt: it.isoDate ? new Date(it.isoDate) : (it.pubDate ? new Date(it.pubDate) : null),
          clientName: "",
          clientHistory: "",
          competitionCount: 0,
          rawPayload: { feedUrl: url, link: it.link, snippet: text.slice(0, 400) },
        });
      }
    } catch (err) {
      errors.push({ url, error: err.message });
    }
  }
  return { items: dedupeByKey(all, "sourceUrl"), errors, fallback: false };
}

/* ───────────────────────────────────────────────────────
   FREELANCER CONNECTOR
   Public REST API — no key needed for active projects.
   Optional: FREELANCER_OAUTH_TOKEN for higher rate limits.
   ─────────────────────────────────────────────────────── */

export async function fetchFreelancer(customKeywords) {
  const queries = customKeywords?.length ? customKeywords : envList("FREELANCER_QUERIES", DEFAULT_PHOTO_QUERIES);
  const apiBase = process.env.FREELANCER_API_BASE || "https://www.freelancer.com/api/projects/0.1/projects/active/";
  const limit = parseInt(process.env.FREELANCER_LIMIT_PER_QUERY || "20", 10) || 20;
  const token = process.env.FREELANCER_OAUTH_TOKEN || "";

  const all = [];
  const errors = [];
  for (const q of queries) {
    try {
      const url = `${apiBase}?query=${encodeURIComponent(q)}&limit=${limit}&full_description=true&job_details=true&user_details=true&compact=false`;
      const headers = {
        "User-Agent": "Mozilla/5.0 HOI-LeadHunter/1.0",
        Accept: "application/json",
      };
      if (token) headers["freelancer-oauth-v1"] = token;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const projects = data?.result?.projects || [];
      const qLower = q.toLowerCase();
      for (const p of projects) {
        const titleDesc = `${p.title || ""} ${p.description || p.preview_description || ""}`.toLowerCase();
        if (!titleDesc.includes(qLower) && !qLower.split(" ").some(w => w.length > 3 && titleDesc.includes(w))) continue;
        all.push({
          source: "Freelancer",
          sourceLeadId: String(p.id),
          sourceUrl: p.seo_url ? `https://www.freelancer.com/projects/${p.seo_url}` : `https://www.freelancer.com/projects/${p.id}`,
          title: p.title || "Untitled project",
          description: p.description || p.preview_description || "",
          budgetMin: p.budget?.minimum ?? null,
          budgetMax: p.budget?.maximum ?? null,
          currency: p.currency?.code || "USD",
          country: p.location?.country?.name || extractCountry(`${p.title || ""} ${p.description || p.preview_description || ""}`),
          skills: Array.isArray(p.jobs) ? p.jobs.map(j => j.name).filter(Boolean).slice(0, 10) : [],
          postedAt: p.submitdate ? new Date(p.submitdate * 1000) : null,
          clientName: "",
          clientHistory: "",
          competitionCount: p.bid_stats?.bid_count || 0,
          rawPayload: { id: p.id, type: p.type, status: p.status, matchedQuery: q },
        });
      }
    } catch (err) {
      errors.push({ query: q, error: err.message });
    }
  }
  return { items: dedupeByKey(all, "sourceLeadId"), errors, fallback: false };
}

/* ───────────────────────────────────────────────────────
   GURU CONNECTOR
   Guru has NO RSS and NO public API. The only programmatic
   path is their robots.txt-published jobs sitemap, where each
   job page carries schema.org JobPosting JSON-LD (the same
   structured data Google For Jobs consumes).

   Flow:
     1. sitemap index  → child sitemap(s)
     2. child sitemap  → {url, lastmod} list
     3. keep recent ones (GURU_MAX_AGE_DAYS), cap (GURU_MAX_JOBS)
     4. fetch each job page, extract JobPosting JSON-LD
     5. keyword-filter → map to lead schema

   Tunables (env, all optional):
     GURU_SITEMAP_INDEX  default https://www.guru.com/sitemap_index_jobs.xml
     GURU_MAX_AGE_DAYS   default 60
     GURU_MAX_JOBS       default 60
     GURU_CONCURRENCY    default 5
   ─────────────────────────────────────────────────────── */

const GURU_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

async function fetchText(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": GURU_UA, Accept: "text/html,application/xml,*/*" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function parseSitemap(xml) {
  // returns [{ loc, lastmod }]
  const out = [];
  const re = /<url>\s*<loc>(.*?)<\/loc>\s*(?:<lastmod>(.*?)<\/lastmod>)?/gis;
  let m;
  while ((m = re.exec(xml)) !== null) {
    out.push({ loc: m[1].trim(), lastmod: m[2] ? m[2].trim() : null });
  }
  return out;
}

function sitemapChildren(xml) {
  const out = [];
  const re = /<sitemap>\s*<loc>(.*?)<\/loc>/gis;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
  return out;
}

// Repair the common double-encoded UTF-8 artifacts Guru emits.
function fixMojibake(s) {
  if (!s) return "";
  return String(s)
    .replace(/Â /g, " ")
    .replace(/ /g, " ")
    .replace(/â€™/g, "'")
    .replace(/â€˜/g, "'")
    .replace(/â€œ|â€/g, '"')
    .replace(/â€"|â€"/g, "—")
    .replace(/â€¦/g, "…")
    .replace(/\s+/g, " ")
    .trim();
}

function extractJobPostingJsonLd(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!/JobPosting/i.test(raw)) continue;
    try {
      const data = JSON.parse(raw);
      const node = Array.isArray(data)
        ? data.find(d => /JobPosting/i.test(d?.["@type"] || ""))
        : data;
      if (node && /JobPosting/i.test(node["@type"] || "")) return node;
    } catch {
      /* malformed JSON-LD — skip */
    }
  }
  return null;
}

function guruBudget(node) {
  const sal = node?.baseSalary;
  if (!sal) return { min: null, max: null, currency: "USD" };
  const currency = sal.currency || "USD";
  const v = sal.Value || sal.value || {};
  const amount = numFrom(v.value ?? v.Value ?? "");
  if (amount && amount > 0) return { min: null, max: amount, currency };
  return { min: null, max: null, currency };
}

function guruCountry(node) {
  const loc = node?.applicantLocationRequirements;
  let name = loc?.name;
  if (Array.isArray(name)) name = name.find(n => n && !/not available/i.test(n));
  if (name && !/not available/i.test(name)) return String(name).trim();
  return "";
}

async function mapBatch(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size);
    out.push(...(await Promise.all(slice.map(fn))));
  }
  return out;
}

export async function fetchGuru(customKeywords) {
  const indexUrl = process.env.GURU_SITEMAP_INDEX || "https://www.guru.com/sitemap_index_jobs.xml";
  const maxAgeDays = parseInt(process.env.GURU_MAX_AGE_DAYS || "60", 10) || 60;
  const maxJobs = parseInt(process.env.GURU_MAX_JOBS || "60", 10) || 60;
  const concurrency = parseInt(process.env.GURU_CONCURRENCY || "5", 10) || 5;
  const keywords = (customKeywords?.length
    ? customKeywords
    : ["photographer", "photography", "photo", "photoshoot", "videographer", "video", "retouch", "headshot", "portrait", "product shoot"]
  ).map(k => k.toLowerCase());

  const errors = [];
  let urlEntries = [];

  try {
    const indexXml = await fetchText(indexUrl);
    // Guru sits behind the Imperva/Incapsula WAF. Bot requests get HTTP 200
    // with a JS challenge page (not XML), so detect that and report it
    // instead of silently returning 0 leads with no error.
    if (/_Incapsula_Resource|incident_id|Request unsuccessful/i.test(indexXml) ||
        (/^\s*<html/i.test(indexXml) && !/<sitemapindex|<urlset/i.test(indexXml))) {
      return { items: [], errors: [{ sitemap: indexUrl, error: "Guru is behind the Imperva/Incapsula WAF — it returned a bot-challenge page instead of the jobs sitemap. Free automated access to Guru is not possible. Use the Google Search source (it indexes guru.com) or the Manual entry form." }], fallback: false };
    }
    const childSitemaps = sitemapChildren(indexXml);
    const targets = childSitemaps.length ? childSitemaps : [indexUrl];
    for (const sm of targets) {
      try {
        const xml = await fetchText(sm);
        urlEntries.push(...parseSitemap(xml));
      } catch (e) {
        errors.push({ sitemap: sm, error: e.message });
      }
    }
  } catch (e) {
    return { items: [], errors: [{ sitemap: indexUrl, error: e.message }], fallback: false };
  }

  // recency filter + newest first
  const cutoff = Date.now() - maxAgeDays * 86400000;
  urlEntries = urlEntries
    .filter(u => u.loc && /\/jobs\//.test(u.loc))
    .map(u => ({ ...u, ts: u.lastmod ? Date.parse(u.lastmod) : 0 }))
    .filter(u => !u.ts || u.ts >= cutoff)
    .sort((a, b) => b.ts - a.ts);

  // cheap slug pre-filter: prioritise URLs whose slug already hints the niche,
  // but keep the rest as backfill so we don't miss differently-worded slugs.
  const slugHit = urlEntries.filter(u => keywords.some(k => u.loc.toLowerCase().includes(k.replace(/\s+/g, "-"))));
  const ordered = [...new Set([...slugHit, ...urlEntries].map(u => u.loc))].slice(0, maxJobs);

  const fetched = await mapBatch(ordered, concurrency, async (loc) => {
    try {
      const html = await fetchText(loc);
      const node = extractJobPostingJsonLd(html);
      if (!node) return null;
      const title = fixMojibake(node.title || "");
      const description = fixMojibake(node.description || "");
      const blob = `${title} ${description} ${fixMojibake(node.skills || "")}`.toLowerCase();
      if (!keywords.some(k => blob.includes(k) || k.split(" ").filter(w => w.length > 3).some(w => blob.includes(w)))) return null;
      const { min, max, currency } = guruBudget(node);
      const idMatch = /\/(\d+)(?:\/)?$/.exec(loc);
      return {
        source: "Guru",
        sourceLeadId: node?.Identifier?.Value || (idMatch ? idMatch[1] : loc),
        sourceUrl: loc,
        title,
        description,
        budgetMin: min,
        budgetMax: max,
        currency,
        country: guruCountry(node) || extractCountry(description),
        skills: typeof node.skills === "string"
          ? node.skills.split(",").map(s => s.trim()).filter(Boolean).slice(0, 12)
          : [],
        postedAt: node.datePosted ? new Date(node.datePosted) : null,
        clientName: node?.hiringOrganization?.name || "",
        clientHistory: "",
        competitionCount: 0,
        rawPayload: { jsonLd: true, validThrough: node.validThrough || null },
      };
    } catch (e) {
      errors.push({ url: loc, error: e.message });
      return null;
    }
  });

  const items = dedupeByKey(fetched.filter(Boolean), "sourceLeadId");
  return { items, errors, fallback: false };
}

/* ───────────────────────────────────────────────────────
   PEOPLEPERHOUR CONNECTOR
   The public jobs RSS feed at /feed/jobs returns the latest
   ~50 jobs across ALL categories. The ?term= filter param
   silently returns an empty feed, so we fetch the full feed
   once and filter by keyword in-process.
   ─────────────────────────────────────────────────────── */

export async function fetchPeoplePerHour(customKeywords) {
  const keywords = (customKeywords?.length
    ? customKeywords
    : ["photographer", "photography", "photo shoot", "photo", "videographer", "video", "retouch", "headshot"]
  ).map(k => k.toLowerCase());

  const feedUrl = process.env.PPH_FEED_URL || "https://www.peopleperhour.com/feed/jobs";
  const all = [];
  const errors = [];

  try {
    const feed = await parser.parseURL(feedUrl);
    for (const it of feed.items || []) {
      const title = (it.title || "").trim();
      const text = stripHtml(it.contentSnippet || it.content || it.description || "");
      const blob = `${title} ${text}`.toLowerCase();
      // keep items matching a full keyword phrase OR any significant word of
      // it (same matching the Freelancer connector / filters.js use — the
      // PPH feed is general-category so exact-phrase match rejects everything)
      if (!keywords.some(k => blob.includes(k) || k.split(" ").filter(w => w.length > 3).some(w => blob.includes(w)))) continue;
      all.push({
        source: "PeoplePerHour",
        sourceLeadId: it.guid?.trim() || it.link?.trim() || title,
        sourceUrl: it.link?.trim() || "",
        title,
        description: text,
        budgetMin: null,
        budgetMax: extractPphBudget(text),
        currency: "GBP",
        country: extractCountry(text),
        skills: [],
        postedAt: it.isoDate ? new Date(it.isoDate) : (it.pubDate ? new Date(it.pubDate) : null),
        clientName: "",
        clientHistory: "",
        competitionCount: 0,
        rawPayload: { matchedFeed: feedUrl, link: it.link },
      });
    }
  } catch (err) {
    errors.push({ feed: feedUrl, error: err.message });
  }
  return { items: dedupeByKey(all, "sourceLeadId"), errors, fallback: false };
}

function extractPphBudget(text) {
  if (!text) return null;
  const m = /[£$]\s*([0-9][\d,]*)/.exec(text);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ""));
  return Number.isNaN(v) ? null : v;
}

/* ───────────────────────────────────────────────────────
   REDDIT CONNECTOR
   Public JSON works without OAuth (rate-limited to ~60/min).
   Set REDDIT_SUBREDDITS to a comma-separated list.
   For higher limits: REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET
   (script-type app at https://www.reddit.com/prefs/apps).
   ─────────────────────────────────────────────────────── */

export async function fetchReddit(customKeywords) {
  const keywords = customKeywords?.length
    ? customKeywords
    : ["need photographer", "hire photographer", "wedding photographer", "product photography"];

  const subreddits = ["forhire", "HireAPhotographer", "weddingplanning", "photography", "smallbusiness"];
  const ua = "HOI-LeadHunter/1.0";
  const all = [];
  const errors = [];

  for (const kw of keywords) {
    for (const sub of subreddits) {
      try {
        const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/search.json?q=${encodeURIComponent(kw)}&restrict_sr=1&sort=new&limit=10&t=month`;
        const res = await fetch(url, { headers: { "User-Agent": ua } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const posts = data?.data?.children || [];
        for (const c of posts) {
          const p = c?.data;
          if (!p) continue;
          const blob = `${p.title || ""} ${p.selftext || ""}`.toLowerCase();
          // Must contain at least one word from the keyword
          const kwWords = kw.toLowerCase().split(" ").filter(w => w.length > 3);
          if (!kwWords.some(w => blob.includes(w))) continue;
          all.push({
            source: "Reddit",
            sourceLeadId: p.id,
            sourceUrl: `https://www.reddit.com${p.permalink}`,
            title: p.title || "Untitled",
            description: p.selftext || "",
            budgetMin: null,
            budgetMax: extractRedditBudget(p.title + " " + p.selftext),
            currency: "USD",
            country: extractCountry(p.title + " " + p.selftext),
            skills: [],
            postedAt: p.created_utc ? new Date(p.created_utc * 1000) : null,
            clientName: p.author || "",
            clientHistory: `r/${p.subreddit}`,
            competitionCount: p.num_comments || 0,
            rawPayload: { id: p.id, sub: p.subreddit, flair: p.link_flair_text, score: p.score, matchedKeyword: kw },
          });
        }
      } catch (err) {
        errors.push({ subreddit: sub, keyword: kw, error: err.message });
      }
    }
  }
  return { items: dedupeByKey(all, "sourceLeadId"), errors, fallback: false };
}

function extractRedditBudget(text) {
  if (!text) return null;
  const m = /\$\s*([0-9][\d,]*)/.exec(text);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ""));
  return Number.isNaN(v) ? null : v;
}

/* ───────────────────────────────────────────────────────
   GOOGLE SEARCH CONNECTOR
   Custom Search JSON API — needs GOOGLE_CSE_KEY + _CX.
   Queries from GOOGLE_CSE_QUERIES (comma-separated) or
   the per-client custom keywords.
   ─────────────────────────────────────────────────────── */

export async function fetchGoogle(customKeywords) {
  const key = process.env.GOOGLE_CSE_KEY;
  const cx = process.env.GOOGLE_CSE_CX;
  if (!key || !cx) {
    return { items: [], errors: [{ note: "GOOGLE_CSE_KEY / GOOGLE_CSE_CX not configured" }], fallback: false };
  }
  const queries = customKeywords?.length ? customKeywords : envList("GOOGLE_CSE_QUERIES", DEFAULT_PHOTO_QUERIES.map(q => `hiring ${q}`));
  const num = Math.min(parseInt(process.env.GOOGLE_CSE_LIMIT || "10", 10) || 10, 10);

  // Test the API with one request first to catch auth errors early
  const testUrl = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=photographer&num=1`;
  try {
    const testRes = await fetch(testUrl);
    if (testRes.status === 403) {
      const body = await testRes.json().catch(() => ({}));
      const reason = body?.error?.message || "Access denied";
      return { items: [], errors: [{ note: `Google CSE 403: ${reason}. Go to https://console.cloud.google.com/apis/library/customsearch.googleapis.com and click Enable.` }], fallback: false };
    }
    if (testRes.status === 400) {
      const body = await testRes.json().catch(() => ({}));
      return { items: [], errors: [{ note: `Google CSE 400: ${body?.error?.message || "Bad request"}` }], fallback: false };
    }
  } catch (err) {
    return { items: [], errors: [{ note: `Google CSE connection error: ${err.message}` }], fallback: false };
  }

  const all = [];
  const errors = [];
  for (const q of queries) {
    try {
      const url = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${encodeURIComponent(q)}&num=${num}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      for (const it of data.items || []) {
        all.push({
          source: "Google Search",
          sourceLeadId: it.cacheId || it.link,
          sourceUrl: it.link,
          title: it.title || "",
          description: it.snippet || "",
          budgetMin: null,
          budgetMax: null,
          currency: "USD",
          country: extractCountry(`${it.title || ""} ${it.snippet || ""}`),
          skills: [],
          postedAt: null,
          clientName: it.displayLink || "",
          clientHistory: "",
          competitionCount: 0,
          rawPayload: { query: q, link: it.link },
        });
      }
    } catch (err) {
      errors.push({ query: q, error: err.message });
    }
  }
  return { items: dedupeByKey(all, "sourceUrl"), errors, fallback: false };
}

/* ───────────────────────────────────────────────────────
   GENERIC RSS FETCHER (used by Guru + PeoplePerHour)
   ─────────────────────────────────────────────────────── */

async function fetchGenericRss(urls, source) {
  const all = [];
  const errors = [];
  for (const url of urls) {
    try {
      const feed = await parser.parseURL(url);
      for (const it of feed.items || []) {
        const text = stripHtml(it.contentSnippet || it.content || "");
        all.push({
          source,
          sourceLeadId: it.guid || it.link || it.title,
          sourceUrl: it.link || "",
          title: (it.title || "").trim(),
          description: text,
          budgetMin: null,
          budgetMax: null,
          currency: "USD",
          country: "",
          skills: [],
          postedAt: it.isoDate ? new Date(it.isoDate) : (it.pubDate ? new Date(it.pubDate) : null),
          clientName: it.creator || it.author || feed.title || "",
          clientHistory: "",
          competitionCount: 0,
          rawPayload: { feedUrl: url, link: it.link, snippet: text.slice(0, 400) },
        });
      }
    } catch (err) {
      errors.push({ url, error: err.message });
    }
  }
  return { items: dedupeByKey(all, "sourceUrl"), errors, fallback: false };
}

/* ───────────────────────────────────────────────────────
   HELPERS
   ─────────────────────────────────────────────────────── */

function stripHtml(s) {
  return String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function cleanTitle(t) {
  return String(t || "").replace(/\s*-\s*Upwork.*$/i, "").trim();
}
function numFrom(s) {
  const v = parseFloat(String(s).replace(/,/g, ""));
  return Number.isNaN(v) ? null : v;
}
function dedupeByKey(arr, key) {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const k = it[key];
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

// Extract country from free text — covers most common patterns in job posts
const COUNTRIES = [
  "United States","United Kingdom","Australia","Canada","India","Germany",
  "France","Netherlands","Singapore","UAE","United Arab Emirates","South Africa",
  "New Zealand","Ireland","Pakistan","Bangladesh","Philippines","Nigeria",
  "Kenya","Brazil","Mexico","Spain","Italy","Sweden","Norway","Denmark",
  "Switzerland","Belgium","Poland","Portugal","Romania","Czech Republic",
  "Hungary","Greece","Turkey","Israel","Saudi Arabia","Qatar","Kuwait",
  "Malaysia","Indonesia","Thailand","Vietnam","Japan","China","Hong Kong",
  "South Korea","Taiwan","Egypt","Morocco","Ghana","Tanzania","Uganda",
  "Zimbabwe","Zambia","Ethiopia","Argentina","Chile","Colombia","Peru",
  "USA","UK","US",
];

function extractCountry(text) {
  if (!text) return "";
  // Pattern 1: explicit label — "Location: United Kingdom", "Country: India"
  const labeled = /(?:location|country|based in|located in|from)\s*:?\s*([A-Z][A-Za-z\s]{2,30})/i.exec(text);
  if (labeled) {
    const candidate = labeled[1].trim().split(/[,\n]/)[0].trim();
    if (COUNTRIES.some(c => c.toLowerCase() === candidate.toLowerCase())) return candidate;
  }
  // Pattern 2: scan for known country names in text
  const lower = text.toLowerCase();
  for (const c of COUNTRIES) {
    if (lower.includes(c.toLowerCase())) return c;
  }
  return "";
}

/* ───────────────────────────────────────────────────────
   DISPATCH
   ─────────────────────────────────────────────────────── */

export const SOURCES = ["Freelancer", "PeoplePerHour", "Guru", "Google Search", "Reddit"];

export async function runConnector(source, customKeywords) {
  if (source === "Upwork")        return fetchUpwork(customKeywords);
  if (source === "Freelancer")    return fetchFreelancer(customKeywords);
  if (source === "Guru")          return fetchGuru(customKeywords);
  if (source === "PeoplePerHour") return fetchPeoplePerHour(customKeywords);
  if (source === "Google Search") return fetchGoogle(customKeywords);
  if (source === "Reddit")        return fetchReddit(customKeywords);
  throw new Error(`Unknown source: ${source}`);
}
