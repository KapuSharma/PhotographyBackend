import { Router } from "express";
import getPrisma from "../db/prisma.js";

const router = Router();

router.get("/", async (req, res) => {
  try {
    res.json(
      await getPrisma().package.findMany({
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
      await getPrisma().package.create({
        data: { ...req.body, clientId: req.user.clientId },
      })
    );
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    // clientId is not editable from the body
    const { clientId, id, ...data } = req.body;
    res.json(await getPrisma().package.update({ where: { id: req.params.id }, data }));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.delete("/:id", async (req, res) => {
  await getPrisma().package.delete({ where: { id: req.params.id } });
  res.json({ message: "Package deleted" });
});

export default router;
