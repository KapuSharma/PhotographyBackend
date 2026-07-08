import PDFDocument from "pdfkit";

/**
 * Server-side invoice PDF generator (pdfkit).
 *
 * Single source of truth for the invoice document: the same buffer is streamed
 * for download (GET /payments/:id/pdf) and attached to the email (POST /:id/send),
 * so the download and the emailed copy can never drift apart.
 *
 * pdfkit's built-in fonts (Helvetica) are AFM/WinAnsi and do NOT include some
 * currency glyphs (notably the rupee "₹"). To stay reliable we render the ISO
 * code for symbols Helvetica can't draw (INR → "INR"), and the symbol otherwise.
 */

// Symbols Helvetica/WinAnsi can actually render.
const SAFE_SYMBOL = { USD: "$", GBP: "£", EUR: "€", JPY: "¥", CNY: "¥", AUD: "A$", CAD: "C$", NZD: "NZ$", SGD: "S$", HKD: "HK$", BRL: "R$", ZAR: "R", MXN: "MX$" };

function moneyPrefix(currencyCode) {
  const code = (currencyCode || "USD").toUpperCase();
  return SAFE_SYMBOL[code] || `${code} `;
}

function fmtAmount(n) {
  const v = Number(n) || 0;
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * @param {object} opts
 * @param {object} opts.studio  { name, logoUrl, addressLines[], email, phone, taxNumber, accent, currencyCode }
 * @param {object} opts.invoice { invoiceNo, dateISO, status, billTo, billEmail, description,
 *                                subtotal, taxLabel, taxRate, taxAmount, total, method, notes, currencyCode }
 * @returns {Promise<Buffer>}
 */
export function buildInvoicePdf({ studio = {}, invoice = {} }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const accent = /^#[0-9a-fA-F]{6}$/.test(studio.accent || "") ? studio.accent : "#1a7a45";
      const ink = "#1a1a1a";
      const muted = "#6b7280";
      const line = "#e5e7eb";
      const pageW = doc.page.width;
      const left = 50;
      const right = pageW - 50;
      const cur = moneyPrefix(invoice.currencyCode || studio.currencyCode);
      const money = (n) => `${cur}${fmtAmount(n)}`;

      // ── Header ──────────────────────────────────────────────
      doc.fillColor(ink).font("Helvetica-Bold").fontSize(20).text(studio.name || "Photography Studio", left, 50, { width: 300 });
      doc.font("Helvetica").fontSize(9).fillColor(muted);
      let hy = doc.y + 2;
      (studio.addressLines || []).filter(Boolean).forEach((l) => { doc.text(l, left, hy, { width: 300 }); hy = doc.y; });
      if (studio.phone) { doc.text(studio.phone, left, hy, { width: 300 }); hy = doc.y; }
      if (studio.email) { doc.text(studio.email, left, hy, { width: 300 }); hy = doc.y; }
      if (studio.taxNumber) { doc.text(`Tax No: ${studio.taxNumber}`, left, hy, { width: 300 }); }

      // Right side: INVOICE + meta
      doc.font("Helvetica-Bold").fontSize(26).fillColor(accent).text("INVOICE", right - 200, 50, { width: 200, align: "right" });
      doc.font("Helvetica").fontSize(9).fillColor(muted);
      const metaY = 84;
      const meta = [
        ["Invoice No", invoice.invoiceNo || "—"],
        ["Date", invoice.dateISO ? new Date(invoice.dateISO).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—"],
        ["Status", invoice.status || "Draft"],
      ];
      let my = metaY;
      meta.forEach(([k, v]) => {
        doc.fillColor(muted).font("Helvetica").fontSize(9).text(k, right - 200, my, { width: 95, align: "right" });
        doc.fillColor(ink).font("Helvetica-Bold").fontSize(9).text(String(v), right - 100, my, { width: 100, align: "right" });
        my += 15;
      });

      // ── Divider ──
      const dividerY = Math.max(hy, my) + 18;
      doc.moveTo(left, dividerY).lineTo(right, dividerY).lineWidth(1).strokeColor(line).stroke();

      // ── Bill To / Payment ──
      const billY = dividerY + 18;
      doc.font("Helvetica-Bold").fontSize(9).fillColor(muted).text("BILL TO", left, billY);
      doc.font("Helvetica-Bold").fontSize(12).fillColor(ink).text(invoice.billTo || "Customer", left, billY + 14, { width: 250 });
      doc.font("Helvetica").fontSize(9).fillColor(muted);
      if (invoice.billEmail) doc.text(invoice.billEmail, left, doc.y + 1, { width: 250 });

      doc.font("Helvetica-Bold").fontSize(9).fillColor(muted).text("PAYMENT METHOD", right - 200, billY, { width: 200, align: "right" });
      doc.font("Helvetica").fontSize(11).fillColor(ink).text(invoice.method || "—", right - 200, billY + 14, { width: 200, align: "right" });

      // ── Table ──
      const tableTop = Math.max(doc.y, billY + 44) + 20;
      doc.rect(left, tableTop, right - left, 24).fill(accent);
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(10);
      doc.text("DESCRIPTION", left + 12, tableTop + 7);
      doc.text("AMOUNT", right - 160, tableTop + 7, { width: 148, align: "right" });

      let rowY = tableTop + 24;
      doc.rect(left, rowY, right - left, 30).fillColor("#fafafa").fill();
      doc.fillColor(ink).font("Helvetica").fontSize(10).text(invoice.description || "Photography services", left + 12, rowY + 9, { width: 320 });
      doc.font("Helvetica").fontSize(10).text(money(invoice.subtotal), right - 160, rowY + 9, { width: 148, align: "right" });
      rowY += 30;
      doc.moveTo(left, rowY).lineTo(right, rowY).lineWidth(1).strokeColor(line).stroke();

      // ── Totals ──
      const totalsX = right - 260;
      let ty = rowY + 14;
      const totalRow = (label, value, bold, big) => {
        doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(big ? 12 : 10).fillColor(bold ? ink : muted);
        doc.text(label, totalsX, ty, { width: 130 });
        doc.font(bold ? "Helvetica-Bold" : "Helvetica").fillColor(bold ? ink : ink);
        doc.text(value, right - 160, ty, { width: 148, align: "right" });
        ty += big ? 22 : 18;
      };
      totalRow("Subtotal", money(invoice.subtotal));
      if (Number(invoice.taxAmount) > 0) {
        totalRow(`${invoice.taxLabel || "Tax"} (${invoice.taxRate || 0}%)`, money(invoice.taxAmount));
      }
      doc.moveTo(totalsX, ty).lineTo(right, ty).lineWidth(1).strokeColor(line).stroke();
      ty += 8;
      totalRow("Total", money(invoice.total), true, true);

      // ── Notes ──
      let ny = ty + 20;
      if (invoice.notes && String(invoice.notes).trim()) {
        doc.font("Helvetica-Bold").fontSize(9).fillColor(muted).text("NOTES", left, ny);
        doc.font("Helvetica").fontSize(9.5).fillColor(ink).text(String(invoice.notes), left, ny + 13, { width: right - left });
        ny = doc.y;
      }

      // ── Footer ── keep it on this page, comfortably above the bottom margin
      // (writing text past height − bottomMargin makes pdfkit spill to a 2nd page).
      const maxFooterY = doc.page.height - 90;
      let footerY = Math.max(ny, ty) + 30;
      if (footerY > maxFooterY) footerY = maxFooterY;
      doc.moveTo(left, footerY).lineTo(right, footerY).lineWidth(1).strokeColor(line).stroke();
      doc.font("Helvetica").fontSize(9).fillColor(muted).text(
        `Thank you for your business.${studio.email ? `  Questions? ${studio.email}` : ""}`,
        left, footerY + 12, { width: right - left, align: "center", lineBreak: false }
      );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
