import nodemailer from "nodemailer";

let transporter = null;
let transporterReady = false;

function getTransporter() {
  if (transporter !== null) return transporter;
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    transporter = null;
    transporterReady = false;
    return null;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
  transporterReady = true;
  return transporter;
}

export function mailerConfigured() {
  getTransporter();
  return transporterReady;
}

export async function sendMail({ to, subject, html, text, replyTo, attachments, icalEvent }) {
  if (!to) throw new Error("sendMail: missing 'to'");
  const t = getTransporter();
  const from = process.env.MAIL_FROM || process.env.SMTP_USER || "no-reply@hoi.local";

  if (!t) {
    console.log("\n[mailer] SMTP not configured — email not sent. Would have sent:");
    console.log(`  to      : ${Array.isArray(to) ? to.join(", ") : to}`);
    console.log(`  from    : ${from}`);
    console.log(`  subject : ${subject}`);
    console.log(`  text    : ${text?.slice(0, 200)}${text && text.length > 200 ? "…" : ""}`);
    return { queued: false, previewOnly: true };
  }

  const info = await t.sendMail({
    from,
    to: Array.isArray(to) ? to.join(", ") : to,
    subject,
    text,
    html,
    replyTo,
    attachments,
    icalEvent,
  });
  return { queued: true, messageId: info.messageId };
}
