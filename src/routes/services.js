import { Router } from "express";
import getPrisma from "../db/prisma.js";

const router = Router();

router.get("/", async (req, res) => {
  res.json(await getPrisma().service.findMany({ where: { clientId: req.user.clientId } }));
});
router.get("/:id", async (req, res) => {
  const s = await getPrisma().service.findUnique({ where: { id: req.params.id } });
  if (!s) return res.status(404).json({ message: "Service not found" });
  res.json(s);
});
router.post("/", async (req, res) => {
  try { res.status(201).json(await getPrisma().service.create({ data: { ...req.body, clientId: req.user.clientId } })); }
  catch (err) { res.status(400).json({ message: err.message }); }
});
router.patch("/:id", async (req, res) => {
  try { res.json(await getPrisma().service.update({ where: { id: req.params.id }, data: req.body })); }
  catch (err) { res.status(400).json({ message: err.message }); }
});
router.delete("/:id", async (req, res) => {
  await getPrisma().service.delete({ where: { id: req.params.id } });
  res.json({ message: "Service deleted" });
});

export default router;
