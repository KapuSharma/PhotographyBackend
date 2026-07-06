import { Router } from "express";
import getPrisma from "../db/prisma.js";
import { generateLeadInsights } from "../lib/groq.js";

const router = Router();

// ── LEAD SCORE CALCULATOR ──────────────────────────────────────────────────
function calculateLeadScore(data) {
  let score = 50;
  if (data.budget) {
    const nums = data.budget.replace(/,/g, "").match(/\d+/g);
    if (nums && nums.length > 0) {
      const high = Math.max(...nums.map(Number));
      if (high >= 8000)      score += 20;
      else if (high >= 5000) score += 15;
      else if (high >= 2000) score += 10;
      else                   score += 5;
    } else {
      score += 3;
    }
  }
  const src = (data.source || "").toLowerCase();
  if (src.includes("referral"))       score += 15;
  else if (src.includes("hunter"))    score += 12;
  else if (src.includes("chatbot"))   score += 10;
  else if (src.includes("form"))      score += 7;
  else if (src.includes("google"))    score += 3;
  else                                score += 3;

  const text = `${data.message || ""} ${data.notes || ""}`.toLowerCase();
  const urgentWords = ["urgent", "asap", "immediately", "deadline", "launch", "next week", "next month", "confirmed", "ready to proceed", "approved"];
  if (urgentWords.some(w => text.includes(w))) score += 8;

  if (data.phone)     score += 3;
  if (data.eventType) score += 3;
  if (data.eventDate) score += 4;
  if (data.location)  score += 2;
  if (data.company)   score += 3;
  if (data.message && data.message.length > 20) score += 3;

  return Math.min(score, 100);
}

// Extract a numeric estimate from a free-text budget string ("$8,000 – 12,000" → 12000)
function parseBudgetEstimate(str) {
  if (!str) return null;
  const nums = String(str).replace(/,/g, "").match(/\d+(?:\.\d+)?/g);
  if (!nums || !nums.length) return null;
  const vals = nums.map(Number).filter(n => !Number.isNaN(n));
  if (!vals.length) return null;
  return Math.max(...vals);
}

const SCORE_FIELDS = ["budget", "source", "message", "notes", "phone", "eventType", "eventDate", "location", "company"];

