import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";

import authRouter from "./routes/auth.js";
import healthRouter from "./routes/health.js";
import publicRouter from "./routes/public.js";
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

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Publicly serve uploaded images so both the dashboard and the public site can load them.
app.use("/uploads", express.static(path.resolve("uploads")));

// Public routes
app.use("/api/auth", authRouter);
app.use("/api", healthRouter);
app.use("/api/public", publicRouter);

// Protected routes — JWT required
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
});

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());

// Don't let a stray async DB rejection (e.g. Neon cold-start timeout) crash the
// whole server. Log it and keep serving — the request itself still gets its 500.
process.on('unhandledRejection', (reason) => {
  console.warn('[server] unhandled rejection:', reason?.message || reason);
});
