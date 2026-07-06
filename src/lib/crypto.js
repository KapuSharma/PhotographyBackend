import crypto from "crypto";

/* AES-256-GCM encryption for secrets at rest (e.g. AI provider keys).
   The key is derived from ENCRYPTION_KEY (or falls back to JWT_SECRET) so it's
   never stored in the DB. Format: ivHex:tagHex:cipherHex. */
function key() {
  const secret = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || "hoi-dev-fallback-key";
  return crypto.createHash("sha256").update(secret).digest(); // 32 bytes
}

export function encrypt(plain) {
  if (!plain) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decrypt(payload) {
  if (!payload) return "";
  try {
    const [ivH, tagH, dataH] = String(payload).split(":");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivH, "hex"));
    decipher.setAuthTag(Buffer.from(tagH, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(dataH, "hex")), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}
