import { Router } from "express";
import getPrisma from "../db/prisma.js";
import { updateOwned, deleteOwned } from "../lib/scoped.js";

const router = Router();

const USER_FIELDS = { id: true, name: true, email: true, role: true, lastLogin: true, createdAt: true };

router.get("/", async (req, res) => {
  const users = await getPrisma().user.findMany({
    where: { clientId: req.user.clientId },
    select: USER_FIELDS,
  });
  res.json(users);
});
router.get("/:id", async (req, res) => {
  const user = await getPrisma().user.findFirst({
    where: { id: req.params.id, clientId: req.user.clientId },
    select: USER_FIELDS,
  });
  if (!user) return res.status(404).json({ message: "User not found" });
  res.json(user);
});
router.post("/", async (req, res) => {
  try {
    // A tenant can only create users inside their own studio.
    const { clientId, id, ...data } = req.body || {};
    const user = await getPrisma().user.create({
      data: { ...data, clientId: req.user.clientId },
      select: { id: true, name: true, email: true, role: true, createdAt: true },
    });
    res.status(201).json(user);
  } catch (err) { res.status(400).json({ message: err.message }); }
});
router.patch("/:id", async (req, res) => {
  try {
    const { clientId, id, ...data } = req.body || {};
    const updated = await updateOwned(getPrisma().user, req.params.id, req.user.clientId, data);
    if (!updated) return res.status(404).json({ message: "User not found" });
    const { passwordHash, ...safe } = updated;
    res.json(safe);
  } catch (err) { res.status(400).json({ message: err.message }); }
});
router.delete("/:id", async (req, res) => {
  const ok = await deleteOwned(getPrisma().user, req.params.id, req.user.clientId);
  if (!ok) return res.status(404).json({ message: "User not found" });
  res.json({ message: "User deleted" });
});

export default router;