// ── ALL leads for current client ───────────────────────────────────────────
router.get("/", async (req, res) => {
  const { status, source, ownerId, temperature, search } = req.query;
  const where = {
    clientId: req.user.clientId,
    ...(status && { status }),
    ...(source && { source }),
    ...(ownerId && { ownerId }),
    ...(temperature && { temperature }),
    ...(search && {
      OR: [
        { name:    { contains: search, mode: "insensitive" } },
        { email:   { contains: search, mode: "insensitive" } },
        { company: { contains: search, mode: "insensitive" } },
      ],
    }),
  };
  const leads = await getPrisma().lead.findMany({
    where,
    include: {
      conversation: true,
      owner: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  const mapped = leads.map(l => ({
    ...l,
    transcript: l.conversation?.messages ?? [],
    time: l.createdAt,
  }));
  res.json(mapped);
});

// ── STATS for KPI cards ────────────────────────────────────────────────────
router.get("/stats", async (req, res) => {
  const prisma = getPrisma();
  const clientId = req.user.clientId;

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfPrevMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
  const stuckThreshold = new Date(now.getTime() - 7 * 86400000); // no activity in last 7 days

  const [all, wonThisMonth, wonLastMonth, pipelineLastMonth] = await Promise.all([
    prisma.lead.findMany({
      where: { clientId },
      select: { id: true, status: true, estimatedValue: true, budget: true, lastActivityAt: true, updatedAt: true, createdAt: true },
    }),
    prisma.lead.findMany({
      where: { clientId, status: "Booked", wonAt: { gte: startOfMonth } },
      select: { estimatedValue: true, budget: true },
    }),
    prisma.lead.findMany({
      where: { clientId, status: "Booked", wonAt: { gte: startOfPrevMonth, lte: endOfPrevMonth } },
      select: { estimatedValue: true, budget: true },
    }),
    prisma.lead.findMany({
      where: { clientId, createdAt: { lte: endOfPrevMonth }, NOT: { status: "Lost" } },
      select: { estimatedValue: true, budget: true },
    }),
  ]);

  const valueOf = l => (typeof l.estimatedValue === "number" ? l.estimatedValue : (parseBudgetEstimate(l.budget) || 0));

  const stageBreakdown = all.reduce((acc, l) => { acc[l.status] = (acc[l.status] || 0) + 1; return acc; }, {});
  const active = all.filter(l => l.status !== "Lost");
  const pipelineTotal = active.reduce((s, l) => s + valueOf(l), 0);
  const pipelineLastTotal = pipelineLastMonth.reduce((s, l) => s + valueOf(l), 0);
  const pipelineDelta = pipelineLastTotal > 0
    ? Math.round(((pipelineTotal - pipelineLastTotal) / pipelineLastTotal) * 100)
    : null;

  const wonCount = wonThisMonth.length;
  const wonAmount = wonThisMonth.reduce((s, l) => s + valueOf(l), 0);
  const wonLastAmount = wonLastMonth.reduce((s, l) => s + valueOf(l), 0);
  const wonDelta = wonLastAmount > 0
    ? Math.round(((wonAmount - wonLastAmount) / wonLastAmount) * 100)
    : null;

  const stuckDeals = active.filter(l => {
    const last = new Date(l.lastActivityAt || l.updatedAt || l.createdAt);
    return last < stuckThreshold && l.status !== "Booked";
  }).length;

  const totalDeals = all.length;
  const compliance = totalDeals > 0
    ? Math.round(((totalDeals - stuckDeals) / totalDeals) * 100)
    : 100;

  res.json({
    totalDeals,
    activeDeals: active.length,
    pipelineTotal,
    pipelineDelta,
    wonCount,
    wonAmount,
    wonDelta,
    stuckDeals,
    compliance,
    stageBreakdown,
  });
});

router.get("/:id", async (req, res) => {
  const lead = await getPrisma().lead.findFirst({
    where: { id: req.params.id, clientId: req.user.clientId },
    include: {
      conversation: true,
      owner: { select: { id: true, name: true, email: true } },
    },
  });
  if (!lead) return res.status(404).json({ message: "Lead not found" });
  res.json({ ...lead, transcript: lead.conversation?.messages ?? [], time: lead.createdAt });
});

// ── AI Intelligence Report — lazy generate + cache ──────────────────────
// POST  /api/leads/:id/insights          → returns cached if present, else generates
// POST  /api/leads/:id/insights?force=1  → always regenerates
//
// DB shape: Lead.aiInsights JSON column stores { summary, insights, sourceData }
router.post("/:id/insights", async (req, res) => {
  try {
    const prisma = getPrisma();
    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id, clientId: req.user.clientId },
    });
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    const force = req.query.force === "1" || req.query.force === "true";

    // Return cached unless forced.
    // Treat two cached shapes as valid:
    //   - NEW (object with `insights` array + `summary`)
    //   - LEGACY (plain array of { category, text }) — served but flagged as legacy
    const cached = lead.aiInsights;
    const isNewShape = cached && typeof cached === "object" && !Array.isArray(cached)
      && Array.isArray(cached.insights) && cached.insights.length > 0;
    const isLegacyShape = Array.isArray(cached) && cached.length > 0;

    if (!force && (isNewShape || isLegacyShape)) {
      return res.json({
        summary:     isNewShape ? (cached.summary || "") : "",
        insights:    isNewShape ? cached.insights : cached,
        sourceData:  isNewShape ? (cached.sourceData || null) : null,
        generatedAt: lead.aiInsightsAt,
        model:       lead.aiInsightsModel,
        cached:      true,
        legacy:      isLegacyShape,
      });
    }

    // Pull studio context for the prompt
    const [client, profile, services] = await Promise.all([
      prisma.client.findUnique({ where: { id: req.user.clientId } }),
      prisma.photographerProfile.findUnique({ where: { clientId: req.user.clientId } }),
      prisma.service.findMany({ where: { clientId: req.user.clientId, active: true }, take: 12 }),
    ]);

    let result;
    try {
      result = await generateLeadInsights({
        lead,
        services,
        profile,
        studioName: client?.studioName || client?.name || "the studio",
      });
    } catch (err) {
      const msg = err?.message || "Failed to generate insights";
      await prisma.lead.update({
        where: { id: lead.id },
        data: { aiInsightsError: msg.slice(0, 400) },
      });
      return res.status(502).json({ message: msg });
    }

    const payload = {
      summary: result.summary,
      insights: result.insights,
      sourceData: result.sourceData,
    };

    const now = new Date();
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        aiInsights: payload,
        aiInsightsAt: now,
        aiInsightsModel: result.model,
        aiInsightsError: null,
      },
    });

    res.json({
      summary:     payload.summary,
      insights:    payload.insights,
      sourceData:  payload.sourceData,
      generatedAt: now,
      model:       result.model,
      cached:      false,
      legacy:      false,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const score = calculateLeadScore(req.body);
    const estimatedValue = req.body.estimatedValue ?? parseBudgetEstimate(req.body.budget);
    const now = new Date();
    const lead = await getPrisma().lead.create({
      data: {
        ...req.body,
        clientId: req.user.clientId,
        ownerId: req.body.ownerId || req.user.userId || null,
        score,
        estimatedValue,
        lastActivityAt: now,
      },
      include: { owner: { select: { id: true, name: true, email: true } } },
    });
    res.status(201).json(lead);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    // Tenant isolation: only the owning studio may modify this lead.
    const owns = await getPrisma().lead.findFirst({ where: { id: req.params.id, clientId: req.user.clientId }, select: { id: true } });
    if (!owns) return res.status(404).json({ message: "Lead not found" });
    const { activity, activityReplace, clientId, id, ...rest } = req.body;
    const updateData = { ...rest, lastActivityAt: new Date() };

    if (Array.isArray(activityReplace)) {
      updateData.activity = activityReplace;
    }

    // Recompute estimatedValue when budget changes
    if ("budget" in rest && !("estimatedValue" in rest)) {
      updateData.estimatedValue = parseBudgetEstimate(rest.budget);
    }

    // Recalculate score if any score-affecting field is being updated
    if (SCORE_FIELDS.some(f => f in rest)) {
      const existing = await getPrisma().lead.findUnique({
        where: { id: req.params.id },
        select: { budget: true, source: true, message: true, notes: true, phone: true, eventType: true, eventDate: true, location: true, company: true },
      });
      const merged = { ...existing, ...rest };
      updateData.score = calculateLeadScore(merged);
    }

    // Status transition timestamps
    if ("status" in rest) {
      if (rest.status === "Booked") updateData.wonAt = new Date();
      if (rest.status === "Lost")   updateData.lostAt = new Date();
      if (rest.status !== "Booked" && rest.status !== "Lost") {
        // Re-opening: clear terminal timestamps
        updateData.wonAt = null;
        updateData.lostAt = null;
      }
    }

    if (activity) {
      const existing = await getPrisma().lead.findUnique({ where: { id: req.params.id }, select: { activity: true } });
      const currentActivity = Array.isArray(existing?.activity) ? existing.activity : [];
      updateData.activity = [...currentActivity, activity];
    }

    const lead = await getPrisma().lead.update({
      where: { id: req.params.id },
      data: updateData,
      include: {
        conversation: true,
        owner: { select: { id: true, name: true, email: true } },
      },
    });

    // Auto-create Draft payment on Booked
    if (rest.status === "Booked") {
      const existing = await getPrisma().payment.findFirst({ where: { leadId: req.params.id } });
      if (!existing) {
        await getPrisma().payment.create({
          data: {
            clientId: req.user.clientId,
            leadId: lead.id,
            company: lead.company || lead.name,
            amount: lead.estimatedValue || 0,
            type: "Deposit",
            status: "Draft",
            method: "Awaiting",
          },
        });
      }
    }

    res.json({ ...lead, transcript: lead.conversation?.messages ?? [], time: lead.createdAt });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.delete("/:id", async (req, res) => {
  const r = await getPrisma().lead.deleteMany({ where: { id: req.params.id, clientId: req.user.clientId } });
  if (r.count === 0) return res.status(404).json({ message: "Lead not found" });
  res.json({ message: "Lead deleted" });
});

export default router;
