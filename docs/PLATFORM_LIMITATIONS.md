# Platform Limitations — Why Free Automated Lead Capture Is Not Possible

**Platforms covered:** Upwork · PeoplePerHour · Guru  
**Status:** Verified 2026-05-01  
**Summary:** None of these three platforms offer a free, automated, publicly accessible API or feed for pulling job listings into a third-party tool. Each has been tested directly. This document records what was tested, why it fails, and what the realistic alternatives are.

---

---

## UPWORK

### Status: RSS feed dead (HTTP 410). No public API.

### What we tested

| Method | Result |
|---|---|
| Public RSS feed `upwork.com/ab/feed/jobs/rss?q=...` | **HTTP 410 Gone** — permanently decommissioned |
| Authenticated RSS with `securityToken` | Also retired. "Save search → RSS" button removed from UI |
| Public Job Search API | **Discontinued in 2019** |
| Upwork Marketplace API | Exists but requires **partnership agreement** — weeks/months approval, not granted to internal tools |
| Self-hosted scraping (Puppeteer/Playwright) | Violates TOS. Cloudflare + fingerprinting blocks it. Account ban risk |
| Apify scraper | Works but **paid** (~$0.50 per 100 jobs) |
| Email forwarding from saved searches | Free + semi-automated. Upwork emails saved search results — parseable via IMAP. Brittle but functional |
| Manual paste form | 100% reliable. Human pastes URL + title + description + budget. AI scores it |

### Why Upwork blocks free automated access

Upwork's business model depends on freelancers using their platform directly. They have systematically closed every free automated channel:
- **2019** — Retired public Job Search API
- **2022–2024** — Tightened RSS auth, removed from search filters
- **2025** — Deprecated public RSS entirely (HTTP 410)
- **Ongoing** — Aggressive Cloudflare/bot-protection on all job search HTML pages

This is a deliberate product decision, not a temporary outage.

### Realistic paths forward

