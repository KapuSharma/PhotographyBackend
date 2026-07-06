import express from "express";
import getPrisma, { ensureConnected } from "../db/prisma.js";
import { runConnector, SOURCES } from "../hunter/connectors.js";
import { applyRejectFilter } from "../hunter/filters.js";
import { scoreLead, defaultScorePrompt } from "../hunter/scorer.js";
import { getSettings } from "../lib/settings.js";
import { huntSourcesFor, platformDefaultKeywords } from "../lib/leadhunt.js";

const router = express.Router();

/* ────────────────────────────────────────────────────────────
   GET /api/hunter/keywords  — load saved keywords
   PUT /api/hunter/keywords  — save keywords
   ──────────────────────────────────────────────────────────── */
router.get("/keywords", async (req, res) => {
  try {
    const cfg = await getPrisma().hunterConfig.findUnique({
      where: { clientId: req.user.clientId },
    });
    res.json({ keywords: cfg?.keywords ?? [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/keywords", async (req, res) => {
  try {
    const keywords = Array.isArray(req.body?.keywords) ? req.body.keywords.map(String).filter(Boolean) : [];
    const cfg = await getPrisma().hunterConfig.upsert({
      where:  { clientId: req.user.clientId },
      create: { clientId: req.user.clientId, keywords },
      update: { keywords },
    });
    res.json({ keywords: cfg.keywords });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ────────────────────────────────────────────────────────────
   GET /api/hunter/score-prompt  — current Groq scoring prompt
   PUT /api/hunter/score-prompt  — override it (empty / equal to
   default clears the override and reverts to the built-in prompt)
   ──────────────────────────────────────────────────────────── */
router.get("/score-prompt", async (req, res) => {
  try {
    const cfg = await getPrisma().hunterConfig.findUnique({
      where: { clientId: req.user.clientId },
    });
    const def = defaultScorePrompt();
    res.json({ prompt: cfg?.scorePrompt || def, default: def, isCustom: !!cfg?.scorePrompt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/score-prompt", async (req, res) => {
  try {
    const raw = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    const def = defaultScorePrompt();
    const scorePrompt = (!raw || raw === def) ? null : raw;
    const cfg = await getPrisma().hunterConfig.upsert({
      where:  { clientId: req.user.clientId },
      create: { clientId: req.user.clientId, scorePrompt },
      update: { scorePrompt },
    });
    res.json({ prompt: cfg.scorePrompt || def, default: def, isCustom: !!cfg.scorePrompt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ────────────────────────────────────────────────────────────
   GET /api/hunter/source-access
   Returns the source-access feasibility table required by
   HG's email (acceptance criterion #1).
   ──────────────────────────────────────────────────────────── */
router.get("/source-access", (req, res) => {
  res.json([
    { source: "Freelancer",      api: "Public REST API",        access: "Free",      login: "No",      scraping: "No",       risk: "Low",  nextAction: "Live" },
    { source: "PeoplePerHour",   api: "Public RSS feed",         access: "Free",      login: "No",      scraping: "No (RSS)", risk: "Low",  nextAction: "Live" },
    { source: "Google Search",   api: "Custom Search JSON API",  access: "Free tier", login: "API key", scraping: "No",       risk: "Low",  nextAction: "Live (needs API key)" },
    { source: "Reddit",          api: "Public JSON API",         access: "Free",      login: "No",      scraping: "No",       risk: "Low",  nextAction: "Live" },
    { source: "LinkedIn",        api: "No scraping allowed",     access: "Manual",    login: "Yes",     scraping: "Forbidden",risk: "High", nextAction: "Manual entry only" },
    { source: "Upwork",          api: "RSS shut down (410)",     access: "N/A",       login: "N/A",     scraping: "N/A",      risk: "N/A",  nextAction: "Dead" },
    { source: "Guru",            api: "Sitemap + JSON-LD",       access: "Free",      login: "No",      scraping: "Structured data", risk: "Low",  nextAction: "Live" },
  ]);
});

/* ────────────────────────────────────────────────────────────
   GET /api/hunter/leads
   List captured leads. Supports filters: source, status,
   minScore, country, search.
   ──────────────────────────────────────────────────────────── */
router.get("/leads", async (req, res) => {
  try {
    await ensureConnected();
    const { source, status, minScore, minBudget, country, search, includeRejected, runId } = req.query;
    const prisma = getPrisma();
    const where = { clientId: req.user.clientId };
    if (source && source !== "All") where.source = source;
    if (status && status !== "All") where.status = status;
    if (country && country !== "All") where.country = { contains: String(country), mode: "insensitive" };
    if (minScore) where.score = { gte: parseInt(minScore) };
    if (minBudget) where.budgetMax = { gte: parseFloat(minBudget) };
    if (runId) where.runId = String(runId);
    if (!includeRejected || includeRejected === "false") where.rejected = false;
    if (search) {
      where.OR = [
        { title:       { contains: String(search), mode: "insensitive" } },
        { description: { contains: String(search), mode: "insensitive" } },
        { clientName:  { contains: String(search), mode: "insensitive" } },
      ];
    }
    const leads = await prisma.hoiLead.findMany({
      where,
      orderBy: [{ score: "desc" }, { capturedAt: "desc" }],
      take: 500,
    });
    res.json(leads);
  } catch (err) {
    console.error("[hunter/leads]", err);
    res.status(500).json({ error: err.message });
  }
});

/* ────────────────────────────────────────────────────────────
   GET /api/hunter/stats
   Counts per source / status / today.
   ──────────────────────────────────────────────────────────── */
router.get("/stats", async (req, res) => {
  try {
    const prisma = getPrisma();
    const all = await prisma.hoiLead.findMany({
      where: { clientId: req.user.clientId, rejected: false },
      select: { source: true, status: true, score: true, capturedAt: true },
    });
    const bySource = {};
    const byStatus = {};
    let highScore = 0;
    let todayCount = 0;
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    for (const l of all) {
      bySource[l.source] = (bySource[l.source] || 0) + 1;
      byStatus[l.status] = (byStatus[l.status] || 0) + 1;
      if (l.score >= 70) highScore++;
      if (new Date(l.capturedAt) >= startOfDay) todayCount++;
    }
    res.json({ total: all.length, bySource, byStatus, highScore, todayCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ────────────────────────────────────────────────────────────
   GET /api/hunter/run-stream
   SSE endpoint — streams live progress logs while hunting.
   ──────────────────────────────────────────────────────────── */
router.get("/run-stream", async (req, res) => {
  const prisma = getPrisma();
  const sourcesParam = req.query.sources ? String(req.query.sources).split(",") : null;
  // Honour the platform-level source enable map — disabled sources are skipped.
  const settings = await getSettings().catch(() => null);
  const sources = huntSourcesFor(settings, sourcesParam);

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  let run = null;
  try {
    const cfg = await prisma.hunterConfig.findUnique({ where: { clientId: req.user.clientId } });
    const customKeywords = (Array.isArray(cfg?.keywords) && cfg.keywords.length ? cfg.keywords.map(String) : null) || platformDefaultKeywords(settings);
    const customPrompt = cfg?.scorePrompt || null;

    run = await prisma.hunterRun.create({
      data: { clientId: req.user.clientId, sources, status: "running" },
    });

    send("start", { sources, keywords: customKeywords || [], runId: run.id, startedAt: run.startedAt });

    const summary = { runId: run.id, startedAt: run.startedAt, sources: {}, totalCaptured: 0, totalRejected: 0 };

    for (const src of sources) {
      const out = { fetched: 0, captured: 0, rejected: 0 };
      send("source_start", { source: src, message: `Hunting ${src}...` });

      try {
        send("log", { source: src, message: `Fetching leads from ${src}...` });
        const { items, errors } = await runConnector(src, customKeywords);
        out.fetched = items.length;
        send("log", { source: src, message: `Fetched ${items.length} raw leads from ${src}` });

        if (errors?.length) {
          errors.forEach(e => send("log", { source: src, message: `Warning: ${e.note || e.error || JSON.stringify(e)}` }));
        }

        let i = 0;
        for (const raw of items) {
          i++;
          const reject = applyRejectFilter(raw, customKeywords);
          if (reject.rejected) {
            out.rejected++;
            send("log", { source: src, message: `Rejected (${reject.reason}): ${raw.title?.slice(0, 60)}` });
            continue;
          }
          send("log", { source: src, message: `AI scoring lead ${i}/${items.length}: ${raw.title?.slice(0, 50)}...` });
          const scored = await scoreLead(raw, customKeywords, customPrompt);
          const data = {
            clientId: req.user.clientId,
            runId: run.id,
            source: raw.source,
            sourceLeadId: String(raw.sourceLeadId || raw.sourceUrl || raw.title).slice(0, 240),
            sourceUrl: raw.sourceUrl || "",
            title: raw.title,
            description: raw.description || "",
            budgetMin: raw.budgetMin ?? null,
            budgetMax: raw.budgetMax ?? null,
            currency: raw.currency || "USD",
            country: raw.country || "",
            skills: raw.skills || [],
            postedAt: raw.postedAt || null,
            clientName: raw.clientName || "",
            clientHistory: raw.clientHistory || "",
            competitionCount: raw.competitionCount || 0,
            rawPayload: raw.rawPayload || {},
            score: scored.total,
            scoreBreakdown: scored.breakdown,
            recommendedService: scored.recommendedService,
            scoreReason: scored.reason,
            suggestedReply: scored.suggestedReply,
            status: "New",
          };
          try {
            const saved = await prisma.hoiLead.upsert({
              where: { clientId_source_sourceLeadId: { clientId: req.user.clientId, source: data.source, sourceLeadId: data.sourceLeadId } },
              create: data,
              update: {
                runId: data.runId,
                title: data.title, description: data.description,
                budgetMin: data.budgetMin, budgetMax: data.budgetMax,
                country: data.country, skills: data.skills,
                competitionCount: data.competitionCount,
                score: data.score, scoreBreakdown: data.scoreBreakdown,
                recommendedService: data.recommendedService,
                scoreReason: data.scoreReason, suggestedReply: data.suggestedReply,
              },
            });
            out.captured++;
            send("lead_saved", {
              source: src,
              count: out.captured,
              score: scored.total,
              title: raw.title?.slice(0, 60),
              lead: saved,
            });
          } catch (e) {
            send("log", { source: src, message: `Save error: ${e.message}` });
          }
        }
      } catch (err) {
        send("log", { source: src, message: `Error: ${err.message}` });
      }

      summary.sources[src] = out;
      summary.totalCaptured += out.captured;
      summary.totalRejected += out.rejected;
      send("source_done", { source: src, captured: out.captured, rejected: out.rejected });

      // Persist progress after every source so totals survive an interrupted stream
      try {
        await prisma.hunterRun.update({
          where: { id: run.id },
          data: {
            totalCaptured: summary.totalCaptured,
            totalRejected: summary.totalRejected,
            perSource: summary.sources,
          },
        });
      } catch {}
    }

    await prisma.hunterRun.update({
      where: { id: run.id },
      data: {
        status: "completed",
        finishedAt: new Date(),
        totalCaptured: summary.totalCaptured,
        totalRejected: summary.totalRejected,
        perSource: summary.sources,
      },
    });

    send("done", { summary });
  } catch (err) {
    if (run) {
      try {
        await prisma.hunterRun.update({
          where: { id: run.id },
          data: { status: "failed", finishedAt: new Date() },
        });
      } catch {}
    }
    send("error", { message: err.message });
  } finally {
    res.end();
  }
});

/* ────────────────────────────────────────────────────────────
   GET /api/hunter/runs
   Returns recent hunt runs for this client (newest first).
   ──────────────────────────────────────────────────────────── */
router.get("/runs", async (req, res) => {
  try {
    const prisma = getPrisma();

    // Auto-mark runs stuck in 'running' for >10 minutes as 'abandoned'
    const staleCutoff = new Date(Date.now() - 10 * 60 * 1000);
    await prisma.hunterRun.updateMany({
      where: {
        clientId: req.user.clientId,
        status: "running",
        startedAt: { lt: staleCutoff },
      },
      data: { status: "abandoned", finishedAt: new Date() },
    });

    const runs = await prisma.hunterRun.findMany({
      where: { clientId: req.user.clientId },
      orderBy: { startedAt: "desc" },
      take: 20,
    });

    // Overlay live captured-counts from the HoiLead table so the displayed
    // totals + per-source breakdown reflect reality even for interrupted runs.
    const runIds = runs.map(r => r.id);
    const perSourceByRunId = {};
    const totalByRunId = {};
    if (runIds.length) {
      const counts = await prisma.hoiLead.groupBy({
        by: ["runId", "source"],
        where: { clientId: req.user.clientId, runId: { in: runIds } },
        _count: { _all: true },
      });
      for (const c of counts) {
        if (!c.runId) continue;
        if (!perSourceByRunId[c.runId]) perSourceByRunId[c.runId] = {};
        perSourceByRunId[c.runId][c.source] = c._count._all;
        totalByRunId[c.runId] = (totalByRunId[c.runId] || 0) + c._count._all;
      }
    }

    const withLiveCounts = runs.map(r => {
      const stored = (r.perSource && typeof r.perSource === "object") ? r.perSource : {};
      const live = perSourceByRunId[r.id] || {};
      // Merge: keep stored fields (rejected counts etc.) but override `captured` with live counts
      const merged = { ...stored };
      for (const [src, captured] of Object.entries(live)) {
        merged[src] = { ...(merged[src] || {}), captured };
      }
      return {
        ...r,
        totalCaptured: totalByRunId[r.id] ?? r.totalCaptured,
        perSource: merged,
      };
    });

    res.json(withLiveCounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ────────────────────────────────────────────────────────────
   POST /api/hunter/run  (kept for backward compat)
   ──────────────────────────────────────────────────────────── */
router.post("/run", async (req, res) => {
  try {
    const prisma = getPrisma();
    const settings = await getSettings().catch(() => null);
    const sources = huntSourcesFor(settings, Array.isArray(req.body?.sources) ? req.body.sources : null);

    // Load custom keywords for this client (falling back to the platform default set)
    const cfg = await prisma.hunterConfig.findUnique({ where: { clientId: req.user.clientId } });
    const customKeywords = (Array.isArray(cfg?.keywords) && cfg.keywords.length ? cfg.keywords.map(String) : null) || platformDefaultKeywords(settings);
    const customPrompt = cfg?.scorePrompt || null;

    const summary = { sources: {}, totalCaptured: 0, totalRejected: 0, errors: [] };

    for (const src of sources) {
      const out = { fetched: 0, captured: 0, rejected: 0, fallback: false };
      try {
        const { items, errors, fallback } = await runConnector(src, customKeywords);
        out.fetched = items.length;
        out.fallback = fallback;
        if (errors?.length) summary.errors.push({ source: src, errors });

        for (const raw of items) {
          const reject = applyRejectFilter(raw, customKeywords);
          if (reject.rejected) { out.rejected++; continue; }
          const scored = await scoreLead(raw, customKeywords, customPrompt);
          const data = {
            clientId: req.user.clientId,
            source: raw.source,
            sourceLeadId: String(raw.sourceLeadId || raw.sourceUrl || raw.title).slice(0, 240),
            sourceUrl: raw.sourceUrl || "",
            title: raw.title,
            description: raw.description || "",
            budgetMin: raw.budgetMin ?? null,
            budgetMax: raw.budgetMax ?? null,
            currency: raw.currency || "USD",
            country: raw.country || "",
            skills: raw.skills || [],
            postedAt: raw.postedAt || null,
            clientName: raw.clientName || "",
            clientHistory: raw.clientHistory || "",
            competitionCount: raw.competitionCount || 0,
            rawPayload: raw.rawPayload || {},
            score: scored.total,
            scoreBreakdown: scored.breakdown,
            recommendedService: scored.recommendedService,
            scoreReason: scored.reason,
            suggestedReply: scored.suggestedReply,
            status: "New",
          };
          try {
            await prisma.hoiLead.upsert({
              where: { clientId_source_sourceLeadId: { clientId: req.user.clientId, source: data.source, sourceLeadId: data.sourceLeadId } },
              create: data,
              update: {
                title: data.title,
                description: data.description,
                budgetMin: data.budgetMin,
                budgetMax: data.budgetMax,
                country: data.country,
                skills: data.skills,
                competitionCount: data.competitionCount,
                score: data.score,
                scoreBreakdown: data.scoreBreakdown,
                recommendedService: data.recommendedService,
                scoreReason: data.scoreReason,
                suggestedReply: data.suggestedReply,
              },
            });
            out.captured++;
          } catch (e) {
            summary.errors.push({ source: src, error: e.message, leadTitle: data.title });
          }
        }
      } catch (err) {
        summary.errors.push({ source: src, error: err.message });
      }
      summary.sources[src] = out;
      summary.totalCaptured += out.captured;
      summary.totalRejected += out.rejected;
    }

    res.json(summary);
  } catch (err) {
    console.error("[hunter/run]", err);
    res.status(500).json({ error: err.message });
  }
});

/* ────────────────────────────────────────────────────────────
   POST /api/hunter/manual-linkedin
   Body: { linkedinUrl, personName, companyName, postText,
           requirementSummary, country, serviceCategory,
           assignedTo }
   Manual LinkedIn lead entry — required by HG (no scraping).
   AI scores the lead and generates an outreach message.
   ──────────────────────────────────────────────────────────── */
router.post("/manual-linkedin", async (req, res) => {
  try {
    const prisma = getPrisma();
    const cfg = await prisma.hunterConfig.findUnique({ where: { clientId: req.user.clientId } });
    const customPrompt = cfg?.scorePrompt || null;
    const {
      linkedinUrl = "",
      personName = "",
      companyName = "",
      postText = "",
      requirementSummary = "",
      country = "",
      serviceCategory = "",
      assignedTo = "",
    } = req.body || {};
    if (!personName && !companyName) return res.status(400).json({ error: "personName or companyName is required" });

    const raw = {
      source: "LinkedIn",
      sourceLeadId: linkedinUrl || `linkedin-manual-${Date.now()}`,
      sourceUrl: linkedinUrl,
      title: requirementSummary || `${personName || companyName} — manual entry`,
      description: [postText, requirementSummary].filter(Boolean).join("\n\n"),
      budgetMin: null,
      budgetMax: null,
      currency: "USD",
      country,
      skills: serviceCategory ? [serviceCategory] : [],
      postedAt: new Date(),
      clientName: personName,
      clientHistory: companyName,
      competitionCount: 0,
      rawPayload: { linkedinUrl, personName, companyName, postText, requirementSummary, serviceCategory, manual: true },
    };
    const scored = await scoreLead(raw, null, customPrompt);

    const created = await prisma.hoiLead.upsert({
      where: { clientId_source_sourceLeadId: { clientId: req.user.clientId, source: "LinkedIn", sourceLeadId: raw.sourceLeadId } },
      create: {
        clientId: req.user.clientId,
        ...raw,
        score: scored.total,
        scoreBreakdown: scored.breakdown,
        recommendedService: scored.recommendedService,
        scoreReason: scored.reason,
        suggestedReply: scored.suggestedReply,
        status: "New",
        assignedTo,
      },
      update: {
        description: raw.description,
        country: raw.country,
        score: scored.total,
        scoreBreakdown: scored.breakdown,
        recommendedService: scored.recommendedService,
        scoreReason: scored.reason,
        suggestedReply: scored.suggestedReply,
        assignedTo,
      },
    });
    res.json(created);
  } catch (err) {
    console.error("[hunter/manual-linkedin]", err);
    res.status(500).json({ error: err.message });
  }
});

/* ────────────────────────────────────────────────────────────
   PATCH /api/hunter/leads/:id
   Update status, assignedTo, or rejected flag.
   ──────────────────────────────────────────────────────────── */
router.patch("/leads/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const lead = await prisma.hoiLead.findFirst({
      where: { id: req.params.id, clientId: req.user.clientId },
    });
    if (!lead) return res.status(404).json({ error: "Not found" });
    const { status, assignedTo, rejected, rejectReason } = req.body || {};
    const updated = await prisma.hoiLead.update({
      where: { id: req.params.id },
      data: {
        ...(status !== undefined && { status }),
        ...(assignedTo !== undefined && { assignedTo }),
        ...(rejected !== undefined && { rejected }),
        ...(rejectReason !== undefined && { rejectReason }),
      },
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ────────────────────────────────────────────────────────────
   POST /api/hunter/leads/:id/rescore
   Re-runs AI scoring on a single lead (useful after editing
   description or after a model change).
   ──────────────────────────────────────────────────────────── */
router.post("/leads/:id/rescore", async (req, res) => {
  try {
    const prisma = getPrisma();
    const lead = await prisma.hoiLead.findFirst({
      where: { id: req.params.id, clientId: req.user.clientId },
    });
    if (!lead) return res.status(404).json({ error: "Not found" });
    const cfg = await prisma.hunterConfig.findUnique({ where: { clientId: req.user.clientId } });
    const scored = await scoreLead(lead, null, cfg?.scorePrompt || null);
    const updated = await prisma.hoiLead.update({
      where: { id: req.params.id },
      data: {
        score: scored.total,
        scoreBreakdown: scored.breakdown,
        recommendedService: scored.recommendedService,
        scoreReason: scored.reason,
        suggestedReply: scored.suggestedReply,
      },
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ────────────────────────────────────────────────────────────
   DELETE /api/hunter/leads/clear-seeds
   Removes all seed/fake leads (sourceLeadId contains 'seed')
   ──────────────────────────────────────────────────────────── */
router.delete("/leads/clear-seeds", async (req, res) => {
  try {
    const prisma = getPrisma();
    const result = await prisma.hoiLead.deleteMany({
      where: {
        clientId: req.user.clientId,
        sourceLeadId: { contains: "seed" },
      },
    });
    res.json({ deleted: result.count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ────────────────────────────────────────────────────────────
   DELETE /api/hunter/leads/:id
   ──────────────────────────────────────────────────────────── */
router.delete("/leads/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const lead = await prisma.hoiLead.findFirst({
      where: { id: req.params.id, clientId: req.user.clientId },
    });
    if (!lead) return res.status(404).json({ error: "Not found" });
    await prisma.hoiLead.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
