import getPrisma, { ensureConnected } from "../db/prisma.js";

export const CYCLE_DAYS = { monthly: 30, annual: 365 };

/** Period end = `from` + one billing cycle. */
export function periodEnd(cycle, from = Date.now()) {
  const days = CYCLE_DAYS[cycle] || 30;
  return new Date(from + days * 24 * 60 * 60 * 1000);
}

/** Approx storage used (GB) from public uploads — mirrors the studios-table math. */
export function usedGb(uploads) {
  return Math.round((uploads || 0) * 0.09 * 10) / 10;
}

/** Does a tenant's current usage fit within a plan's limits? { ok, reason }. */
export function fitsPlan(plan, usage) {
  if (usage.seats > plan.seats) return { ok: false, reason: `the team has ${usage.seats} seats but this plan allows ${plan.seats}` };
  if (usage.websites > plan.websites) return { ok: false, reason: `${usage.websites} website(s) exceed this plan's ${plan.websites}` };
  if (usage.usedGb > plan.storageGb) return { ok: false, reason: `${usage.usedGb}GB used exceeds this plan's ${plan.storageGb}GB` };
  return { ok: true };
}

/* Expiry workflow: expire past-due subscriptions, then auto-suspend those that
   have been expired beyond the grace window. Reminders (email) are wired later. */
export async function sweepSubscriptions(graceDays = 7) {
  await ensureConnected();
  const p = getPrisma();
  const now = new Date();
  const expired = await p.client.updateMany({
    where: { deletedAt: null, subscriptionStatus: { in: ["active", "trial"] }, subscriptionExpiresAt: { lt: now } },
    data: { subscriptionStatus: "expired" },
  });
  const graceCutoff = new Date(now.getTime() - graceDays * 24 * 60 * 60 * 1000);
  const suspended = await p.client.updateMany({
    where: { deletedAt: null, status: { not: "suspended" }, subscriptionStatus: "expired", subscriptionExpiresAt: { lt: graceCutoff } },
    data: { status: "suspended" },
  });
  return { expired: expired.count, suspended: suspended.count };
}
