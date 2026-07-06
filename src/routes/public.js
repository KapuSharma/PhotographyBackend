import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import getPrisma, { ensureConnected } from "../db/prisma.js";
import { generateAssistantReply } from "../lib/assistant.js";
import { getSettings } from "../lib/settings.js";

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

    // Platform-wide maintenance mode takes all tenant sites offline.
    const settings = await getSettings();
    if (settings.maintenanceMode) {
      return res.status(503).json({ message: settings.maintenanceMessage, unavailable: true, maintenance: true });
    }

    await ensureConnected();
    const client = await getPrisma().client.findUnique({
      where: { domain },
      select: {
        studioName: true,
        accentColor: true,
        logoUrl: true,
        template: true,
        status: true,
        deletedAt: true,
        siteStatus: true,
        aiConfig: { select: { aiAssistantName: true, greetingMessage: true } },
        siteContent: { select: { hero: true, brand: true, trust: true, cta: true, about: true, contact: true, galleryCategories: true, header: true, footer: true, sections: true, galleryPage: true, servicesPage: true, reviewsPage: true, blogPage: true, blogPostPage: true, packagesPage: true, commonSections: true } },
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
    // Suspended, archived, or a site taken offline shows a holding state.
    if (client.deletedAt || (client.status || "active").toLowerCase() === "suspended" || client.siteStatus === "offline") {
      return res.status(403).json({ message: "This site is currently unavailable.", unavailable: true });
    }
    const { status, deletedAt, siteStatus, ...site } = client;
    res.json(site);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /public/plans — active plans for the public Pricing page (single source of truth).
router.get("/plans", async (_req, res) => {
  try {
    await ensureConnected();
    const plans = await getPrisma().plan.findMany({
      where: { archived: false, active: true },
      orderBy: { order: "asc" },
      select: { id: true, name: true, slug: true, audience: true, blurb: true, monthlyPrice: true, annualPrice: true, currency: true, features: true, badge: true, highlighted: true, storageGb: true, aiCredits: true, leadCredits: true, seats: true, websites: true },
    });
    res.json(plans);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /public/track — consent-gated funnel event sink (the client only calls
// this once the visitor has granted analytics consent). Fire-and-forget.
router.post("/track", rateLimit({ max: 60 }), async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || "").slice(0, 60);
    if (!name) return res.status(400).json({ message: "name is required" });
    await ensureConnected();
    await getPrisma().analyticsEvent.create({
      data: {
        name,
        props: b.props && typeof b.props === "object" ? b.props : {},
        utm: b.utm && typeof b.utm === "object" ? b.utm : {},
        path: String(b.path || "").slice(0, 300),
        ref: String(b.ref || "").slice(0, 300),
      },
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ── Marketing blog (public read) ── A post is visible when it's published, or
   scheduled with a publish time in the past. */
function visibleWhere() {
  const now = new Date();
  return { OR: [{ status: "published" }, { status: "scheduled", publishAt: { lte: now } }] };
}
const POST_LIST_SELECT = { title: true, slug: true, excerpt: true, category: true, tags: true, author: true, coverImage: true, publishAt: true, createdAt: true };

router.get("/blog", async (req, res) => {
  try {
    await ensureConnected();
    const where = visibleWhere();
    if (req.query.category) where.category = String(req.query.category);
    if (req.query.q) {
      const q = String(req.query.q);
      where.AND = [{ OR: [{ title: { contains: q, mode: "insensitive" } }, { excerpt: { contains: q, mode: "insensitive" } }] }];
    }
    const posts = await getPrisma().marketingPost.findMany({ where, orderBy: [{ publishAt: "desc" }, { createdAt: "desc" }], take: 60, select: POST_LIST_SELECT });
    const categories = [...new Set((await getPrisma().marketingPost.findMany({ where: visibleWhere(), select: { category: true } })).map((p) => p.category).filter(Boolean))];
    res.json({ posts, categories });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get("/blog/:slug", async (req, res) => {
  try {
    await ensureConnected();
    const post = await getPrisma().marketingPost.findFirst({ where: { slug: req.params.slug, ...visibleWhere() } });
    if (!post) return res.status(404).json({ message: "Article not found" });
    const related = await getPrisma().marketingPost.findMany({ where: { ...visibleWhere(), category: post.category, NOT: { id: post.id } }, take: 3, select: POST_LIST_SELECT });
    res.json({ post, related });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ── Trial-provisioning contract (BL-18 / SRS §19.3) ──
   The marketing site's "Start Free Trial" flow calls these. Provider-agnostic,
   idempotent, with clear terminal error codes so the site can apply FR-T7/T8. */

// POST /public/trial/check-subdomain → { available } (FR-T2). Synchronous, fast.
router.post("/trial/check-subdomain", rateLimit({ max: 30 }), async (req, res) => {
  try {
    const sub = String(req.body?.subdomain || "").toLowerCase().trim().replace(/[^a-z0-9-]/g, "").slice(0, 63);
    if (sub.length < 3) return res.json({ available: false, subdomain: sub, reason: "Too short (min 3 characters)" });
    await ensureConnected();
    const taken = await getPrisma().client.findFirst({ where: { domain: sub }, select: { id: true } });
    res.json({ available: !taken, subdomain: sub });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /public/trial/provision → creates the trial tenant + owner, returns a
// session hand-off (FR-T4). Idempotent via idempotencyKey (FR-T8); terminal
// conflicts return typed codes (FR-T7).
router.post("/trial/provision", rateLimit({ max: 10 }), async (req, res) => {
  try {
    const { name, email, studioName, planSlug, subdomain, idempotencyKey } = req.body || {};
    if (!name || !email || !studioName) return res.status(400).json({ code: "VALIDATION", message: "name, email and studioName are required" });
    const emailLc = String(email).toLowerCase().trim();
    const sub = String(subdomain || "").toLowerCase().trim().replace(/[^a-z0-9-]/g, "").slice(0, 63);
    await ensureConnected();
    const p = getPrisma();

    if (idempotencyKey) {
      const prior = await p.trialRequest.findUnique({ where: { idempotencyKey } });
      if (prior) return res.json({ ok: true, duplicate: true, clientId: prior.clientId, message: "Trial already provisioned for this request." });
    }
    const [clientEx, userEx] = await Promise.all([
      p.client.findUnique({ where: { email: emailLc } }),
      p.user.findUnique({ where: { email: emailLc } }),
    ]);
    if (clientEx || userEx) return res.status(409).json({ code: "EMAIL_TAKEN", message: "An account with that email already exists — please log in." });
    if (sub) { const taken = await p.client.findFirst({ where: { domain: sub } }); if (taken) return res.status(409).json({ code: "SUBDOMAIN_TAKEN", message: "That subdomain is taken — pick another." }); }

    const plan = planSlug ? await p.plan.findUnique({ where: { slug: String(planSlug).toLowerCase() } }) : null;
    const tempPassword = "Hoi-" + crypto.randomBytes(4).toString("hex");
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const client = await p.client.create({
      data: {
        name, studioName, email: emailLc, domain: sub || null,
        plan: plan?.slug || "starter", status: "active",
        subscriptionStatus: "trial", subscriptionExpiresAt: trialEndsAt, trialEndsAt,
        provisionStatus: "ready", siteStatus: "live",
        users: { create: { name, email: emailLc, passwordHash, role: "photographer" } },
      },
      select: { id: true, users: { select: { id: true }, take: 1 } },
    });
    await p.subscriptionEvent.create({ data: { clientId: client.id, type: "trial_started", toPlan: plan?.slug || "starter", cycle: "monthly", actorEmail: "self-serve", meta: { trialDays: 14 } } });
    if (idempotencyKey) await p.trialRequest.create({ data: { idempotencyKey, email: emailLc, clientId: client.id, status: "created" } });

    const token = jwt.sign({ userId: client.users[0].id, clientId: client.id, email: emailLc, role: "photographer" }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.status(201).json({ ok: true, clientId: client.id, loginEmail: emailLc, tempPassword, token, trialEndsAt, redirect: "/dashboard" });
  } catch (err) {
    res.status(500).json({ code: "SERVER", message: err.message });
  }
});

/* ── Marketing-site lead capture (HOI's own funnel) ──
   Distinct from tenant CRM enquiries below. Creates typed MarketingLead records
   worked from the super-admin Inquiries inbox. */
function marketingHandler(type) {
  return async (req, res) => {
    try {
      const b = req.body || {};
      const email = String(b.email || "").toLowerCase().trim();
      if (type !== "newsletter" && !b.name) return res.status(400).json({ message: "Name is required" });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ message: "A valid email is required" });
      if (b.hp) return res.status(200).json({ ok: true }); // honeypot: silently accept, don't store
      await ensureConnected();
      const lead = await getPrisma().marketingLead.create({
        data: {
          type,
          name: String(b.name || "").slice(0, 120),
          email,
          phone: String(b.phone || "").slice(0, 40),
          company: String(b.company || "").slice(0, 120),
          message: String(b.message || "").slice(0, 3000),
          plan: String(b.plan || "").slice(0, 40),
          topic: String(b.topic || "").slice(0, 40),
          preferredSlot: String(b.preferredSlot || "").slice(0, 80),
          source: String(b.source || "").slice(0, 120),
          utm: b.utm && typeof b.utm === "object" ? b.utm : {},
          consent: Boolean(b.consent),
        },
      });
      // TODO(email): notify sales within 5 minutes (needs the email service — Phase 8).
      res.status(201).json({ ok: true, id: lead.id });
    } catch (err) { res.status(500).json({ message: err.message }); }
  };
}
router.post("/marketing/contact", rateLimit({ max: 15 }), marketingHandler("contact"));
router.post("/marketing/demo", rateLimit({ max: 15 }), marketingHandler("demo"));
router.post("/marketing/newsletter", rateLimit({ max: 20 }), marketingHandler("newsletter"));

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
        id: true, plan: true, aiCreditsUsed: true,
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

    // AI credit enforcement (cost control) — cap end-customer assistant usage to
    // the studio's plan allowance.
    const plan = client.plan ? await getPrisma().plan.findUnique({ where: { slug: String(client.plan).toLowerCase() }, select: { aiCredits: true } }) : null;
    const aiLimit = plan?.aiCredits || 0;
    if (aiLimit > 0 && (client.aiCreditsUsed || 0) >= aiLimit) {
      return res.json({
        reply: "Thanks for your interest! Our assistant has paused for now — please use the booking or contact form and the studio will get back to you personally.",
        suggestions: ["View packages", "Book a session", "Contact the studio"],
        overLimit: true,
      });
    }

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
      // Meter one AI credit per successful reply (fire-and-forget).
      getPrisma().client.update({ where: { id: client.id }, data: { aiCreditsUsed: { increment: 1 } } }).catch(() => {});
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
