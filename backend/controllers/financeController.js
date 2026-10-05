/**
 * Finance module — fee-gated admit-card dispatch.
 *
 * Flow: admit cards are generated (batch PDF, one card per page) as before, but
 * now from the Finance portal. Finance then uploads the FEE-PAID list; the
 * "Email now" action:
 *   1. reads the paid registration numbers from the uploaded list,
 *   2. for each paid student finds their card page in the batch PDF and their
 *      email (from the list, else the student's DB record),
 *   3. extracts just that student's one-page admit card and emails it,
 *   4. skips unpaid students, and
 *   5. returns a failure report (RegNo / name / department / email / reason)
 *      for anyone who could not be emailed.
 * An admin activity entry ("admit cards dispatched…") powers the admin's in-app
 * notification.
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { PDFDocument } = require('pdf-lib');
const GeneratedFile = require('../models/GeneratedFile');
const AdmitVerification = require('../models/AdmitVerification');
const EmailDispatch = require('../models/EmailDispatch');
const User = require('../models/User');
const { logActivity } = require('../utils/logger');
const { sendMail, isConfigured } = require('../utils/mailer');
const { OUTPUT_DIR } = require('../utils/pythonRunner');

const norm = (s) => String(s == null ? '' : s).replace(/[^a-z0-9]/gi, '').toUpperCase();
const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');

// ── fee-list parsing (deliberately forgiving) ─────────────────────────────────
// Almost any real fee sheet should "just work": headers are matched by exact
// synonym then by substring, and if a column can't be named from its header the
// email and registration columns are sniffed from the DATA. The Paid/Unpaid
// status is read with a typo-tolerant classifier.
const HEAD = {
  reg: ['registrationnumber', 'registrationno', 'registration', 'regno', 'regnum', 'regno.', 'reg', 'rollno', 'rollnumber', 'roll', 'studentid', 'stdid', 'sid', 'cmsid', 'cms', 'arid', 'enrollmentno', 'enrollment', 'id'],
  email: ['emailaddress', 'emailid', 'email', 'studentemail', 'mail', 'emailadress', 'emial', 'email', 'e-mail'],
  name: ['studentname', 'candidatename', 'fullname', 'name', 'student'],
  status: ['feestatus', 'paymentstatus', 'feepaid', 'payment', 'feestate', 'status', 'paid', 'remarks', 'remark', 'fee', 'dues', 'due'],
};
function matchHead(h) {
  const n = norm(h).toLowerCase();
  if (!n) return null;
  // pass 1 — exact synonym
  for (const [k, arr] of Object.entries(HEAD)) if (arr.includes(n)) return k;
  // pass 2 — substring either way (min length 4 so short words don't mis-hit)
  if (n.length >= 4) {
    for (const [k, arr] of Object.entries(HEAD)) {
      if (arr.some((s) => s.length >= 4 && (n.includes(s) || s.includes(n)))) return k;
    }
  }
  return null;
}

const looksEmail = (v) => /@/.test(String(v == null ? '' : v));
const looksReg = (v) => { const s = String(v == null ? '' : v).trim(); return s.length >= 4 && /\d/.test(s) && !/@/.test(s); };

// Typo-tolerant Paid / Unpaid classifier. true = paid, false = unpaid, null =
// can't tell. UNPAID is checked first because "unpaid" contains "paid".
function classifyPaid(v) {
  const s = String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!s) return null;
  if (['no', 'n', 'x', 'nil', 'none', '0', 'false', 'unp'].includes(s)) return false;
  if (['yes', 'y', 'p', '1', 'true', 'ok'].includes(s)) return true;
  // unpaid family: leading un/not/non/dis + a pay/clear word, or standalone words
  if (/^(un|not|non|dis)/.test(s) && /(paid|pay|pai|clear|clr|cleard|cleared)/.test(s)) return false;
  if (/(unpaid|unpiad|unpai|notpaid|nonpaid|due|dues|pending|defaulter|default|outstanding|owing|arrear|balance|unclear|notclear|remaining|payable|owe)/.test(s)) return false;
  // paid family (tolerate common typos / abbreviations)
  if (/(paid|paidd|payed|clear|clr|cleard|cleared|done|received|recieved|recvd|complete|settled|deposited|submitted|fullpaid|pd)$/.test(s)
    || /(paid|clear|cleared|done|received|recieved|settled|deposited)/.test(s) || s === 'pai') return true;
  return null;
}
// A blank / unreadable status in a fee list is taken as PAID (these are usually
// the paid roster); an explicit unpaid value overrides that.
const isPaidCell = (v) => classifyPaid(v) !== false;

function parseFeeList(filePath) {
  let wb;
  try { wb = XLSX.readFile(filePath, { cellDates: false }); }
  catch (e) { return { error: `Could not read the file (${e.message}).`, rows: [], paid: [], unpaid: [] }; }

  // first sheet that actually has rows
  let rows = [];
  for (const name of wb.SheetNames) {
    const r = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '' });
    if (r.length) { rows = r; break; }
  }
  if (!rows.length) return { error: 'The uploaded file is empty.', rows: [], paid: [], unpaid: [] };

  // header row = first row that maps a reg column; else assume there's no header
  let hIdx = rows.findIndex((r) => r.some((c) => matchHead(c) === 'reg'));
  const hasHeader = hIdx >= 0;
  const header = hasHeader ? rows[hIdx].map(matchHead) : [];
  const col = (k) => header.indexOf(k);
  let cReg = col('reg'), cEmail = col('email'), cName = col('name'), cStatus = col('status');

  const dataStart = hasHeader ? hIdx + 1 : 0;
  const sample = rows.slice(dataStart, dataStart + 40);
  const ncols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const colScore = (test) => {
    const scores = [];
    for (let c = 0; c < ncols; c++) {
      let hit = 0, seen = 0;
      for (const r of sample) { const v = r[c]; if (v !== '' && v != null) { seen += 1; if (test(v)) hit += 1; } }
      scores.push(seen ? hit / seen : 0);
    }
    return scores;
  };
  // value-sniff any column the header didn't name
  if (cEmail < 0) { const s = colScore(looksEmail); const best = s.indexOf(Math.max(0, ...s)); if (s[best] >= 0.5) cEmail = best; }
  if (cReg < 0) {
    const s = colScore(looksReg);
    if (cEmail >= 0) s[cEmail] = 0;                 // never treat the email col as reg
    const best = s.indexOf(Math.max(0, ...s));
    cReg = s[best] >= 0.5 ? best : 0;               // last resort: first column
  }
  // Status column: if the header didn't name it (e.g. "Fee Positon"), find the
  // column whose values mostly READ as paid/unpaid — this is what lets the
  // upload predict who is paid even with odd headers and typos.
  if (cStatus < 0) {
    const s = colScore((v) => classifyPaid(v) !== null);
    if (cReg >= 0) s[cReg] = 0;
    if (cEmail >= 0) s[cEmail] = 0;
    if (cName >= 0) s[cName] = 0;
    const best = s.indexOf(Math.max(0, ...s));
    if (s[best] >= 0.5) cStatus = best;
  }

  const rowsOut = [];
  for (let i = dataStart; i < rows.length; i++) {
    const r = rows[i];
    const reg = String(r[cReg] == null ? '' : r[cReg]).trim();
    if (!reg || !/\d/.test(reg)) continue;          // skip label / blank / total rows
    let email = cEmail >= 0 ? String(r[cEmail] || '').trim() : '';
    if (!looksEmail(email)) { const alt = r.find((v) => looksEmail(v)); email = alt ? String(alt).trim() : ''; }
    const statusRaw = cStatus >= 0 ? r[cStatus] : '';
    rowsOut.push({
      reg,
      email: email.toLowerCase(),
      name: cName >= 0 ? String(r[cName] || '').trim() : '',
      paid: cStatus >= 0 ? isPaidCell(statusRaw) : true,
      explicitUnpaid: cStatus >= 0 && classifyPaid(statusRaw) === false,
    });
  }
  if (!rowsOut.length) return { error: 'Could not find any registration numbers in the file.', rows: [], paid: [], unpaid: [] };

  return {
    rows: rowsOut,
    paid: rowsOut.filter((x) => x.paid),
    unpaid: rowsOut.filter((x) => x.explicitUnpaid),
    hasStatus: cStatus >= 0, hasHeader,
    columns: { reg: cReg, email: cEmail, name: cName, status: cStatus },
  };
}

// ── batch listing ────────────────────────────────────────────────────────────
// GET /api/finance/batches — admit-card batches Finance can dispatch.
exports.listBatches = async (_req, res) => {
  const recs = await GeneratedFile.find({ kind: 'admit_cards', status: 'ready' })
    .sort({ createdAt: -1 }).limit(30).lean();
  const out = [];
  for (const r of recs) {
    const count = await AdmitVerification.countDocuments({ batchId: r._id });
    const pdf = (r.files || []).find((f) => f.format === 'pdf' && /admit/i.test(f.label));
    out.push({
      id: r._id, title: r.title, createdAt: r.createdAt,
      students: count, hasPdf: !!pdf, examType: r.examType || '',
    });
  }
  res.json({ items: out, smtpConfigured: isConfigured() });
};

// GET /api/finance/smtp — mail configuration status
exports.smtpStatus = async (_req, res) => {
  const { verifyConnection } = require('../utils/mailer');
  res.json(await verifyConnection());
};

// ── fee gate ─────────────────────────────────────────────────────────────────
// A student's admit card is issued (portal / email / print) ONLY when the fee is
// cleared. 'Unpaid' contains "paid", so UNPAID is checked first.
function isFeePaid(s) {
  const v = String(s == null ? '' : s).toLowerCase();
  if (v.includes('unpaid') || v.includes('not paid')) return false;
  return v.includes('paid');
}

// Email ONE student their own single-page admit card (idempotent per batch).
// Used when a student is marked Paid manually — mirrors the list dispatch.
async function issueCardEmail(av) {
  if (!av || !av.batchId) return { ok: false, reason: 'No admit-card batch for this student.' };
  const batch = await GeneratedFile.findById(av.batchId).lean();
  if (!batch) return { ok: false, reason: 'Admit-card batch not found.' };
  const pdfFile = (batch.files || []).find((f) => f.format === 'pdf' && /admit/i.test(f.label));
  if (!pdfFile) return { ok: false, reason: 'Admit-card PDF missing for this batch.' };
  const pdfPath = path.join(OUTPUT_DIR, path.basename(pdfFile.filename));
  if (!fs.existsSync(pdfPath)) return { ok: false, reason: 'Admit-card PDF file not found on the server.' };
  if (!av.cardPage || av.cardPage < 1) return { ok: false, reason: 'This student has no card page in the batch.' };

  // Where the email lives: the student's User account (by reg no.).
  const u = await User.findOne({ role: 'student', $or: [{ regNo: av.studentId }, { username: norm(av.studentId) }] })
    .select('email').lean();
  const email = (u && u.email) ? u.email : '';
  if (!email) return { ok: false, reason: 'No email address on record for this student.' };

  const key = norm(av.studentId);
  const prior = await EmailDispatch.findOne({ scope: 'admit', refId: String(batch._id), ident: key }).lean();
  if (prior) return { ok: true, alreadyEmailed: true, email };

  try {
    const src = await PDFDocument.load(fs.readFileSync(pdfPath));
    if (av.cardPage > src.getPageCount()) return { ok: false, email, reason: 'Card page is out of range.' };
    const one = await PDFDocument.create();
    const [pg] = await one.copyPages(src, [av.cardPage - 1]);
    one.addPage(pg);
    const bytes = Buffer.from(await one.save());
    const { subject, html, text } = admitEmail(batch, av);
    const sent = await sendMail({ to: email, subject, html, text, attachments: [{ filename: `AdmitCard_${av.studentId}.pdf`, content: bytes, contentType: 'application/pdf' }] });
    if (sent.ok) {
      try { await EmailDispatch.create({ scope: 'admit', refId: String(batch._id), ident: key, email, name: av.name }); } catch { /* race */ }
      return { ok: true, email, devMode: !!sent.devMode };
    }
    return { ok: false, email, reason: `Email failed: ${sent.error || 'unknown error'}` };
  } catch (e) { return { ok: false, email, reason: `Could not build/send: ${e.message}` }; }
}

