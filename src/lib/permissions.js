/* Role-Based Access Control for the Super Admin panel.
   Two tiers of roles:
     - System roles (below) are code-defined, always present, and immutable.
     - Custom roles live in the AdminRole table and are composed by a super
       admin from the permission catalog. They are merged over the system roles
       at read time (see getRoleMap).
   "*" means all permissions (super_admin only). */

import getPrisma, { ensureConnected } from "../db/prisma.js";

export const SYSTEM_ROLES = {
  super_admin: { label: "Super Admin", permissions: ["*"] },
  operations: {
    label: "Operations",
    permissions: [
      "dashboard.view",
      "tenants.view", "tenants.manage",
      "subscriptions.view", "subscriptions.manage",
      "payments.view",
      "cms.view",
      "inquiries.view", "inquiries.manage",
      "support.view", "support.manage",
      "reports.view",
      "settings.view", "settings.manage",
      "ai.manage", "ai.logs",
      "leadhunt.view", "leadhunt.manage",
      "audit.view",
    ],
  },
  support: { label: "Support", permissions: ["dashboard.view", "tenants.view", "payments.view", "inquiries.view", "inquiries.manage", "support.view", "support.manage"] },
  content_editor: { label: "Content Editor", permissions: ["dashboard.view", "cms.view", "cms.manage"] },
  finance: { label: "Finance", permissions: ["dashboard.view", "payments.view", "subscriptions.view", "reports.view"] },
  auditor: { label: "Auditor", permissions: ["dashboard.view", "audit.view", "reports.view", "inquiries.view"] },
};

/* Catalog of every assignable permission, grouped for the role-builder UI.
   "admins.manage" is intentionally NOT assignable to a custom role — it stays
   the exclusive province of super_admin so custom roles can't self-escalate. */
export const PERMISSION_CATALOG = [
  { group: "Dashboard", perms: [["dashboard.view", "View dashboard & KPIs"]] },
  { group: "Tenants & Studios", perms: [["tenants.view", "View studios"], ["tenants.manage", "Manage studios (lifecycle, domains)"], ["tenants.impersonate", "Impersonate a studio owner"]] },
  { group: "Subscriptions", perms: [["subscriptions.view", "View plans & subscriptions"], ["subscriptions.manage", "Manage plans & subscriptions"]] },
  { group: "Payments", perms: [["payments.view", "View payments ledger"]] },
  { group: "Website CMS", perms: [["cms.view", "View site content & blog"], ["cms.manage", "Edit site content & blog"]] },
  { group: "Inquiries", perms: [["inquiries.view", "View inquiries"], ["inquiries.manage", "Respond to inquiries"]] },
  { group: "Support", perms: [["support.view", "View tickets"], ["support.manage", "Work tickets"]] },
  { group: "Reports", perms: [["reports.view", "View & export reports"]] },
  { group: "AI Platform", perms: [["ai.manage", "Configure AI & meter usage"], ["ai.logs", "Read tenant AI conversation logs"]] },
  { group: "Lead Hunt", perms: [["leadhunt.view", "View Lead-Hunt sources & analytics"], ["leadhunt.manage", "Configure Lead-Hunt sources & keywords"]] },
  { group: "Settings", perms: [["settings.view", "View platform settings"], ["settings.manage", "Change platform settings"]] },
  { group: "Audit", perms: [["audit.view", "View the audit log"]] },
];

/** Flat set of catalog permission keys (what a custom role may hold). */
export const ASSIGNABLE_PERMISSIONS = PERMISSION_CATALOG.flatMap((g) => g.perms.map(([key]) => key));

// ── Role-map cache (system roles + DB custom roles) ──
let cache = null, cacheAt = 0;
const TTL = 30000;

/** All roles keyed by machine name: { key, label, permissions, isSystem }. */
export async function getRoleMap() {
  if (cache && Date.now() - cacheAt < TTL) return cache;
  const map = {};
  for (const [key, def] of Object.entries(SYSTEM_ROLES)) {
    map[key] = { key, label: def.label, permissions: def.permissions, isSystem: true };
  }
  try {
    await ensureConnected();
    const custom = await getPrisma().adminRole.findMany();
    for (const r of custom) {
      // System keys can never be shadowed by a custom row.
      if (SYSTEM_ROLES[r.key]) continue;
      map[r.key] = { key: r.key, label: r.label, permissions: r.permissions || [], isSystem: false };
    }
  } catch {
    // DB unavailable — fall back to system roles only (fail closed to defaults).
  }
  cache = map; cacheAt = Date.now();
  return map;
}

/** Drop the cache after a role mutation so changes take effect immediately. */
export function invalidateRoles() { cache = null; cacheAt = 0; }

/** Permissions array for a role key ([] if unknown). */
export async function getRolePermissions(role) {
  const map = await getRoleMap();
  return map[role]?.permissions || [];
}

/** True if a role holds a permission (or the "*" wildcard). Async — resolves
    against system + custom roles. */
export async function can(role, permission) {
  const perms = await getRolePermissions(role);
  return perms.includes("*") || perms.includes(permission);
}
