import Groq from "groq-sdk";
import { findPriorityHits, recommendService } from "./filters.js";

let _groq = null;
function getGroq() {
  if (_groq) return _groq;
  if (!process.env.GROQ_API_KEY) return null;
  _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _groq;
}

const MODEL = "llama-3.1-8b-instant";

export function heuristicScore(lead, customKeywords) {
  const blob = `${lead.title || ""} ${lead.description || ""}`.toLowerCase();
  const priorityHits = findPriorityHits(lead, customKeywords);

  // Buyer intent (30)
  const intentSignals = [
    /\b(hiring|looking for|seeking|need(ed)?|we want|we need|seeks|wanted|required)\b/i,
    /\b(rfp|request for proposal|quote|bid|booking)\b/i,
    /\b(freelancer|contractor|agency|professional|expert|specialist)\b/i,
  ];
  let intent = 0;
  intentSignals.forEach(re => { if (re.test(blob)) intent += 10; });
  intent = Math.min(intent, 30);

  // Budget/value (25)
  let budget = 0;
  const max = lead.budgetMax || 0;
  if (max >= 10000) budget = 25;
  else if (max >= 5000) budget = 20;
  else if (max >= 2000) budget = 14;
  else if (max >= 500) budget = 8;
  else if (max > 0) budget = 4;
  else budget = 12;

  // Keyword fit (20)
  const fit = Math.min(20, priorityHits.length * 7);

  // Urgency (15)
  let urgency = 0;
  if (/\b(urgent|asap|immediately|deadline|this week|by friday)\b/i.test(blob)) urgency += 8;
  if (lead.postedAt) {
    const ageHours = (Date.now() - new Date(lead.postedAt).getTime()) / 3600000;
    if (ageHours < 24) urgency += 7;
    else if (ageHours < 72) urgency += 4;
    else if (ageHours < 168) urgency += 2;
  } else {
    urgency += 3;
  }
  urgency = Math.min(urgency, 15);

  // Competition risk (10)
  let comp = 10;
  if (lead.competitionCount >= 30) comp = 2;
  else if (lead.competitionCount >= 15) comp = 5;
  else if (lead.competitionCount >= 5) comp = 8;

  const total = Math.min(100, intent + budget + fit + urgency + comp);
  const breakdown = { buyerIntent: intent, budgetValue: budget, hoiFit: fit, urgency, competitionRisk: comp };
  const recommendedService = recommendService(lead, customKeywords);
  const reason = `Buyer intent ${intent}/30 · Budget ${budget}/25${lead.budgetMax ? ` (${lead.currency || "USD"} ${lead.budgetMax})` : ""} · Fit ${fit}/20${priorityHits.length ? ` — ${priorityHits.slice(0, 2).join(", ")}` : ""} · Urgency ${urgency}/15 · Competition ${comp}/10`;
  const suggestedReply = buildBaselineReply(lead, recommendedService);

  return { total, breakdown, recommendedService, reason, suggestedReply };
}

function buildBaselineReply(lead, service) {
  const t = (lead.title || "").trim();
  return `Hi${lead.clientName ? ` ${lead.clientName.split(" ")[0]}` : ""},\n\nI came across your post about "${t}" and I'd love to help. I specialise in ${service} and have delivered similar work for clients across various industries.\n\nA few quick questions:\n  1. What is your timeline or deadline?\n  2. What is your approximate budget?\n  3. Do you have any references or examples of what you're looking for?\n\nHappy to discuss further and share relevant examples of my work.\n\nBest regards`;
}

// The default Groq system prompt. `{{keywords}}` is substituted with the
// account's hunt keywords at scoring time. Exposed via the API so the UI
// can show it and let the user override it (stored in HunterConfig).
export function defaultScorePrompt() {
  return `You are a lead analyst. Score inbound job/project leads on a 100-point scale for a business that offers: {{keywords}}.

Scoring weights:
- Buyer intent: 30 (are they clearly looking to hire?)
- Budget/value: 25 (is the budget reasonable?)
- Service fit: 20 (does it match the business keywords: {{keywords}}?)
- Urgency: 15 (how soon do they need it?)
- Competition risk: 10 (fewer bidders = better)

Return STRICT JSON:
{
  "buyerIntent": 0-30,
  "budgetValue": 0-25,
  "hoiFit": 0-20,
  "urgency": 0-15,
  "competitionRisk": 0-10,
  "recommendedService": "<best matching service from keywords>",
  "reason": "<≤220 chars — why this score>",
  "suggestedReply": "<150-220 word professional outreach reply tailored to this lead>"
}`;
}

export async function scoreLead(lead, customKeywords, scorePromptTemplate) {
  const baseline = heuristicScore(lead, customKeywords);
  const groq = getGroq();
  if (!groq) return baseline;

  const keywordList = customKeywords?.length ? customKeywords.join(", ") : "general services";

  const template = (typeof scorePromptTemplate === "string" && scorePromptTemplate.trim())
    ? scorePromptTemplate
    : defaultScorePrompt();
  const sys = template.split("{{keywords}}").join(keywordList);

  const usr = `LEAD
Source: ${lead.source}
Title: ${lead.title}
Description: ${(lead.description || "").slice(0, 400)}
Budget: ${lead.budgetMin ?? "?"} - ${lead.budgetMax ?? "?"} ${lead.currency || "USD"}
Country: ${lead.country || "?"}
Posted: ${lead.postedAt ? new Date(lead.postedAt).toISOString() : "?"}
Competition: ${lead.competitionCount || 0} bidders

Score now and return JSON only.`;

  try {
    const resp = await groq.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: usr },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 600,
    });
    const raw = resp.choices?.[0]?.message?.content || "{}";
    const p = JSON.parse(raw);
    const breakdown = {
      buyerIntent: clamp(p.buyerIntent, 0, 30),
      budgetValue: clamp(p.budgetValue, 0, 25),
      hoiFit: clamp(p.hoiFit, 0, 20),
      urgency: clamp(p.urgency, 0, 15),
      competitionRisk: clamp(p.competitionRisk, 0, 10),
    };
    const total = breakdown.buyerIntent + breakdown.budgetValue + breakdown.hoiFit + breakdown.urgency + breakdown.competitionRisk;
    return {
      total,
      breakdown,
      recommendedService: String(p.recommendedService || baseline.recommendedService).slice(0, 80),
      reason: String(p.reason || baseline.reason).slice(0, 240),
      suggestedReply: String(p.suggestedReply || baseline.suggestedReply).slice(0, 1500),
    };
  } catch (err) {
    console.warn("[hunter scorer] groq fallback:", err.message);
    return baseline;
  }
}

function clamp(n, min, max) {
  const v = Math.round(Number(n));
  if (Number.isNaN(v)) return min;
  return Math.max(min, Math.min(max, v));
}
