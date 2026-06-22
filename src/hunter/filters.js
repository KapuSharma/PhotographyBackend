/* Filtering rules for HOI AI Lead Hunter — Dynamic, works for any business type */

// Universal garbage filters — apply regardless of business type
const REJECT_PATTERNS = [
  { rule: "data entry",      re: /\b(data entry|copy[- ]paste|excel typing)\b/i },
  { rule: "essay/homework",  re: /\b(essay writing|homework help|assignment help|thesis writing|dissertation)\b/i },
  { rule: "adult content",   re: /\b(adult|nsfw|escort|onlyfans|cam ?model)\b/i },
  { rule: "crypto scam",     re: /\b(pump.{0,5}dump|crypto airdrop|memecoin shill|forex signals|MLM crypto)\b/i },
];

export function applyRejectFilter(lead, customKeywords) {
  const blob = `${lead.title || ""}\n${lead.description || ""}`.toLowerCase();

  // Layer 1 — universal garbage reject
  for (const { rule, re } of REJECT_PATTERNS) {
    if (re.test(blob)) return { rejected: true, reason: rule };
  }

  // Layer 2 — keyword relevance check
  // If client has saved keywords, at least one must appear in title/description
  if (customKeywords?.length) {
    const hasMatch = customKeywords.some(kw => {
      const words = kw.toLowerCase().split(" ").filter(w => w.length > 2);
      return words.some(w => blob.includes(w));
    });
    if (!hasMatch) return { rejected: true, reason: "not relevant to saved keywords" };
  }

  // Layer 3 — budget floor (reject under $20 — universal)
  if (typeof lead.budgetMax === "number" && lead.budgetMax > 0 && lead.budgetMax < 20) {
    return { rejected: true, reason: "very low budget" };
  }

  return { rejected: false, reason: "" };
}

export function findPriorityHits(lead, customKeywords) {
  const blob = `${lead.title || ""}\n${lead.description || ""}\n${(lead.skills || []).join(" ")}`.toLowerCase();
  if (!customKeywords?.length) return [];
  return customKeywords.filter(k => {
    const words = k.toLowerCase().split(" ").filter(w => w.length > 2);
    return words.some(w => blob.includes(w));
  });
}

export function recommendService(lead, customKeywords) {
  const blob = `${lead.title || ""}\n${lead.description || ""}\n${(lead.skills || []).join(" ")}`.toLowerCase();
  if (!customKeywords?.length) return "General Services";
  // Return the keyword that matches best
  let best = null;
  let bestCount = 0;
  for (const kw of customKeywords) {
    const words = kw.toLowerCase().split(" ").filter(w => w.length > 2);
    const count = words.filter(w => blob.includes(w)).length;
    if (count > bestCount) { bestCount = count; best = kw; }
  }
  return best || customKeywords[0] || "General Services";
}
