import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import getPrisma from "../db/prisma.js";

const router = Router();

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ message: "Email and password are required" });
  try {
    const user = await getPrisma().user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ message: "Invalid email or password" });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ message: "Invalid email or password" });

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
