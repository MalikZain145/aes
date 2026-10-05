/**
 * Admin → registration forms. Lists forms by status for the "New Registration
 * Forms" tab, and renders them to PDF — a single form, or one sequential
 * multi-page PDF per advisor batch (one student per page).
 */
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const RegistrationForm = require('../models/RegistrationForm');

const LOGO_PATH = path.join(__dirname, '..', '..', 'frontend', 'public', 'favicon.png');

// "BS Computer Science" → "Computer Science" (drop the leading degree token)
const deptOnly = (program) => String(program || '')
  .replace(/^(BS|BE|BSC|BBA|MBA|MS|MSC|MA|MPHIL|PHD|DPT|PHARM-?D|BSCS|ADP|AD)\s+/i, '').trim();
// "BS Computer Science Spring 2023" → "Spring 2023"
const intakeOnly = (batch) => {
  const m = String(batch || '').match(/(Fall|Spring|Summer)\s+\d{4}/i);
  return m ? m[0] : String(batch || '');
};

const GREEN = rgb(0.098, 0.239, 0.18);
const BRAND = rgb(0.098, 0.529, 0.329);
const GREY = rgb(0.42, 0.45, 0.43);
const LIGHT = rgb(0.93, 0.95, 0.94);
const GOLD = rgb(0.62, 0.45, 0.12);
const STAMP_GREEN = rgb(0.11, 0.42, 0.26);

// Text curved along a circle ring (top reads L→R across the top; bottom L→R across the bottom).
function drawArcText(page, font, { cx, cy, radius, text, size, color, top = true }) {
  const chars = [...String(text || '').toUpperCase()];
  if (!chars.length) return;
  const widths = chars.map((c) => font.widthOfTextAtSize(c, size) + 0.6);
  const totalAngle = widths.reduce((a, w) => a + w, 0) / radius;   // radians
  const center = top ? Math.PI / 2 : -Math.PI / 2;
  let ang = top ? center + totalAngle / 2 : center - totalAngle / 2;
  for (let i = 0; i < chars.length; i++) {
    const step = widths[i] / radius;
    const a = top ? ang - step / 2 : ang + step / 2;
    const x = cx + radius * Math.cos(a);
    const y = cy + radius * Math.sin(a);
    const rot = top ? (a * 180 / Math.PI - 90) : (a * 180 / Math.PI + 90);
    page.drawText(chars[i], { x, y, size, font, color, rotate: degrees(rot) });
    ang = top ? ang - step : ang + step;
  }
}

// A circular official stamp — outer/inner rings, curved top text, optional centre
// logo, and centred lines placed by explicit dy offsets from the centre.
function drawStamp(page, fonts, { cx, cy, r, color, topArc, logo, lines }) {
  const { reg, bold } = fonts;
  page.drawCircle({ x: cx, y: cy, size: r, borderColor: color, borderWidth: 1.6, opacity: 0 });
  page.drawCircle({ x: cx, y: cy, size: r - 4, borderColor: color, borderWidth: 0.6, opacity: 0 });
  drawArcText(page, bold, { cx, cy, radius: r - 8, text: topArc, size: 4.4, color, top: true });
  if (logo && logo.img) {
    const lw = logo.size, lh = logo.size * (logo.img.height / logo.img.width);
    page.drawImage(logo.img, { x: cx - lw / 2, y: cy + logo.dy, width: lw, height: lh });
  }
  const clip = (s, max) => { s = String(s || ''); return s.length > max ? s.slice(0, max - 1) + '…' : s; };
  for (const ln of lines) {
    if (!ln.t) continue;
    const t = clip(ln.t, Math.floor((r * 1.7) / (ln.size * 0.5)));
    const w = (ln.bold ? bold : reg).widthOfTextAtSize(t, ln.size);
    page.drawText(t, { x: cx - w / 2, y: cy + ln.dy, size: ln.size, font: ln.bold ? bold : reg, color });
  }
}

