import Groq from "groq-sdk";

/**
 * Generates an "AI Intelligence Report" for a lead.
 *
 * Response shape:
 *   {
 *     summary: string,                         // 2 sentences about who this lead is + key angle
 *     insights: Array<{
 *       category: 'warn'|'demand'|'detail'|'highlight'|'emphasize',
 *       title:    string,                      // ≤ 8 words — headline
 *       detail:   string,                      // 2-3 sentences — reasoning + action
 *     }>
 *   }
 *
 * Uses Groq (free tier) + llama-3.3-70b with JSON mode.
 */

const ALLOWED_CATEGORIES = new Set(["warn", "demand", "detail", "highlight", "emphasize"]);
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

let _client = null;
function getGroq() {
  if (_client) return _client;
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not set");
  }
  _client = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _client;
}

function buildSystemPrompt({ studioName, niche }) {
  const studio = studioName || "the studio";
  const nicheLabel = niche || "photography";

  return `You are a senior sales-intelligence analyst advising ${studio}, a ${nicheLabel} studio.

Given a new lead's details, produce:
1. A SHORT SUMMARY — exactly 2 sentences — describing who this lead is and the single most important pitch angle or concern.
2. EXACTLY 5 intelligence points.

Each insight MUST have:
- category: EXACTLY one of: "warn", "demand", "detail", "highlight", "emphasize"
  • warn      — a risk, objection, or blocker the photographer must address
  • demand    — an explicit client need (deliverables, scope, timeline, inclusions)
  • detail    — a nuance about the requirements, audience, or context
  • highlight — a selling angle that fits this specific lead's profile
  • emphasize — a long-term value proposition worth stressing in the pitch
- title: a concise headline, maximum 8 words, specific and punchy (not generic)
- detail: 2–3 complete sentences (40–70 words total). Explain the reasoning grounded in the lead's actual data, then recommend ONE concrete action the photographer should take.

Hard rules:
- Never invent facts not present in the lead data. If relevant info is missing, call that out honestly (e.g. "event date is missing — request before quoting").
- Use a mix of categories across the 5 points; do not use the same category more than twice.
- Details must cite specific things from the lead (e.g. the stated budget, event type, the phrasing of their message).
- Keep the tone professional, direct, and actionable — no fluff, no generic advice like "respond quickly".

Return ONLY this JSON, no markdown, no prose:
{
  "summary": "Two-sentence overview.",
  "insights": [
    {"category":"warn","title":"...","detail":"..."},
    {"category":"demand","title":"...","detail":"..."},
    {"category":"detail","title":"...","detail":"..."},
    {"category":"highlight","title":"...","detail":"..."},
    {"category":"emphasize","title":"...","detail":"..."}
  ]
}`;
}

function buildUserPrompt({ lead, services, profile }) {
  const facts = [
    ["Name",            lead.name],
    ["Company",         lead.company],
    ["Email",           lead.email],
    ["Phone",           lead.phone],
    ["Event type",      lead.eventType],
    ["Event date",      lead.eventDate],
    ["Location",        lead.location],
    ["Budget",          lead.budget],
    ["Source",          lead.source],
    ["Lead score",      typeof lead.score === "number" ? String(lead.score) + "/100" : null],
    ["Client message",  lead.message],
    ["Internal notes",  lead.notes],
  ]
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim().length > 0)
    .map(([k, v]) => `- ${k}: ${String(v).trim()}`)
    .join("\n");

  const servicesBlock = (services && services.length > 0)
    ? services
        .slice(0, 10)
        .map(s => `- ${s.name}${s.startingPrice ? ` (from $${s.startingPrice})` : ""}${s.description ? ` — ${s.description}` : ""}`)
        .join("\n")
    : "(no services configured)";

  const profileBlock = [
    profile?.shootingStyle     && `- Shooting style: ${profile.shootingStyle}`,
    profile?.editingStyle      && `- Editing style: ${profile.editingStyle}`,
    profile?.minBudget         && `- Minimum project budget: ${profile.minBudget}`,
    profile?.avgProjectValue   && `- Average project value: ${profile.avgProjectValue}`,
    profile?.turnaround        && `- Turnaround: ${profile.turnaround}`,
    profile?.bookingLeadTime   && `- Booking lead time: ${profile.bookingLeadTime}`,
    profile?.idealClientDesc   && `- Ideal client: ${profile.idealClientDesc}`,
    profile?.dealBreakers      && `- Deal breakers: ${profile.dealBreakers}`,
  ].filter(Boolean).join("\n") || "(no studio profile configured)";

  return `LEAD DETAILS
${facts || "(no data)"}

STUDIO SERVICES
${servicesBlock}

STUDIO PROFILE
${profileBlock}

Generate the summary and the 5-point intelligence report now.`;
}

