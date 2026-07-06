import jwt from "jsonwebtoken";
import { can } from "../lib/permissions.js";

/* Verifies a Super Admin JWT (kind:"admin"), distinct from tenant/photographer
   tokens so a photographer token can never be used against admin endpoints.
   Expects the super-admin proxy to forward the token as a Bearer header. */
export function adminAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Admin authentication required" });
  }
  try {
    const decoded = jwt.verify(header.split(" ")[1], process.env.JWT_SECRET);
    if (decoded.kind !== "admin") {
      return res.status(401).json({ message: "Not an admin token" });
    }
    req.admin = decoded; // { kind:"admin", adminId, email, role }
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired admin session" });
  }
}

/** Gate a route behind a permission key; super_admin passes everything.
    Resolves against system + custom (DB-backed) roles. */
export function requirePermission(permission) {
  return async (req, res, next) => {
    if (!req.admin) return res.status(401).json({ message: "Admin authentication required" });
    try {
      if (!(await can(req.admin.role, permission))) {
        return res.status(403).json({ message: "Insufficient permission" });
      }
      next();
    } catch (err) {
      return res.status(500).json({ message: "Permission check failed" });
    }
  };
}
