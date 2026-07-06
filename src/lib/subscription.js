import getPrisma, { ensureConnected } from "../db/prisma.js";

/**
 * A subscription is active when its status is "active" AND it has not expired
 * (no expiry set, or the expiry is still in the future).
 */
export function isSubscriptionActive(client) {
  if (!client) return false;
  const status = client.subscriptionStatus || "active";
  // A trial counts as active access; anything else (expired/suspended) does not.
  if (status !== "active" && status !== "trial") return false;
  if (client.subscriptionExpiresAt && new Date(client.subscriptionExpiresAt).getTime() <= Date.now()) {
    return false;
  }
  return true;
}

/** A small, UI-friendly summary of a client's subscription state. */
export function subscriptionSummary(client) {
  const active = isSubscriptionActive(client);
  const expiresAt = client?.subscriptionExpiresAt || null;
  const expired = !active;
  return {
    active,
    expired,
    status: active ? "active" : "expired",
    plan: client?.plan || "starter",
    expiresAt,
  };
}

/**
 * Express middleware that gates a feature behind an active subscription.
 * Requires authMiddleware to have run first (uses req.user.clientId).
 * Responds 403 with code SUBSCRIPTION_REQUIRED when the subscription is expired.
 */
export async function requireActiveSubscription(req, res, next) {
  try {
    await ensureConnected();
    const client = await getPrisma().client.findUnique({
      where: { id: req.user.clientId },
      select: { subscriptionStatus: true, subscriptionExpiresAt: true, plan: true },
    });
    if (!client) return res.status(404).json({ message: "Client not found" });
    if (!isSubscriptionActive(client)) {
      return res.status(403).json({
        code: "SUBSCRIPTION_REQUIRED",
        message: "Your subscription has expired. Renew it to upload media and use premium features.",
      });
    }
    next();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}
