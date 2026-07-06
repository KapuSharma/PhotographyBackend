import dotenv from "dotenv";
import getPrisma, { ensureConnected } from "../db/prisma.js";

dotenv.config();

/* Seed the default platform subscription plans (idempotent — upsert by slug).
   Run: npm run seed:plans */
const PLANS = [
  { slug: "lite", name: "Creator Lite", audience: "Emerging Artists & Freelancers", blurb: "For independent photographers taking their first step into digital self-branding.", monthlyPrice: 29, annualPrice: 290, currency: "USD", features: ["3 elegant portfolio templates", "Custom subdomain", "High-performance CDN delivery", "Responsive layouts", "Standard SSL & security", "Email support (24h)"], storageGb: 15, aiCredits: 200, leadCredits: 50, seats: 1, websites: 1, badge: "", highlighted: false, order: 1 },
  { slug: "pro", name: "Studio Pro", audience: "Professional Photographers & Studios", blurb: "Our signature plan — full client management tools for a working studio.", monthlyPrice: 79, annualPrice: 790, currency: "USD", features: ["All 10+ premium templates", "Connect your custom domain", "Client proofing galleries", "Calendar booking & deposits", "Advanced SEO & performance suite", "Priority live chat (<1h)", "Unlimited high-res uploads"], storageGb: 150, aiCredits: 2000, leadCredits: 500, seats: 3, websites: 1, badge: "Most Popular", highlighted: true, order: 2 },
  { slug: "elite", name: "Agency Elite", audience: "Collectives, Production Houses & Agencies", blurb: "The complete white-glove solution for agencies and elite studios.", monthlyPrice: 199, annualPrice: 1990, currency: "USD", features: ["Everything in Studio Pro", "Multi-photographer & collective portal", "Tailor-made template customization", "Automated delivery pipeline", "Custom invoice & contracts manager", "Dedicated account manager", "Automated client follow-ups"], storageGb: 500, aiCredits: 10000, leadCredits: 2500, seats: 10, websites: 5, badge: "Premium", highlighted: false, order: 3 },
];

async function run() {
  await ensureConnected();
  for (const p of PLANS) {
    await getPrisma().plan.upsert({ where: { slug: p.slug }, update: p, create: p });
    console.log("upserted plan:", p.slug);
  }
  console.log("Done — default plans seeded.");
  process.exit(0);
}
run().catch((e) => { console.error("seedPlans failed:", e.message); process.exit(1); });
