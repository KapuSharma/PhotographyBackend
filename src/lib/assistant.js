import Groq from "groq-sdk";

/**
 * Public website "Ask AI" assistant.
 *
 * Generates a friendly, grounded chat reply for a studio's website visitor,
 * using only the studio's own content (services, packages, reviews, contact,
 * FAQs, about). Returns short follow-up suggestions so the UI can offer tappable
 * next questions.
 *
 * Response shape: { reply: string, suggestions: string[] }
 *
 * Uses Groq (free tier) + llama-3.3-70b with JSON mode.
 */

const DEFAULT_MODEL = "llama-3.3-70b-versatile";

let _client = null;
function getGroq() {
  if (_client) return _client;
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not set");
  _client = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _client;
}

// Strip HTML tags + collapse whitespace from CMS rich-text so we don't waste
// tokens (and the model reads clean prose).
function plain(html, max = 600) {
  if (!html) return "";
  const text = String(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function buildStudioContext(studio) {
  const lines = [];
  lines.push(`Studio name: ${studio.studioName || "the studio"}`);
  if (studio.niche) lines.push(`Speciality: ${studio.niche} photography`);
  if (studio.tagline) lines.push(`Tagline: ${plain(studio.tagline, 160)}`);
  if (studio.about) lines.push(`About: ${plain(studio.about, 500)}`);

  if (studio.services?.length) {
    lines.push("\nSERVICES:");
    studio.services.slice(0, 15).forEach((s) => {
      const price = s.price || (s.startingPrice ? `from ₹${s.startingPrice}` : "");
      lines.push(`- ${s.name}${price ? ` (${price})` : ""}${s.description ? ` — ${plain(s.description, 160)}` : ""}`);
    });
  }

  if (studio.packages?.length) {
    lines.push("\nPACKAGES:");
    studio.packages.slice(0, 15).forEach((p) => {
      const bits = [
        p.price && `${p.price}`,
        p.duration && `${p.duration}`,
        p.bestFor && `best for ${p.bestFor}`,
      ].filter(Boolean).join(", ");
      const includes = Array.isArray(p.includes) && p.includes.length ? ` Includes: ${p.includes.slice(0, 8).join(", ")}.` : "";
      lines.push(`- ${p.name}${bits ? ` (${bits})` : ""}.${includes}`);
    });
  }

  if (studio.faqs?.length) {
    lines.push("\nFAQs:");
    studio.faqs.slice(0, 20).forEach((f) => {
      if (f.question && f.answer) lines.push(`- Q: ${plain(f.question, 160)}\n  A: ${plain(f.answer, 300)}`);
    });
  }

  const contact = [
    studio.contact?.phone && `phone ${studio.contact.phone}`,
    studio.contact?.email && `email ${studio.contact.email}`,
    studio.contact?.address && `address ${studio.contact.address}`,
  ].filter(Boolean).join(", ");
  if (contact) lines.push(`\nCONTACT: ${contact}`);

  if (typeof studio.reviewCount === "number" && studio.reviewCount > 0) {
    lines.push(`\nThis studio has ${studio.reviewCount} client review(s) on the website.`);
  }

  // ── Photographer's AI Training Profile ──
  const profile = studio.profile;
  if (profile) {
    const p = [];
    if (profile.fullName) p.push(`Lead photographer: ${profile.fullName}.`);
    if (profile.bio) p.push(`About the photographer: ${plain(profile.bio, 400)}`);
    const style = [profile.shootingStyle, profile.editingStyle].filter(Boolean).join(", ");
    if (style) p.push(`Shooting & editing style: ${style}.`);
    if (Array.isArray(profile.niches) && profile.niches.length) p.push(`Specialities: ${profile.niches.join(", ")}.`);
    if (profile.minBudget) p.push(`Minimum budget the studio takes on: ${profile.minBudget}.`);
    if (profile.avgProjectValue) p.push(`Typical project value: ${profile.avgProjectValue}.`);
    if (profile.turnaround) p.push(`Delivery / turnaround: ${profile.turnaround}.`);
    if (profile.bookingLeadTime) p.push(`Minimum booking lead time: ${profile.bookingLeadTime}.`);
    const pay = [profile.depositPercent ? `${profile.depositPercent}% deposit` : "", profile.paymentTerms].filter(Boolean).join(" — ");
    if (pay) p.push(`Payment terms: ${pay}.`);
    const base = [profile.city, profile.state, profile.country].filter(Boolean).join(", ");
    if (base) p.push(`Based in: ${base}.`);
    if (Array.isArray(profile.serviceAreas) && profile.serviceAreas.length) p.push(`Travels for shoots to: ${profile.serviceAreas.join(", ")}.`);
    if (profile.travelsInterstate && profile.travelsInterstate !== "No") p.push(`Travels interstate: ${profile.travelsInterstate}.`);
    if (profile.travelsInternational && profile.travelsInternational !== "No") p.push(`Travels internationally: ${profile.travelsInternational}.`);
    if (profile.idealClientDesc) p.push(`Ideal client profile: ${plain(profile.idealClientDesc, 300)}`);
    if (p.length) {
      lines.push("\nABOUT THE PHOTOGRAPHER (use to answer naturally and qualify leads):");
      p.forEach((x) => lines.push(`- ${x}`));
    }
  }

  return lines.join("\n");
}

function buildSystemPrompt(studio) {
  const name = studio.assistantName || "the studio assistant";
  const studioName = studio.studioName || "the studio";
  const tone = studio.tone || "warm and professional";
  const profile = studio.profile || {};

  // Behaviour lines derived from the photographer's AI Training Profile.
  const behaviour = [];
  if (profile.responseStyle) behaviour.push(`- The photographer wants replies to feel ${profile.responseStyle.toLowerCase()}. Blend this with your ${tone} tone.`);
  if (profile.qualifyingQuestions && String(profile.qualifyingQuestions).trim()) {
    behaviour.push(`- When it fits naturally, gently ask qualifying questions to understand the lead. The photographer's preferred questions: ${plain(profile.qualifyingQuestions, 400)}`);
  }
  if (profile.dealBreakers && String(profile.dealBreakers).trim()) {
    behaviour.push(`- The studio does NOT take on: ${plain(profile.dealBreakers, 300)}. If a request clearly matches, be honest and polite, and don't over-promise.`);
  }
  if (profile.minBudget) {
    behaviour.push(`- The studio's minimum budget is ${profile.minBudget}. If a visitor's budget is clearly below this, stay kind and suggest the closest-fit option or the contact page — never be dismissive.`);
  }
  if (profile.closingLine && String(profile.closingLine).trim()) {
    behaviour.push(`- When the visitor seems ready to move forward, encourage them warmly in the spirit of: "${plain(profile.closingLine, 200)}"`);
  }

  return `You are ${name}, the friendly AI assistant on the website of ${studioName}, a photography studio. Your job is to help website visitors, answer their questions clearly, and turn them into happy, booked clients.

HOW TO RESPOND:
- Introduce yourself by name ("${name}") in your very first reply of the conversation, then get straight to helping. Don't repeat the introduction after that.
- Be ${tone}, welcoming and genuinely helpful. Write like a real person, not a brochure.
- Keep answers short and easy to understand: usually 2–4 sentences. Use simple language, no jargon.
- You may use a light bit of formatting (a short bullet list) when listing packages or services, but keep it brief.
- Always guide the visitor toward a helpful next step (view packages, check availability, or book a session) when it fits naturally.
${behaviour.length ? `\nHOW THIS PHOTOGRAPHER WANTS YOU TO QUALIFY & CLOSE:\n${behaviour.join("\n")}\n` : ""}
GROUNDING RULES (very important):
- Only use the STUDIO INFORMATION provided below. Never invent prices, packages, dates, or facts that are not given.
- If you don't know something (e.g. an exact price that isn't listed, or live calendar availability), say so honestly and point them to the Booking page or the studio's contact details.
- For availability or specific dates: explain you can't see the live calendar, and invite them to use the Booking page to request a date, or to contact the studio directly.
- Never make promises on the studio's behalf (no guaranteed discounts or dates).
- If asked something unrelated to photography or this studio, gently steer back to how you can help with their shoot.

STUDIO INFORMATION:
${buildStudioContext(studio)}

OUTPUT FORMAT:
Return ONLY valid JSON, no markdown fences, in exactly this shape:
{
  "reply": "Your helpful answer to the visitor.",
  "suggestions": ["Short follow-up", "Another option", "One more"]
}
"suggestions" = up to 3 short follow-up questions the visitor might want to tap next, each maximum 6 words, phrased from the visitor's point of view (e.g. "How much for a wedding?"). They must be relevant to this studio and the conversation. Use an empty array if none make sense.`;
}

function clampHistory(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-10)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }));
}

/**
 * @returns {Promise<{ reply: string, suggestions: string[], model: string }>}
 */
export async function generateAssistantReply({ studio, messages, model }) {
  const chosenModel = model || DEFAULT_MODEL;
  const client = getGroq();
  const history = clampHistory(messages);
  if (history.length === 0 || history[history.length - 1].role !== "user") {
    throw new Error("The last message must be from the user");
  }

  const completion = await client.chat.completions.create({
    model: chosenModel,
    temperature: 0.5,
    max_tokens: 700,
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: buildSystemPrompt(studio) }, ...history],
  });

  const content = completion.choices?.[0]?.message?.content || "";
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { return { reply: content.trim() || "Sorry, I didn't catch that — could you rephrase?", suggestions: [], model: chosenModel }; }

  const reply = typeof parsed.reply === "string" && parsed.reply.trim()
    ? parsed.reply.trim()
    : "I'm here to help with our services, packages and bookings — what would you like to know?";
  const suggestions = Array.isArray(parsed.suggestions)
    ? parsed.suggestions.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim().slice(0, 60)).slice(0, 3)
    : [];

  return { reply: reply.slice(0, 1500), suggestions, model: chosenModel };
}
