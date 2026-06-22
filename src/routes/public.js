import { Router } from "express";
import getPrisma, { ensureConnected } from "../db/prisma.js";
import { generateAssistantReply } from "../lib/assistant.js";

const router = Router();

/* Lightweight in-memory per-IP rate limiter for the public endpoints.
   Protects the AI/booking endpoints from spam & runaway cost. Single-instance
   only (resets on restart); swap for Redis if you scale horizontally. */
const _rlHits = new Map();
function rateLimit({ windowMs = 60000, max = 20 } = {}) {
  return (req, res, next) => {
    const ip = (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket?.remoteAddress || "unknown").trim();
    const key = `${req.path}:${ip}`;
    const now = Date.now();
    const rec = _rlHits.get(key);
    if (!rec || now > rec.resetAt) {
      _rlHits.set(key, { count: 1, resetAt: now + windowMs });
      if (_rlHits.size > 5000) for (const [k, v] of _rlHits) if (now > v.resetAt) _rlHits.delete(k);
      return next();
    }
    if (rec.count >= max) {
      const retry = Math.ceil((rec.resetAt - now) / 1000);
      res.set("Retry-After", String(retry));
      return res.status(429).json({ message: `Too many requests — please wait ${retry}s and try again.` });
    }
    rec.count++;
    next();
  };
}

/* Public site resolver — NO auth.
   The public website calls this with a tenant's domain to get everything it
   needs to render: studio identity, accent colour, selected template, and the
   generic CMS content (hero / brand / trust JSON). */