function validate(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid response: not an object");
  }
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (!summary) throw new Error("Invalid response: missing summary");

  if (!Array.isArray(raw.insights)) {
    throw new Error("Invalid response: insights must be an array");
  }

  const insights = raw.insights
    .filter(i => i && typeof i === "object")
    .map(i => {
      const category = String(i.category || "").toLowerCase().trim();
      const title    = String(i.title || "").trim();
      const detail   = String(i.detail || "").trim();
      if (!ALLOWED_CATEGORIES.has(category)) return null;
      if (!title || !detail) return null;
      return {
        category,
        title:  title.length  > 120 ? title.slice(0, 117) + "…" : title,
        detail: detail.length > 600 ? detail.slice(0, 597) + "…" : detail,
      };
    })
    .filter(Boolean)
    .slice(0, 5);

  if (insights.length === 0) throw new Error("Invalid response: no usable insights");

  return {
    summary: summary.length > 400 ? summary.slice(0, 397) + "…" : summary,
    insights,
  };
}

/**
 * Returns: { summary, insights, model, sourceData }
 * where sourceData is a machine-readable description of exactly what was sent
 * to the model, so the UI can show the user what fed the analysis.
 */
export async function generateLeadInsights({ lead, services, profile, studioName, niche, model }) {
  const chosenModel = model || DEFAULT_MODEL;
  const client = getGroq();

  const leadFieldsUsed = [
    lead.name           && "name",
    lead.company        && "company",
    lead.email          && "email",
    lead.phone          && "phone",
    lead.eventType      && "eventType",
    lead.eventDate      && "eventDate",
    lead.location       && "location",
    lead.budget         && "budget",
    lead.source         && "source",
    typeof lead.score === "number" && "score",
    lead.message        && "message",
    lead.notes          && "notes",
  ].filter(Boolean);

  const sourceData = {
    leadFields: leadFieldsUsed,
    studio: {
      studioName: studioName || null,
      servicesCount: Array.isArray(services) ? services.length : 0,
      profileFieldsUsed: [
        profile?.shootingStyle   && "shootingStyle",
        profile?.editingStyle    && "editingStyle",
        profile?.minBudget       && "minBudget",
        profile?.avgProjectValue && "avgProjectValue",
        profile?.turnaround      && "turnaround",
        profile?.bookingLeadTime && "bookingLeadTime",
        profile?.idealClientDesc && "idealClientDesc",
        profile?.dealBreakers    && "dealBreakers",
      ].filter(Boolean),
    },
  };

  const completion = await client.chat.completions.create({
    model: chosenModel,
    temperature: 0.4,
    max_tokens: 1400,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: buildSystemPrompt({ studioName, niche }) },
      { role: "user",   content: buildUserPrompt({ lead, services, profile }) },
    ],
  });

  const content = completion.choices?.[0]?.message?.content || "";
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { throw new Error("Groq returned invalid JSON: " + content.slice(0, 200)); }

  const validated = validate(parsed);
  return {
    summary:   validated.summary,
    insights:  validated.insights,
    model:     chosenModel,
    sourceData,
  };
}
