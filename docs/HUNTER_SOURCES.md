# AI Lead Hunter — Source Setup Guide

This document explains, source by source, **how to obtain API keys / RSS URLs** and **which environment variables to set** in `.env`.

After editing `.env`, restart the backend (`Ctrl+C` then `npm run dev`) so new vars load.

---

## Quick reference — env vars vs sources

| Source | Requires | Env vars |
|---|---|---|
| Upwork | RSS URL or query | `UPWORK_RSS_URLS` *or* `UPWORK_QUERIES` |
| Freelancer | nothing (public API) | `FREELANCER_QUERIES` (optional `FREELANCER_OAUTH_TOKEN`) |
| Guru | nothing (sitemap + JSON-LD) | optional `GURU_MAX_JOBS`, `GURU_MAX_AGE_DAYS` |
| PeoplePerHour | nothing (public RSS) | optional `PPH_FEED_URL` |
| Google Search | API key + CX | `GOOGLE_CSE_KEY`, `GOOGLE_CSE_CX`, `GOOGLE_CSE_QUERIES` |
| Reddit | nothing (or optional OAuth) | `REDDIT_SUBREDDITS`, `REDDIT_KEYWORDS` (optional `REDDIT_CLIENT_ID/SECRET`) |
| LinkedIn | manual entry only | — (use the **+ Manual LinkedIn** form in the dashboard) |

---

## 1. Upwork

**API:** No public API. Upwork dropped its public Job Search API in 2019. They publish RSS feeds for any saved search — that is what we use.

**Cost:** Free.
**Login:** A free Upwork account is enough.
**Risk:** Low (RSS is officially supported).

### How to get the RSS URL
1. Sign in at <https://www.upwork.com>.
2. Open **Find Work → Search**.
3. Type your keywords (e.g. *wedding photographer*) and apply any filters (budget, country, hourly/fixed).
4. Below the search results, click the orange **RSS** link.
5. Copy the URL from the address bar. It looks like:
   `https://www.upwork.com/ab/feed/jobs/rss?q=wedding+photographer&sort=recency&...`
6. Paste it into `.env`:
   ```
   UPWORK_RSS_URLS="<url1>,<url2>,<url3>"
   ```

If you'd rather just give us keywords and let the connector build the URL, set:
```
UPWORK_QUERIES="wedding photographer,product photography,event photographer"
```

---

## 2. Freelancer.com

**API:** Public, unauthenticated REST API at `https://www.freelancer.com/api/projects/0.1/projects/active/`.

**Cost:** Free.
**Login:** Not required.
**Risk:** Low.

### Setup
Just edit the keyword list:
```
FREELANCER_QUERIES="wedding photographer,product photography,event photography,real estate photography,headshot photographer"
FREELANCER_LIMIT_PER_QUERY="20"
```

(Optional) for higher rate limits, sign in at <https://accounts.freelancer.com/settings/develop> → "OAuth Apps" → create a personal token, then:
```
FREELANCER_OAUTH_TOKEN="<token>"
```

---

## 3. Guru.com

**API:** None. No RSS either (the old `/d/jobs/rss/` now 301-redirects to a 404).
**Method:** Guru publishes a **jobs sitemap in their own robots.txt** (intended for
Google For Jobs), and every public job page carries a `schema.org/JobPosting`
**JSON-LD** block. The connector reads the sitemap, filters by recency, then
parses the JSON-LD on each job page — the same structured data search engines
consume. No login, no API key, no billing, no headless browser.

**Cost:** Free.
**Login:** Not required.
**Risk:** Low. This is structured-data consumption, not bot/DOM scraping. It is a
gray zone (Guru's ToS doesn't explicitly sanction automated access, but the
sitemap + JSON-LD are published *for* machines). Request volume is small
(≤ `GURU_MAX_JOBS` pages per run, default 60), so ban-risk is minimal.

### Setup
**Nothing required** — it works out of the box. Optional tuning in `.env`:
```
GURU_SITEMAP_INDEX="https://www.guru.com/sitemap_index_jobs.xml"
GURU_MAX_AGE_DAYS="60"   # skip jobs older than this many days
GURU_MAX_JOBS="60"       # cap job pages fetched per run
GURU_CONCURRENCY="5"     # parallel fetches (keep modest / polite)
```

### How it works internally
1. Fetch `GURU_SITEMAP_INDEX` → resolve child sitemap(s).
2. Parse `{url, lastmod}`; keep entries newer than `GURU_MAX_AGE_DAYS`, newest first.
3. Prioritise URLs whose slug hints the niche, cap to `GURU_MAX_JOBS`.
4. Fetch each job page, extract the `JobPosting` JSON-LD
   (`title`, `description`, `skills`, `datePosted`, `baseSalary`, location, client).
5. Keyword-filter on title/description/skills → map to the common lead schema.

If the sitemap is unreachable the run summary logs the error and Guru returns
zero leads (other sources are unaffected).

---

## 4. PeoplePerHour

**API:** No public REST API.
**Workaround:** Per-category RSS feeds.

**Cost:** Free.
**Login:** Not required to read RSS.
**Risk:** Low–medium.

### How to get the RSS URL
1. Open <https://www.peopleperhour.com/freelance-jobs>.
2. Pick the relevant category (Photography / Visual Arts).
3. Look near the page footer or top-right — there's an **RSS** icon.
4. Right-click → "Copy link".
5. Paste into `.env`:
   ```
   PPH_RSS_URLS="<url1>,<url2>"
   ```

