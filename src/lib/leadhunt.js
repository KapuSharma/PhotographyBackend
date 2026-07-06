import { SOURCES } from "../hunter/connectors.js";

/* Canonical Lead-Hunt source catalog for the platform admin. `huntable` marks
   sources that participate in automated hunts (LinkedIn is manual-only; Upwork's
   feed is dead). This is the single source of truth for the admin feasibility
   table and the per-source enable map. */
export const SOURCE_CATALOG = [
  { key: "Freelancer",    api: "Public REST API",       access: "Free",              huntable: true,  risk: "Low",  note: "Live" },
  { key: "PeoplePerHour", api: "Public RSS feed",       access: "Free",              huntable: true,  risk: "Low",  note: "Live" },
  { key: "Guru",          api: "Sitemap + JSON-LD",     access: "Free",              huntable: true,  risk: "Low",  note: "Live" },
  { key: "Google Search", api: "Custom Search JSON API",access: "Free tier (API key)",huntable: true, risk: "Low",  note: "Needs GOOGLE_CSE_* env" },
  { key: "Reddit",        api: "Public JSON API",       access: "Free",              huntable: true,  risk: "Low",  note: "Live" },
  { key: "LinkedIn",      api: "No scraping allowed",   access: "Manual entry",      huntable: false, risk: "High", note: "Manual only (ToS)" },
  { key: "Upwork",        api: "RSS shut down (410)",   access: "N/A",               huntable: false, risk: "N/A",  note: "Dead" },
];

/** True unless the platform has explicitly disabled this source. */
export function isSourceEnabled(settings, source) {
  const map = settings?.leadHunt?.sources || {};
  return map[source] !== false;
}

/** Resolve the huntable sources for a run: intersect the requested set (or all
    huntable sources) with the platform-enabled set. */
export function huntSourcesFor(settings, requested) {
  const base = Array.isArray(requested) && requested.length
    ? requested.filter((s) => SOURCES.includes(s))
    : SOURCES;
  return base.filter((s) => isSourceEnabled(settings, s));
}

/** Platform default keyword set (used only when a tenant has none), or null. */
export function platformDefaultKeywords(settings) {
  const k = settings?.leadHunt?.defaultKeywords;
  return Array.isArray(k) && k.length ? k.map(String).filter(Boolean) : null;
}