router.get("/site", async (req, res) => {
  try {
    const domain = (req.query.domain || "").toString().trim();
    if (!domain) {
      return res.status(400).json({ message: "domain query param is required" });
    }

    await ensureConnected();
    const client = await getPrisma().client.findUnique({
      where: { domain },
      select: {
        studioName: true,
        accentColor: true,
        logoUrl: true,
        template: true,
        aiConfig: { select: { aiAssistantName: true, greetingMessage: true } },
        siteContent: { select: { hero: true, brand: true, trust: true, cta: true, about: true, contact: true, galleryCategories: true, header: true, footer: true, sections: true } },
        services: {
          where: { active: true },
          select: { id: true, name: true, price: true, startingPrice: true, description: true, category: true, content: true, images: true },
        },
        packages: {
          where: { active: true },
          orderBy: { order: "asc" },
          select: { id: true, name: true, price: true, duration: true, bestFor: true, includes: true, popular: true, content: true, images: true },
        },
        testimonials: {
          where: { active: true },
          orderBy: { order: "asc" },
          select: { client: true, city: true, rating: true, text: true, avatar: true },
        },
        gallery: {
          where: { active: true },
          orderBy: { order: "asc" },
          select: { url: true, title: true, category: true },
        },
        blogPosts: {
          where: { active: true },
          orderBy: { order: "asc" },
          select: { title: true, excerpt: true, date: true, imageUrl: true },
        },
      },
    });

    if (!client) {
      return res.status(404).json({ message: "Site not found for that domain" });
    }
    res.json(client);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* Public enquiry — NO auth.
   The website's contact form posts here; we create a CRM lead for the tenant
   that owns the given domain. */
router.post("/enquiry", rateLimit({ windowMs: 60000, max: 12 }), async (req, res) => {
  try {
    const { domain, name, email, phone, service, message, source } = req.body || {};
    if (!domain || !name || !email) {
      return res.status(400).json({ message: "domain, name and email are required" });
    }
    const leadSource = typeof source === "string" && source.trim() ? source.trim().slice(0, 60) : "Website Form";

    await ensureConnected();
    const client = await getPrisma().client.findUnique({
      where: { domain: domain.toString().trim() },
      select: { id: true },
    });
    if (!client) {
      return res.status(404).json({ message: "Site not found for that domain" });
    }

    const lead = await getPrisma().lead.create({
      data: {
        clientId: client.id,
        name: String(name).slice(0, 200),
        email: String(email).slice(0, 200),
        phone: phone ? String(phone).slice(0, 50) : null,
        eventType: service ? String(service).slice(0, 100) : null,
        message: message ? String(message).slice(0, 2000) : null,
        source: leadSource,
        status: "New",
      },
      select: { id: true },
    });

    res.status(201).json({ ok: true, id: lead.id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* Public booking request — NO auth.
   The website's booking flow posts here; we record it as a high-intent CRM lead
   for the tenant (service, package, preferred date & slot, contact + note). */
router.post("/booking", rateLimit({ windowMs: 60000, max: 12 }), async (req, res) => {
  try {
    const { domain, service, packageName, date, slot, name, email, phone, message, estimatedValue } = req.body || {};
    if (!domain || !name || !email || !date || !slot) {
      return res.status(400).json({ message: "domain, name, email, date and slot are required" });
    }

    await ensureConnected();
    const client = await getPrisma().client.findUnique({
      where: { domain: domain.toString().trim() },
      select: { id: true },
    });
    if (!client) return res.status(404).json({ message: "Site not found for that domain" });

    const note = [
      packageName && `Package: ${packageName}`,
      slot && `Preferred time: ${slot}`,
      message && `Note: ${message}`,
    ].filter(Boolean).join(" | ");

    const lead = await getPrisma().lead.create({
      data: {
        clientId: client.id,
        name: String(name).slice(0, 200),
        email: String(email).slice(0, 200),
        phone: phone ? String(phone).slice(0, 50) : null,
        eventType: service ? String(service).slice(0, 100) : "Booking",
        eventDate: String(date).slice(0, 40),
        estimatedValue: typeof estimatedValue === "number" ? estimatedValue : null,
        message: note || null,
        source: "Website Booking",
        status: "New",
        temperature: "Hot",
      },
      select: { id: true },
    });

    res.status(201).json({ ok: true, id: lead.id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* Public "Ask AI" assistant — NO auth.
   The website's chat widget posts the conversation here; we ground a Groq
   reply in the tenant's own content (services, packages, FAQs, contact, about)
   and return a friendly answer plus tappable follow-up suggestions. */
router.post("/ask-ai", rateLimit({ windowMs: 60000, max: 20 }), async (req, res) => {
  try {
    const { domain, messages } = req.body || {};
    if (!domain) return res.status(400).json({ message: "domain is required" });
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ message: "messages must be a non-empty array" });
    }

    await ensureConnected();
    const client = await getPrisma().client.findUnique({
      where: { domain: domain.toString().trim() },
      select: {
        studioName: true,
        siteContent: { select: { about: true, contact: true } },
        aiConfig: { select: { aiAssistantName: true, tone: true, primaryNiche: true } },
        services: {
          where: { active: true },
          select: { name: true, price: true, startingPrice: true, description: true },
        },
        packages: {
          where: { active: true },
          orderBy: { order: "asc" },
          select: { name: true, price: true, duration: true, bestFor: true, includes: true },
        },
        faqs: { where: { active: true }, select: { question: true, answer: true } },
        _count: { select: { testimonials: { where: { active: true } } } },
      },
    });
    if (!client) return res.status(404).json({ message: "Site not found for that domain" });

    const about = client.siteContent?.about || {};
    const contact = client.siteContent?.contact || {};
    const studio = {
      studioName: client.studioName,
      assistantName: client.aiConfig?.aiAssistantName,
      tone: client.aiConfig?.tone,
      niche: client.aiConfig?.primaryNiche,
      tagline: about?.intro?.tagline || contact?.tagline || "",
      about: about?.intro?.body || "",
      contact: { phone: contact.phone, email: contact.email, address: contact.address },
      services: client.services,
      packages: client.packages,
      faqs: client.faqs,
      reviewCount: client._count?.testimonials || 0,
    };

    try {
      const result = await generateAssistantReply({ studio, messages });
      return res.json({ reply: result.reply, suggestions: result.suggestions });
    } catch (aiErr) {
      // AI unavailable (e.g. no GROQ_API_KEY / rate limit) — never break the chat.
      const phone = contact.phone ? ` or call ${contact.phone}` : "";
      return res.json({
        reply: `Sorry, I'm having a little trouble right now. You can browse our packages and book a session from the Booking page${phone}. Our team will be happy to help!`,
        suggestions: ["View packages", "How do I book?", "Contact the studio"],
        degraded: true,
      });
    }
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
