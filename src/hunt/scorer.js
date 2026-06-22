import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SYSTEM_PROMPT = `You score social media posts for a photographer lead-generation system.
Given a post, decide: is this person likely hiring/looking for a photographer?
Return strict JSON with fields:
- confidence: integer 0-100 (how likely this post is a photography lead)
- niche: one of "Wedding" | "Event" | "Product" | "Portrait" | "Maternity" | "Other"
- city: string (best guess of city from post, empty string if none)
- matchedKeywords: array of 1-4 short phrases from the post that signal intent
- summary: one-line summary (max 120 chars)

Only return JSON, no prose.`;

export async function scorePost({ text, author, platform }) {
  if (!process.env.GROQ_API_KEY) {
    return {
      confidence: 50,
      niche: "Other",
      city: "",
      matchedKeywords: [],
      summary: text.slice(0, 120),
    };
  }

  const userPrompt = `Platform: ${platform}
Author: ${author || "unknown"}
Post:
"""
${text}
"""`;

  try {
    const resp = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 300,
    });
    const raw = resp.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    return {
      confidence: clampInt(parsed.confidence, 0, 100),
      niche: parsed.niche || "Other",
      city: parsed.city || "",
      matchedKeywords: Array.isArray(parsed.matchedKeywords) ? parsed.matchedKeywords.slice(0, 4) : [],
      summary: (parsed.summary || text).slice(0, 120),
    };
  } catch (err) {
    console.error("[scorer] groq error:", err.message);
    return {
      confidence: 50,
      niche: "Other",
      city: "",
      matchedKeywords: [],
      summary: text.slice(0, 120),
    };
  }
}

function clampInt(n, min, max) {
  const v = Math.round(Number(n));
  if (Number.isNaN(v)) return min;
  return Math.max(min, Math.min(max, v));
}
