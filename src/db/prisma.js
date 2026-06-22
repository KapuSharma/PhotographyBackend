import pkg from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const { PrismaClient } = pkg;
const { Pool } = pg;

let _prisma = null;
let _pool = null;

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

    // Remove broken connections from pool automatically
    _pool.on("error", (err) => {
      console.warn("[db] pool error (reconnecting):", err.message);
    });

    const adapter = new PrismaPg(_pool);
    _prisma = new PrismaClient({ adapter });
  }
  return _prisma;
}

// Called on routes that hit Neon after a cold start — wakes the DB
export async function ensureConnected() {
  const prisma = getPrisma();
  let attempts = 0;
  while (attempts < 3) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return;
    } catch (err) {
      attempts++;
      console.warn(`[db] connection attempt ${attempts} failed:`, err.message);
      // Reset the pool so next attempt gets a fresh connection
      if (_pool) {
        try { await _pool.end(); } catch {}
        _pool = null;
        _prisma = null;
      }
      if (attempts < 3) await new Promise(r => setTimeout(r, 1500 * attempts));
    }
  }
  throw new Error("Database unavailable after 3 attempts");
}
