import { Router } from "express";
import getPrisma from "../db/prisma.js";
import { buildInvoicePdf } from "../lib/invoice-pdf.js";
import { sendMail, mailerConfigured } from "../lib/mailer.js";

const router = Router();

// Next per-studio sequential invoice number, e.g. INV-2026-0001. Zero-padded so
// lexical ordering matches numeric ordering; unique per studio via @@unique.
async function nextInvoiceNo(prisma, clientId) {
  const year = new Date().getFullYear();
  const prefix = `INV-${year}-`;
  const last = await prisma.payment.findFirst({
    where: { clientId, invoiceNo: { startsWith: prefix } },
    orderBy: { invoiceNo: "desc" },
    select: { invoiceNo: true },
  });
  let seq = 1;
  if (last?.invoiceNo) {
    const n = parseInt(last.invoiceNo.slice(prefix.length), 10);
    if (Number.isFinite(n)) seq = n + 1;
  }
  return `${prefix}${String(seq).padStart(4, "0")}`;
}

// Assemble the studio + invoice context the PDF/email need, from the same
// settings/profile sources used elsewhere in the app.
async function buildContext(prisma, clientId, payment) {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      studioName: true, logoUrl: true, accentColor: true, email: true, taxConfig: true,
      profile: { select: { fullName: true, phone: true, city: true, state: true, country: true, currency: true } },
      siteContent: { select: { contact: true } },
    },
  });
  const contact = client?.siteContent?.contact || {};
  const prof = client?.profile || {};
  const currencyCode = (String(prof.currency || "USD").match(/[A-Za-z]{3}/) || ["USD"])[0].toUpperCase();

  const addressLines = [];
  if (contact.address) addressLines.push(contact.address);
  else {
    const loc = [prof.city, prof.state, prof.country].filter(Boolean).join(", ");
    if (loc) addressLines.push(loc);
  }

  const studio = {
    name: client?.studioName || "Photography Studio",
    logoUrl: client?.logoUrl || "",
    accent: client?.accentColor && client.accentColor !== "#000000" ? client.accentColor : "#1a7a45",
    email: contact.email || client?.email || "",
    phone: contact.phone || prof.phone || "",
    taxNumber: client?.taxConfig?.number || "",
    addressLines,
    currencyCode,
  };

  const subtotal = payment.subtotal != null ? payment.subtotal : payment.amount;
  const invoice = {
    invoiceNo: payment.invoiceNo,
    dateISO: payment.paymentDate || payment.createdAt,
    status: payment.status,
    billTo: payment.company,
    billEmail: payment.billEmail || "",
    description: payment.type || "Photography services",
    subtotal,
    taxLabel: payment.taxLabel,
    taxRate: payment.taxRate,
    taxAmount: payment.taxAmount || 0,
    total: payment.amount,
    method: payment.method,
    notes: payment.notes,
    currencyCode,
  };
  return { studio, invoice };
}

