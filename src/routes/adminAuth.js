import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import getPrisma, { ensureConnected } from "../db/prisma.js";
import { adminAuth } from "../middleware/adminAuth.js";
import { logAudit } from "../lib/audit.js";
import { getRolePermissions } from "../lib/permissions.js";
import { generateSecret, verifyTOTP, otpauthURL } from "../lib/totp.js";

const router = Router();

/* Only the trusted super-admin server proxy (which injects the shared secret)
   can reach these endpoints — defence in depth on top of credential auth. */
router.use((req, res, next) => {
  const secret = req.headers["x-admin-secret"];
  if (!process.env.SUPERADMIN_SECRET || secret !== process.env.SUPERADMIN_SECRET) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
});

// POST /admin/login — email + password → short-lived admin JWT.
router.post("/login", async (req, res) => {
  const { email, password, code } = req.body || {};
  if (!email || !password) return res.status(400).json({ message: "Email and password are required" });
  try {
    await ensureConnected();
    const admin = await getPrisma().adminUser.findUnique({ where: { email: String(email).toLowerCase() } });
    // Constant-ish response regardless of which check fails (no user enumeration).
    if (!admin || !admin.active || !(await bcrypt.compare(password, admin.passwordHash))) {
      return res.status(401).json({ message: "Invalid email or password" });
    }
    // Second factor, when enabled.
    if (admin.mfaEnabled) {
      if (!code) return res.status(401).json({ mfaRequired: true, message: "Enter your authenticator code" });
      if (!verifyTOTP(admin.mfaSecret, code)) return res.status(401).json({ mfaRequired: true, message: "Invalid authenticator code" });
    }
    await getPrisma().adminUser.update({ where: { id: admin.id }, data: { lastLogin: new Date() } });
    const token = jwt.sign(
      { kind: "admin", adminId: admin.id, email: admin.email, role: admin.role },
      process.env.JWT_SECRET,
      { expiresIn: "12h" }
    );
    await logAudit({
      req: { ...req, admin: { adminId: admin.id, email: admin.email, role: admin.role } },
      action: "auth.login", target: "admin", targetId: admin.id,
    });
    res.json({
      token,
      admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role, permissions: await getRolePermissions(admin.role) },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /admin/me — the signed-in admin (validates the token).
router.get("/me", adminAuth, async (req, res) => {
  try {
    await ensureConnected();
    const admin = await getPrisma().adminUser.findUnique({
      where: { id: req.admin.adminId },
      select: { id: true, name: true, email: true, role: true, active: true, mfaEnabled: true },
    });
    if (!admin || !admin.active) return res.status(401).json({ message: "Account inactive" });
    res.json({ ...admin, permissions: await getRolePermissions(admin.role) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /admin/logout — stateless; the proxy clears the cookie. Logged for audit.
router.post("/logout", adminAuth, async (req, res) => {
  await logAudit({ req, action: "auth.logout", target: "admin", targetId: req.admin.adminId });
  res.json({ ok: true });
});

// POST /admin/change-password — verify current, set a new password.
router.post("/change-password", adminAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ message: "Both fields are required" });
  if (String(newPassword).length < 8) return res.status(400).json({ message: "New password must be at least 8 characters" });
  try {
    await ensureConnected();
    const admin = await getPrisma().adminUser.findUnique({ where: { id: req.admin.adminId } });
    if (!admin || !(await bcrypt.compare(currentPassword, admin.passwordHash))) {
      return res.status(400).json({ message: "Current password is incorrect" });
    }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await getPrisma().adminUser.update({ where: { id: admin.id }, data: { passwordHash } });
    await logAudit({ req, action: "auth.password_change", target: "admin", targetId: admin.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /admin/mfa/setup — issue a pending TOTP secret (not yet enabled).
router.post("/mfa/setup", adminAuth, async (req, res) => {
  try {
    await ensureConnected();
    const secret = generateSecret();
    const admin = await getPrisma().adminUser.update({
      where: { id: req.admin.adminId },
      data: { mfaSecret: secret, mfaEnabled: false },
      select: { email: true },
    });
    res.json({ secret, otpauth: otpauthURL(secret, admin.email) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /admin/mfa/enable — verify a code against the pending secret, then turn MFA on.
router.post("/mfa/enable", adminAuth, async (req, res) => {
  const { code } = req.body || {};
  try {
    await ensureConnected();
    const admin = await getPrisma().adminUser.findUnique({ where: { id: req.admin.adminId } });
    if (!admin?.mfaSecret) return res.status(400).json({ message: "Start MFA setup first" });
    if (!verifyTOTP(admin.mfaSecret, code)) return res.status(400).json({ message: "Invalid code — try again" });
    await getPrisma().adminUser.update({ where: { id: admin.id }, data: { mfaEnabled: true } });
    await logAudit({ req, action: "mfa.enable", target: "admin", targetId: admin.id });
    res.json({ ok: true, mfaEnabled: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /admin/mfa/disable — require current password AND a valid code to turn MFA off.
router.post("/mfa/disable", adminAuth, async (req, res) => {
  const { password, code } = req.body || {};
  try {
    await ensureConnected();
    const admin = await getPrisma().adminUser.findUnique({ where: { id: req.admin.adminId } });
    if (!admin) return res.status(404).json({ message: "Not found" });
    if (!admin.mfaEnabled) return res.json({ ok: true, mfaEnabled: false });
    const okPw = await bcrypt.compare(password || "", admin.passwordHash);
    if (!okPw || !verifyTOTP(admin.mfaSecret, code)) {
      return res.status(400).json({ message: "Password or code incorrect" });
    }
    await getPrisma().adminUser.update({ where: { id: admin.id }, data: { mfaEnabled: false, mfaSecret: null } });
    await logAudit({ req, action: "mfa.disable", target: "admin", targetId: admin.id });
    res.json({ ok: true, mfaEnabled: false });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
