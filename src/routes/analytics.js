import { Router } from "express";
import getPrisma from "../db/prisma.js";

const router = Router();

// GET /analytics — aggregated stats from existing DB data, no new tracking needed
router.get("/", async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const prisma = getPrisma();

    // ── Run all queries in parallel ──────────────────────────────────────────
    const [leads, payments, conversations] = await Promise.all([
      prisma.lead.findMany({
        where: { clientId },
        select: { status: true, source: true, score: true, createdAt: true },
      }),
      prisma.payment.findMany({
        where: { clientId },
        select: { amount: true, status: true, createdAt: true },
      }),
      prisma.aIConversation.findMany({
        where: { clientId },
        select: { leadId: true, messages: true, createdAt: true },
      }),
    ]);

    // ── Lead funnel ──────────────────────────────────────────────────────────
    const funnel = {
      new:      leads.filter(l => l.status === 'New').length,
      contacted: leads.filter(l => l.status === 'Contacted').length,
      quoted:   leads.filter(l => l.status === 'Quoted').length,
      booked:   leads.filter(l => l.status === 'Booked').length,
      total:    leads.length,
    };

    // ── Lead sources ─────────────────────────────────────────────────────────
    const sourceMap = {};
    for (const l of leads) {
      const s = l.source || 'Unknown';
      sourceMap[s] = (sourceMap[s] || 0) + 1;
    }
    const leadSources = Object.entries(sourceMap)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    // ── Avg lead score ───────────────────────────────────────────────────────
    const avgScore = leads.length
      ? Math.round(leads.reduce((sum, l) => sum + (l.score || 0), 0) / leads.length)
      : 0;

    // ── Revenue by month (last 6 months) ─────────────────────────────────────
    const now = new Date();
    const monthlyRevenue = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const label = d.toLocaleString('en', { month: 'short' });
      const year  = d.getFullYear();
      const month = d.getMonth();

      const monthPayments = payments.filter(p => {
        const pd = new Date(p.createdAt);
        return pd.getFullYear() === year && pd.getMonth() === month;
      });

      const confirmed = monthPayments
        .filter(p => p.status === 'Paid')
        .reduce((sum, p) => sum + (p.amount || 0), 0);

      const pipeline = monthPayments
        .filter(p => p.status === 'Draft' || p.status === 'Sent')
        .reduce((sum, p) => sum + (p.amount || 0), 0);

      monthlyRevenue.push({ label, confirmed, pipeline, total: confirmed + pipeline });
    }

    // ── Total revenue ────────────────────────────────────────────────────────
    const totalRevenue = payments
      .filter(p => p.status === 'Paid')
      .reduce((sum, p) => sum + (p.amount || 0), 0);

    const pipelineRevenue = payments
      .filter(p => p.status === 'Draft' || p.status === 'Sent')
      .reduce((sum, p) => sum + (p.amount || 0), 0);

    // ── Chatbot stats ────────────────────────────────────────────────────────
    const totalChats     = conversations.length;
    const briefsComplete = conversations.filter(c => c.leadId).length;
    const briefRate      = totalChats > 0
      ? Math.round((briefsComplete / totalChats) * 100)
      : 0;

    // Avg messages per session — messages is a JSON array
    const totalMessages = conversations.reduce((sum, c) => {
      const msgs = Array.isArray(c.messages) ? c.messages : [];
      return sum + msgs.length;
    }, 0);
    const avgMessages = totalChats > 0
      ? (totalMessages / totalChats).toFixed(1)
      : '0';

    // Leads captured via chatbot (source contains 'chatbot' or 'AI')
    const chatbotLeads = leads.filter(l =>
      (l.source || '').toLowerCase().includes('chatbot') ||
      (l.source || '').toLowerCase().includes('ai')
    ).length;

    // ── Leads created per month (last 6 months) ──────────────────────────────
    const monthlyLeads = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const label = d.toLocaleString('en', { month: 'short' });
      const year  = d.getFullYear();
      const month = d.getMonth();
      const count = leads.filter(l => {
        const ld = new Date(l.createdAt);
        return ld.getFullYear() === year && ld.getMonth() === month;
      }).length;
      monthlyLeads.push({ label, count });
    }

    res.json({
      funnel,
      leadSources,
      avgScore,
      monthlyRevenue,
      totalRevenue,
      pipelineRevenue,
      chatbot: {
        totalChats,
        briefsComplete,
        briefRate,
        avgMessages,
        chatbotLeads,
      },
      monthlyLeads,
      totals: {
        leads: leads.length,
        booked: funnel.booked,
        payments: payments.length,
        conversations: conversations.length,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
