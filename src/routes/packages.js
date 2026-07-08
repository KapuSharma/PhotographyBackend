import { Router } from "express";
import getPrisma from "../db/prisma.js";
import { updateOwned, deleteOwned } from "../lib/scoped.js";

const router = Router();

// Whitelist the real Package columns so a stray/unknown field from the client
// can never 400 the whole save.
const PACKAGE_FIELDS = ["name", "price", "priceMax", "duration", "bestFor", "includes", "popular", "active", "order", "content", "images", "badge", "category", "description"];
const pickPackage = (body = {}) =>
  PACKAGE_FIELDS.reduce((acc, k) => { if (body[k] !== undefined) acc[k] = body[k]; return acc; }, {});

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
        data: { ...pickPackage(req.body), clientId: req.user.clientId },
      })
    );
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const data = pickPackage(req.body);
    const updated = await updateOwned(getPrisma().package, req.params.id, req.user.clientId, data);
    if (!updated) return res.status(404).json({ message: "Package not found" });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.delete("/:id", async (req, res) => {
  const ok = await deleteOwned(getPrisma().package, req.params.id, req.user.clientId);
  if (!ok) return res.status(404).json({ message: "Package not found" });
  res.json({ message: "Package deleted" });
});

export default router;
