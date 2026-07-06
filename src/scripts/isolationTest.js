import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import getPrisma, { ensureConnected } from "../db/prisma.js";

dotenv.config();

/* Automated tenant-isolation suite (FR-100/101, AC-7).
   Creates two throwaway tenants, then asserts — against the live API — that
   tenant A cannot read, modify, or delete any of tenant B's data by id (IDOR),
   and cannot list other tenants. Exits non-zero on any failure so CI can gate
   the release. Requires the backend running (API_URL, default :5000). */

const API = process.env.API_URL || "http://localhost:5000/api";
let passed = 0, failed = 0;
const failures = [];
function check(name, cond) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; failures.push(name); console.log("  ✗ " + name); }
}
const auth = (t) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });
async function login(email, password) {
  const r = await fetch(`${API}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  const d = await r.json().catch(() => ({}));
  return d.token;
}

async function main() {
  await ensureConnected();
  const p = getPrisma();
  const tag = "isotest-" + Date.now();
  const password = "IsoTest!123";
  const passwordHash = await bcrypt.hash(password, 10);

  const A = await p.client.create({ data: { name: `A ${tag}`, studioName: `StudioA ${tag}`, email: `a-${tag}@iso.test`, users: { create: { name: "A user", email: `a-user-${tag}@iso.test`, passwordHash, role: "photographer" } } } });
  const B = await p.client.create({ data: { name: `B ${tag}`, studioName: `StudioB ${tag}`, email: `b-${tag}@iso.test`, users: { create: { name: "B user", email: `b-user-${tag}@iso.test`, passwordHash, role: "photographer" } } } });
  const bService = await p.service.create({ data: { clientId: B.id, name: "B secret service" } });
  const bImage = await p.galleryImage.create({ data: { clientId: B.id, url: "http://x/b.jpg", title: "B image" } });
  const bLead = await p.lead.create({ data: { clientId: B.id, name: "B lead", email: "blead@x.com" } });
  const bFaq = await p.fAQ.create({ data: { clientId: B.id, question: "B?", answer: "B" } });
  const aService = await p.service.create({ data: { clientId: A.id, name: "A service" } });

  console.log(`\nTenant isolation suite  (API: ${API})\n`);
  try {
    const ta = await login(`a-user-${tag}@iso.test`, password);
    const tb = await login(`b-user-${tag}@iso.test`, password);
    check("tenant A can log in", !!ta);
    check("tenant B can log in", !!tb);
    if (!ta) throw new Error("Login failed — is the backend running?");

    let r, list;
    r = await fetch(`${API}/services`, { headers: auth(ta) }); list = await r.json();
    check("services list excludes B's service", Array.isArray(list) && !list.some((s) => s.id === bService.id));
    check("services list includes A's own", Array.isArray(list) && list.some((s) => s.id === aService.id));

    r = await fetch(`${API}/services/${bService.id}`, { headers: auth(ta) });
    check("GET B's service by id -> 404", r.status === 404);

    r = await fetch(`${API}/services/${bService.id}`, { method: "PATCH", headers: auth(ta), body: JSON.stringify({ name: "HACKED" }) });
    check("PATCH B's service -> 404", r.status === 404);
    check("B's service NOT modified", (await p.service.findUnique({ where: { id: bService.id } }))?.name === "B secret service");

    r = await fetch(`${API}/services/${bService.id}`, { method: "DELETE", headers: auth(ta) });
    check("DELETE B's service -> 404", r.status === 404);
    check("B's service still exists", (await p.service.findUnique({ where: { id: bService.id } })) !== null);

    r = await fetch(`${API}/gallery/${bImage.id}`, { method: "DELETE", headers: auth(ta) });
    check("DELETE B's gallery image -> 404", r.status === 404);
    check("B's gallery image still exists", (await p.galleryImage.findUnique({ where: { id: bImage.id } })) !== null);

    r = await fetch(`${API}/leads/${bLead.id}`, { method: "PATCH", headers: auth(ta), body: JSON.stringify({ status: "Lost" }) });
    check("PATCH B's lead -> 404", r.status === 404);
    r = await fetch(`${API}/leads`, { headers: auth(ta) }); list = await r.json();
    check("leads list excludes B's lead", Array.isArray(list) && !list.some((l) => l.id === bLead.id));

    r = await fetch(`${API}/faqs/${bFaq.id}`, { headers: auth(ta) });
    check("GET B's faq by id -> 404", r.status === 404);

    r = await fetch(`${API}/clients`, { headers: auth(ta) }); list = await r.json();
    check("GET /clients returns only self (not B)", Array.isArray(list) && list.every((c) => c.id === A.id) && !list.some((c) => c.id === B.id));
    r = await fetch(`${API}/clients/${B.id}`, { headers: auth(ta) });
    check("GET B's studio record -> 404", r.status === 404);
    r = await fetch(`${API}/clients/${B.id}`, { method: "PATCH", headers: auth(ta), body: JSON.stringify({ studioName: "HACKED" }) });
    check("PATCH B's studio -> 403", r.status === 403);
    check("B's studioName NOT modified", (await p.client.findUnique({ where: { id: B.id } }))?.studioName.startsWith("StudioB"));
  } finally {
    for (const id of [A.id, B.id]) {
      await p.lead.deleteMany({ where: { clientId: id } });
      await p.service.deleteMany({ where: { clientId: id } });
      await p.galleryImage.deleteMany({ where: { clientId: id } });
      await p.fAQ.deleteMany({ where: { clientId: id } });
      await p.user.deleteMany({ where: { clientId: id } });
      await p.client.delete({ where: { id } }).catch(() => {});
    }
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed.`);
  if (failed) console.log("FAILED: " + failures.join("; "));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("Isolation suite error:", e.message); process.exit(1); });
