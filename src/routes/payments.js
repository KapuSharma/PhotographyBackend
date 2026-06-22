import { Router } from "express";
import getPrisma from "../db/prisma.js";

const router = Router();

// GET all payments for client
router.get("/", async (req, res) => {
  try {
    const payments = await getPrisma().payment.findMany({
      where: { clientId: req.user.clientId },
      orderBy: { createdAt: "desc" },
    });
    res.json(payments);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET single payment — ownership check
router.get("/:id", async (req, res) => {
  try {
    const payment = await getPrisma().payment.findFirst({
      where: { id: req.params.id, clientId: req.user.clientId },
    });
    if (!payment) return res.status(404).json({ message: "Payment not found" });
    res.json(payment);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST create payment
router.post("/", async (req, res) => {
  try {
    const payment = await getPrisma().payment.create({
      data: { ...req.body, clientId: req.user.clientId },
    });
    res.status(201).json(payment);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// PATCH update payment — ownership check
router.patch("/:id", async (req, res) => {
  try {
    const existing = await getPrisma().payment.findFirst({
      where: { id: req.params.id, clientId: req.user.clientId },
    });
    if (!existing) return res.status(404).json({ message: "Payment not found" });
    const payment = await getPrisma().payment.update({
      where: { id: req.params.id },
      data: req.body,
    });
    res.json(payment);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE payment — ownership check
router.delete("/:id", async (req, res) => {
  try {
    const existing = await getPrisma().payment.findFirst({
      where: { id: req.params.id, clientId: req.user.clientId },
    });
    if (!existing) return res.status(404).json({ message: "Payment not found" });
    await getPrisma().payment.delete({ where: { id: req.params.id } });
    res.json({ message: "Payment deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
