import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";

import authRouter from "./routes/auth.js";
import healthRouter from "./routes/health.js";
import publicRouter from "./routes/public.js";
import mainSiteRouter from "./routes/mainSite.js";
import adminAuthRouter from "./routes/adminAuth.js";
import superadminRouter from "./routes/superadmin.js";
import impersonationRouter from "./routes/impersonation.js";
import clientsRouter from "./routes/clients.js";
import leadsRouter from "./routes/leads.js";
import usersRouter from "./routes/users.js";
import servicesRouter from "./routes/services.js";
import packagesRouter from "./routes/packages.js";
import testimonialsRouter from "./routes/testimonials.js";
import galleryRouter from "./routes/gallery.js";
import blogRouter from "./routes/blog.js";
import uploadsRouter from "./routes/uploads.js";
import faqsRouter from "./routes/faqs.js";
import aiConfigRouter from "./routes/aiConfig.js";
import conversationsRouter from "./routes/conversations.js";
import paymentsRouter from "./routes/payments.js";
import siteContentRouter from "./routes/siteContent.js";
import analyticsRouter from "./routes/analytics.js";
import profileRouter from "./routes/profile.js";
import tasksRouter from "./routes/tasks.js";
import huntRouter from "./routes/hunt.js";
import hunterRouter from "./routes/hunter.js";
import meetingsRouter from "./routes/meetings.js";
import authMiddleware from "./middleware/auth.js";
import { sweepSubscriptions } from "./lib/plans.js";
import { ensureConnected } from "./db/prisma.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Publicly serve uploaded images so both the dashboard and the public site can load them.
app.use("/uploads", express.static(path.resolve("uploads")));

// Wake a cold/serverless (Neon) database before any DB-backed handler runs, so a
// suspended DB is retried into life instead of surfacing as a query timeout /
// unhandled rejection. Cheap when warm (skips the probe within a short TTL).
// The health check reports DB status itself, so it's exempt.
app.use(async (req, res, next) => {
  if (req.path.startsWith("/api/health")) return next();
  try {
    await ensureConnected();
    next();
  } catch (err) {
    console.warn("[db] request blocked — DB unavailable:", err.message);
    res.status(503).json({ error: "Database temporarily unavailable, please retry." });
  }
});

// Public routes
app.use("/api/auth", authRouter);
app.use("/api", healthRouter);
app.use("/api/public", publicRouter);
// HOI marketing-site content — GET public (site reads it); PUT guarded by SUPERADMIN_SECRET.
app.use("/api/main-site", mainSiteRouter);
// Super-admin authentication (login/me/logout) — secret-guarded inside the router.
app.use("/api/admin", adminAuthRouter);
// Super-admin platform endpoints — secret-guarded + admin JWT + RBAC inside the router.
app.use("/api/superadmin", superadminRouter);

// Protected routes — JWT required
app.use("/api/impersonation", authMiddleware, impersonationRouter);
app.use("/api/clients", authMiddleware, clientsRouter);
app.use("/api/leads", authMiddleware, leadsRouter);
app.use("/api/users", authMiddleware, usersRouter);
app.use("/api/services", authMiddleware, servicesRouter);
app.use("/api/packages", authMiddleware, packagesRouter);
app.use("/api/testimonials", authMiddleware, testimonialsRouter);
app.use("/api/gallery", authMiddleware, galleryRouter);
app.use("/api/blog", authMiddleware, blogRouter);
app.use("/api/uploads", authMiddleware, uploadsRouter);
app.use("/api/faqs", authMiddleware, faqsRouter);
app.use("/api/ai-config", authMiddleware, aiConfigRouter);
app.use("/api/conversations", authMiddleware, conversationsRouter);
app.use("/api/payments", authMiddleware, paymentsRouter);
app.use("/api/site-content", authMiddleware, siteContentRouter);
app.use("/api/analytics", authMiddleware, analyticsRouter);
app.use("/api/profile", authMiddleware, profileRouter);
app.use("/api/tasks", authMiddleware, tasksRouter);
app.use("/api/hunt", authMiddleware, huntRouter);
app.use("/api/hunter", authMiddleware, hunterRouter);
app.use("/api/meetings", authMiddleware, meetingsRouter);

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  // Warm the DB immediately at boot so Neon is awake before the dashboard's
  // first requests arrive — avoids the cold-start query timeouts on startup.
  ensureConnected()
    .then(() => console.log("[db] connected"))
    .catch((e) => console.warn("[db] initial warm-up failed (will retry per-request):", e.message));
});

// Subscription expiry workflow: expire past-due subscriptions and auto-suspend
// after the grace window. Runs hourly; also triggerable via /superadmin/subscriptions/sweep.
setInterval(() => { sweepSubscriptions().catch((e) => console.warn("[sweep]", e.message)); }, 60 * 60 * 1000);

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());

// Don't let a stray async DB rejection (e.g. Neon cold-start timeout) crash the
// whole server. Log it and keep serving — the request itself still gets its 500.
process.on('unhandledRejection', (reason) => {
  console.warn('[server] unhandled rejection:', reason?.message || reason);
});
