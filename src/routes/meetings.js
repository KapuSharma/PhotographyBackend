import { Router } from "express";
import getPrisma from "../db/prisma.js";
import { sendMail, mailerConfigured } from "../lib/mailer.js";

const router = Router();

/* ─── Email helpers ───────────────────────────────────────────── */

const BRAND = "#D4680C";

// Escape HTML-special characters so user input can't break the template
function esc(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function icsDate(d) {
  // YYYYMMDDTHHMMSSZ in UTC
  const pad = n => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

function icsEscape(s = "") {
  return String(s).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function buildICS({ meeting, lead, photographer, studioName }) {
  const start = new Date(meeting.startTime);
  const end   = new Date(start.getTime() + (Number(meeting.durationMins) || 30) * 60000);
  const now   = new Date();
  const uid   = `${meeting.id}@hoi-photographer-kit`;
  const desc  = [
    meeting.notes || "",
    meeting.notes ? "" : null,
    `Meeting link: ${meeting.meetingLink}`,
  ].filter(x => x !== null).join("\n");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//HOI//Photographer Kit//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEscape(meeting.title || "Consultation Call")}`,
    `DESCRIPTION:${icsEscape(desc)}`,
    `LOCATION:${icsEscape(meeting.meetingLink)}`,
    `URL:${meeting.meetingLink}`,
    photographer?.email
      ? `ORGANIZER;CN=${icsEscape(photographer.name || studioName || "Studio")}:mailto:${photographer.email}`
      : null,
    lead?.email
      ? `ATTENDEE;CN=${icsEscape(lead.name || "")};RSVP=TRUE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION:mailto:${lead.email}`
      : null,
    "STATUS:CONFIRMED",
    "TRANSP:OPAQUE",
    "BEGIN:VALARM",
    "TRIGGER:-PT15M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsEscape(meeting.title || "Consultation Call")} in 15 minutes`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);

  return lines.join("\r\n");
}

function googleCalendarUrl({ meeting }) {
  const start = new Date(meeting.startTime);
  const end   = new Date(start.getTime() + (Number(meeting.durationMins) || 30) * 60000);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: meeting.title || "Consultation Call",
    dates: `${icsDate(start)}/${icsDate(end)}`,
    details: `${meeting.notes ? meeting.notes + "\n\n" : ""}Meeting link: ${meeting.meetingLink}`,
    location: meeting.meetingLink,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function outlookCalendarUrl({ meeting }) {
  const start = new Date(meeting.startTime);
  const end   = new Date(start.getTime() + (Number(meeting.durationMins) || 30) * 60000);
  const params = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: meeting.title || "Consultation Call",
    startdt: start.toISOString(),
    enddt: end.toISOString(),
    body: `${meeting.notes ? meeting.notes + "\n\n" : ""}Meeting link: ${meeting.meetingLink}`,
    location: meeting.meetingLink,
  });
  return `https://outlook.office.com/calendar/0/deeplink/compose?${params.toString()}`;
}

function formatMeetingDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { long: "", dayName: "", day: "", month: "", time: "", range: "" };
  const long = d.toLocaleString("en", {
    weekday: "long", day: "2-digit", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
  return {
    long,
    dayName: d.toLocaleString("en", { weekday: "long" }),
    day: String(d.getDate()).padStart(2, "0"),
    month: d.toLocaleString("en", { month: "short" }).toUpperCase(),
    time: d.toLocaleString("en", { hour: "2-digit", minute: "2-digit" }),
  };
}

function buildEmail({ role, meeting, lead, photographer, photographerName, studioName }) {
  const fmt = formatMeetingDate(meeting.startTime);
  const start = new Date(meeting.startTime);
  const end = new Date(start.getTime() + (Number(meeting.durationMins) || 30) * 60000);
  const range = `${fmt.time} – ${end.toLocaleString("en", { hour: "2-digit", minute: "2-digit" })}`;

  const link = meeting.meetingLink;
  const title = meeting.title || "Consultation Call";
  const isLead = role === "lead";

  const greetTo = isLead
    ? (lead.name ? lead.name.split(" ")[0] : null)
    : (photographerName ? photographerName.split(" ")[0] : null);
  const greet = greetTo ? `Hi ${greetTo},` : "Hello,";

  const intro = isLead
    ? `${photographerName || studioName || "Your photographer"} has scheduled a meeting with you. Details are below — click the button to join at the scheduled time.`
    : `A meeting with ${lead.name || "the lead"}${lead.company ? ` (${lead.company})` : ""} has been scheduled. A copy has also been sent to them.`;

  const gcalUrl = googleCalendarUrl({ meeting });
  const outlookUrl = outlookCalendarUrl({ meeting });

  // ── Plain-text version ───────────────────────────────────────
  const text = [
    greet,
    "",
    intro,
    "",
    `Meeting:  ${title}`,
    `When:     ${fmt.long} (${range})`,
    `Duration: ${meeting.durationMins} minutes`,
    `Join:     ${link}`,
    meeting.notes ? `\nAgenda:\n${meeting.notes}` : "",
    "",
    "Add to calendar:",
    `  Google:  ${gcalUrl}`,
    `  Outlook: ${outlookUrl}`,
    "",
    `— ${studioName || "HOI Studio"}`,
  ].filter(Boolean).join("\n");

  // ── HTML version (table-based, bulletproof) ──────────────────
  const brandInitial = esc((studioName || "S").charAt(0).toUpperCase());
  const notesBlock = meeting.notes ? `
              <tr><td style="padding: 0 32px 24px 32px;">
                <table width="100%" role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
                  <tr><td style="padding: 16px 18px; background:#F8F7F4; border-left: 3px solid ${BRAND}; border-radius: 4px;">
                    <div style="font-family: Arial, Helvetica, sans-serif; font-size: 10px; font-weight: 700; color:#9C9790; letter-spacing: 1.5px; text-transform: uppercase; margin-bottom: 6px;">Agenda</div>
                    <div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #27231e; line-height: 1.6; white-space: pre-wrap;">${esc(meeting.notes)}</div>
                  </td></tr>
                </table>
              </td></tr>` : "";

  const html = `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${esc(title)}</title>
  <!--[if mso]>
  <style>table, td, div, h1, p { font-family: Arial, Helvetica, sans-serif; }</style>
  <![endif]-->
  <style>
    @media (max-width: 620px) {
      .container { width: 100% !important; }
      .px { padding-left: 22px !important; padding-right: 22px !important; }
      .hero-title { font-size: 22px !important; }
      .cta a { display: block !important; }
    }
  </style>
</head>
<body style="margin:0; padding:0; background:#F4F2EE; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%;">
  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">
    ${esc(title)} · ${esc(fmt.long)}
  </div>
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#F4F2EE;">
    <tr><td align="center" style="padding: 28px 16px;">

      <!-- Container -->
      <table role="presentation" class="container" cellspacing="0" cellpadding="0" border="0" width="600" style="width:600px; max-width:600px; background:#FFFFFF; border:1px solid #E2DFD8; border-radius:8px; overflow:hidden;">

        <!-- Top bar -->
        <tr><td class="px" style="padding: 22px 32px; border-bottom:1px solid #E2DFD8;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
            <tr>
              <td align="left" style="vertical-align:middle;">
                <table role="presentation" cellspacing="0" cellpadding="0"><tr>
                  <td style="width:34px; height:34px; background:${BRAND}; border-radius:5px; color:#FFFFFF; font-family: Georgia, 'Times New Roman', serif; font-size:16px; font-weight:700; text-align:center; line-height:34px;">${brandInitial}</td>
                  <td style="padding-left:12px; font-family: Georgia, 'Times New Roman', serif; font-size: 16px; font-weight: 700; color:#27231E;">${esc(studioName || "HOI Studio")}</td>
                </tr></table>
              </td>
              <td align="right" style="vertical-align:middle; font-family: Arial, Helvetica, sans-serif; font-size:10px; font-weight:700; letter-spacing:1.5px; color:#9C9790; text-transform:uppercase;">
                Meeting Invitation
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Hero -->
        <tr><td class="px" style="padding: 36px 32px 8px 32px;">
          <div style="font-family: Arial, Helvetica, sans-serif; font-size: 12px; color:${BRAND}; letter-spacing: 1.5px; text-transform: uppercase; font-weight: 700; margin-bottom: 10px;">
            ${esc(fmt.dayName)}, ${esc(fmt.day)} ${esc(fmt.month)}
          </div>
          <div class="hero-title" style="font-family: Georgia, 'Times New Roman', serif; font-size: 28px; font-weight: 600; color:#27231E; line-height:1.2; margin:0 0 16px 0;">
            ${esc(title)}
          </div>
          <div style="font-family: Arial, Helvetica, sans-serif; font-size: 15px; color:#5C5651; line-height: 1.6; margin: 0;">
            <p style="margin:0 0 12px 0;">${esc(greet)}</p>
            <p style="margin:0;">${esc(intro)}</p>
          </div>
        </td></tr>

        <!-- Details card -->
        <tr><td class="px" style="padding: 24px 32px 24px 32px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #E2DFD8; border-radius:6px; border-collapse:separate;">
            <tr>
              <td style="padding: 16px 20px; border-bottom:1px solid #E2DFD8; width:140px;">
                <div style="font-family: Arial, Helvetica, sans-serif; font-size: 10px; color:#9C9790; letter-spacing: 1.3px; text-transform: uppercase; font-weight: 700; margin-bottom: 4px;">When</div>
                <div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color:#27231E; font-weight: 600;">${esc(fmt.long)}</div>
              </td>
              <td style="padding: 16px 20px; border-bottom:1px solid #E2DFD8; border-left:1px solid #E2DFD8;">
                <div style="font-family: Arial, Helvetica, sans-serif; font-size: 10px; color:#9C9790; letter-spacing: 1.3px; text-transform: uppercase; font-weight: 700; margin-bottom: 4px;">Duration</div>
                <div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color:#27231E; font-weight: 600;">${meeting.durationMins} minutes</div>
              </td>
            </tr>
            <tr>
              <td colspan="2" style="padding: 16px 20px;">
                <div style="font-family: Arial, Helvetica, sans-serif; font-size: 10px; color:#9C9790; letter-spacing: 1.3px; text-transform: uppercase; font-weight: 700; margin-bottom: 4px;">Meeting Link</div>
                <a href="${esc(link)}" style="font-family: Arial, Helvetica, sans-serif; font-size: 13px; color:${BRAND}; font-weight: 600; word-break: break-all; text-decoration: none;">${esc(link)}</a>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- CTA (bulletproof button) -->
        <tr><td class="px cta" style="padding: 0 32px 28px 32px;" align="center">
          <!--[if mso]>
          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${esc(link)}" style="height:50px;v-text-anchor:middle;width:220px;" arcsize="12%" strokecolor="${BRAND}" fillcolor="${BRAND}">
            <w:anchorlock/>
            <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">Join Meeting</center>
          </v:roundrect>
          <![endif]-->
          <!--[if !mso]><!-- -->
          <a href="${esc(link)}" style="background:${BRAND}; color:#FFFFFF; display:inline-block; font-family: Arial, Helvetica, sans-serif; font-size:15px; font-weight:600; line-height:50px; text-align:center; text-decoration:none; width:220px; -webkit-text-size-adjust:none; border-radius:6px;">Join Meeting</a>
          <!--<![endif]-->
        </td></tr>
        ${notesBlock}

        <!-- Add to calendar -->
        <tr><td class="px" style="padding: 20px 32px; border-top:1px solid #E2DFD8; background:#FAFAF8;" align="center">
          <div style="font-family: Arial, Helvetica, sans-serif; font-size:11px; color:#9C9790; letter-spacing:1.2px; text-transform:uppercase; font-weight:700; margin-bottom:10px;">Add to Calendar</div>
          <table role="presentation" cellspacing="0" cellpadding="0" align="center"><tr>
            <td style="padding:0 12px;"><a href="${esc(gcalUrl)}" style="font-family: Arial, Helvetica, sans-serif; font-size:13px; color:#27231E; font-weight:600; text-decoration:none;">Google</a></td>
            <td style="color:#E2DFD8;">|</td>
            <td style="padding:0 12px;"><a href="${esc(outlookUrl)}" style="font-family: Arial, Helvetica, sans-serif; font-size:13px; color:#27231E; font-weight:600; text-decoration:none;">Outlook</a></td>
            <td style="color:#E2DFD8;">|</td>
            <td style="padding:0 12px;"><span style="font-family: Arial, Helvetica, sans-serif; font-size:13px; color:#27231E; font-weight:600;">Apple (.ics attached)</span></td>
          </tr></table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding: 22px 32px; background:#27231E;" align="center">
          <div style="font-family: Georgia, 'Times New Roman', serif; font-size:15px; font-weight:600; color:#FFFFFF; margin-bottom:4px;">${esc(studioName || "HOI Studio")}</div>
          ${photographer?.email ? `<div style="font-family: Arial, Helvetica, sans-serif; font-size:12px; color:#9C9790; margin-bottom:4px;">
            Reply to <a href="mailto:${esc(photographer.email)}" style="color:#C8C2BB; text-decoration:underline;">${esc(photographer.email)}</a>
          </div>` : ""}
          <div style="font-family: Arial, Helvetica, sans-serif; font-size:11px; color:#8E8782; letter-spacing:0.5px;">Sent via HOI Photographer Kit</div>
        </td></tr>

      </table>
      <!-- /Container -->

      <div style="font-family: Arial, Helvetica, sans-serif; font-size:11px; color:#9C9790; padding: 16px 8px 0 8px; max-width:600px;">
        You're receiving this email because a meeting was scheduled with you. If this wasn't expected, please reply to this message.
      </div>

    </td></tr>
  </table>
</body>
</html>`;

  const subject = isLead
    ? `Meeting invitation: ${title} · ${fmt.dayName}, ${fmt.day} ${fmt.month} at ${fmt.time}`
    : `Scheduled: ${title} with ${lead.name || "lead"} · ${fmt.dayName}, ${fmt.day} ${fmt.month} at ${fmt.time}`;

  return { subject, text, html };
}

// GET /api/meetings?leadId=...
router.get("/", async (req, res) => {
  try {
    const { leadId } = req.query;
    const where = { clientId: req.user.clientId };
    if (leadId) where.leadId = String(leadId);
    const meetings = await getPrisma().meeting.findMany({
      where,
      include: {
        scheduledBy: { select: { id: true, name: true, email: true } },
        lead:        { select: { id: true, name: true, company: true, email: true } },
      },
      orderBy: { startTime: "desc" },
    });
    res.json(meetings);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/meetings — create + send email
router.post("/", async (req, res) => {
  try {
    const { leadId, title, meetingLink, startTime, durationMins, notes } = req.body || {};
    if (!leadId)        return res.status(400).json({ message: "leadId is required" });
    if (!meetingLink)   return res.status(400).json({ message: "meetingLink is required" });
    if (!startTime)     return res.status(400).json({ message: "startTime is required" });

    // Validate URL
    try { new URL(meetingLink); }
    catch { return res.status(400).json({ message: "meetingLink must be a valid URL" }); }

    const start = new Date(startTime);
    if (isNaN(start.getTime())) return res.status(400).json({ message: "startTime is not a valid date" });

    const prisma = getPrisma();
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, clientId: req.user.clientId },
    });
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    const [photographer, client] = await Promise.all([
      prisma.user.findUnique({ where: { id: req.user.userId } }),
      prisma.client.findUnique({ where: { id: req.user.clientId } }),
    ]);

    const meeting = await prisma.meeting.create({
      data: {
        clientId:     req.user.clientId,
        leadId,
        scheduledById: req.user.userId || null,
        title:        title?.trim() || "Consultation Call",
        meetingLink:  String(meetingLink).trim(),
        startTime:    start,
        durationMins: Math.max(5, Math.min(Number(durationMins) || 30, 600)),
        notes:        notes?.trim() || null,
      },
    });

    // Log activity on the lead so it shows in the timeline
    const existingActivity = Array.isArray(lead.activity) ? lead.activity : [];
    const activityEntry = {
      id: Date.now(),
      type: "meeting",
      date: new Date().toISOString(),
      label: `Meeting scheduled — ${meeting.title}`,
      meetingId: meeting.id,
      meetingLink: meeting.meetingLink,
      startTime: meeting.startTime,
    };
    await prisma.lead.update({
      where: { id: leadId },
      data: {
        activity: [...existingActivity, activityEntry],
        lastActivityAt: new Date(),
      },
    });

    // Send the emails (to lead + photographer)
    const studioName = client?.studioName || client?.name || "Your photographer";
    const photographerName = photographer?.name || studioName;

    const recipients = [];
    if (lead.email)         recipients.push({ role: "lead",  to: lead.email });
    if (photographer?.email) recipients.push({ role: "user", to: photographer.email });

    let emailSentAt = null;
    let emailError  = null;

    try {
      const icsBody = buildICS({ meeting, lead, photographer, studioName });
      const icsAttachment = {
        filename: "invite.ics",
        content: icsBody,
        contentType: 'text/calendar; charset="utf-8"; method=REQUEST',
      };

      const results = await Promise.all(recipients.map(r => {
        const { subject, text, html } = buildEmail({
          role: r.role, meeting, lead, photographer, photographerName, studioName,
        });
        return sendMail({
          to: r.to,
          subject,
          text,
          html,
          replyTo: r.role === "lead" ? photographer?.email : lead.email,
          attachments: [icsAttachment],
          icalEvent: {
            method: "REQUEST",
            content: icsBody,
          },
        });
      }));
      // Mark sent if at least one delivery attempt didn't error
      if (results.length > 0 && mailerConfigured()) {
        emailSentAt = new Date();
      }
    } catch (err) {
      emailError = err.message || "Failed to send meeting email";
    }

    const updated = await prisma.meeting.update({
      where: { id: meeting.id },
      data: { emailSentAt, emailError },
      include: {
        scheduledBy: { select: { id: true, name: true, email: true } },
        lead:        { select: { id: true, name: true, company: true, email: true } },
      },
    });

    res.status(201).json({
      meeting: updated,
      email: {
        configured: mailerConfigured(),
        sent: !!emailSentAt,
        error: emailError,
        recipients: recipients.map(r => r.to),
      },
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// PATCH /api/meetings/:id — update status/link/time
router.patch("/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const existing = await prisma.meeting.findFirst({
      where: { id: req.params.id, clientId: req.user.clientId },
    });
    if (!existing) return res.status(404).json({ message: "Meeting not found" });

    const { title, meetingLink, startTime, durationMins, notes, status } = req.body || {};
    const data = {};
    if (title !== undefined)         data.title = String(title).trim() || "Consultation Call";
    if (meetingLink !== undefined) {
      try { new URL(String(meetingLink)); }
      catch { return res.status(400).json({ message: "meetingLink must be a valid URL" }); }
      data.meetingLink = String(meetingLink).trim();
    }
    if (startTime !== undefined) {
      const t = new Date(startTime);
      if (isNaN(t.getTime())) return res.status(400).json({ message: "startTime is not a valid date" });
      data.startTime = t;
    }
    if (durationMins !== undefined) data.durationMins = Math.max(5, Math.min(Number(durationMins) || 30, 600));
    if (notes !== undefined)        data.notes = notes ? String(notes).trim() : null;
    if (status !== undefined)       data.status = String(status);

    const meeting = await prisma.meeting.update({
      where: { id: req.params.id },
      data,
      include: {
        scheduledBy: { select: { id: true, name: true, email: true } },
        lead:        { select: { id: true, name: true, company: true, email: true } },
      },
    });
    res.json(meeting);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE /api/meetings/:id
router.delete("/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
    const existing = await prisma.meeting.findFirst({
      where: { id: req.params.id, clientId: req.user.clientId },
    });
    if (!existing) return res.status(404).json({ message: "Meeting not found" });
    await prisma.meeting.delete({ where: { id: req.params.id } });
    res.json({ message: "Meeting deleted" });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

export default router;
