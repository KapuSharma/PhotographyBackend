import { Router } from "express";
import getPrisma from "../db/prisma.js";

const router = Router();

// GET /profile — load this client's photographer profile
router.get("/", async (req, res) => {
  try {
    const profile = await getPrisma().photographerProfile.findUnique({
      where: { clientId: req.user.clientId },
    });
    res.json(profile || {});
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /profile — upsert the full profile for this client
router.put("/", async (req, res) => {
  try {
    const {
      fullName, studioName, location, website, phone, email,
      yearsExperience, bio, niches, shootingStyle, editingStyle,
      minBudget, depositPercent, paymentTerms, avgProjectValue,
      bookingLeadTime, turnaround, travelsInterstate, travelsInternational,
      idealClientDesc, pastClients,
      responseStyle, dealBreakers, qualifyingQuestions, closingLine,
    } = req.body;

    const data = {
      fullName:             fullName             ?? null,
      studioName:           studioName           ?? null,
      location:             location             ?? null,
      website:              website              ?? null,
      phone:                phone                ?? null,
      email:                email                ?? null,
      yearsExperience:      yearsExperience      ?? null,
      bio:                  bio                  ?? null,
      niches:               Array.isArray(niches) ? niches : [],
      shootingStyle:        shootingStyle        ?? null,
      editingStyle:         editingStyle         ?? null,
      minBudget:            minBudget            ?? null,
      depositPercent:       depositPercent       ?? "50",
      paymentTerms:         paymentTerms         ?? null,
      avgProjectValue:      avgProjectValue      ?? null,
      bookingLeadTime:      bookingLeadTime      ?? null,
      turnaround:           turnaround           ?? null,
      travelsInterstate:    travelsInterstate    ?? "No",
      travelsInternational: travelsInternational ?? "No",
      idealClientDesc:      idealClientDesc      ?? null,
      pastClients:          pastClients          ?? null,
      responseStyle:        responseStyle        ?? "Professional",
      dealBreakers:         dealBreakers         ?? null,
      qualifyingQuestions:  qualifyingQuestions  ?? null,
      closingLine:          closingLine          ?? null,
    };

    const clientExists = await getPrisma().client.findUnique({
      where: { id: req.user.clientId },
      select: { id: true },
    });
    if (!clientExists) {
      return res.status(404).json({ message: `Client ${req.user.clientId} not found` });
    }

    const profile = await getPrisma().photographerProfile.upsert({
      where:  { clientId: req.user.clientId },
      create: { clientId: req.user.clientId, ...data },
      update: data,
    });

    res.json(profile);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

export default router;