// Draw one student's registration form onto a fresh page.
function drawForm(pdf, fonts, form) {
  const { reg, bold } = fonts;
  const page = pdf.addPage([595, 842]); // A4
  const W = 595; const M = 48; let y = 800;
  const text = (s, x, yy, size = 10, font = reg, color = rgb(0.07, 0.15, 0.11)) =>
    page.drawText(String(s == null ? '' : s), { x, y: yy, size, font, color });

  // header band — title centred across the page
  page.drawRectangle({ x: 0, y: 792, width: W, height: 50, color: GREEN });
  const center = (s, yy, size, font, color) => {
    const wid = font.widthOfTextAtSize(String(s), size);
    text(s, (W - wid) / 2, yy, size, font, color);
  };
  center('ABASYN UNIVERSITY — ISLAMABAD CAMPUS', 818, 13, bold, rgb(1, 1, 1));
  center(form.kind === 'add_drop' ? 'Course Add / Drop Form' : 'Course Registration Form', 802, 9.5, reg, rgb(0.85, 0.93, 0.88));
  y = 762;

  // identity grid
  const rows = [
    ['Registration No', form.regNo, 'Name', form.name],
    ['Batch / Program', form.batch, 'Degree', form.degree],
    ['Semester', form.semester, 'Department', form.program || form.department],
    ['Phone', form.phone, 'Email', form.email],
    ['Submitted', form.submittedAt ? new Date(form.submittedAt).toLocaleDateString() : '', 'Approved', form.approvedAt ? new Date(form.approvedAt).toLocaleDateString() : ''],
  ];
  for (const [l1, v1, l2, v2] of rows) {
    text(l1, M, y, 8, bold, GREY); text(v1 || '—', M + 92, y, 9.5);
    text(l2, 320, y, 8, bold, GREY); text(v2 || '—', 320 + 62, y, 9.5);
    y -= 20;
  }
  y -= 8;

  // A titled course table in a column of width `w` starting at (x, yTop).
  // Returns the y after the last row. `showStatus` adds a Status column.
  const courseTable = (x, w, yTop, title, titleColor, list, showStatus) => {
    let ty = yTop;
    text(title, x, ty, 9, bold, titleColor); ty -= 6;
    page.drawRectangle({ x, y: ty - 16, width: w, height: 18, color: GREEN });
    const cHash = x + 6, cBody = x + 24;
    const cCr = showStatus ? x + w - 118 : x + w - 42;
    const cStatus = x + w - 74;
    const maxChars = Math.max(10, Math.floor((cCr - cBody) / 4.6));
    text('#', cHash, ty - 12, 8, bold, rgb(1, 1, 1));
    text('Course Code / Title', cBody, ty - 12, 8, bold, rgb(1, 1, 1));
    text('Cr', cCr, ty - 12, 8, bold, rgb(1, 1, 1));
    if (showStatus) text('Status', cStatus, ty - 12, 8, bold, rgb(1, 1, 1));
    ty -= 16;
    if (!list.length) { ty -= 18; text('None', cBody, ty, 9, reg, GREY); }
    list.forEach((c, i) => {
      ty -= 18;
      if (i % 2 === 0) page.drawRectangle({ x, y: ty - 4, width: w, height: 18, color: LIGHT });
      text(i + 1, cHash, ty, 9);
      const body = `${c.code || ''}${c.title ? '  ' + c.title : ''}`;
      text(body.length > maxChars ? body.slice(0, maxChars) + '…' : body, cBody, ty, 8.5);
      text(c.creditHours || '', cCr, ty, 8.5);
      if (showStatus) text('Registered', cStatus, ty, 8.5, reg, BRAND);
    });
    return ty;
  };

  if (form.kind === 'add_drop') {
    // two sides: courses to drop | courses to add
    const colW = (W - 2 * M - 16) / 2;
    const drops = (form.courses || []).filter((c) => c.action === 'drop');
    const adds = (form.courses || []).filter((c) => c.action !== 'drop');
    const yL = courseTable(M, colW, y, 'COURSES TO DROP', rgb(0.65, 0.16, 0.16), drops, false);
    const yR = courseTable(M + colW + 16, colW, y, 'COURSES TO ADD', BRAND, adds, false);
    y = Math.min(yL, yR) - 40;
  } else {
    y = courseTable(M, W - 2 * M, y, 'COURSES', BRAND, form.courses || [], true) - 40;
  }

  // approvals
  text('APPROVALS', M, y, 9, bold, BRAND); y -= 22;
  const sig = (label, name, at, remark, x) => {
    text(label, x, y, 8, bold, GREY);
    text(name || '—', x, y - 14, 9.5);
    text(at ? new Date(at).toLocaleString() : '', x, y - 27, 8, reg, GREY);
    if (remark) text(`Remark: ${remark}`, x, y - 40, 7.5, reg, rgb(0.6, 0.2, 0.2));
  };
  sig('Student Advisor', form.advisorName, form.advisorActionAt, '', M);
  sig('Head of Department', form.hodName, form.hodActionAt, '', 320);
  y -= 70;

  // ── official stamps ──
  const advisorApproved = form.advisorActionAt && (form.status === 'with_hod' || form.status === 'approved');
  const hodApproved = form.status === 'approved';
  const dept = deptOnly(form.program || form.department || '');
  const stampY = Math.max(y + 6, 152);
  if (advisorApproved) {
    drawStamp(page, fonts, { cx: 155, cy: stampY, r: 46, color: GOLD,
      topArc: 'ABASYN UNIVERSITY ISLAMABAD CAMPUS',
      lines: [
        { t: form.advisorName || 'Advisor', size: 8, bold: true, dy: 10 },
        { t: 'Student Advisor', size: 5.5, dy: 1 },
        { t: `Department of ${dept}`, size: 5, dy: -7 },
        { t: intakeOnly(form.batch), size: 5, dy: -15 },
      ] });
  }
  if (hodApproved) {
    drawStamp(page, fonts, { cx: 425, cy: stampY, r: 46, color: STAMP_GREEN,
      topArc: 'ABASYN UNIVERSITY ISLAMABAD CAMPUS',
      logo: fonts.logo ? { img: fonts.logo, size: 15, dy: 7 } : null,
      lines: [
        { t: form.hodName || 'HoD', size: 8, bold: true, dy: -2 },
        { t: 'Head of Department', size: 5.5, dy: -10 },
        { t: `Department of ${dept}`, size: 5, dy: -18 },
      ] });
  }

  center('This is a system-generated form from the Abasyn University portal. It will be reflected on Odoo within 72 hours of approval.', 60, 7.5, reg, GREY);
}