// POST /api/finance/fee  { reg, paid:boolean }
// Mark ONE student's fee Paid / Unpaid (individual counterpart of the fee-paid
// list upload). Updates every admit-card record for that registration number so
// the student portal, email dispatch and single-card print all follow it. When
// marked Paid, the student is also emailed their admit card automatically.
exports.setFee = async (req, res) => {
  try {
    const reg = String(req.body.reg || '').trim();
    const paid = req.body.paid === true || req.body.paid === 'true';
    if (!reg) return res.status(400).json({ error: 'Enter a registration number.' });

    // Match exact, then fall back to a normalised / digits match so a small
    // formatting difference never blocks the toggle.
    const key = norm(reg), dig = digits(reg);
    let avs = await AdmitVerification.find({ studentId: reg }).lean();
    if (!avs.length) {
      const all = await AdmitVerification.find({}).select('studentId').lean();
      const ids = all.filter((a) => norm(a.studentId) === key || (dig && digits(a.studentId) === dig)).map((a) => a.studentId);
      if (ids.length) avs = await AdmitVerification.find({ studentId: { $in: ids } }).lean();
    }
    if (!avs.length) return res.status(404).json({ error: 'No admit card found for that registration number.' });

    const status = paid ? 'Paid' : 'Unpaid';
    const ids = [...new Set(avs.map((a) => a.studentId))];
    await AdmitVerification.updateMany({ studentId: { $in: ids } }, { $set: { feeStatus: status } });

    // Email dispatch has been removed — students access their admit card from the
    // portal. Marking Paid only releases the card on the portal / for printing.
    const emailInfo = null;

    await logActivity('finance.fee',
      `Fee marked ${status} for ${avs[0].name || reg} (${avs[0].studentId || reg}) — admit card ${paid ? 'released' : 'held'}`
      + (paid && emailInfo ? (emailInfo.ok ? (emailInfo.alreadyEmailed ? ', already emailed' : `, emailed to ${emailInfo.email}${emailInfo.devMode ? ' (dev)' : ''}`) : `, email not sent: ${emailInfo.reason}`) : '') + '.',
      paid ? 'success' : 'warning');

    res.json({
      ok: true, reg: avs[0].studentId, name: avs[0].name, feeStatus: status, feePaid: paid, updated: ids.length,
      email: emailInfo ? {
        sent: !!(emailInfo.ok && !emailInfo.alreadyEmailed),
        alreadyEmailed: !!emailInfo.alreadyEmailed,
        devMode: !!emailInfo.devMode,
        address: emailInfo.email || '',
        reason: emailInfo.reason || '',
      } : null,
    });
  } catch (err) {
    console.error('finance.setFee error:', err);
    res.status(500).json({ error: err.message || 'Could not update the fee status.' });
  }
};

