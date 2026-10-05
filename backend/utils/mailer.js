/**
 * SMTP mailer for the Abasyn Exam-Cell portal (institutional mail server).
 *
 * Configured entirely from the environment so no credential lives in code:
 *   SMTP_HOST   e.g. mail.abasynisb.edu.pk
 *   SMTP_PORT   587 (STARTTLS) or 465 (SSL)   [default 587]
 *   SMTP_SECURE "true" for port 465            [default false]
 *   SMTP_USER   the mailbox login
 *   SMTP_PASS   the mailbox password
 *   SMTP_FROM   "Abasyn Exam Cell <exams@abasynisb.edu.pk>"  [default = SMTP_USER]
 *
 * When SMTP is NOT configured the mailer runs in DEV MODE: it does not send,
 * it writes each message as an .eml file under output/sent_mail/ and reports
 * success, so the whole dispatch pipeline can be built and tested before real
 * credentials are plugged in.
 */
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { OUTPUT_DIR } = require('./pythonRunner');

let _transport = null;
let _configured = false;

function getConfig() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || (port === 465)).toLowerCase() === 'true';
  const from = process.env.SMTP_FROM || user;
  return { host, port, secure, auth: { user, pass }, from };
}

function transport() {
  if (_transport !== null) return _transport;
  const cfg = getConfig();
  if (!cfg) { _configured = false; _transport = false; return false; }
  _configured = true;
  _transport = nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth,
  });
  return _transport;
}

const isConfigured = () => { transport(); return _configured; };
const fromAddress = () => (getConfig() ? getConfig().from : 'Abasyn Exam Cell <noreply@abasynisb.edu.pk>');

/** Verify the SMTP connection (used by a health/test endpoint). */
async function verifyConnection() {
  const t = transport();
  if (!t) return { ok: false, devMode: true, message: 'SMTP not configured — running in dev mode (emails saved to disk, not sent).' };
  try { await t.verify(); return { ok: true, devMode: false, message: 'SMTP connection OK.' }; }
  catch (e) { return { ok: false, devMode: false, message: e.message }; }
}

/**
 * Send one email. Returns { ok, devMode, messageId?, error? }.
 * In dev mode it writes an .eml to output/sent_mail/ and returns ok:true.
 */
async function sendMail({ to, subject, html, text, attachments }) {
  if (!to) return { ok: false, error: 'No recipient address.' };
  const t = transport();
  const msg = { from: fromAddress(), to, subject, html, text, attachments };

  if (!t) {
    // Dev mode — persist to disk instead of sending.
    try {
      const dir = path.join(OUTPUT_DIR, 'sent_mail');
      fs.mkdirSync(dir, { recursive: true });
      const safe = String(to).replace(/[^a-z0-9@._-]/gi, '_');
      const stamp = Date.now();
      const meta = `To: ${to}\nSubject: ${subject}\nAttachments: ${(attachments || []).map((a) => a.filename).join(', ')}\n\n`;
      fs.writeFileSync(path.join(dir, `${stamp}_${safe}.eml`), meta + (text || html || ''), 'utf-8');
    } catch { /* ignore disk errors in dev mode */ }
    return { ok: true, devMode: true };
  }

  try {
    const info = await t.sendMail(msg);
    return { ok: true, devMode: false, messageId: info.messageId };
  } catch (e) {
    return { ok: false, devMode: false, error: e.message };
  }
}

module.exports = { sendMail, verifyConnection, isConfigured, fromAddress };