// GET all payments for client
router.get("/", async (req, res) => {
  try {
    const payments = await getPrisma().payment.findMany({
      where: { clientId: req.user.clientId },
      orderBy: { createdAt: "desc" },
    });
    res.json(payments);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET single payment — ownership check
router.get("/:id", async (req, res) => {
  try {
    const payment = await getPrisma().payment.findFirst({
      where: { id: req.params.id, clientId: req.user.clientId },
    });
    if (!payment) return res.status(404).json({ message: "Payment not found" });
    res.json(payment);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST create payment — assigns a sequential invoice number (retry on collision)
router.post("/", async (req, res) => {
  try {
    const prisma = getPrisma();
    const { invoiceNo: _ignore, ...body } = req.body;
    let payment;
    for (let attempt = 0; attempt < 5; attempt++) {
      const invoiceNo = await nextInvoiceNo(prisma, req.user.clientId);
      try {
        payment = await prisma.payment.create({
          data: { ...body, invoiceNo, clientId: req.user.clientId },
        });
        break;
      } catch (e) {
        // Another invoice grabbed this number — retry with the next one.
        if (e.code === "P2002" && attempt < 4) continue;
        throw e;
      }
    }
    res.status(201).json(payment);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// PATCH update payment — ownership check (invoiceNo is immutable)
router.patch("/:id", async (req, res) => {
  try {
    const existing = await getPrisma().payment.findFirst({
      where: { id: req.params.id, clientId: req.user.clientId },
    });
    if (!existing) return res.status(404).json({ message: "Payment not found" });
    const { invoiceNo: _ignore, clientId: _c, id: _i, ...data } = req.body;
    const payment = await getPrisma().payment.update({
      where: { id: req.params.id },
      data,
    });
    res.json(payment);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE payment — ownership check
router.delete("/:id", async (req, res) => {
  try {
    const existing = await getPrisma().payment.findFirst({
      where: { id: req.params.id, clientId: req.user.clientId },
    });
    if (!existing) return res.status(404).json({ message: "Payment not found" });
    await getPrisma().payment.delete({ where: { id: req.params.id } });
    res.json({ message: "Payment deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /payments/:id/pdf — stream the invoice as a PDF (same doc used for email)
router.get("/:id/pdf", async (req, res) => {
  try {
    const prisma = getPrisma();
    const payment = await prisma.payment.findFirst({
      where: { id: req.params.id, clientId: req.user.clientId },
    });
    if (!payment) return res.status(404).json({ message: "Payment not found" });

    const { studio, invoice } = await buildContext(prisma, req.user.clientId, payment);
    const pdf = await buildInvoicePdf({ studio, invoice });
    const filename = `${payment.invoiceNo || "invoice"}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.setHeader("Content-Length", pdf.length);
    res.end(pdf);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /payments/:id/send — email the invoice PDF to the customer, mark as Sent
router.post("/:id/send", async (req, res) => {
  try {
    if (!mailerConfigured()) {
      return res.status(400).json({ message: "Email isn't set up yet — add SMTP settings to send invoices." });
    }
    const prisma = getPrisma();
    const payment = await prisma.payment.findFirst({
      where: { id: req.params.id, clientId: req.user.clientId },
    });
    if (!payment) return res.status(404).json({ message: "Payment not found" });

    // Recipient: the invoice's bill email, a manual override, or the linked lead's email.
    let to = payment.billEmail || (typeof req.body?.to === "string" ? req.body.to.trim() : "");
    if (!to && payment.leadId) {
      const lead = await prisma.lead.findFirst({ where: { id: payment.leadId, clientId: req.user.clientId }, select: { email: true } });
      to = lead?.email || "";
    }
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return res.status(400).json({ message: "No valid customer email on this invoice. Add one and try again." });
    }

    const { studio, invoice } = await buildContext(prisma, req.user.clientId, payment);
    const pdf = await buildInvoicePdf({ studio, invoice });

    const invNo = payment.invoiceNo || "your invoice";
    const totalStr = `${invoice.currencyCode} ${(Number(payment.amount) || 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;line-height:1.6">
        <p>Hi ${payment.company || "there"},</p>
        <p>Please find attached invoice <strong>${invNo}</strong> from <strong>${studio.name}</strong>.</p>
        <p>Amount: <strong>${totalStr}</strong>${payment.method ? ` &middot; ${payment.method}` : ""}.</p>
        <p>Thank you for your business.${studio.email ? `<br/>Questions? Reply to this email or write to ${studio.email}.` : ""}</p>
        <p style="color:#6b7280">— ${studio.name}</p>
      </div>`;
    const text = `Hi ${payment.company || "there"},\n\nPlease find attached invoice ${invNo} from ${studio.name}.\nAmount: ${totalStr}.\n\nThank you.\n— ${studio.name}`;

    await sendMail({
      to,
      subject: `Invoice ${invNo} from ${studio.name}`,
      html,
      text,
      replyTo: studio.email || undefined,
      attachments: [{ filename: `${invNo}.pdf`, content: pdf, contentType: "application/pdf" }],
    });

    // Mark as Sent (unless already Paid).
    const updated = payment.status === "Paid"
      ? payment
      : await prisma.payment.update({ where: { id: payment.id }, data: { status: "Sent" } });

    res.json({ message: `Invoice emailed to ${to}`, payment: updated });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