---

## 5. Google Search (Custom Search JSON API)

**API:** Programmable Search Engine + Custom Search JSON API.
**Cost:** Free up to 100 queries/day. Beyond that: $5 per 1,000 queries (max 10k/day).
**Login:** Google account.
**Risk:** Low.

### Setup steps

1. **Create the search engine (gives you the CX)**
   - Go to <https://programmablesearchengine.google.com/>.
   - Click **Add**.
   - Set "What to search" → **Search the entire web**.
   - Click **Create**.
   - Open the engine → **Setup** → copy the **Search engine ID**.
   - Set `GOOGLE_CSE_CX="<that id>"`.

2. **Enable the API**
   - Go to <https://console.cloud.google.com/apis/library/customsearch.googleapis.com>.
   - Pick (or create) a project → click **Enable**.

3. **Create the API key**
   - Go to <https://console.cloud.google.com/apis/credentials>.
   - **+ Create Credentials → API key**. Copy it.
   - (Optional) restrict the key to "Custom Search API" only.
   - Set `GOOGLE_CSE_KEY="<that key>"`.

4. **Pick your queries**
   ```
   GOOGLE_CSE_QUERIES="hiring wedding photographer 2026,looking for product photographer,event photography needed"
   GOOGLE_CSE_LIMIT="10"
   ```

If `GOOGLE_CSE_KEY` or `GOOGLE_CSE_CX` is empty, the Google connector returns 0 results and logs a config note.

---

## 6. Reddit

**API:** Reddit's public JSON endpoints (`https://www.reddit.com/r/<sub>/new.json`) work without auth at ~60 req/min. OAuth raises that limit.

**Cost:** Free.
**Login:** Not required for read-only without OAuth.
**Risk:** Low.

### Setup — minimum (no auth)
```
REDDIT_SUBREDDITS="forhire,HireAPhotographer"
REDDIT_KEYWORDS="photographer,photography,photo shoot,wedding photo,product photo"
REDDIT_LIMIT="30"
REDDIT_USER_AGENT="HOI-LeadHunter/1.0 (by /u/your_username)"
```

Useful subreddits for photographers:
- `r/forhire` (filter on the keywords)
- `r/HireAPhotographer`
- `r/slavelabour` (low-budget gigs — keep keyword filter on)
- `r/photography_jobs`

### Setup — with OAuth (recommended for production)
1. Sign in at <https://www.reddit.com/prefs/apps>.
2. Click **are you a developer? create an app...**.
3. Pick **script**.
4. Name: `HOI Lead Hunter`. Redirect URL: `http://localhost:5000` (anything works for script type).
5. Submit. You'll see:
   - **client ID** — short string under the app name → `REDDIT_CLIENT_ID`.
   - **secret** → `REDDIT_CLIENT_SECRET`.
6. Replace the placeholder in `REDDIT_USER_AGENT` with your real Reddit username.

Add to `.env`:
```
REDDIT_CLIENT_ID="<id>"
REDDIT_CLIENT_SECRET="<secret>"
```

---

## 7. LinkedIn

**Scraping is forbidden by LinkedIn's TOS** and the scraping APIs (Apify, Phantombuster, etc.) carry account-ban risk.

**Workflow:**
- In the dashboard, click **+ Manual LinkedIn** in the AI Hunter section.
- Paste the LinkedIn URL, person/company name, post text, and a 1-line requirement summary.
- The AI scores the lead and writes an outreach message.

No env config needed.

---

## After editing `.env`

1. Save the file.
2. Restart the backend: `Ctrl+C` in the terminal running `npm run dev`, then `npm run dev` again.
3. Open the dashboard → **AI Hunter** → click **▶ Run Hunt (All)** (or the per-source ▶ Run button).
4. Watch the run-summary banner: `Last run captured N · rejected M`.
5. Each source card shows `+N new` for the most recent run.

If a source returns 0 leads, click **◎ Source Access** in the toolbar — the table shows whether the issue is "API key missing", "URL not configured", or "API returned empty".

---

## Troubleshooting

- **`Cannot read properties of undefined (reading 'findMany')`** → Prisma client is stale. Run `npx prisma generate` then restart the backend.
- **0 leads from Upwork** → Most likely `UPWORK_RSS_URLS` is empty *and* `UPWORK_QUERIES` is empty. Add at least one.
- **0 leads from Google** → Either `GOOGLE_CSE_KEY` or `GOOGLE_CSE_CX` is missing, or the API isn't enabled in your Google Cloud project.
- **Reddit rate-limited (HTTP 429)** → set up OAuth (see section 6) or lower `REDDIT_LIMIT`.
- **Freelancer returns HTTP 429** → reduce `FREELANCER_LIMIT_PER_QUERY` or shorten `FREELANCER_QUERIES`.
- **Guru silently empty** → the sitemap was unreachable, or all jobs are older than `GURU_MAX_AGE_DAYS`. Raise that value or check the run-summary error. Needs no env to work.
- **PeoplePerHour silently empty** → the public `/feed/jobs` feed had no items matching your keywords this cycle. It pulls the latest ~50 jobs across all categories and keyword-filters in-process.
