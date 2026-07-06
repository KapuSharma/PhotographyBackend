import { Router } from "express";
import getPrisma from "../db/prisma.js";

const router = Router();

// GET /site-content — load current client's saved site content
router.get("/", async (req, res) => {
  try {
    const content = await getPrisma().siteContent.findUnique({
      where: { clientId: req.user.clientId },
    });
    res.json(content || {});
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /site-content — upsert one DISC section at a time
// Body: { section: 'hero' | 'brand' | 'trust', data: { ... } }
router.put("/", async (req, res) => {
  try {
    const { section, data } = req.body;
    if (!section || !data) {
      return res.status(400).json({ message: "section and data are required" });
    }
    const allowed = ["hero", "brand", "trust", "cta", "about", "contact", "galleryCategories", "header", "footer", "sections", "galleryPage", "servicesPage", "reviewsPage", "blogPage", "blogPostPage", "packagesPage", "commonSections"];
    if (!allowed.includes(section)) {
      return res.status(400).json({ message: `section must be one of: ${allowed.join(", ")}` });
    }
    const result = await getPrisma().siteContent.upsert({
      where: { clientId: req.user.clientId },
      create: { clientId: req.user.clientId, [section]: data },
      update: { [section]: data },
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

export default router;