async function renderPdf(forms) {
  const pdf = await PDFDocument.create();
  const fonts = { reg: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold) };
  try { if (fs.existsSync(LOGO_PATH)) fonts.logo = await pdf.embedPng(fs.readFileSync(LOGO_PATH)); }
  catch { /* logo optional */ }
  for (const f of forms) drawForm(pdf, fonts, f);
  if (!forms.length) { const p = pdf.addPage([595, 842]); p.drawText('No forms.', { x: 48, y: 780, size: 12, font: fonts.reg }); }
  return Buffer.from(await pdf.save());
}

// Reusable single-form renderer (with stamps) for the student & faculty portals.
exports.renderFormPdf = (form) => renderPdf([form]);

// ── GET /api/registrations?status=approved ────────────────────────────────────
exports.list = async (req, res) => {
  const status = req.query.status || 'approved';
  const items = await RegistrationForm.find({ status }).sort({ approvedAt: -1, updatedAt: -1 }).limit(500).lean();
  res.json({ items, count: items.length });
};

// ── GET /api/registrations/summary ────────────────────────────────────────────
exports.summary = async (_req, res) => {
  const statuses = ['with_advisor', 'with_hod', 'returned_to_student', 'approved'];
  const out = {};
  for (const s of statuses) out[s] = await RegistrationForm.countDocuments({ status: s });
  // approved forms grouped by advisor batch (for the per-batch PDF)
  const approved = await RegistrationForm.find({ status: 'approved' }).select('batch').lean();
  const byBatch = {};
  for (const f of approved) byBatch[f.batch || '—'] = (byBatch[f.batch || '—'] || 0) + 1;
  res.json({ counts: out, approvedByBatch: byBatch });
};

// ── GET /api/registrations/:id/pdf ────────────────────────────────────────────
exports.formPdf = async (req, res) => {
  const form = await RegistrationForm.findById(req.params.id).lean();
  if (!form) return res.status(404).json({ error: 'Form not found.' });
  const bytes = await renderPdf([form]);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Registration_${form.regNo}.pdf"`);
  res.send(bytes);
};

// ── GET /api/registrations/pdf?batch=...&status=approved ───────────────────────
// One sequential PDF, a page per student (per advisor batch if `batch` given).
exports.batchPdf = async (req, res) => {
  const status = req.query.status || 'approved';
  const q = { status };
  if (req.query.batch) q.batch = req.query.batch;
  const forms = await RegistrationForm.find(q).sort({ regNo: 1 }).limit(1000).lean();
  const bytes = await renderPdf(forms);
  const label = req.query.batch ? req.query.batch.replace(/[^a-z0-9]+/gi, '_') : 'all';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Registrations_${label}.pdf"`);
  res.send(bytes);
};
