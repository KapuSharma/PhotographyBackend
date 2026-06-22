import Parser from "rss-parser";

const parser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "Mozilla/5.0 HOI-HunterBot/1.0" },
});

function sanitizeXml(str) {
  // Replace bare & not part of a valid entity with &amp;
  return str.replace(/&(?!(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);)/g, "&amp;");
}

export async function fetchRssFeed(url) {
  const res = await fetch(url, {
    timeout: 15000,
    headers: { "User-Agent": "Mozilla/5.0 HOI-HunterBot/1.0" },
  });
  const text = await res.text();
  const clean = sanitizeXml(text);
  const feed = await parser.parseString(clean);
  return (feed.items || []).map((it) => ({
    title: it.title || "",
    content: stripHtml(it.contentSnippet || it.content || it.summary || it.title || ""),
    link: it.link || it.guid || "",
    author: it.creator || it.author || feed.title || "",
    pubDate: it.isoDate || it.pubDate || new Date().toISOString(),
  }));
}

export async function fetchManyRss(urls) {
  const results = await Promise.allSettled(urls.map((u) => fetchRssFeed(u)));
  const ok = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") ok.push(...r.value);
    else errors.push({ url: urls[i], error: r.reason?.message || "fetch failed" });
  });
  return { items: ok, errors };
}

function stripHtml(s) {
  return String(s).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
