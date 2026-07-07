import pkg from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const { PrismaClient } = pkg;
const { Pool } = pg;

let _prisma = null;
let _pool = null;
// Timestamp of the last successful probe. While the DB is known-warm we skip
// the SELECT 1 so the per-request guard adds ~no latency. Neon stays awake a
// few minutes after activity, so a short TTL is safe.
let _lastOkAt = 0;
let _warming = null; // de-dupes concurrent cold-start probes into one wake-up
const WARM_TTL_MS = 20000;

export default function getPrisma() {
  if (!_prisma) {
    const url = new URL(process.env.DATABASE_URL);
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    const port = url.port ? parseInt(url.port) : 5432;
    _pool = new Pool({
      host: url.hostname,
      port,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace("/", ""),
      ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } }),
      max: 5,
      idleTimeoutMillis: 10000,
      // Neon serverless auto-suspends; the first connect after a sleep can be
      // slow to wake, so allow up to 30s before giving up. keepAlive avoids
      // idle sockets being dropped silently.
      connectionTimeoutMillis: 30000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 5000,
    });

    // Remove broken connections from pool automatically. Also invalidate the
    // "warm" cache so the next request re-probes and returns a clean 503 instead
    // of letting a query fail as an unhandled rejection while the DB is down.
    _pool.on("error", (err) => {
      console.warn("[db] pool error (reconnecting):", err.message);
      _lastOkAt = 0;
    });

    const adapter = new PrismaPg(_pool);
    _prisma = new PrismaClient({ adapter });
  }
  return _prisma;
}

// Called on routes that hit Neon after a cold start — wakes the DB.
// Retries the probe query on the shared pool with backoff. The pg Pool
// self-heals (broken connections are evicted via the "error" handler),
// so we must NOT end/recreate the pool here: doing so tears down the
// connections that other concurrent callers are actively using, which
// caused the "Cannot use a pool after calling end on the pool" cascade.
export async function ensureConnected() {
  // Fast path: recently confirmed warm — skip the probe entirely.
  if (Date.now() - _lastOkAt < WARM_TTL_MS) return;
  // Collapse concurrent callers (e.g. the dashboard firing several requests at
  // boot) onto a single wake-up probe instead of each hammering a cold Neon.
  if (_warming) return _warming;

  _warming = (async () => {
    let lastErr;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const prisma = getPrisma();
        await prisma.$queryRaw`SELECT 1`;
        _lastOkAt = Date.now();
        return;
      } catch (err) {
        lastErr = err;
        const detail = err?.message?.trim() || err?.code || String(err);
        console.warn(`[db] connection attempt ${attempt} failed:`, detail);
        if (attempt < 5) await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    throw new Error(`Database unavailable after 5 attempts: ${lastErr?.message?.trim() || lastErr?.code || lastErr}`);
  })();

  try {
    await _warming;
  } finally {
    _warming = null;
  }
}
