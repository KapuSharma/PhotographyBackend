import { Router } from "express";
import getPrisma, { ensureConnected } from "../db/prisma.js";

const router = Router();
const SINGLETON_ID = "hoi-main";

/* Default content — mirrors the marketing site's current copy. Returned (merged
   under any saved content) so the CMS always shows the live site's real values,
   and the site falls back to these if a section was never edited. */
const DEFAULTS = {
  brand: { name: "High On Innovation", tagline: "Portfolio Engines" },
  hero: {
    eyebrow: "High On Innovation Portfolios Engine 2.5",
    line1: "Exquisite Portfolios",
    line2: "Engineered for",
    line3: "Photographers",
    subtitle:
      "We host state-of-the-art websites, private proofing hubs, and automated sales calendars for professional commercial shooters. Designed for those who value absolute elite design and blazing speed.",
  },
  stats: [
    { value: "99.98%", label: "CDN Uptime Status" },
    { value: "11ms", label: "Average Edge Render" },
    { value: "4,800+", label: "Active Portfolios" },
    { value: "42%+", label: "Booking Inquiries Growth" },
  ],
  services: [
    { id: "deploy", name: "Zero-Click Template Deployment", description: "Instantly launch an Instagram-optimized website from our collection. Your images sync effortlessly to standard layout grids with zero coding.", deliverables: ["Auto-populated portfolio layout", "Optimized static asset generation", "Instant responsive layout verification"], availability: "INCLUDED IN ALL SUBSCRIPTIONS", tag: "Instant" },
    { id: "proofing", name: "Secure Client Proofing System", description: "Create private, gorgeous galleries for your clients to select, heart, review, and directly download their high-res digital assets with password control.", deliverables: ["Password-protected digital rooms", "Watermark generator & toggle", "Direct favorite selections & feedback logs"], availability: "STUDIO PRO & AGENCY ELITE", tag: "Included" },
    { id: "booking", name: "Seamless Session Booking & Depositing", description: "A customized checkout calendar that lets clients choose packages, view available dates, sign terms, and securely pay initial session deposits.", deliverables: ["Custom session packages builder", "Two-way Google Calendar synchronization", "Secure Stripe and PayPal credit integration"], availability: "STUDIO PRO & AGENCY ELITE", tag: "Configurable" },
    { id: "cdn", name: "Ultra-Fast CDN & SEO Optimization", description: "Never lose a client to a slow website. We optimize, resize, and serve your images via global edges using Next-Gen WebP formats for top performance scores.", deliverables: ["Automatic high-resolution optimization", "Metadata, Schema.org and OG Tag builder", "Sub-second visual loads on mobile"], availability: "ALL PLANS", tag: "Continuous" },
  ],
  pricing: [
    { id: "lite", name: "Creator Lite", audience: "Emerging Artists & Freelancers", blurb: "Perfect for independent photographers taking their first step in digital self-branding.", monthlyPrice: 29, features: ["Access to 3 Elegant Portfolio Templates (including 'Aether')", "Custom Subdomain (e.g., yourname.hoi.design)", "High-Performance CDN Image Delivery", "Responsive Desktop & Mobile Layouts", "Standard SSL Certificate & Security", "Email Customer Support (24h response)"], badge: "", highlighted: false, ctaLabel: "Get Started with Lite" },
    { id: "pro", name: "Studio Pro", audience: "Professional Photographers & Active Studios", blurb: "Our signature plan. Empower your commercial photography business with full client management tools.", monthlyPrice: 79, features: ["Access to ALL 10+ Premium Templates (including 'Vogue' & 'Soleil')", "Connect Your Custom Domain (e.g., yourname.com)", "Interactive Client Proofing Galleries (with password protection & downloads)", "Integrated Calendar Booking & Deposit Payments (Stripe/Paypal)", "Advanced SEO & Performance Optimization Suite", "Priority Live Chat Support (under 1 hour response)", "Unlimited High-Res Image Uploads"], badge: "Most Popular", highlighted: true, ctaLabel: "Upgrade to Studio Pro" },
    { id: "elite", name: "Agency Elite", audience: "Collectives, Production Houses & Elite Agencies", blurb: "The complete white-glove solution for agencies, collectives, and elite photography studios.", monthlyPrice: 199, features: ["Everything in Studio Pro", "Multi-Photographer Portfolio & Collective Portal Setup", "Tailor-made Template Customizations (by HOI's senior engineers)", "Automated Delivery Pipeline (integrated raw/JPEG download flows)", "Custom Invoice Builder & Client Contracts Manager", "Dedicated account manager & 1-on-1 strategy calls", "Custom newsletter integration and automated client follow-ups"], badge: "Premium Experience", highlighted: false, ctaLabel: "Inquire Elite Studio" },
  ],
  footer: [
    { title: "Engineering Solutions", links: ["1-Click CDN Deployment", "Private Watermarked Proofing", "Stripe Depository Calendars", "DNS Domain Workspace"] },
    { title: "Interactive Assets", links: ["Portfolio Templates", "Deliverables Showcase", "Engineers Support Live Chat", "Client Dashboard"] },
  ],
  // Photography showcase section (new CMS-managed gallery on the marketing site).
  gallery: [
    { id: "g1", title: "Midnight Shibuya Crossing", category: "Street", src: "https://images.unsplash.com/photo-1542051841857-5f90071e7989?auto=format&fit=crop&w=1200&q=80" },
    { id: "g2", title: "Amber Hour Coastline", category: "Landscape", src: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1200&q=80" },
    { id: "g3", title: "Studio Noir Portrait", category: "Portrait", src: "https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=1200&q=80" },
    { id: "g4", title: "Ridge Ascent at Dawn", category: "Adventure", src: "https://images.unsplash.com/photo-1454496522488-7a8e488e8606?auto=format&fit=crop&w=1200&q=80" },
    { id: "g5", title: "Editorial Couture", category: "Editorial", src: "https://images.unsplash.com/photo-1483985988355-763728e1935b?auto=format&fit=crop&w=1200&q=80" },
    { id: "g6", title: "Glacier Field Telemetry", category: "Wilderness", src: "https://images.unsplash.com/photo-1469474968028-56623f02e42e?auto=format&fit=crop&w=1200&q=80" },
  ],
  // Promotional announcement strip shown site-wide above the navbar.
  notice: { enabled: true, text: "FLASH SALE: Get 20% off all annual subscriptions this week with code HOI20!", preset: "amber", link: "" },
  // Offers / deals the super-admin promotes on the main HOI marketing site.
  offers: [
    { id: "o1", title: "Launch Offer — 20% off Studio Pro", description: "Get your first 3 months of Studio Pro at 20% off. Custom domain, client proofing galleries and unlimited uploads included.", badge: "Limited time", code: "HOI20", ctaLabel: "Claim this offer", ctaHref: "#pricing", active: true },
    { id: "o2", title: "Free domain for the first year", description: "Subscribe to Agency Elite and we cover your custom domain registration for the first 12 months.", badge: "Agency Elite", code: "", ctaLabel: "Talk to us", ctaHref: "#pricing", active: true },
  ],
  // Customer reviews / testimonials displayed on the main HOI marketing site.
  reviews: [
    { id: "r1", name: "Jane Sterling", role: "Bride / Customer", stars: 5, quote: "We hired our photographer through HOI and the visual experience was unparalleled. The dashboard galleries made downloading our high-res memories incredibly fluid!", active: true },
    { id: "r2", name: "Richard Branson", role: "Art Director, Horizon Mag", stars: 5, quote: "The licensing system is seamless. HOI lets us source verified, highly professional local street and portrait photographers at standard rates.", active: true },
    { id: "r3", name: "Marcus Lee", role: "Commercial Studio Owner", stars: 5, quote: "Moving my studio onto HOI doubled my inbound bookings. The proofing and deposit flow alone pays for the subscription.", active: true },
  ],
  // FAQ accordion on the home page (rendered with FAQPage schema).
  faqs: [
    { id: "f1", q: "Do I need any technical skills to use HOI?", a: "None. Pick a template, edit your content in the dashboard, and publish — no code, no plugins." },
    { id: "f2", q: "Can I use my own domain?", a: "Yes. Connect a custom domain with guided DNS verification and automatic SSL, or start on a free subdomain." },
    { id: "f3", q: "Is there a free trial?", a: "Every plan starts with a 14-day free trial — no credit card required to begin." },
    { id: "f4", q: "What happens to my galleries if I cancel?", a: "Your data stays yours. You can export it, and nothing is deleted without notice." },
    { id: "f5", q: "Does HOI help me get bookings?", a: "Yes — the AI assistant qualifies enquiries, the CRM tracks them, and Lead Hunt surfaces new prospects." },
  ],
  // Section visibility on the public home page.
  layout: { show: { hero: true, sandbox: true, gallery: true, offers: true, services: true, pricing: true, reviews: true, comparison: true, faq: true, feed: true, finalCta: true, footer: true } },
  // HOI Photography public landing (managed from the super-admin "Website CMS Control").
  hoiLanding: {
    hero: {
      heading: "Discover Elite Local Photographers.",
      subheading: "Book verified photographic artists, purchase premium image licenses, and preserve your special moments in pristine custom galleries.",
      cta: "Browse Galleries",
      deals: "20% off with HOI20",
    },
    notice: { enabled: true, text: "FLASH SALE: Get 20% off all photo prints & license buyouts this week with code HOI20!", preset: "amber" },
    reviews: [
      { id: "r1", name: "Jane Sterling", role: "Bride / Customer", stars: 5, quote: "We hired Aarav through HOI Photography and the visual experience was unparalleled. The dashboard galleries made downloading our high-res memories incredibly fluid!", status: "visible" },
      { id: "r2", name: "Richard Branson", role: "Art Director, Horizon mag", stars: 5, quote: "The photography licensing system is seamless. HOI allows us to source verified, highly professional local street and portrait photographers at standard rates.", status: "visible" },
      { id: "r3", name: "Clara Oswald", role: "Client", stars: 4, quote: "The UI looks decent, but would love to see more landscape collections in the default categories soon.", status: "pending" },
    ],
  },
};

async function readContent() {
  await ensureConnected();
  const row = await getPrisma().mainSiteContent.findUnique({ where: { id: SINGLETON_ID } });
  const saved = (row?.data && typeof row.data === "object") ? row.data : {};
  return { ...DEFAULTS, ...saved };
}

// GET /api/main-site — public. The marketing site + the CMS both read this.
router.get("/", async (_req, res) => {
  try {
    res.json(await readContent());
  } catch (err) {
    // Never break the public site — fall back to defaults.
    res.json(DEFAULTS);
  }
});

// PUT /api/main-site — guarded by a shared admin secret (sent by the super-admin
// server, never exposed to the browser).
router.put("/", async (req, res) => {
  try {
    const secret = req.headers["x-admin-secret"];
    if (!process.env.SUPERADMIN_SECRET || secret !== process.env.SUPERADMIN_SECRET) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const body = req.body && typeof req.body === "object" ? req.body : {};
    // Only persist the known sections.
    const data = {};
    for (const key of ["brand", "hero", "stats", "services", "pricing", "gallery", "notice", "offers", "reviews", "faqs", "footer", "layout", "hoiLanding"]) {
      if (body[key] !== undefined) data[key] = body[key];
    }
    await ensureConnected();
    await getPrisma().mainSiteContent.upsert({
      where: { id: SINGLETON_ID },
      update: { data },
      create: { id: SINGLETON_ID, data },
    });
    res.json({ ok: true, content: { ...DEFAULTS, ...data } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
