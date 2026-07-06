import { Router } from "express";
import getPrisma from "../db/prisma.js";
import { findOwned, updateOwned, deleteOwned } from "../lib/scoped.js";

const router = Router();

router.get("/", async (req, res) => {
  res.json(await getPrisma().fAQ.findMany({ where: { clientId: req.user.clientId } }));
});
router.get("/:id", async (req, res) => {
  const faq = await findOwned(getPrisma().fAQ, req.params.id, req.user.clientId);
  if (!faq) return res.status(404).json({ message: "FAQ not found" });
  res.json(faq);
});
router.post("/", async (req, res) => {
  try {
    const { clientId, id, ...data } = req.body || {};
    res.status(201).json(await getPrisma().fAQ.create({ data: { ...data, clientId: req.user.clientId } }));
  } catch (err) { res.status(400).json({ message: err.message }); }
});
router.patch("/:id", async (req, res) => {
  try {
    const { clientId, id, ...data } = req.body || {};
    const updated = await updateOwned(getPrisma().fAQ, req.params.id, req.user.clientId, data);
    if (!updated) return res.status(404).json({ message: "FAQ not found" });
    res.json(updated);
  } catch (err) { res.status(400).json({ message: err.message }); }
});
router.delete("/:id", async (req, res) => {
  const ok = await deleteOwned(getPrisma().fAQ, req.params.id, req.user.clientId);
  if (!ok) return res.status(404).json({ message: "FAQ not found" });
  res.json({ message: "FAQ deleted" });
});

export default router;
