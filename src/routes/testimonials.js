import { Router } from "express";
import getPrisma from "../db/prisma.js";

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
    res.json(await getPrisma().testimonial.update({ where: { id: req.params.id }, data }));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.delete("/:id", async (req, res) => {
  await getPrisma().testimonial.delete({ where: { id: req.params.id } });
  res.json({ message: "Testimonial deleted" });
});

export default router;
