import { Router } from "express";
import Groq from "groq-sdk";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import dns from "dns/promises";
import getPrisma, { ensureConnected } from "../db/prisma.js";
import { isSubscriptionActive } from "../lib/subscription.js";
import { adminAuth, requirePermission } from "../middleware/adminAuth.js";
import { getRoleMap, invalidateRoles, PERMISSION_CATALOG, ASSIGNABLE_PERMISSIONS, SYSTEM_ROLES } from "../lib/permissions.js";
import { logAudit } from "../lib/audit.js";
import { periodEnd, usedGb, fitsPlan, sweepSubscriptions } from "../lib/plans.js";
import { getSettings, saveSettings, getAiKey, redactSettings } from "../lib/settings.js";
import { SOURCE_CATALOG, isSourceEnabled } from "../lib/leadhunt.js";
import { encrypt } from "../lib/crypto.js";

const router = Router();

/* Platform-level (cross-tenant) endpoints for the super-admin console.
   Two layers of defence: the shared SUPERADMIN_SECRET (sent by the super-admin's
   own server proxy, never exposed to the browser) AND an authenticated admin JWT
   with RBAC, so every action is attributed to a real admin and permission-checked. */
router.use((req, res, next) => {
  const secret = req.headers["x-admin-secret"];
  if (!process.env.SUPERADMIN_SECRET || secret !== process.env.SUPERADMIN_SECRET) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
});
router.use(adminAuth);

const PLAN_PRICE = { free: 0, starter: 29, pro: 79, studio: 149, agency: 199, elite: 199 };
const PLAN_CAP = { free: 5, starter: 15, pro: 50, studio: 150, agency: 200, elite: 200 };
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");
const mapStatus = (s) => { const v = (s || "active").toLowerCase(); return v === "active" ? "Active" : v === "trial" ? "Trial" : "Suspended"; };
const mapPay = (s) => { const v = (s || "").toLowerCase(); return v === "paid" ? "Paid" : v === "overdue" ? "Overdue" : "Pending"; };

// Sum MRR from live plan prices for currently-subscribed studios.
async function computeMrr(clients) {
  const plans = await getPrisma().plan.findMany({ select: { slug: true, monthlyPrice: true } });
  const price = Object.fromEntries(plans.map((p) => [p.slug, p.monthlyPrice]));
  return clients
    .filter((c) => ["active", "trial"].includes((c.subscriptionStatus || "active").toLowerCase()))
    .reduce((a, c) => a + (price[(c.plan || "").toLowerCase()] ?? PLAN_PRICE[(c.plan || "starter").toLowerCase()] ?? 0), 0);
}

