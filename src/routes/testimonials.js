import { Router } from "express";
import getPrisma from "../db/prisma.js";
import { updateOwned, deleteOwned } from "../lib/scoped.js";

const router = Router();

router.get("/", async (req, res) => {
  try {
    res.json(
      await getPrisma().testimonial.findMany({
        where: { clientId: req.user.clientId },
        orderBy: { order: "asc" },
      })
    );
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/", async (req, res) => {
  try {
    res.status(201).json(
      await getPrisma().testimonial.create({
        data: { ...req.body, clientId: req.user.clientId },
      })
    );
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const { clientId, id, ...data } = req.body;
    const updated = await updateOwned(getPrisma().testimonial, req.params.id, req.user.clientId, data);
    if (!updated) return res.status(404).json({ message: "Testimonial not found" });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.delete("/:id", async (req, res) => {
  const ok = await deleteOwned(getPrisma().testimonial, req.params.id, req.user.clientId);
  if (!ok) return res.status(404).json({ message: "Testimonial not found" });
  res.json({ message: "Testimonial deleted" });
});

export default router;