// ── the admit-card email ─────────────────────────────────────────────────────
function admitEmail(rec, av) {
  const heading = rec.title || 'Examination Admit Card';
  const subject = `Your Admit Card — ${heading}`;
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#12261c;max-width:560px">
    <div style="background:linear-gradient(135deg,#198754,#0f3d2e);color:#fff;padding:20px;border-radius:14px 14px 0 0">
      <h2 style="margin:0;font-size:18px">Abasyn University Islamabad Campus</h2>
      <p style="margin:4px 0 0;font-size:13px;opacity:.9">Examination Admit Card</p>
    </div>
    <div style="border:1px solid #d7e6dd;border-top:0;border-radius:0 0 14px 14px;padding:20px;font-size:14px;line-height:1.6">
      <p>Dear <b>${av.name || 'Student'}</b> (${av.studentId}),</p>
      <p>Your admit card for <b>${heading}</b> is attached to this email. Please print it and bring it to every paper.</p>
      <p style="font-size:13px;color:#5c6b63">Programme: ${av.program || '—'} &nbsp;·&nbsp; Batch: ${av.batch || '—'}</p>
      <p style="margin-top:16px;font-size:12px;color:#8a978f">This is an automated message from the Abasyn University Examination System. For queries, contact the Examination Office.</p>
    </div></div>`;
  const text = `Dear ${av.name || 'Student'} (${av.studentId}),\n\nYour admit card for ${heading} is attached. Print it and bring it to every paper.\n\nProgramme: ${av.program || '-'} | Batch: ${av.batch || '-'}\n\n— Abasyn University Examination System`;
  return { subject, html, text };
}

// ── the dispatch ─────────────────────────────────────────────────────────────
// POST /api/finance/dispatch  (multipart: feeList; optional body.batchId)
exports.dispatch = async (req, res) => {
  const uploadPath = req.file && req.file.path;
  // Email dispatch has been retired — students collect their admit card from the
  // portal. This endpoint no longer sends any email.
  try { if (uploadPath && fs.existsSync(uploadPath)) fs.unlinkSync(uploadPath); } catch { /* ignore */ }
  return res.status(410).json({ error: 'Admit-card emailing has been disabled. Students now access their admit card from the student portal.' });
  // eslint-disable-next-line no-unreachable
  try {
    if (!uploadPath) return res.status(400).json({ error: 'Upload the fee-paid list (Excel/CSV).' });

    // 1. the admit-card batch
    const batch = req.body.batchId
      ? await GeneratedFile.findById(req.body.batchId).lean()
      : await GeneratedFile.findOne({ kind: 'admit_cards', status: 'ready' }).sort({ createdAt: -1 }).lean();
    if (!batch) return res.status(400).json({ error: 'No admit-card batch found. Generate admit cards first.' });

    const pdfFile = (batch.files || []).find((f) => f.format === 'pdf' && /admit/i.test(f.label));
    if (!pdfFile) return res.status(400).json({ error: 'The admit-card PDF for this batch is missing.' });
    const pdfPath = path.join(OUTPUT_DIR, path.basename(pdfFile.filename));
    if (!fs.existsSync(pdfPath)) return res.status(400).json({ error: 'The admit-card PDF file could not be found on the server.' });

    // 2. the students of this batch (with their card page)
    const avs = await AdmitVerification.find({ batchId: batch._id }).lean();
    if (!avs.length) return res.status(400).json({ error: 'This batch has no student records to dispatch.' });
    const avByReg = new Map();
    const avByDigits = new Map();
    for (const a of avs) { avByReg.set(norm(a.studentId), a); if (digits(a.studentId)) avByDigits.set(digits(a.studentId), a); }

    // 3. the paid list
    const parsed = parseFeeList(uploadPath);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    if (!parsed.paid.length) return res.status(400).json({ error: 'No paid students found in the uploaded list.' });

    // Persist the fee gate: every paid student in the list has their card
    // RELEASED (portal + email + print). This mirrors the individual Paid toggle,
    // so the list upload and the single-student button do exactly the same job.
    const feePaidIds = new Set();
    for (const p of parsed.paid) {
      const av = avByReg.get(norm(p.reg)) || avByDigits.get(digits(p.reg));
      if (av) feePaidIds.add(av.studentId);
    }
    // Rows whose status column explicitly says UNPAID → hold their cards.
    const feeUnpaidIds = new Set();
    for (const p of (parsed.unpaid || [])) {
      const av = avByReg.get(norm(p.reg)) || avByDigits.get(digits(p.reg));
      if (av && !feePaidIds.has(av.studentId)) feeUnpaidIds.add(av.studentId);
    }
    if (feePaidIds.size) {
      try { await AdmitVerification.updateMany({ studentId: { $in: [...feePaidIds] } }, { $set: { feeStatus: 'Paid' } }); }
      catch (e) { console.error('fee-status persist:', e.message); }
    }
    if (feeUnpaidIds.size) {
      try { await AdmitVerification.updateMany({ studentId: { $in: [...feeUnpaidIds] } }, { $set: { feeStatus: 'Unpaid' } }); }
      catch (e) { console.error('fee-status persist (unpaid):', e.message); }
    }

    // 4. load the batch PDF once
    const srcPdf = await PDFDocument.load(fs.readFileSync(pdfPath));
    const pageCount = srcPdf.getPageCount();

    // pre-fetch student emails from the DB for reg numbers lacking an email in the list
    const needEmail = parsed.paid.filter((p) => !p.email).map((p) => norm(p.reg));
    const dbUsers = needEmail.length
      ? await User.find({ role: 'student', regNo: { $exists: true, $ne: '' } }).select('regNo email').lean()
      : [];
    const emailByReg = new Map();
    for (const u of dbUsers) { if (u.email) { emailByReg.set(norm(u.regNo), u.email); if (digits(u.regNo)) emailByReg.set('D' + digits(u.regNo), u.email); } }

    // Already-emailed students for THIS batch → skip them on a repeat click.
    const priorDocs = await EmailDispatch.find({ scope: 'admit', refId: String(batch._id) }).select('ident').lean();
    const already = new Set(priorDocs.map((d) => d.ident));

    const dispatched = [];
    const failed = [];
    const seen = new Set();
    let alreadyEmailed = 0;

    for (const p of parsed.paid) {
      const key = norm(p.reg);
      if (seen.has(key)) continue;
      seen.add(key);

      if (already.has(key)) { alreadyEmailed += 1; continue; }   // emailed on a previous run

      const av = avByReg.get(key) || avByDigits.get(digits(p.reg));
      const dept = (av && av.program) || '';
      const name = (av && av.name) || p.name || '';
      let email = p.email || (av ? (emailByReg.get(norm(av.studentId)) || emailByReg.get('D' + digits(av.studentId))) : '')
        || emailByReg.get(key) || emailByReg.get('D' + digits(p.reg)) || '';

      if (!av) { failed.push({ regNo: p.reg, name, dept, email, reason: 'No admit card found for this registration number' }); continue; }
      if (!email) { failed.push({ regNo: av.studentId, name, dept, email: '', reason: 'No email address on record' }); continue; }
      if (!av.cardPage || av.cardPage < 1 || av.cardPage > pageCount) {
        failed.push({ regNo: av.studentId, name, dept, email, reason: 'Admit-card page not found in the batch PDF' }); continue;
      }

      try {
        const one = await PDFDocument.create();
        const [pg] = await one.copyPages(srcPdf, [av.cardPage - 1]);
        one.addPage(pg);
        const bytes = Buffer.from(await one.save());
        const { subject, html, text } = admitEmail(batch, av);
        const sent = await sendMail({
          to: email, subject, html, text,
          attachments: [{ filename: `AdmitCard_${av.studentId}.pdf`, content: bytes, contentType: 'application/pdf' }],
        });
        if (sent.ok) {
          dispatched.push({ regNo: av.studentId, name, email, devMode: !!sent.devMode });
          try {
            await EmailDispatch.create({ scope: 'admit', refId: String(batch._id), ident: key, email, name });
          } catch { /* unique-index race — already recorded, fine */ }
        } else {
          failed.push({ regNo: av.studentId, name, dept, email, reason: `Email failed: ${sent.error || 'unknown error'}` });
        }
      } catch (e) {
        failed.push({ regNo: av.studentId, name, dept, email, reason: `Could not build/send card: ${e.message}` });
      }
    }

    const paidRegs = new Set(parsed.paid.map((p) => norm(p.reg)).concat(parsed.paid.map((p) => digits(p.reg)).filter(Boolean)));
    const skippedUnpaid = avs.filter((a) => !paidRegs.has(norm(a.studentId)) && !paidRegs.has(digits(a.studentId))).length;
    const devMode = dispatched.some((d) => d.devMode) || (!isConfigured());

    await logActivity(
      'admit.dispatch',
      devMode
        ? `Admit cards PREPARED in dev mode — ${dispatched.length} saved to disk but NOT emailed (configure SMTP to send)`
          + `${alreadyEmailed ? `, ${alreadyEmailed} already done` : ''}${failed.length ? `, ${failed.length} could not be prepared` : ''}.`
        : `Admit cards has been dispatched successfully — ${dispatched.length} emailed`
          + `${alreadyEmailed ? `, ${alreadyEmailed} already emailed` : ''}${failed.length ? `, ${failed.length} failed` : ''}.`,
      devMode || failed.length ? 'warning' : 'success'
    );

    res.json({
      ok: true,
      batch: { id: batch._id, title: batch.title },
      total: avs.length,
      dispatched: dispatched.length,
      alreadyEmailed,
      failedCount: failed.length,
      skippedUnpaid,
      devMode,
      dispatchedList: dispatched,
      failed,
    });
  } catch (err) {
    console.error('Finance dispatch error:', err);
    res.status(500).json({ error: err.message || 'Admit-card dispatch failed.' });
  } finally {
    try { if (uploadPath && fs.existsSync(uploadPath)) fs.unlinkSync(uploadPath); } catch { /* ignore */ }
  }
};
