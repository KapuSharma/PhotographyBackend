import { Router } from "express";
import getPrisma from "../db/prisma.js";

const router = Router();

router.get("/", async (req, res) => {
  const config = await getPrisma().aIConfig.findUnique({ where: { clientId: req.user.clientId } });
  if (!config) return res.json({
    aiAssistantName: "",
    primaryNiche: "commercial",
    tone: "professional",
    smsNotifications: true,
    humanDelay: false,
    greetingMessage: "",
    bookingCtaText: "Book a Session",
  });
  res.json(config);
});

router.put("/", async (req, res) => {
  try {
    const config = await getPrisma().aIConfig.upsert({
      where: { clientId: req.user.clientId },
      update: req.body,
      create: { clientId: req.user.clientId, ...req.body },
    });
    res.json(config);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

export default router;
