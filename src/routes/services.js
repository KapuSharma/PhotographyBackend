import { Router } from "express";
import getPrisma from "../db/prisma.js";
import { findOwned, updateOwned, deleteOwned } from "../lib/scoped.js";

const router = Router();

router.get("/", async (req, res) => {
  res.json(await getPrisma().service.findMany({ where: { clientId: req.user.clientId } }));
});
router.get("/:id", async (req, res) => {
  const s = await findOwned(getPrisma().service, req.params.id, req.user.clientId);
  if (!s) return res.status(404).json({ message: "Service not found" });
  res.json(s);
});
router.post("/", async (req, res) => {
  try {
    const { clientId, id, ...data } = req.body || {};
    res.status(201).json(await getPrisma().service.create({ data: { ...data, clientId: req.user.clientId } }));
  } catch (err) { res.status(400).json({ message: err.message }); }
});
router.patch("/:id", async (req, res) => {
  try {
    const { clientId, id, ...data } = req.body || {};
    const updated = await updateOwned(getPrisma().service, req.params.id, req.user.clientId, data);
    if (!updated) return res.status(404).json({ message: "Service not found" });
    res.json(updated);
  } catch (err) { res.status(400).json({ message: err.message }); }
});
router.delete("/:id", async (req, res) => {
  const ok = await deleteOwned(getPrisma().service, req.params.id, req.user.clientId);
  if (!ok) return res.status(404).json({ message: "Service not found" });
  res.json({ message: "Service deleted" });
});

export default router;
