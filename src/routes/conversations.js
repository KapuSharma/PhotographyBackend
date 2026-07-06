import { Router } from "express";
import getPrisma from "../db/prisma.js";
import { updateOwned } from "../lib/scoped.js";

const router = Router();

router.get("/", async (req, res) => {
  res.json(await getPrisma().aIConversation.findMany({
    where: { clientId: req.user.clientId },
    orderBy: { createdAt: "desc" },
  }));
});
router.get("/:id", async (req, res) => {
  const convo = await getPrisma().aIConversation.findFirst({ where: { id: req.params.id, clientId: req.user.clientId } });
  if (!convo) return res.status(404).json({ message: "Conversation not found" });
  res.json(convo);
});
router.post("/", async (req, res) => {
  try {
    res.status(201).json(await getPrisma().aIConversation.create({
      data: { ...req.body, clientId: req.user.clientId },
    }));
  } catch (err) { res.status(400).json({ message: err.message }); }
});
router.patch("/:id", async (req, res) => {
  try {
    const updated = await updateOwned(getPrisma().aIConversation, req.params.id, req.user.clientId, { messages: req.body.messages });
    if (!updated) return res.status(404).json({ message: "Conversation not found" });
    res.json(updated);
  } catch (err) { res.status(400).json({ message: err.message }); }
});

export default router;
