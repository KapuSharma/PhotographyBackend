import { Router } from "express";
import getPrisma, { ensureConnected } from "../db/prisma.js";
import { logAudit } from "../lib/audit.js";

const router = Router();

/* POST /api/impersonation/end — the impersonation token ends its own session
   (the "Exit impersonation" button in the customer dashboard). Attributed to
   the admin who started it. authMiddleware is applied at the mount. */
router.post("/end", async (req, res) => {
  if (!req.user?.impersonatedBy || !req.user?.sid) {
    return res.status(400).json({ message: "Not an impersonation session" });
  }
  try {
    await ensureConnected();
    const s = await getPrisma().impersonationSession
      .update({ where: { id: req.user.sid }, data: { active: false, endedAt: new Date() } })
      .catch(() => null);
    await logAudit({
      req: { ...req, admin: { adminId: req.user.impersonatedBy, email: req.user.adminEmail || "", role: "" } },
      action: "impersonation.end", target: "studio", targetId: req.user.clientId,
      meta: { sessionId: req.user.sid },
    });
    res.json({ ok: true, ended: Boolean(s) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
