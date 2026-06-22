import { Router } from "express";
import getPrisma from "../db/prisma.js";

const router = Router();

router.get("/", async (req, res) => {
  const users = await getPrisma().user.findMany({
    where: { clientId: req.user.clientId },
    select: { id: true, name: true, email: true, role: true, lastLogin: true, createdAt: true },
  });
  res.json(users);
});
router.get("/:id", async (req, res) => {
  const user = await getPrisma().user.findUnique({
    where: { id: req.params.id },
    select: { id: true, name: true, email: true, role: true, lastLogin: true, createdAt: true },
  });
  if (!user) return res.status(404).json({ message: "User not found" });
  res.json(user);
});
router.post("/", async (req, res) => {
  try {
    const user = await getPrisma().user.create({
      data: req.body,
      select: { id: true, name: true, email: true, role: true, createdAt: true },
    });
    res.status(201).json(user);
  } catch (err) { res.status(400).json({ message: err.message }); }
});
router.patch("/:id", async (req, res) => {
  try { res.json(await getPrisma().user.update({ where: { id: req.params.id }, data: req.body })); }
  catch (err) { res.status(400).json({ message: err.message }); }
});
router.delete("/:id", async (req, res) => {
  await getPrisma().user.delete({ where: { id: req.params.id } });
  res.json({ message: "User deleted" });
});

export default router;
