/* Tenant-isolation helpers. Every by-id mutation/read of a tenant-owned record
   MUST be scoped to the caller's clientId, so one tenant can never touch
   another's data by guessing an id (IDOR). Prisma's update/delete on a bare
   unique id can't express the composite (id + clientId) guard — these use
   updateMany/deleteMany/findFirst with both keys. */

export async function findOwned(delegate, id, clientId) {
  return delegate.findFirst({ where: { id, clientId } });
}

export async function updateOwned(delegate, id, clientId, data) {
  const r = await delegate.updateMany({ where: { id, clientId }, data });
  if (r.count === 0) return null; // not found OR not owned — caller returns 404
  return delegate.findFirst({ where: { id, clientId } });
}

export async function deleteOwned(delegate, id, clientId) {
  const r = await delegate.deleteMany({ where: { id, clientId } });
  return r.count > 0;
}
