import express from "express";
import { fetchManyRss } from "../hunt/rssFetcher.js";
import { scorePost } from "../hunt/scorer.js";
import getPrisma from "../db/prisma.js";

const router = express.Router();

/* ── Sources ─────────────────────────────────────────── */

router.get("/sources", async (req, res) => {
  try {
    const sources = await getPrisma().huntSource.findMany({
      where: { clientId: req.user.clientId },
      orderBy: { createdAt: "asc" },
    });
    res.json(sources);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/sources", async (req, res) => {
  try {
    const { platform, niche = "Other", location = "", feeds = [], enabled = true } = req.body;
    if (!platform) return res.status(400).json({ error: "platform is required" });
    const source = await getPrisma().huntSource.create({
      data: { clientId: req.user.clientId, platform, niche, location, feeds, enabled },
    });
    res.json(source);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/sources/:id", async (req, res) => {
  try {
    const source = await getPrisma().huntSource.findFirst({
      where: { id: req.params.id, clientId: req.user.clientId },
    });
    if (!source) return res.status(404).json({ error: "Not found" });
    const { platform, niche, location, feeds, enabled } = req.body;
    const updated = await getPrisma().huntSource.update({
      where: { id: req.params.id },
      data: {
        ...(platform !== undefined && { platform }),
        ...(niche !== undefined && { niche }),
        ...(location !== undefined && { location }),
        ...(feeds !== undefined && { feeds }),
        ...(enabled !== undefined && { enabled }),
      },
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/sources/:id", async (req, res) => {
  try {
    const source = await getPrisma().huntSource.findFirst({
      where: { id: req.params.id, clientId: req.user.clientId },
    });
    if (!source) return res.status(404).json({ error: "Not found" });
    await getPrisma().huntSignal.deleteMany({ where: { sourceId: req.params.id } });
    await getPrisma().huntSource.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Signals ─────────────────────────────────────────── */

router.get("/signals", async (req, res) => {
  try {
    const { platform, status } = req.query;
    const signals = await getPrisma().huntSignal.findMany({
      where: {
        clientId: req.user.clientId,
        ...(platform && platform !== "All" && { platform }),
        ...(status && status !== "All" && { status }),
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json(signals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/signals/:id", async (req, res) => {
  try {
    const signal = await getPrisma().huntSignal.findFirst({
      where: { id: req.params.id, clientId: req.user.clientId },
    });
    if (!signal) return res.status(404).json({ error: "Not found" });
    const updated = await getPrisma().huntSignal.update({
      where: { id: req.params.id },
      data: { status: req.body.status },
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Run Hunt ────────────────────────────────────────── */

router.post("/run", async (req, res) => {
  try {
    const { sourceId, platform = "X", rssUrls, minConfidence = 20, locationFilter = "" } = req.body || {};
    if (!Array.isArray(rssUrls) || rssUrls.length === 0) {
      return res.status(400).json({ error: "rssUrls array is required" });
    }

    const { items, errors } = await fetchManyRss(rssUrls);

    const scored = await Promise.all(
      items.map(async (it) => {
        const text = [it.title, it.content].filter(Boolean).join(" — ");
        const score = await scorePost({ text, author: it.author, platform });
        return {
          platform,
          profileName: it.author || extractHandleFromUrl(it.link, platform) || "Unknown",
          profileHandle: extractHandleFromUrl(it.link, platform) || "",
          profileUrl: extractProfileUrl(it.link) || "",
          postUrl: it.link,
          postContent: score.summary || text.slice(0, 280),
          city: score.city || "",
          region: "",
          niche: score.niche,
          confidence: score.confidence,
          matchedKeywords: score.matchedKeywords,
          pubDate: it.pubDate ? new Date(it.pubDate) : null,
        };
      }),
    );

    const loc = (locationFilter || "").trim().toLowerCase();
    const filtered = scored.filter((s) => {
      if (s.confidence < minConfidence) return false;
      if (loc && s.city && !s.city.toLowerCase().includes(loc)) return false;
      return true;
    });

    filtered.sort((a, b) => b.confidence - a.confidence);
    console.log(`[hunt/run] fetched=${items.length} scored=${scored.length} filtered=${filtered.length} errors=${errors.length}`);

    // Persist to DB if sourceId provided
    let saved = [];
    if (sourceId) {
      // Avoid duplicates by postUrl
      const existingUrls = new Set(
        (await getPrisma().huntSignal.findMany({
          where: { sourceId, clientId: req.user.clientId },
          select: { postUrl: true },
        })).map((s) => s.postUrl),
      );

      const toInsert = filtered.filter((s) => s.postUrl && !existingUrls.has(s.postUrl));

      if (toInsert.length > 0) {
        await getPrisma().huntSignal.createMany({
          data: toInsert.map((s) => ({
            clientId: req.user.clientId,
            sourceId,
            platform: s.platform,
            profileName: s.profileName,
            profileHandle: s.profileHandle,
            profileUrl: s.profileUrl,
            postUrl: s.postUrl,
            postContent: s.postContent,
            city: s.city,
            region: s.region,
            niche: s.niche,
            confidence: s.confidence,
            matchedKeywords: s.matchedKeywords,
            status: "New",
            pubDate: s.pubDate,
          })),
        });
      }

      saved = await getPrisma().huntSignal.findMany({
        where: { sourceId, clientId: req.user.clientId },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
    }

    res.json({
      platform,
      totalFetched: items.length,
      totalMatched: filtered.length,
      signals: sourceId ? saved : filtered,
      errors,
    });
  } catch (err) {
    console.error("[hunt/run]", err);
    res.status(500).json({ error: err.message || "hunt failed" });
  }
});

function extractHandleFromUrl(url, platform = "X") {
  if (!url) return "";
  const patterns = {
    X: /(?:twitter\.com|x\.com|nitter\.[^/]+)\/([^/?#]+)/i,
    Instagram: /instagram\.com\/([^/?#]+)/i,
    Facebook: /facebook\.com\/([^/?#]+)/i,
    LinkedIn: /linkedin\.com\/in\/([^/?#]+)/i,
  };
  const re = patterns[platform] || patterns.X;
  const m = url.match(re);
  return m ? `@${m[1]}` : "";
}

function extractProfileUrl(url) {
  if (!url) return "";
  const m = url.match(/^(https?:\/\/[^/]+\/[^/?#]+)/i);
  return m ? m[1] : "";
}

export default router;
