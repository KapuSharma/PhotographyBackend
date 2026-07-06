import dotenv from "dotenv";
import getPrisma, { ensureConnected } from "../db/prisma.js";

dotenv.config();

/* Seed a couple of published starter blog posts (idempotent by slug).
   Run: npm run seed:blog */
const POSTS = [
  {
    slug: "5-ways-to-book-more-weddings",
    title: "5 Ways Photographers Book More Weddings in 2026",
    excerpt: "From faster galleries to AI enquiry handling — the small changes that move couples from 'just looking' to 'booked'.",
    category: "Growth", tags: ["weddings", "bookings", "conversion"], author: "HOI Team",
    status: "published", publishAt: new Date("2026-05-02"),
    seoTitle: "5 Ways Photographers Book More Weddings in 2026 | HOI",
    seoDescription: "Practical, proven tactics photographers use to convert wedding enquiries into booked dates.",
    body: "Couples decide fast, and slow websites lose them.\n\nStart with speed: a portfolio that loads instantly keeps couples browsing. Then capture the enquiry the moment interest peaks — an AI assistant that answers questions and collects the date and budget converts far better than a static form.\n\nFinally, make saying yes easy: password-protected proofing galleries, a booking calendar, and deposits in one flow remove the friction between 'we love your work' and a signed contract.",
  },
  {
    slug: "custom-domain-vs-subdomain",
    title: "Custom Domain vs. Subdomain: What Should Photographers Choose?",
    excerpt: "A plain-English guide to domains, DNS and SSL — and when it's worth connecting your own domain.",
    category: "Guides", tags: ["domains", "seo", "setup"], author: "HOI Team",
    status: "published", publishAt: new Date("2026-05-20"),
    seoTitle: "Custom Domain vs Subdomain for Photographers | HOI",
    seoDescription: "When to use a free subdomain vs a custom domain, and how DNS and SSL work in plain English.",
    body: "A subdomain (you.hoi.design) gets you online instantly and is perfect for a new studio.\n\nA custom domain (yourstudio.com) builds brand trust and helps SEO. Connecting one is simple: add a DNS record we give you, we verify it, and SSL is issued automatically — no server admin required.\n\nOur advice: start on a subdomain, and connect your own domain the day you land your first paying client.",
  },
];

async function run() {
  await ensureConnected();
  for (const p of POSTS) {
    await getPrisma().marketingPost.upsert({ where: { slug: p.slug }, update: p, create: p });
    console.log("upserted post:", p.slug);
  }
  console.log("Done — starter blog posts seeded.");
  process.exit(0);
}
run().catch((e) => { console.error("seedBlog failed:", e.message); process.exit(1); });