1. **Manual paste form** (30 min effort) — Same UI as LinkedIn manual entry. Sales rep pastes job details, AI scores it. 100% reliable.
2. **Browser bookmarklet** (1 hr effort) — One click on an Upwork search page captures 20–30 visible jobs via DOM and POSTs to the backend. Free, no TOS issue (runs in user's own session).
3. **Email pipeline** (3–4 hr effort) — Set up saved searches on Upwork → forward emails to a Gmail inbox → backend reads via IMAP and parses job data. Fully automated, free, durable.
4. **Apify** (paid) — `epctex/upwork-scraper` actor, ~$0.50/100 jobs. `APIFY_TOKEN` placeholder already exists in `.env`.

---

---

## PEOPLEPERHOUR

### Status: No public API. No RSS. All data behind authenticated session.

### What we tested

| Method | Endpoint | Result |
|---|---|---|
| Public REST API | `/api/jobs?keyword=photographer` | **HTTP 404** — endpoint does not exist |
| Public REST API v2 | `/api/v2/jobs?keyword=photographer` | **HTTP 404** — endpoint does not exist |
| Hourlies API | `/api/hourlies?keyword=photographer` | **HTTP 404** — endpoint does not exist |
| RSS feed | `/jobs/rss?keyword=photographer` | **HTTP 404** — no RSS feed exists |
| RSS feed alt | `/rss/jobs?keyword=photographer` | **HTTP 404** — no RSS feed exists |
| Page HTML scraping | `/freelance-jobs?keyword=photographer` | Returns **302KB React app shell** — all job data loaded via private authenticated XHR calls after page load. No job data in the HTML. |
| Internal XHR API | Inspected network calls in browser | All calls require `pph-session` cookie + CSRF token from a logged-in account. Cannot be replicated without login. |

### Why PeoplePerHour blocks free automated access

PeoplePerHour is a smaller platform than Upwork or Freelancer and has never offered a public API. Their entire job board is rendered client-side via private API calls that require:
- A valid `pph-session` cookie (only issued after login)
- A CSRF token tied to that session
- Correct `Referer` and `Origin` headers matching their domain

Any attempt to replicate these calls without a real logged-in session will return 401 or redirect to the login page.

**Scraping is also not viable:**
- Their login page is protected by reCAPTCHA v3
- Session cookies expire frequently
- IP rate limiting kicks in after ~10 requests/minute from the same IP

### What IS possible (free)

| Option | Effort | Notes |
|---|---|---|
| **Manual paste form** | 30 min | Same as LinkedIn/Upwork manual entry. Human pastes job details, AI scores it |
| **Google Search covers PPH** | 0 effort | Google CSE already indexes `www.peopleperhour.com/*` — photography jobs on PPH will appear in Google Search results automatically once the API key is configured |
| **Official API (if approved)** | Unknown | PeoplePerHour has a private API program. Contact `api@peopleperhour.com`. No public documentation. Approval timeline unknown |

### Recommendation

Do not attempt to automate PeoplePerHour directly. The Google Search connector already covers it passively — any PPH photography job that Google has indexed will appear in Google Search results when you run the hunt with photography keywords. No additional work needed.

---

---

## GURU

### Status: No public API. No RSS. Blocked by Incapsula/Imperva WAF.

### What we tested

| Method | Endpoint | Result |
|---|---|---|
| Job search page | `/d/jobs/search/?keyword=photographer` | **HTTP 301 → 404** — search URL pattern changed |
| Job search page alt | `/jobs/search/?keyword=photographer` | **HTTP 200** but returns Incapsula challenge page |
| Public REST API | `/api/search/jobs?keyword=photographer` | **HTTP 404** |
| AJAX/XHR JSON | `/d/jobs/search/?keyword=photographer&format=json` | **HTTP 404** |
| RSS feed | Not found anywhere in page source or documentation | **Does not exist** |
| Page HTML | `/d/jobs/` | Returns HTML but all job listings are loaded via JavaScript after page load. Raw HTML contains no job data. |

### The Incapsula/Imperva block

Guru uses **Imperva (formerly Incapsula)** as their WAF (Web Application Firewall). Evidence found in the page source:

```
<script src="/_Incapsula_Resource?SWJIYLWA=719d34d31c8e3a6e6fffd425f7e032f3...">
```

This means:
- Every request is fingerprinted (browser, IP, headers, timing)
- Bot-like requests (no JS execution, no cookies, no browser fingerprint) are served a JavaScript challenge page instead of real content
- Even if you get past the challenge, session tokens expire in minutes
- IP blocks are applied after repeated requests

### Why Guru blocks free automated access

Guru is a mid-tier freelance platform that has never offered a public API. Their business model is similar to Upwork — they want freelancers to use their platform directly. They have:
- No public API (confirmed — their footer links to `/apihelp/help.html` which is a legacy page for their **payment/escrow API only**, not job listings)
- No RSS feed
- Active WAF (Imperva) that blocks all non-browser traffic
- All job data loaded via private JavaScript calls after authentication

### What IS possible (free)

| Option | Effort | Notes |
|---|---|---|
| **Manual paste form** | 30 min | Human pastes job details from Guru, AI scores it |
| **Google Search covers Guru** | 0 effort | Google CSE indexes `www.guru.com/*` — Guru photography jobs will appear in Google Search results automatically |
| **Guru's own API (payment only)** | N/A | Their API at `/apihelp/` is for SafePay/escrow only — not job listings |

### Recommendation

Same as PeoplePerHour — do not attempt to automate Guru directly. The Google Search connector covers it passively. Any Guru photography job that Google has indexed will appear in search results when the hunt runs.

---

---

## Summary Table

| Platform | Free API | RSS | Scraping | Google CSE covers it | Manual form |
|---|---|---|---|---|---|
| Upwork | ❌ Dead | ❌ Dead (410) | ⚠️ TOS violation | ✅ Yes | ✅ Recommended |
| PeoplePerHour | ❌ None | ❌ None | ❌ Auth required + reCAPTCHA | ✅ Yes | ✅ Recommended |
| Guru | ❌ None | ❌ None | ❌ Imperva WAF blocks it | ✅ Yes | ✅ Recommended |
| Freelancer | ✅ Live | — | — | — | — |
| Reddit | ✅ Live | — | — | — | — |
| Google Search | ✅ Live (API key needed) | — | — | — | — |

**Bottom line:** For Upwork, PeoplePerHour, and Guru — the only free and reliable path is either the manual paste form (for high-value leads you find manually) or the Google Search connector (which passively indexes all three platforms). No automated free API exists for any of them.

---

**Authored:** 2026-05-01  
**Verified:** All endpoints tested directly against production URLs  
**Last updated:** 2026-05-01
