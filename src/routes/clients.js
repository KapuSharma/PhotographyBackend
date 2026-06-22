import { Router } from "express";
import getPrisma, { ensureConnected } from "../db/prisma.js";

const router = Router();

// Allowed public-site templates (keep in sync with the website's registry).
const TEMPLATES = ["aurora", "noir", "heritage", "alpenglow"];

// GET /clients/me — the signed-in client's own record (incl. selected template).
// Declared before "/:id" so "me" is not captured as an id.
router.get("/me", async (req, res) => {
  try {
    await ensureConnected();
    const c = await getPrisma().client.findUnique({ where: { id: req.user.clientId } });
    if (!c) return res.status(404).json({ message: "Client not found" });
    res.json(c);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /clients/me — self-service update of safe fields (website template, accent colour).
// Scoped to the token's own clientId; ignores any client-supplied id.
router.patch("/me", async (req, res) => {
  try {
    await ensureConnected();
    const data = {};
    if (typeof req.body.template === "string") {
      if (!TEMPLATES.includes(req.body.template)) {
        return res.status(400).json({ message: `template must be one of: ${TEMPLATES.join(", ")}` });
      }
      data.template = req.body.template;
    }
    if (typeof req.body.accentColor === "string") data.accentColor = req.body.accentColor;
    if (typeof req.body.studioName === "string") data.studioName = req.body.studioName;
    if (typeof req.body.logoUrl === "string") data.logoUrl = req.body.logoUrl;
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ message: "No updatable fields provided" });
    }
    const updated = await getPrisma().client.update({ where: { id: req.user.clientId }, data });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.get("/", async (req, res) => { res.json(await getPrisma().client.findMany()); });
router.get("/:id", async (req, res) => {
  const c = await getPrisma().client.findUnique({ where: { id: req.params.id } });
  if (!c) return res.status(404).json({ message: "Client not found" });
  res.json(c);
});
router.post("/", async (req, res) => {
  try { res.status(201).json(await getPrisma().client.create({ data: req.body })); }
  catch (err) { res.status(400).json({ message: err.message }); }
});
router.patch("/:id", async (req, res) => {
  try { res.json(await getPrisma().client.update({ where: { id: req.params.id }, data: req.body })); }
  catch (err) { res.status(400).json({ message: err.message }); }
});
router.delete("/:id", async (req, res) => {
  await getPrisma().client.delete({ where: { id: req.params.id } });
  res.json({ message: "Client deleted" });
});

export default router;
