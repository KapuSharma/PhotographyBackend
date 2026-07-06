import getPrisma, { ensureConnected } from "../db/prisma.js";
import { decrypt } from "./crypto.js";

const ID = "platform";
const DEFAULTS = {
  maintenanceMode: false,
  maintenanceMessage: "We'll be back shortly — the platform is undergoing scheduled maintenance.",
  flags: { selfServeTrials: true, leadHunt: true, aiAssistant: true, publicBooking: true },
  ai: { provider: "groq", model: "llama-3.3-70b-versatile", temperature: 0.5, maxTokens: 800 },
  smtp: { host: "", port: 587, user: "", from: "", secure: false },
  storage: { provider: "local", bucket: "", region: "" },
  // Lead-Hunt platform controls: per-source enable map (missing/true = on) and a
  // platform default keyword set applied when a tenant hasn't configured its own.
  leadHunt: { sources: {}, defaultKeywords: [] },
};

// Short-lived in-memory cache so hot paths (e.g. the public site) don't hit the
// DB on every request. Invalidated on save.
let cache = null, cacheAt = 0;
const TTL = 30000;

export async function getSettings() {
  if (cache && Date.now() - cacheAt < TTL) return cache;
  await ensureConnected();
  const row = await getPrisma().platformSetting.findUnique({ where: { id: ID } });
  const d = row?.data || {};
  cache = { ...DEFAULTS, ...d, flags: { ...DEFAULTS.flags, ...(d.flags || {}) }, ai: { ...DEFAULTS.ai, ...(d.ai || {}) }, smtp: { ...DEFAULTS.smtp, ...(d.smtp || {}) }, storage: { ...DEFAULTS.storage, ...(d.storage || {}) }, leadHunt: { ...DEFAULTS.leadHunt, ...(d.leadHunt || {}) } };
  cacheAt = Date.now();
  return cache;
}

/** The active AI provider key — decrypted from settings, or the env fallback. */
export async function getAiKey() {
  const s = await getSettings();
  return (s.aiKeyEnc && decrypt(s.aiKeyEnc)) || process.env.GROQ_API_KEY || "";
}

/** Public-safe view of settings (no encrypted secrets). */
export function redactSettings(s) {
  const { aiKeyEnc, smtpPassEnc, storageKeyEnc, ...safe } = s;
  return {
    ...safe,
    ai: { ...s.ai, hasKey: Boolean(aiKeyEnc) || Boolean(process.env.GROQ_API_KEY) },
    smtp: { ...s.smtp, hasPassword: Boolean(smtpPassEnc) },
    storage: { ...s.storage, hasKey: Boolean(storageKeyEnc) },
  };
}

export async function saveSettings(patch) {
  await ensureConnected();
  const before = await getSettings();
  const data = { ...before, ...patch, flags: { ...before.flags, ...(patch.flags || {}) } };
  await getPrisma().platformSetting.upsert({ where: { id: ID }, update: { data }, create: { id: ID, data } });
  cache = data; cacheAt = Date.now();
  return { before, after: data };
}
