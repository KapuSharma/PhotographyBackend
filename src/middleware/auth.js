import jwt from "jsonwebtoken";
import getPrisma, { ensureConnected } from "../db/prisma.js";

export default async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorised — no token" });
  }
  let decoded;
  try {
    decoded = jwt.verify(header.split(" ")[1], process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: "Unauthorised — invalid token" });
  }
  req.user = decoded; // { userId, clientId, email, role, [impersonatedBy, sid] }

  // Impersonation tokens are only valid while their server-side session is live
  // — this makes "log in as tenant" revocable and enforces the time-box.
  if (decoded.impersonatedBy && decoded.sid) {
    try {
      await ensureConnected();
      const s = await getPrisma().impersonationSession.findUnique({ where: { id: decoded.sid } });
      if (!s || !s.active || new Date(s.expiresAt) <= new Date()) {
        return res.status(401).json({ message: "Impersonation session ended", code: "IMPERSONATION_ENDED" });
      }
    } catch {
      return res.status(401).json({ message: "Impersonation check failed", code: "IMPERSONATION_ENDED" });
    }
  }
  next();
}