// GET /overview — full platform KPI set.
router.get("/overview", requirePermission("dashboard.view"), async (_req, res) => {
  try {
    await ensureConnected();
    const prisma = getPrisma();
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const in7d = new Date(now.getTime() + 7 * 86400000);
    const live = await prisma.client.findMany({ where: { deletedAt: null }, select: { plan: true, status: true, subscriptionStatus: true, subscriptionExpiresAt: true, trialEndsAt: true, domain: true, createdAt: true } });
    const [totalUsers, galleryCount, openInquiries, publishedPosts, totalLeads, openTickets] = await Promise.all([
      prisma.user.count(),
      prisma.galleryImage.count(),
      prisma.marketingLead.count({ where: { status: "New" } }),
      prisma.marketingPost.count({ where: { OR: [{ status: "published" }, { status: "scheduled", publishAt: { lte: now } }] } }),
      prisma.lead.count(),
      prisma.ticket.count({ where: { status: { in: ["open", "pending"] } } }),
    ]);
    const byStatus = (s) => live.filter((c) => (c.status || "active").toLowerCase() === s).length;
    const bySub = (s) => live.filter((c) => (c.subscriptionStatus || "active").toLowerCase() === s).length;
    const mrr = await computeMrr(live);
    res.json({
      totalStudios: live.length,
      activeStudios: byStatus("active"),
      suspendedStudios: byStatus("suspended"),
      trialStudios: bySub("trial"),
      expiredSubs: bySub("expired"),
      newStudiosThisMonth: live.filter((c) => new Date(c.createdAt) >= monthStart).length,
      websites: live.filter((c) => c.domain).length,
      upcomingRenewals: live.filter((c) => c.subscriptionExpiresAt && new Date(c.subscriptionExpiresAt) > now && new Date(c.subscriptionExpiresAt) <= in7d).length,
      mrr, arr: mrr * 12,
      totalUsers, archiveShots: galleryCount, storageGb: usedGb(galleryCount),
      openInquiries, publishedPosts, totalLeads, openTickets,
      pendingReviews: bySub("trial"),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Map a client row to the Clients-table shape.
function mapStudio(c) {
  const plan = (c.plan || "starter").toLowerCase();
  const uploads = c._count?.gallery || 0;
  return {
    id: c.id,
    name: c.studioName || c.name,
    owner: c.name,
    email: c.email,
    phone: c.phone || "",
    domain: c.domain || "",
    initials: (c.studioName || c.name || "?").charAt(0).toUpperCase(),
    joined: day(c.createdAt),
    plan: cap(plan),
    usedGb: Math.round(uploads * 0.09 * 10) / 10,
    capGb: PLAN_CAP[plan] ?? 15,
    uploads,
    status: c.deletedAt ? "Archived" : mapStatus(c.status),
    archived: Boolean(c.deletedAt),
    subActive: isSubscriptionActive(c),
    subExpiresAt: c.subscriptionExpiresAt ? day(c.subscriptionExpiresAt) : null,
    verified: Boolean(c.domain),
    siteStatus: c.siteStatus || "live",
    customDomain: c.customDomain || "",
    domainStatus: c.domainStatus || "none",
    sslStatus: c.sslStatus || "none",
    provisionStatus: c.provisionStatus || "ready",
  };
}
const STUDIO_SELECT = { id: true, name: true, studioName: true, email: true, phone: true, plan: true, status: true, subscriptionStatus: true, subscriptionExpiresAt: true, domain: true, createdAt: true, deletedAt: true, siteStatus: true, customDomain: true, domainStatus: true, sslStatus: true, provisionStatus: true, _count: { select: { gallery: true } } };

// GET /studios — client studios for the table. Supports ?q= ?status= ?plan=
// ?includeArchived=1. Archived (soft-deleted) studios are hidden by default.
router.get("/studios", requirePermission("tenants.view"), async (req, res) => {
  try {
    await ensureConnected();
    const where = {};
    if (req.query.includeArchived !== "1") where.deletedAt = null;
    if (req.query.status) where.status = String(req.query.status).toLowerCase();
    if (req.query.plan) where.plan = String(req.query.plan).toLowerCase();
    if (req.query.q) {
      const q = String(req.query.q);
      where.OR = [
        { studioName: { contains: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
      ];
    }
    const clients = await getPrisma().client.findMany({ where, select: STUDIO_SELECT, orderBy: { createdAt: "desc" } });
    res.json(clients.map(mapStudio));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /studios/export — CSV of studios (PII, permission-gated + audited).
router.get("/studios/export", requirePermission("tenants.view"), async (req, res) => {
  try {
    await ensureConnected();
    const clients = await getPrisma().client.findMany({ where: req.query.includeArchived === "1" ? {} : { deletedAt: null }, select: STUDIO_SELECT, orderBy: { createdAt: "desc" } });
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const header = ["Studio", "Owner", "Email", "Phone", "Plan", "Status", "Domain", "Joined"];
    const lines = [header.join(",")].concat(clients.map(mapStudio).map((s) => [s.name, s.owner, s.email, s.phone, s.plan, s.status, s.domain, s.joined].map(cell).join(",")));
    await logAudit({ req, action: "tenant.export", target: "studios", meta: { count: clients.length } });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=studios.csv");
    res.send(lines.join("\n"));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /studios — create (onboard) a tenant: client + owner user + temp password.
router.post("/studios", requirePermission("tenants.manage"), async (req, res) => {
  try {
    const { studioName, ownerName, email, phone, plan, domain } = req.body || {};
    if (!studioName || !ownerName || !email) return res.status(400).json({ message: "studioName, ownerName and email are required" });
    const emailLc = String(email).toLowerCase().trim();
    await ensureConnected();
    const [clientEx, userEx] = await Promise.all([
      getPrisma().client.findUnique({ where: { email: emailLc } }),
      getPrisma().user.findUnique({ where: { email: emailLc } }),
    ]);
    if (clientEx || userEx) return res.status(409).json({ message: "A studio or user with that email already exists" });
    if (domain) {
      const d = await getPrisma().client.findUnique({ where: { domain: String(domain) } });
      if (d) return res.status(409).json({ message: "That domain is already taken" });
    }
    const tempPassword = "Hoi-" + crypto.randomBytes(4).toString("hex");
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const client = await getPrisma().client.create({
      data: {
        name: ownerName, studioName, email: emailLc, phone: phone || null, domain: domain || null,
        plan: (plan || "starter").toLowerCase(), status: "active",
        users: { create: { name: ownerName, email: emailLc, passwordHash, role: "photographer" } },
      },
      select: { id: true, studioName: true, name: true, email: true, plan: true },
    });
    // NB: tempPassword is returned once for the admin to relay — never audit-logged.
    await logAudit({ req, action: "tenant.create", target: "studio", targetId: client.id, meta: { studioName, email: emailLc, plan: client.plan } });
    res.status(201).json({ ...client, tempPassword });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// GET /studios/:id — consolidated tenant profile.
router.get("/studios/:id", requirePermission("tenants.view"), async (req, res) => {
  try {
    await ensureConnected();
    const c = await getPrisma().client.findUnique({
      where: { id: req.params.id },
      include: {
        users: { select: { id: true, name: true, email: true, role: true, lastLogin: true, createdAt: true } },
        _count: { select: { leads: true, gallery: true, services: true, packages: true, payments: true } },
      },
    });
    if (!c) return res.status(404).json({ message: "Studio not found" });
    const activity = await getPrisma().auditLog.findMany({ where: { targetId: c.id }, orderBy: { createdAt: "desc" }, take: 15 });
    res.json({
      id: c.id, studioName: c.studioName, owner: c.name, email: c.email, phone: c.phone || "",
      domain: c.domain || "", subdomain: c.domain || "", plan: cap((c.plan || "starter").toLowerCase()),
      siteStatus: c.siteStatus || "live", customDomain: c.customDomain || "", domainStatus: c.domainStatus || "none",
      domainToken: c.domainToken || "", sslStatus: c.sslStatus || "none", provisionStatus: c.provisionStatus || "ready",
      status: c.deletedAt ? "Archived" : mapStatus(c.status), archived: Boolean(c.deletedAt),
      subActive: isSubscriptionActive(c), subStatus: c.subscriptionStatus, subExpiresAt: c.subscriptionExpiresAt ? day(c.subscriptionExpiresAt) : null,
      joined: day(c.createdAt),
      counts: c._count,
      users: c.users.map((u) => ({ ...u, lastLogin: u.lastLogin ? day(u.lastLogin) : null, createdAt: day(u.createdAt) })),
      activity: activity.map((a) => ({ action: a.action, actor: a.actorEmail || "system", at: a.createdAt, meta: a.meta })),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /studios/:id — edit business/contact info (not email — that's the login).
router.patch("/studios/:id", requirePermission("tenants.manage"), async (req, res) => {
  try {
    const b = req.body || {};
    const data = {};
    if (typeof b.studioName === "string") data.studioName = b.studioName;
    if (typeof b.ownerName === "string") data.name = b.ownerName;
    if (typeof b.phone === "string") data.phone = b.phone || null;
    if (typeof b.plan === "string") data.plan = b.plan.toLowerCase();
    if (typeof b.domain === "string") data.domain = b.domain || null;
    if (typeof b.accentColor === "string") data.accentColor = b.accentColor;
    if (!Object.keys(data).length) return res.status(400).json({ message: "No updatable fields provided" });
    await ensureConnected();
    const updated = await getPrisma().client.update({ where: { id: req.params.id }, data, select: STUDIO_SELECT });
    await logAudit({ req, action: "tenant.update", target: "studio", targetId: updated.id, meta: { fields: Object.keys(data) } });
    res.json(mapStudio(updated));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Lifecycle transitions — suspend / reactivate / archive / restore.
async function setLifecycle(req, res, { data, action }) {
  try {
    await ensureConnected();
    const updated = await getPrisma().client.update({ where: { id: req.params.id }, data, select: STUDIO_SELECT });
    await logAudit({ req, action, target: "studio", targetId: updated.id });
    res.json(mapStudio(updated));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}
router.post("/studios/:id/suspend", requirePermission("tenants.manage"), (req, res) => setLifecycle(req, res, { data: { status: "suspended" }, action: "tenant.suspend" }));
router.post("/studios/:id/reactivate", requirePermission("tenants.manage"), (req, res) => setLifecycle(req, res, { data: { status: "active" }, action: "tenant.reactivate" }));
router.post("/studios/:id/archive", requirePermission("tenants.manage"), (req, res) => setLifecycle(req, res, { data: { deletedAt: new Date() }, action: "tenant.archive" }));
router.post("/studios/:id/restore", requirePermission("tenants.manage"), (req, res) => setLifecycle(req, res, { data: { deletedAt: null }, action: "tenant.restore" }));

// POST /studios/:id/reset-password — issue a one-time reset token for the owner.
// Returns the token so the admin can relay a reset LINK — never a password.
router.post("/studios/:id/reset-password", requirePermission("tenants.manage"), async (req, res) => {
  try {
    await ensureConnected();
    const client = await getPrisma().client.findUnique({ where: { id: req.params.id }, select: { users: { select: { id: true, email: true }, take: 1 } } });
    const user = client?.users?.[0];
    if (!user) return res.status(404).json({ message: "Studio or owner account not found" });
    const token = crypto.randomBytes(24).toString("hex");
    const resetTokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await getPrisma().user.update({ where: { id: user.id }, data: { resetTokenHash, resetTokenExpiry } });
    await logAudit({ req, action: "tenant.password_reset", target: "studio", targetId: req.params.id, meta: { email: user.email } });
    res.json({ token, email: user.email, expiresAt: resetTokenExpiry });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /payments — all payment records across studios, mapped for Billing.
router.get("/payments", requirePermission("payments.view"), async (_req, res) => {
  try {
    await ensureConnected();
    const payments = await getPrisma().payment.findMany({
      orderBy: { createdAt: "desc" },
      take: 30,
      include: { client: { select: { studioName: true, name: true, email: true } } },
    });
    res.json(payments.map((p) => ({
      id: p.paymentId || `INV-${p.id.slice(0, 8)}`,
      studio: p.company || p.client?.studioName || p.client?.name || "—",
      email: p.client?.email || "",
      created: day(p.createdAt),
      due: p.paymentDate || day(p.createdAt),
      description: p.notes || p.type || "Subscription license",
      method: p.method && p.method !== "Awaiting" ? p.method : null,
      amount: p.amount || 0,
      status: mapPay(p.status),
    })));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /studios/:id/subscription — activate / expire a studio's subscription.
// Body: { active: boolean, days?: number }. When activating, sets the expiry to
// `days` from now (default 30); when expiring, sets it to now.
router.patch("/studios/:id/subscription", requirePermission("subscriptions.manage"), async (req, res) => {
  try {
    await ensureConnected();
    const active = Boolean(req.body?.active);
    const days = Number.isFinite(req.body?.days) ? Number(req.body.days) : 30;
    const expiresAt = active
      ? new Date(Date.now() + days * 24 * 60 * 60 * 1000)
      : new Date();
    const updated = await getPrisma().client.update({
      where: { id: req.params.id },
      data: { subscriptionStatus: active ? "active" : "expired", subscriptionExpiresAt: expiresAt },
      select: { id: true, subscriptionStatus: true, subscriptionExpiresAt: true, plan: true },
    });
    await logAudit({
      req, action: "subscription.update", target: "studio", targetId: updated.id,
      meta: { active, days, status: updated.subscriptionStatus },
    });
    res.json({
      id: updated.id,
      subActive: isSubscriptionActive(updated),
      subStatus: updated.subscriptionStatus,
      subExpiresAt: day(updated.subscriptionExpiresAt),
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// GET /audit — recent audit records (append-only), newest first. Supports
// ?action= and ?q= (matches actor email) filters and ?take= (default 100).
router.get("/audit", requirePermission("audit.view"), async (req, res) => {
  try {
    await ensureConnected();
    const take = Math.min(Number(req.query.take) || 100, 500);
    const where = {};
    if (req.query.action) where.action = String(req.query.action);
    if (req.query.q) where.actorEmail = { contains: String(req.query.q), mode: "insensitive" };
    const rows = await getPrisma().auditLog.findMany({ where, orderBy: { createdAt: "desc" }, take });
    res.json(rows.map((r) => ({
      id: r.id,
      actor: r.actorEmail || "system",
      role: r.actorRole || "",
      action: r.action,
      target: r.target,
      targetId: r.targetId,
      ip: r.ip,
      meta: r.meta,
      at: r.createdAt,
    })));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /impersonate — start a controlled "log in as tenant" session.
// Requires a reason, is time-boxed (30 min), audited, and revocable. Only roles
// holding "tenants.impersonate" (super_admin) may call it.
const IMPERSONATION_MINUTES = 30;
router.post("/impersonate", requirePermission("tenants.impersonate"), async (req, res) => {
  try {
    const { clientId, reason } = req.body || {};
    if (!clientId) return res.status(400).json({ message: "clientId is required" });
    if (!reason || String(reason).trim().length < 3) return res.status(400).json({ message: "A reason (min 3 chars) is required" });
    await ensureConnected();
    const client = await getPrisma().client.findUnique({
      where: { id: clientId },
      select: { id: true, studioName: true, name: true, users: { select: { id: true, email: true, name: true }, take: 1 } },
    });
    if (!client) return res.status(404).json({ message: "Studio not found" });
    const user = client.users[0];
    if (!user) return res.status(400).json({ message: "This studio has no user account to impersonate" });

    const expiresAt = new Date(Date.now() + IMPERSONATION_MINUTES * 60 * 1000);
    const session = await getPrisma().impersonationSession.create({
      data: { adminId: req.admin.adminId, adminEmail: req.admin.email, clientId: client.id, userId: user.id, reason: String(reason).slice(0, 300), expiresAt },
    });
    // A photographer token, marked as impersonation so every action carries the
    // admin identity and the session can be revoked server-side.
    const token = jwt.sign(
      { userId: user.id, clientId: client.id, email: user.email, role: "photographer", impersonatedBy: req.admin.adminId, adminEmail: req.admin.email, sid: session.id },
      process.env.JWT_SECRET,
      { expiresIn: `${IMPERSONATION_MINUTES}m` }
    );
    await logAudit({
      req, action: "impersonation.start", target: "studio", targetId: client.id,
      meta: { reason: String(reason).slice(0, 300), studio: client.studioName || client.name, sessionId: session.id, expiresAt },
    });
    res.json({ token, sessionId: session.id, expiresAt, minutes: IMPERSONATION_MINUTES, studio: client.studioName || client.name, user: { name: user.name, email: user.email } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /impersonate/end — revoke a session from the admin side.
router.post("/impersonate/end", requirePermission("tenants.impersonate"), async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ message: "sessionId is required" });
    await ensureConnected();
    const s = await getPrisma().impersonationSession.update({ where: { id: sessionId }, data: { active: false, endedAt: new Date() } });
    await logAudit({ req, action: "impersonation.end", target: "studio", targetId: s.clientId, meta: { sessionId } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* ── Website provisioning & domain management ── */
const normSub = (s) => String(s || "").toLowerCase().trim().replace(/[^a-z0-9-]/g, "").slice(0, 63);
const cleanDomain = (s) => String(s || "").toLowerCase().trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

// POST /studios/:id/subdomain — assign/change the subdomain (with availability check).
router.post("/studios/:id/subdomain", requirePermission("tenants.manage"), async (req, res) => {
  try {
    const sub = normSub(req.body?.subdomain);
    if (sub.length < 3) return res.status(400).json({ message: "Subdomain must be at least 3 characters (a–z, 0–9, -)" });
    await ensureConnected();
    const taken = await getPrisma().client.findFirst({ where: { domain: sub, NOT: { id: req.params.id } } });
    if (taken) return res.status(409).json({ message: "That subdomain is already taken" });
    const updated = await getPrisma().client.update({ where: { id: req.params.id }, data: { domain: sub, provisionStatus: "ready" }, select: STUDIO_SELECT });
    await logAudit({ req, action: "site.subdomain", target: "studio", targetId: req.params.id, meta: { subdomain: sub } });
    res.json(mapStudio(updated));
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// POST /studios/:id/domain/connect — attach a custom domain; returns DNS instructions.
router.post("/studios/:id/domain/connect", requirePermission("tenants.manage"), async (req, res) => {
  try {
    const domain = cleanDomain(req.body?.customDomain);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return res.status(400).json({ message: "Enter a valid domain like studio.com" });
    await ensureConnected();
    const dup = await getPrisma().client.findFirst({ where: { customDomain: domain, NOT: { id: req.params.id } } });
    if (dup) return res.status(409).json({ message: "That domain is already connected to another studio" });
    const cur = await getPrisma().client.findUnique({ where: { id: req.params.id }, select: { customDomain: true, domainToken: true } });
    const token = cur?.customDomain === domain && cur?.domainToken ? cur.domainToken : "hoi-verify-" + crypto.randomBytes(8).toString("hex"); // idempotent
    await getPrisma().client.update({ where: { id: req.params.id }, data: { customDomain: domain, domainToken: token, domainStatus: "pending", sslStatus: "pending" } });
    await logAudit({ req, action: "domain.connect", target: "studio", targetId: req.params.id, meta: { domain } });
    res.json({ customDomain: domain, domainStatus: "pending", sslStatus: "pending", dns: { type: "TXT", host: `_hoi-verify.${domain}`, value: token }, cname: { type: "CNAME", host: domain, value: "sites.highoninnovation.in" } });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// POST /studios/:id/domain/verify — real DNS TXT check; issues SSL on success.
router.post("/studios/:id/domain/verify", requirePermission("tenants.manage"), async (req, res) => {
  try {
    await ensureConnected();
    const c = await getPrisma().client.findUnique({ where: { id: req.params.id }, select: { customDomain: true, domainToken: true } });
    if (!c?.customDomain || !c?.domainToken) return res.status(400).json({ message: "Connect a domain first" });
    let verified = false, detail = "";
    try {
      const records = (await dns.resolveTxt(`_hoi-verify.${c.customDomain}`)).flat().map(String);
      verified = records.includes(c.domainToken);
      detail = verified ? "Verified." : "A TXT record was found but the token didn't match yet.";
    } catch { detail = "DNS TXT record not found yet — add it and allow time to propagate."; }
    // NB: on success the platform's ACME layer issues the certificate; modelled here as sslStatus:"issued".
    const data = verified ? { domainStatus: "verified", sslStatus: "issued" } : { domainStatus: "pending" };
    await getPrisma().client.update({ where: { id: req.params.id }, data });
    await logAudit({ req, action: "domain.verify", target: "studio", targetId: req.params.id, meta: { domain: c.customDomain, verified } });
    res.json({ verified, detail, ...data });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /studios/:id/domain/disconnect — remove the custom domain.
router.post("/studios/:id/domain/disconnect", requirePermission("tenants.manage"), async (req, res) => {
  try {
    await ensureConnected();
    await getPrisma().client.update({ where: { id: req.params.id }, data: { customDomain: null, domainToken: null, domainStatus: "none", sslStatus: "none" } });
    await logAudit({ req, action: "domain.disconnect", target: "studio", targetId: req.params.id });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// Per-website online/offline (independent of the account status).
router.post("/studios/:id/site/offline", requirePermission("tenants.manage"), (req, res) => setLifecycle(req, res, { data: { siteStatus: "offline" }, action: "site.offline" }));
router.post("/studios/:id/site/online", requirePermission("tenants.manage"), (req, res) => setLifecycle(req, res, { data: { siteStatus: "live" }, action: "site.online" }));

// POST /studios/:id/provision/retry — idempotent recompute of provisioning state.
router.post("/studios/:id/provision/retry", requirePermission("tenants.manage"), async (req, res) => {
  try {
    await ensureConnected();
    const c = await getPrisma().client.findUnique({ where: { id: req.params.id }, select: { domain: true, _count: { select: { users: true } } } });
    if (!c) return res.status(404).json({ message: "Studio not found" });
    const ready = Boolean(c.domain) && c._count.users > 0;
    const updated = await getPrisma().client.update({ where: { id: req.params.id }, data: { provisionStatus: ready ? "ready" : "pending" }, select: STUDIO_SELECT });
    await logAudit({ req, action: "provision.retry", target: "studio", targetId: req.params.id, meta: { status: ready ? "ready" : "pending" } });
    res.json(mapStudio(updated));
  } catch (err) { res.status(400).json({ message: err.message }); }
});

/* ── Inquiries (marketing-site leads) ── */
router.get("/inquiries", requirePermission("inquiries.view"), async (req, res) => {
  try {
    await ensureConnected();
    const where = {};
    if (req.query.type) where.type = String(req.query.type);
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.q) where.OR = [{ name: { contains: String(req.query.q), mode: "insensitive" } }, { email: { contains: String(req.query.q), mode: "insensitive" } }];
    res.json(await getPrisma().marketingLead.findMany({ where, orderBy: { createdAt: "desc" }, take: 300 }));
  } catch (err) { res.status(500).json({ message: err.message }); }
});
router.get("/inquiries/export", requirePermission("inquiries.view"), async (req, res) => {
  try {
    await ensureConnected();
    const rows = await getPrisma().marketingLead.findMany({ orderBy: { createdAt: "desc" }, take: 5000 });
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const header = ["Type", "Name", "Email", "Phone", "Topic", "Plan", "Status", "Consent", "Created", "Message"];
    const lines = [header.join(",")].concat(rows.map((r) => [r.type, r.name, r.email, r.phone, r.topic, r.plan, r.status, r.consent ? "yes" : "no", day(r.createdAt), r.message].map(cell).join(",")));
    await logAudit({ req, action: "inquiry.export", target: "inquiries", meta: { count: rows.length } });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=inquiries.csv");
    res.send(lines.join("\n"));
  } catch (err) { res.status(500).json({ message: err.message }); }
});
router.patch("/inquiries/:id", requirePermission("inquiries.manage"), async (req, res) => {
  try {
    const data = {};
    if (typeof req.body?.status === "string") data.status = req.body.status;
    if (!Object.keys(data).length) return res.status(400).json({ message: "No updatable fields" });
    await ensureConnected();
    const updated = await getPrisma().marketingLead.update({ where: { id: req.params.id }, data });
    await logAudit({ req, action: "inquiry.update", target: "inquiry", targetId: updated.id, meta: { status: updated.status } });
    res.json(updated);
  } catch (err) { res.status(400).json({ message: err.message }); }
});

/* ── Support tickets ── */
const SLA_HOURS = { urgent: 4, high: 8, normal: 24, low: 72 };
const slaBreached = (t) => t.dueAt && !["resolved", "closed"].includes(t.status) && new Date(t.dueAt) < new Date();
async function notify({ type = "info", title, body = "", link = "" }) {
  try { await getPrisma().notification.create({ data: { type, title, body, link } }); } catch { /* best-effort */ }
}

router.get("/tickets", requirePermission("support.view"), async (req, res) => {
  try {
    await ensureConnected();
    const where = {};
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.priority) where.priority = String(req.query.priority);
    if (req.query.category) where.category = String(req.query.category);
    if (req.query.q) where.OR = [{ subject: { contains: String(req.query.q), mode: "insensitive" } }, { requesterEmail: { contains: String(req.query.q), mode: "insensitive" } }];
    const tickets = await getPrisma().ticket.findMany({ where, orderBy: [{ status: "asc" }, { createdAt: "desc" }], take: 200, include: { _count: { select: { messages: true } } } });
    res.json(tickets.map((t) => ({ ...t, messages: undefined, messageCount: t._count.messages, breached: slaBreached(t) })));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post("/tickets", requirePermission("support.manage"), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.subject) return res.status(400).json({ message: "Subject is required" });
    const priority = ["low", "normal", "high", "urgent"].includes(b.priority) ? b.priority : "normal";
    const dueAt = new Date(Date.now() + (SLA_HOURS[priority] || 24) * 3600000);
    await ensureConnected();
    const ticket = await getPrisma().ticket.create({
      data: {
        subject: String(b.subject).slice(0, 200), category: b.category || "general", priority, status: "open",
        requesterName: String(b.requesterName || "").slice(0, 120), requesterEmail: String(b.requesterEmail || "").slice(0, 160),
        clientId: b.clientId || null, assignedTo: b.assignedTo || "", dueAt,
        messages: b.message ? { create: { authorType: "customer", authorName: b.requesterName || "Customer", body: String(b.message).slice(0, 5000), internal: false } } : undefined,
      },
    });
    await logAudit({ req, action: "ticket.create", target: "ticket", targetId: ticket.id, meta: { subject: ticket.subject, priority } });
    await notify({ type: "warning", title: `New ${priority} ticket`, body: ticket.subject, link: "/support" });
    res.status(201).json(ticket);
  } catch (err) { res.status(400).json({ message: err.message }); }
});

router.get("/tickets/:id", requirePermission("support.view"), async (req, res) => {
  try {
    await ensureConnected();
    const t = await getPrisma().ticket.findUnique({ where: { id: req.params.id }, include: { messages: { orderBy: { createdAt: "asc" } } } });
    if (!t) return res.status(404).json({ message: "Ticket not found" });
    let context = null;
    if (t.clientId) {
      const c = await getPrisma().client.findUnique({ where: { id: t.clientId }, select: { studioName: true, name: true, email: true, plan: true, status: true, subscriptionStatus: true } });
      if (c) context = c;
    }
    res.json({ ...t, breached: slaBreached(t), context });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post("/tickets/:id/messages", requirePermission("support.manage"), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.body) return res.status(400).json({ message: "Message body is required" });
    await ensureConnected();
    const msg = await getPrisma().ticketMessage.create({
      data: { ticketId: req.params.id, authorType: "admin", authorName: req.admin.email, body: String(b.body).slice(0, 5000), internal: Boolean(b.internal) },
    });
    await getPrisma().ticket.update({ where: { id: req.params.id }, data: { updatedAt: new Date(), status: b.setStatus || undefined } });
    await logAudit({ req, action: b.internal ? "ticket.note" : "ticket.reply", target: "ticket", targetId: req.params.id });
    res.status(201).json(msg);
  } catch (err) { res.status(400).json({ message: err.message }); }
});

router.patch("/tickets/:id", requirePermission("support.manage"), async (req, res) => {
  try {
    const b = req.body || {};
    const data = {};
    if (typeof b.status === "string") data.status = b.status;
    if (typeof b.priority === "string") { data.priority = b.priority; data.dueAt = new Date(Date.now() + (SLA_HOURS[b.priority] || 24) * 3600000); }
    if (typeof b.assignedTo === "string") data.assignedTo = b.assignedTo;
    if (typeof b.category === "string") data.category = b.category;
    if (!Object.keys(data).length) return res.status(400).json({ message: "No updatable fields" });
    await ensureConnected();
    const t = await getPrisma().ticket.update({ where: { id: req.params.id }, data });
    await logAudit({ req, action: "ticket.update", target: "ticket", targetId: t.id, meta: { fields: Object.keys(data) } });
    res.json({ ...t, breached: slaBreached(t) });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

/* ── Notifications (in-app) ── */
router.get("/notifications", requirePermission("dashboard.view"), async (_req, res) => {
  try {
    await ensureConnected();
    const [items, unread] = await Promise.all([
      getPrisma().notification.findMany({ orderBy: { createdAt: "desc" }, take: 20 }),
      getPrisma().notification.count({ where: { read: false } }),
    ]);
    res.json({ items, unread });
  } catch (err) { res.status(500).json({ message: err.message }); }
});
router.post("/notifications/read", requirePermission("dashboard.view"), async (_req, res) => {
  try { await ensureConnected(); await getPrisma().notification.updateMany({ where: { read: false }, data: { read: true } }); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ message: err.message }); }
});

/* ── Marketing blog / resources (CMS authoring) ── */
const BLOG_FIELDS = ["title", "slug", "excerpt", "body", "category", "tags", "author", "coverImage", "status", "publishAt", "seoTitle", "seoDescription"];
function pickPost(b) {
  const d = {};
  for (const k of BLOG_FIELDS) if (b[k] !== undefined) d[k] = b[k];
  if (d.slug) d.slug = String(d.slug).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (d.publishAt) d.publishAt = new Date(d.publishAt);
  if (d.tags !== undefined && !Array.isArray(d.tags)) d.tags = String(d.tags).split(",").map((t) => t.trim()).filter(Boolean);
  return d;
}
router.get("/blog", requirePermission("cms.view"), async (req, res) => {
  try { await ensureConnected(); res.json(await getPrisma().marketingPost.findMany({ orderBy: { createdAt: "desc" } })); }
  catch (err) { res.status(500).json({ message: err.message }); }
});
router.post("/blog", requirePermission("cms.manage"), async (req, res) => {
  try {
    const d = pickPost(req.body || {});
    if (!d.title) return res.status(400).json({ message: "Title is required" });
    if (!d.slug) d.slug = d.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
    await ensureConnected();
    const post = await getPrisma().marketingPost.create({ data: d });
    await logAudit({ req, action: "blog.create", target: "post", targetId: post.id, meta: { slug: post.slug } });
    res.status(201).json(post);
  } catch (err) { res.status(400).json({ message: err.code === "P2002" ? "That slug is already in use" : err.message }); }
});
router.patch("/blog/:id", requirePermission("cms.manage"), async (req, res) => {
  try {
    const d = pickPost(req.body || {});
    delete d.slug;
    await ensureConnected();
    const post = await getPrisma().marketingPost.update({ where: { id: req.params.id }, data: d });
    await logAudit({ req, action: "blog.update", target: "post", targetId: post.id, meta: { fields: Object.keys(d) } });
    res.json(post);
  } catch (err) { res.status(400).json({ message: err.message }); }
});
router.delete("/blog/:id", requirePermission("cms.manage"), async (req, res) => {
  try {
    await ensureConnected();
    await getPrisma().marketingPost.delete({ where: { id: req.params.id } });
    await logAudit({ req, action: "blog.delete", target: "post", targetId: req.params.id });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

/* ── Plans (platform subscription tiers, single source of truth) ── */
const PLAN_FIELDS = ["name", "slug", "audience", "blurb", "monthlyPrice", "annualPrice", "currency", "features", "storageGb", "aiCredits", "leadCredits", "seats", "websites", "badge", "highlighted", "order", "active"];
function pickPlan(body) {
  const d = {};
  for (const k of PLAN_FIELDS) if (body[k] !== undefined) d[k] = body[k];
  ["monthlyPrice", "annualPrice"].forEach((k) => { if (d[k] !== undefined) d[k] = Number(d[k]) || 0; });
  ["storageGb", "aiCredits", "leadCredits", "seats", "websites", "order"].forEach((k) => { if (d[k] !== undefined) d[k] = Math.round(Number(d[k]) || 0); });
  return d;
}

router.get("/plans", requirePermission("subscriptions.view"), async (req, res) => {
  try {
    await ensureConnected();
    const where = req.query.includeArchived === "1" ? {} : { archived: false };
    res.json(await getPrisma().plan.findMany({ where, orderBy: { order: "asc" } }));
  } catch (err) { res.status(500).json({ message: err.message }); }
});
router.post("/plans", requirePermission("subscriptions.manage"), async (req, res) => {
  try {
    const d = pickPlan(req.body || {});
    if (!d.name || !d.slug) return res.status(400).json({ message: "name and slug are required" });
    d.slug = String(d.slug).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    await ensureConnected();
    const plan = await getPrisma().plan.create({ data: d });
    await logAudit({ req, action: "plan.create", target: "plan", targetId: plan.id, meta: { slug: plan.slug } });
    res.status(201).json(plan);
  } catch (err) { res.status(400).json({ message: err.code === "P2002" ? "That slug is already in use" : err.message }); }
});
router.patch("/plans/:id", requirePermission("subscriptions.manage"), async (req, res) => {
  try {
    const d = pickPlan(req.body || {});
    delete d.slug; // slug is referenced by tenants — immutable after create
    await ensureConnected();
    const plan = await getPrisma().plan.update({ where: { id: req.params.id }, data: d });
    await logAudit({ req, action: "plan.update", target: "plan", targetId: plan.id, meta: { fields: Object.keys(d) } });
    res.json(plan);
  } catch (err) { res.status(400).json({ message: err.message }); }
});
router.post("/plans/:id/clone", requirePermission("subscriptions.manage"), async (req, res) => {
  try {
    await ensureConnected();
    const src = await getPrisma().plan.findUnique({ where: { id: req.params.id } });
    if (!src) return res.status(404).json({ message: "Plan not found" });
    const { id, createdAt, updatedAt, ...rest } = src;
    let slug = `${src.slug}-copy`, n = 1;
    while (await getPrisma().plan.findUnique({ where: { slug } })) { n++; slug = `${src.slug}-copy${n}`; }
    const plan = await getPrisma().plan.create({ data: { ...rest, name: `${src.name} (copy)`, slug, highlighted: false } });
    await logAudit({ req, action: "plan.clone", target: "plan", targetId: plan.id, meta: { from: src.slug } });
    res.status(201).json(plan);
  } catch (err) { res.status(400).json({ message: err.message }); }
});
router.post("/plans/:id/archive", requirePermission("subscriptions.manage"), async (req, res) => {
  try { await ensureConnected(); const plan = await getPrisma().plan.update({ where: { id: req.params.id }, data: { archived: true, active: false } }); await logAudit({ req, action: "plan.archive", target: "plan", targetId: plan.id }); res.json(plan); }
  catch (err) { res.status(400).json({ message: err.message }); }
});
router.post("/plans/:id/restore", requirePermission("subscriptions.manage"), async (req, res) => {
  try { await ensureConnected(); const plan = await getPrisma().plan.update({ where: { id: req.params.id }, data: { archived: false, active: true } }); await logAudit({ req, action: "plan.restore", target: "plan", targetId: plan.id }); res.json(plan); }
  catch (err) { res.status(400).json({ message: err.message }); }
});

/* ── Subscription lifecycle (per tenant) ── */
// POST /studios/:id/subscription/set — assign / upgrade / downgrade / start trial.
// A downgrade is rejected when current usage exceeds the target plan's limits.
router.post("/studios/:id/subscription/set", requirePermission("subscriptions.manage"), async (req, res) => {
  try {
    const { planSlug, cycle = "monthly", trialDays = 0 } = req.body || {};
    if (!planSlug) return res.status(400).json({ message: "planSlug is required" });
    await ensureConnected();
    const plan = await getPrisma().plan.findUnique({ where: { slug: String(planSlug).toLowerCase() } });
    if (!plan || plan.archived) return res.status(404).json({ message: "Plan not found or archived" });
    const client = await getPrisma().client.findUnique({ where: { id: req.params.id }, select: { id: true, plan: true, domain: true, _count: { select: { users: true, gallery: true } } } });
    if (!client) return res.status(404).json({ message: "Studio not found" });

    const usage = { seats: client._count.users, websites: client.domain ? 1 : 0, usedGb: usedGb(client._count.gallery) };
    const prevPlan = client.plan ? await getPrisma().plan.findUnique({ where: { slug: String(client.plan).toLowerCase() } }) : null;
    const isDowngrade = prevPlan && plan.monthlyPrice < prevPlan.monthlyPrice;
    if (isDowngrade) { const fit = fitsPlan(plan, usage); if (!fit.ok) return res.status(409).json({ message: `Downgrade rejected — ${fit.reason}.` }); }

    const trial = Number(trialDays) > 0;
    const billingCycle = cycle === "annual" ? "annual" : "monthly";
    const expiresAt = trial ? new Date(Date.now() + Number(trialDays) * 86400000) : periodEnd(billingCycle);
    await getPrisma().client.update({ where: { id: client.id }, data: { plan: plan.slug, billingCycle, subscriptionStatus: trial ? "trial" : "active", subscriptionExpiresAt: expiresAt, trialEndsAt: trial ? expiresAt : null } });
    const type = trial ? "trial_started" : prevPlan ? (isDowngrade ? "downgraded" : "upgraded") : "created";
    await getPrisma().subscriptionEvent.create({ data: { clientId: client.id, type, fromPlan: client.plan || "", toPlan: plan.slug, cycle: billingCycle, actorEmail: req.admin.email, meta: { trialDays: trial ? Number(trialDays) : 0 } } });
    await logAudit({ req, action: `subscription.${type}`, target: "studio", targetId: client.id, meta: { plan: plan.slug, cycle: billingCycle } });
    res.json({ ok: true, plan: plan.slug, status: trial ? "trial" : "active", expiresAt });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// POST /studios/:id/subscription/renew — extend the current period by one cycle.
router.post("/studios/:id/subscription/renew", requirePermission("subscriptions.manage"), async (req, res) => {
  try {
    await ensureConnected();
    const client = await getPrisma().client.findUnique({ where: { id: req.params.id }, select: { id: true, billingCycle: true, subscriptionExpiresAt: true, plan: true } });
    if (!client) return res.status(404).json({ message: "Studio not found" });
    const c = req.body?.cycle || client.billingCycle || "monthly";
    const base = client.subscriptionExpiresAt && new Date(client.subscriptionExpiresAt) > new Date() ? new Date(client.subscriptionExpiresAt).getTime() : Date.now();
    const expiresAt = periodEnd(c === "annual" ? "annual" : "monthly", base);
    await getPrisma().client.update({ where: { id: client.id }, data: { subscriptionStatus: "active", subscriptionExpiresAt: expiresAt, billingCycle: c === "annual" ? "annual" : "monthly", trialEndsAt: null } });
    await getPrisma().subscriptionEvent.create({ data: { clientId: client.id, type: "renewed", toPlan: client.plan || "", cycle: c, actorEmail: req.admin.email } });
    await logAudit({ req, action: "subscription.renewed", target: "studio", targetId: client.id, meta: { cycle: c } });
    res.json({ ok: true, expiresAt });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// GET /studios/:id/subscription/history — immutable change log.
router.get("/studios/:id/subscription/history", requirePermission("subscriptions.view"), async (req, res) => {
  try { await ensureConnected(); res.json(await getPrisma().subscriptionEvent.findMany({ where: { clientId: req.params.id }, orderBy: { createdAt: "desc" }, take: 50 })); }
  catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /subscriptions/sweep — run the expiry workflow now (also runs hourly).
router.post("/subscriptions/sweep", requirePermission("subscriptions.manage"), async (req, res) => {
  try { const r = await sweepSubscriptions(); await logAudit({ req, action: "subscription.sweep", target: "platform", meta: r }); res.json(r); }
  catch (err) { res.status(500).json({ message: err.message }); }
});

/* ── Reports & analytics ── */
function parseRange(req) {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 30 * 86400000);
  return { from, to };
}
async function buildReport(req) {
  await ensureConnected();
  const prisma = getPrisma();
  const { from, to } = parseRange(req);
  const live = await prisma.client.findMany({ where: { deletedAt: null }, select: { plan: true, status: true, subscriptionStatus: true, createdAt: true } });
  const plans = await prisma.plan.findMany({ select: { slug: true, name: true, monthlyPrice: true } });
  const priceOf = Object.fromEntries(plans.map((p) => [p.slug, p.monthlyPrice]));
  const nameOf = Object.fromEntries(plans.map((p) => [p.slug, p.name]));
  // revenue by plan (currently-subscribed)
  const revenueByPlan = {};
  for (const c of live) {
    if (!["active", "trial"].includes((c.subscriptionStatus || "active").toLowerCase())) continue;
    const slug = (c.plan || "").toLowerCase();
    revenueByPlan[slug] = revenueByPlan[slug] || { plan: nameOf[slug] || slug || "—", count: 0, mrr: 0 };
    revenueByPlan[slug].count++;
    revenueByPlan[slug].mrr += priceOf[slug] || 0;
  }
  const subscriptions = { active: 0, trial: 0, expired: 0 };
  live.forEach((c) => { const s = (c.subscriptionStatus || "active").toLowerCase(); if (subscriptions[s] !== undefined) subscriptions[s]++; });
  const tenantsByStatus = { active: 0, suspended: 0, trial: 0 };
  live.forEach((c) => { const s = (c.status || "active").toLowerCase(); if (tenantsByStatus[s] !== undefined) tenantsByStatus[s]++; });
  const [newSignups, inquiriesInRange] = await Promise.all([
    prisma.client.count({ where: { deletedAt: null, createdAt: { gte: from, lte: to } } }),
    prisma.marketingLead.groupBy({ by: ["type"], where: { createdAt: { gte: from, lte: to } }, _count: true }),
  ]);
  const mrr = Object.values(revenueByPlan).reduce((a, r) => a + r.mrr, 0);
  return {
    range: { from, to },
    mrr, arr: mrr * 12,
    revenueByPlan: Object.values(revenueByPlan),
    subscriptions, tenantsByStatus,
    newSignups,
    inquiriesByType: inquiriesInRange.map((i) => ({ type: i.type, count: i._count })),
  };
}
router.get("/reports", requirePermission("reports.view"), async (req, res) => {
  try { res.json(await buildReport(req)); } catch (err) { res.status(500).json({ message: err.message }); }
});
router.get("/reports/export", requirePermission("reports.view"), async (req, res) => {
  try {
    const r = await buildReport(req);
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = ["Metric,Value"];
    lines.push(["MRR", r.mrr].map(cell).join(","), ["ARR", r.arr].map(cell).join(","), ["New signups (range)", r.newSignups].map(cell).join(","));
    lines.push(["Subscriptions active", r.subscriptions.active].map(cell).join(","), ["Subscriptions trial", r.subscriptions.trial].map(cell).join(","), ["Subscriptions expired", r.subscriptions.expired].map(cell).join(","));
    r.revenueByPlan.forEach((p) => lines.push([`Plan ${p.plan} (count)`, p.count].map(cell).join(","), [`Plan ${p.plan} (MRR)`, p.mrr].map(cell).join(",")));
    r.inquiriesByType.forEach((i) => lines.push([`Inquiries ${i.type}`, i.count].map(cell).join(",")));
    await logAudit({ req, action: "report.export", target: "reports", meta: { range: r.range } });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=report.csv");
    res.send(lines.join("\n"));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ── Admin user management (super_admin only) ── */
const ADMIN_SELECT = { id: true, name: true, email: true, role: true, active: true, mfaEnabled: true, lastLogin: true, createdAt: true };
router.get("/admins", requirePermission("admins.manage"), async (_req, res) => {
  try {
    await ensureConnected();
    const admins = await getPrisma().adminUser.findMany({ orderBy: { createdAt: "desc" }, select: ADMIN_SELECT });
    const roleMap = await getRoleMap();
    res.json({ admins, roles: Object.values(roleMap).map(({ key, label, isSystem }) => ({ key, label, isSystem })) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});
router.post("/admins", requirePermission("admins.manage"), async (req, res) => {
  try {
    const { name, email, role } = req.body || {};
    if (!name || !email) return res.status(400).json({ message: "Name and email are required" });
    if (!(await getRoleMap())[role]) return res.status(400).json({ message: "Invalid role" });
    const emailLc = String(email).toLowerCase().trim();
    await ensureConnected();
    if (await getPrisma().adminUser.findUnique({ where: { email: emailLc } })) return res.status(409).json({ message: "An admin with that email already exists" });
    const tempPassword = "Hoi-" + crypto.randomBytes(4).toString("hex");
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const admin = await getPrisma().adminUser.create({ data: { name, email: emailLc, passwordHash, role, active: true }, select: ADMIN_SELECT });
    await logAudit({ req, action: "admin.create", target: "admin", targetId: admin.id, meta: { email: emailLc, role } });
    res.status(201).json({ ...admin, tempPassword });
  } catch (err) { res.status(400).json({ message: err.message }); }
});
router.patch("/admins/:id", requirePermission("admins.manage"), async (req, res) => {
  try {
    const b = req.body || {};
    // Guard: you can't demote or deactivate your own account (avoid self-lockout).
    if (req.params.id === req.admin.adminId && (b.active === false || (b.role && b.role !== "super_admin"))) {
      return res.status(400).json({ message: "You can't change your own role or deactivate yourself." });
    }
    const data = {};
    if (b.role && (await getRoleMap())[b.role]) data.role = b.role;
    if (typeof b.active === "boolean") data.active = b.active;
    if (!Object.keys(data).length) return res.status(400).json({ message: "No updatable fields" });
    await ensureConnected();
    const updated = await getPrisma().adminUser.update({ where: { id: req.params.id }, data, select: ADMIN_SELECT });
    await logAudit({ req, action: "admin.update", target: "admin", targetId: updated.id, meta: { fields: Object.keys(data) } });
    res.json(updated);
  } catch (err) { res.status(400).json({ message: err.message }); }
});
router.delete("/admins/:id", requirePermission("admins.manage"), async (req, res) => {
  try {
    if (req.params.id === req.admin.adminId) return res.status(400).json({ message: "You can't delete your own account." });
    await ensureConnected();
    await getPrisma().adminUser.delete({ where: { id: req.params.id } });
    await logAudit({ req, action: "admin.delete", target: "admin", targetId: req.params.id });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

/* ── Custom role builder (super_admin only, via admins.manage) ── */
const keyify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
// Keep only known, assignable permission keys — never let a custom role hold "*" or admins.manage.
const cleanPerms = (arr) => Array.from(new Set((Array.isArray(arr) ? arr : []).filter((p) => ASSIGNABLE_PERMISSIONS.includes(p))));

router.get("/roles", requirePermission("admins.manage"), async (_req, res) => {
  try {
    const roleMap = await getRoleMap();
    res.json({ roles: Object.values(roleMap), catalog: PERMISSION_CATALOG });
  } catch (err) { res.status(500).json({ message: err.message }); }
});
router.post("/roles", requirePermission("admins.manage"), async (req, res) => {
  try {
    const { label, permissions } = req.body || {};
    if (!label || !String(label).trim()) return res.status(400).json({ message: "A role name is required" });
    const key = keyify(label);
    if (!key) return res.status(400).json({ message: "Role name must contain letters or numbers" });
    if (SYSTEM_ROLES[key] || (await getRoleMap())[key]) return res.status(409).json({ message: "A role with that name already exists" });
    await ensureConnected();
    const role = await getPrisma().adminRole.create({ data: { key, label: String(label).trim(), permissions: cleanPerms(permissions) } });
    invalidateRoles();
    await logAudit({ req, action: "role.create", target: "role", targetId: key, meta: { permissions: role.permissions } });
    res.status(201).json({ key: role.key, label: role.label, permissions: role.permissions, isSystem: false });
  } catch (err) { res.status(400).json({ message: err.message }); }
});
router.patch("/roles/:key", requirePermission("admins.manage"), async (req, res) => {
  try {
    if (SYSTEM_ROLES[req.params.key]) return res.status(400).json({ message: "System roles can't be edited." });
    const b = req.body || {};
    const data = {};
    if (typeof b.label === "string" && b.label.trim()) data.label = b.label.trim();
    if (b.permissions !== undefined) data.permissions = cleanPerms(b.permissions);
    if (!Object.keys(data).length) return res.status(400).json({ message: "No updatable fields" });
    await ensureConnected();
    const role = await getPrisma().adminRole.update({ where: { key: req.params.key }, data });
    invalidateRoles();
    await logAudit({ req, action: "role.update", target: "role", targetId: role.key, meta: { fields: Object.keys(data), permissions: role.permissions } });
    res.json({ key: role.key, label: role.label, permissions: role.permissions, isSystem: false });
  } catch (err) { res.status(400).json({ message: err.message }); }
});
router.delete("/roles/:key", requirePermission("admins.manage"), async (req, res) => {
  try {
    if (SYSTEM_ROLES[req.params.key]) return res.status(400).json({ message: "System roles can't be deleted." });
    await ensureConnected();
    const inUse = await getPrisma().adminUser.count({ where: { role: req.params.key } });
    if (inUse > 0) return res.status(409).json({ message: `${inUse} admin${inUse > 1 ? "s are" : " is"} assigned this role. Reassign them first.` });
    await getPrisma().adminRole.delete({ where: { key: req.params.key } });
    invalidateRoles();
    await logAudit({ req, action: "role.delete", target: "role", targetId: req.params.key });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

/* ── Lead-Hunt platform admin (source config, default keywords, analytics) ── */
router.get("/leadhunt", requirePermission("leadhunt.view"), async (_req, res) => {
  try {
    await ensureConnected();
    const prisma = getPrisma();
    const settings = await getSettings();
    const sources = SOURCE_CATALOG.map((s) => ({ ...s, enabled: s.huntable ? isSourceEnabled(settings, s.key) : false }));

    // Platform-wide aggregates across every tenant (rejected leads excluded).
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const [totalLeads, todayLeads, totalRuns, bySourceRaw, byTenantRaw, recentRuns] = await Promise.all([
      prisma.hoiLead.count({ where: { rejected: false } }),
      prisma.hoiLead.count({ where: { rejected: false, capturedAt: { gte: startOfDay } } }),
      prisma.hunterRun.count(),
      prisma.hoiLead.groupBy({ by: ["source"], where: { rejected: false }, _count: { _all: true } }),
      prisma.hoiLead.groupBy({ by: ["clientId"], where: { rejected: false }, _count: { _all: true } }),
      prisma.hunterRun.findMany({ orderBy: { startedAt: "desc" }, take: 10 }),
    ]);
    const bySource = Object.fromEntries(bySourceRaw.map((r) => [r.source, r._count._all]));

    // Resolve top tenants to studio names.
    const topRaw = [...byTenantRaw].sort((a, b) => b._count._all - a._count._all).slice(0, 8);
    const clientMap = Object.fromEntries(
      (await prisma.client.findMany({ where: { id: { in: topRaw.map((t) => t.clientId) } }, select: { id: true, studioName: true, email: true } }))
        .map((c) => [c.id, c])
    );
    const topTenants = topRaw.map((t) => ({ clientId: t.clientId, studio: clientMap[t.clientId]?.studioName || clientMap[t.clientId]?.email || "—", leads: t._count._all }));

    // Attach studio name to recent runs.
    const runClientIds = [...new Set(recentRuns.map((r) => r.clientId))];
    const runClientMap = Object.fromEntries(
      (await prisma.client.findMany({ where: { id: { in: runClientIds } }, select: { id: true, studioName: true } })).map((c) => [c.id, c.studioName])
    );
    const runs = recentRuns.map((r) => ({ id: r.id, studio: runClientMap[r.clientId] || "—", status: r.status, sources: r.sources, totalCaptured: r.totalCaptured, startedAt: r.startedAt, finishedAt: r.finishedAt }));

    res.json({
      sources,
      defaultKeywords: settings.leadHunt?.defaultKeywords || [],
      leadHuntEnabled: settings.flags?.leadHunt !== false,
      stats: { totalLeads, todayLeads, totalRuns, bySource, topTenants, runs },
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});
router.put("/leadhunt", requirePermission("leadhunt.manage"), async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    const cur = (await getSettings()).leadHunt || {};
    const next = { ...cur };
    if (b.sources && typeof b.sources === "object") {
      // Merge: only keys actually sent are updated. Non-huntable keys are never
      // stored (they can't be enabled), and unknown keys are ignored.
      const map = { ...(cur.sources || {}) };
      for (const s of SOURCE_CATALOG) {
        if (!s.huntable) { delete map[s.key]; continue; }
        if (s.key in b.sources) map[s.key] = b.sources[s.key] !== false;
      }
      next.sources = map;
    }
    if (Array.isArray(b.defaultKeywords)) {
      next.defaultKeywords = b.defaultKeywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 50);
    }
    patch.leadHunt = next;
    const { before, after } = await saveSettings(patch);
    await logAudit({ req, action: "leadhunt.update", target: "platform", meta: { before: before.leadHunt, after: after.leadHunt } });
    const settings = after;
    res.json({ sources: SOURCE_CATALOG.map((s) => ({ ...s, enabled: s.huntable ? isSourceEnabled(settings, s.key) : false })), defaultKeywords: settings.leadHunt?.defaultKeywords || [] });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

/* ── Platform settings (maintenance mode, feature flags) ── */
router.get("/settings", requirePermission("settings.view"), async (_req, res) => {
  try { res.json(redactSettings(await getSettings())); } catch (err) { res.status(500).json({ message: err.message }); }
});
router.put("/settings", requirePermission("settings.manage"), async (req, res) => {
  try {
    const patch = {};
    const b = req.body || {};
    const cur = await getSettings();
    if (typeof b.maintenanceMode === "boolean") patch.maintenanceMode = b.maintenanceMode;
    if (typeof b.maintenanceMessage === "string") patch.maintenanceMessage = b.maintenanceMessage.slice(0, 300);
    if (b.flags && typeof b.flags === "object") patch.flags = b.flags;
    if (b.smtp && typeof b.smtp === "object") patch.smtp = { ...cur.smtp, ...b.smtp };
    if (typeof b.smtpPassword === "string" && b.smtpPassword.trim()) patch.smtpPassEnc = encrypt(b.smtpPassword.trim());
    if (b.storage && typeof b.storage === "object") patch.storage = { ...cur.storage, ...b.storage };
    if (typeof b.storageKey === "string" && b.storageKey.trim()) patch.storageKeyEnc = encrypt(b.storageKey.trim());
    if (!Object.keys(patch).length) return res.status(400).json({ message: "No settings provided" });
    const { before, after } = await saveSettings(patch);
    await logAudit({ req, action: "settings.update", target: "platform", meta: { before: redactSettings(before), after: redactSettings(after) } });
    res.json(redactSettings(after));
  } catch (err) { res.status(400).json({ message: err.message }); }
});

/* ── AI platform management ── */
// GET /ai-config — provider/model config (never returns the key).
router.get("/ai-config", requirePermission("ai.manage"), async (_req, res) => {
  try { const s = await getSettings(); res.json({ ...s.ai, hasKey: Boolean(s.aiKeyEnc) || Boolean(process.env.GROQ_API_KEY) }); }
  catch (err) { res.status(500).json({ message: err.message }); }
});
// PUT /ai-config — set provider/model/params; the key is encrypted at rest.
router.put("/ai-config", requirePermission("ai.manage"), async (req, res) => {
  try {
    const b = req.body || {};
    const ai = {};
    if (typeof b.provider === "string") ai.provider = b.provider;
    if (typeof b.model === "string") ai.model = b.model;
    if (b.temperature !== undefined) ai.temperature = Math.max(0, Math.min(2, Number(b.temperature) || 0));
    if (b.maxTokens !== undefined) ai.maxTokens = Math.max(1, Math.min(4000, Math.round(Number(b.maxTokens) || 800)));
    const patch = { ai: { ...(await getSettings()).ai, ...ai } };
    if (typeof b.apiKey === "string" && b.apiKey.trim()) patch.aiKeyEnc = encrypt(b.apiKey.trim());
    const { after } = await saveSettings(patch);
    // Audit records config change only — never the key.
    await logAudit({ req, action: "ai.config.update", target: "platform", meta: { ai: after.ai, keyChanged: Boolean(patch.aiKeyEnc) } });
    res.json({ ...after.ai, hasKey: Boolean(after.aiKeyEnc) || Boolean(process.env.GROQ_API_KEY) });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// GET /ai-usage — per-tenant AI & Lead-Hunt credit usage vs plan allowance.
router.get("/ai-usage", requirePermission("ai.manage"), async (_req, res) => {
  try {
    await ensureConnected();
    const [clients, plans] = await Promise.all([
      getPrisma().client.findMany({ where: { deletedAt: null }, select: { id: true, studioName: true, name: true, plan: true, aiCreditsUsed: true, leadCreditsUsed: true, _count: { select: { conversations: true } } } }),
      getPrisma().plan.findMany({ select: { slug: true, aiCredits: true, leadCredits: true } }),
    ]);
    const lim = Object.fromEntries(plans.map((p) => [p.slug, p]));
    res.json(clients.map((c) => {
      const p = lim[(c.plan || "").toLowerCase()] || {};
      return {
        id: c.id, studio: c.studioName || c.name, plan: c.plan,
        aiUsed: c.aiCreditsUsed, aiLimit: p.aiCredits || 0,
        leadUsed: c.leadCreditsUsed, leadLimit: p.leadCredits || 0,
        conversations: c._count.conversations,
        aiOver: p.aiCredits ? c.aiCreditsUsed >= p.aiCredits : false,
      };
    }));
  } catch (err) { res.status(500).json({ message: err.message }); }
});
// POST /studios/:id/credits/reset — reset a tenant's metered usage.
router.post("/studios/:id/credits/reset", requirePermission("ai.manage"), async (req, res) => {
  try {
    await ensureConnected();
    await getPrisma().client.update({ where: { id: req.params.id }, data: { aiCreditsUsed: 0, leadCreditsUsed: 0 } });
    await logAudit({ req, action: "ai.credits.reset", target: "studio", targetId: req.params.id });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ message: err.message }); }
});
// GET /studios/:id/conversations — end-customer AI logs (permission-gated + audited).
router.get("/studios/:id/conversations", requirePermission("ai.logs"), async (req, res) => {
  try {
    await ensureConnected();
    const convos = await getPrisma().aIConversation.findMany({ where: { clientId: req.params.id }, orderBy: { createdAt: "desc" }, take: 30, select: { id: true, messages: true, createdAt: true, lead: { select: { name: true, email: true } } } });
    await logAudit({ req, action: "ai.logs.view", target: "studio", targetId: req.params.id, meta: { count: convos.length } });
    res.json(convos);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /copilot — real generation via Groq (llama-3.3-70b).
const SYSTEMS = {
  aesthetics: "You are HOI Copilot, a photography portfolio analyst. Analyze composition, lighting and curation, and give concrete suggestions. Be concise; reply in markdown with short bullet points.",
  marketing: "You are HOI Copilot, a marketing copywriter for a photography SaaS platform. Draft compelling, concise marketing/newsletter copy in markdown.",
  cfo: "You are HOI Copilot, a SaaS CFO advisor. Give concise, numbers-driven financial strategy in markdown with clear next steps.",
  support: "You are HOI Copilot, a premium customer-support specialist. Draft a warm, professional support reply in markdown.",
  default: "You are HOI Copilot, an AI assistant for a photography platform super-admin. Respond concisely in markdown.",
};
router.post("/copilot", requirePermission("dashboard.view"), async (req, res) => {
  try {
    const apiKey = await getAiKey();
    if (!apiKey) return res.status(503).json({ message: "AI is not configured — add a provider key in AI Platform." });
    const cfg = (await getSettings()).ai;
    const { routine, prompt } = req.body || {};
    const client = new Groq({ apiKey });
    const completion = await client.chat.completions.create({
      model: cfg.model || "llama-3.3-70b-versatile",
      temperature: cfg.temperature ?? 0.5,
      max_tokens: cfg.maxTokens || 800,
      messages: [
        { role: "system", content: SYSTEMS[routine] || SYSTEMS.default },
        { role: "user", content: String(prompt || "").slice(0, 4000) },
      ],
    });
    res.json({ output: completion.choices?.[0]?.message?.content || "", model: cfg.model || "llama-3.3-70b-versatile" });
  } catch (err) {
    res.status(502).json({ message: err.message });
  }
});

export default router;
