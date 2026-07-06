import crypto from "crypto";
import getPrisma, { ensureConnected } from "../db/prisma.js";

/* Writes an append-only audit record attributed to the acting admin.
   Best-effort: a logging failure must never break the underlying action, but it
   is reported to the server console for investigation. Each record carries a
   SHA-256 integrity digest of its content (tamper-evidence groundwork). */
export async function logAudit({ req, action, target = "", targetId = "", meta = {} }) {
  try {
    const actor = req?.admin || {};
    const fwd = (req?.headers?.["x-forwarded-for"] || "").toString().split(",")[0].trim();
    const ip = fwd || req?.socket?.remoteAddress || "";
    const base = {
      actorId: actor.adminId || null,
      actorEmail: actor.email || "",
      actorRole: actor.role || "",
      action,
      target,
      targetId,
      meta,
      ip,
    };
    const hash = crypto
      .createHash("sha256")
      .update(JSON.stringify(base) + new Date().toISOString())
      .digest("hex");
    await ensureConnected();
    await getPrisma().auditLog.create({ data: { ...base, hash } });
  } catch (e) {
    console.error("[audit] failed to record", action, "-", e.message);
  }
}
