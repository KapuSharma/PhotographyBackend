import { Router } from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { requireActiveSubscription } from "../lib/subscription.js";

const router = Router();
const UPLOAD_DIR = path.resolve("uploads");

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_DIR, req.user.clientId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || ".jpg").toLowerCase().replace(/[^.a-z0-9]/g, "");
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
});

// POST /uploads — accepts one image file ("file"), returns its public URL.
// Gated: unlimited while the subscription is active, blocked once it expires.
router.post("/", requireActiveSubscription, (req, res) => {
  upload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message });
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });
    const url = `${req.protocol}://${req.get("host")}/uploads/${req.user.clientId}/${req.file.filename}`;
    res.status(201).json({ url });
  });
});

export default router;
