import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import getPrisma from "../db/prisma.js";

const router = Router();

// POST /auth/reset-password — a photographer sets a new password via a one-time
// token link issued by an admin. The admin never sees or sets the password.
router.post("/reset-password", async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword) return res.status(400).json({ message: "Token and new password are required" });
  if (String(newPassword).length < 8) return res.status(400).json({ message: "Password must be at least 8 characters" });
  try {
    const hash = crypto.createHash("sha256").update(String(token)).digest("hex");
    const user = await getPrisma().user.findFirst({ where: { resetTokenHash: hash, resetTokenExpiry: { gt: new Date() } } });
    if (!user) return res.status(400).json({ message: "This reset link is invalid or has expired." });
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await getPrisma().user.update({ where: { id: user.id }, data: { passwordHash, resetTokenHash: null, resetTokenExpiry: null } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ message: "Email and password are required" });
  try {
    const user = await getPrisma().user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ message: "Invalid email or password" });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ message: "Invalid email or password" });

    // Blocked when the studio is suspended or archived by the platform.
    const client = await getPrisma().client.findUnique({ where: { id: user.clientId }, select: { status: true, deletedAt: true } });
    if (client?.deletedAt) return res.status(403).json({ message: "This account has been closed. Contact support." });
    if ((client?.status || "active").toLowerCase() === "suspended") {
      return res.status(403).json({ message: "Your studio is suspended. Contact HOI support to restore access." });
    }

    await getPrisma().user.update({ where: { id: user.id }, data: { lastLogin: new Date() } });

    const token = jwt.sign(
      { userId: user.id, clientId: user.clientId, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, clientId: user.clientId },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/me", async (req, res) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ message: "No token" });
  try {
    const decoded = jwt.verify(header.split(" ")[1], process.env.JWT_SECRET);
    const user = await getPrisma().user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, name: true, email: true, role: true, clientId: true },
    });
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
});

export default router;
