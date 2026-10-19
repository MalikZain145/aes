/**
 * Admit-card COURSE PACK — type a course code, get that course's documents from the
 * issued admit-card batch (nothing is re-seated or re-assigned):
 *
 *   idsheets      identification sheet(s) of the course, one per room
 *   seating       seating plan rows of the course's students, per room
 *   invigilation  every room the course is written in, with its invigilators
 *   cards         the admit cards of every student registered in the course
 *
 *   GET /api/generate/admit-course/search?q=CS1       → matching courses (suggestions)
 *   GET /api/generate/admit-course/:code              → summary (students, rooms, invigilators)
 *   GET /api/generate/admit-course/:code/pdf/:doc     → the PDF (?download=1 → attachment)
 *
 * Source: the batch's _layout.json (written by admit_cards.py next to the cards PDF)
 * and the batch's AdmitVerification records (card page numbers).
 */
const fs = require('fs');
const path = require('path');
const GeneratedFile = require('../models/GeneratedFile');
const AdmitVerification = require('../models/AdmitVerification');
const { OUTPUT_DIR, SCHEDULER_DIR, runPython } = require('../utils/pythonRunner');
const XLSX = require('xlsx');   // in-process Excel build for the fast duty-roster download

const PACK_DIR = path.join(OUTPUT_DIR, 'coursepack');
const DOCS = {
  idsheets: { key: 'out_idsheets', label: 'Identification Sheets' },
  seating: { key: 'out_seating', label: 'Seating Plan' },
  invigilation: { key: 'out_invig', label: 'Invigilation' },
  cards: { label: 'Admit Cards' },
};
const norm = (c) => String(c || '').replace(/\s+/g, '').toUpperCase();
const isFeePaid = (s) => /^paid$/i.test(String(s || '').trim());

const cardsFileOf = (rec) => {
  const f = (rec.files || []).find((x) => /admit cards/i.test(x.label || '')) || (rec.files || [])[0];
  return f ? f.filename : null;
};
const layoutOf = (rec) => {
  const f = cardsFileOf(rec);
  if (!f) return null;
  const p = path.join(OUTPUT_DIR, path.basename(f).replace(/\.pdf$/i, '_layout.json'));
  return fs.existsSync(p) ? p : null;
};

// a hosted server may not have the batch files on its disk yet → restore them from the database
async function ensureBatchFiles(rec) {
  const { ensureLocal } = require('../utils/fileStore');
  const f = cardsFileOf(rec);
  if (!f) return;
  const base = path.basename(f);
  await ensureLocal(base.replace(/\.pdf$/i, '_layout.json'));
  await ensureLocal(base);
}

// layout JSON is big — cache the per-course index by path + mtime
const _idx = new Map();
function courseIndex(layoutPath) {
  const mt = fs.statSync(layoutPath).mtimeMs;
  const hit = _idx.get(layoutPath);
  if (hit && hit.mt === mt) return hit.idx;
  const L = JSON.parse(fs.readFileSync(layoutPath, 'utf-8'));
  const idx = new Map();
  for (const s of L.sessions || []) {
    for (const rm of s.rooms || []) {
      for (const r of rm.rows || []) {
        const c = norm(r.course);
        if (!idx.has(c)) idx.set(c, { code: c, students: new Set(), rooms: new Set(), sittings: new Map(), invigilators: new Set() });
        const e = idx.get(c);
        e.students.add(String(r.sid));
        e.rooms.add(rm.name);
        const sk = `${s.date}|${s.slot}`;
        if (!e.sittings.has(sk)) e.sittings.set(sk, { date: s.date, day: s.day, slot: s.slot, rooms: new Set() });
        e.sittings.get(sk).rooms.add(rm.name);
        for (const i of rm.invigilators || []) e.invigilators.add(i);
      }
    }
  }
  const out = { idx, titles: L.code_title || {}, meta: L.meta || {} };
  _idx.set(layoutPath, { mt, idx: out });
  if (_idx.size > 6) _idx.delete(_idx.keys().next().value);
  return out;
}

/** active admit-card batches, newest first, that still have their layout */
async function batches(batchId) {
  const q = { kind: 'admit_cards', archived: { $ne: true } };
  if (batchId) q._id = batchId;
  const recs = await GeneratedFile.find(q).sort({ createdAt: -1 }).lean();
  for (const r of recs) await ensureBatchFiles(r);
  return recs.map((r) => ({ rec: r, layout: layoutOf(r) })).filter((x) => x.layout);
}

async function titlesFor(codes) {
  const out = {};
  try {
    const Course = require('../models/Course');
    for (const c of await Course.find({ code: { $in: codes } }).select('code name').lean()) {
      const k = norm(c.code); if (!out[k] && c.name) out[k] = c.name;
    }
  } catch { /* cosmetic */ }
  return out;
}

/** the newest batch that seats this course */
async function locate(code, batchId) {
  const list = await batches(batchId);
  if (!list.length) throw Object.assign(new Error('No admit cards have been generated yet (or their seating data is missing — regenerate them).'), { status: 404 });
  for (const b of list) {
    const ci = courseIndex(b.layout);
    if (ci.idx.has(code)) return { ...b, ci, entry: ci.idx.get(code) };
  }
  throw Object.assign(new Error(`${code} is not in the latest admit cards — it has no paper on the datesheet, or nobody is seated for it.`), { status: 404 });
}

const summarize = (e, title, rec) => ({
  code: e.code, title: title || '',
  students: e.students.size, rooms: [...e.rooms].sort(),
  sittings: [...e.sittings.values()].map((s) => ({ date: s.date, day: s.day, slot: s.slot, rooms: [...s.rooms].sort() })),
  invigilators: [...e.invigilators].sort(),
  batch: { id: rec._id, title: rec.title, createdAt: rec.createdAt },
});

// GET /api/generate/admit-course/search?q=
exports.search = async (req, res) => {
  try {
    const q = norm(req.query.q);
    const list = await batches(req.query.batchId);
    if (!list.length) return res.json({ items: [], batch: null });
    const seen = new Map();
    for (const b of list) {
      const ci = courseIndex(b.layout);
      for (const [code, e] of ci.idx) {
        if (seen.has(code)) continue;
        if (q && !code.includes(q)) continue;
        seen.set(code, { e, rec: b.rec, title: ci.titles[code] || '' });
      }
    }
    const codes = [...seen.keys()].sort((a, b) => (a.startsWith(q) ? 0 : 1) - (b.startsWith(q) ? 0 : 1) || a.localeCompare(b)).slice(0, 25);
    const names = await titlesFor(codes);
    // match on the course TITLE too ("data struct")
    let items = codes.map((c) => summarize(seen.get(c).e, seen.get(c).title || names[c], seen.get(c).rec));
    if (q && items.length < 25 && String(req.query.q || '').trim().length >= 3) {
      const t = String(req.query.q).trim().toLowerCase();
      const all = [];
      for (const b of list) for (const [code, e] of courseIndex(b.layout).idx) if (!seen.has(code)) all.push([code, e, b.rec]);
      const allNames = await titlesFor(all.map((x) => x[0]));
      for (const [code, e, rec] of all) {
        if (items.length >= 25) break;
        if ((allNames[code] || '').toLowerCase().includes(t)) { items.push(summarize(e, allNames[code], rec)); seen.set(code, true); }
      }
    }
    res.json({ items, batch: { id: list[0].rec._id, title: list[0].rec.title, createdAt: list[0].rec.createdAt } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Search failed.' });
  }
};

// GET /api/generate/admit-course/:code
exports.summary = async (req, res) => {
  try {
    const code = norm(req.params.code);
    const { rec, ci, entry } = await locate(code, req.query.batchId);
    const names = await titlesFor([code]);
    const avs = await AdmitVerification.find({ batchId: rec._id, 'exams.code': { $in: [code, code.toLowerCase()] } }).select('feeStatus cardPage').lean();
    res.json({
      ...summarize(entry, ci.titles[code] || names[code], rec),
      cards: avs.filter((a) => a.cardPage).length,
      unpaid: avs.filter((a) => !isFeePaid(a.feeStatus)).length,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not open that course.' });
  }
};

async function batchMeta(rec) {
  try {
    const av = await AdmitVerification.findOne({ batchId: rec._id, heading: { $ne: '' } }).select('heading examType').lean();
    if (!av) return {};
    const t = String(av.examType || '').toLowerCase();
    return { heading: av.heading || '', exam_label: t ? (t.startsWith('mid') ? 'Mid Term Examination' : 'Final Term Examination') : '' };
  } catch { return {}; }
}

async function buildPythonDocs(code, rec, layoutPath, title) {
  if (!fs.existsSync(PACK_DIR)) fs.mkdirSync(PACK_DIR, { recursive: true });
  const base = path.join(PACK_DIR, `${rec._id}_${code.replace(/[^A-Z0-9-]/g, '')}`);
  const files = { idsheets: `${base}_IdentificationSheets.pdf`, seating: `${base}_SeatingPlan.pdf`, invigilation: `${base}_Invigilation.pdf` };
  const lm = fs.statSync(layoutPath).mtimeMs;
  const fresh = Object.values(files).every((f) => fs.existsSync(f) && fs.statSync(f).mtimeMs >= lm);
  if (fresh) return files;
  const cfg = {
    mode: 'course_pack', layout_json: layoutPath, course: code,
    out_idsheets: files.idsheets, out_seating: files.seating, out_invig: files.invigilation,
    // a layout written by admit_cards.py carries its own meta; older ones get it from the batch
    meta: { ...(await batchMeta(rec)), ...((rec.meta && rec.meta.heading) ? { heading: rec.meta.heading } : {}) },
    code_title: title ? { [code]: title } : {},
  };
  const cfgPath = `${base}_cfg.json`;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  try {
    const { code: rc, stdout, stderr } = await runPython(path.join(SCHEDULER_DIR, 'admit_cards.py'), ['--config', cfgPath], { timeoutMs: 3 * 60 * 1000 });
    let r = {};
    try { r = JSON.parse(String(stdout || '').trim().split('\n').filter(Boolean).pop() || '{}'); } catch { r = {}; }
    if (rc !== 0 || r.status !== 'ok') throw Object.assign(new Error(r.error || `Could not build the course documents. ${String(stderr || '').slice(-200)}`), { status: r.status === 'error' ? 404 : 500 });
  } finally {
    try { fs.unlinkSync(cfgPath); } catch { /* ignore */ }
  }
  return files;
}

async function buildCards(code, rec) {
  const f = cardsFileOf(rec);
  const pdfPath = f ? path.join(OUTPUT_DIR, path.basename(f)) : null;
  if (!pdfPath || !fs.existsSync(pdfPath)) throw Object.assign(new Error('The admit-card PDF of this batch is missing — regenerate the admit cards.'), { status: 404 });
  if (!fs.existsSync(PACK_DIR)) fs.mkdirSync(PACK_DIR, { recursive: true });
  const out = path.join(PACK_DIR, `${rec._id}_${code.replace(/[^A-Z0-9-]/g, '')}_AdmitCards.pdf`);
  const avs = await AdmitVerification.find({ batchId: rec._id, 'exams.code': { $in: [code, code.toLowerCase()] } })
    .select('studentId cardPage updatedAt').lean();
  const pages = [...new Set(avs.map((a) => a.cardPage).filter((p) => p > 0))].sort((a, b) => a - b);
  if (!pages.length) throw Object.assign(new Error(`No admit card in this batch lists ${code}.`), { status: 404 });
  const newest = Math.max(fs.statSync(pdfPath).mtimeMs, ...avs.map((a) => new Date(a.updatedAt || 0).getTime()));
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= newest) return out;
  const { PDFDocument } = require('pdf-lib');
  const src = await PDFDocument.load(fs.readFileSync(pdfPath));
  const doc = await PDFDocument.create();
  const idx = pages.map((p) => p - 1).filter((i) => i >= 0 && i < src.getPageCount());
  for (const pg of await doc.copyPages(src, idx)) doc.addPage(pg);
  doc.setTitle(`Admit Cards — ${code}`);
  fs.writeFileSync(out, await doc.save());
  return out;
}

// GET /api/generate/admit-course/:code/pdf/:doc
exports.pdf = async (req, res) => {
  try {
    const code = norm(req.params.code);
    const doc = String(req.params.doc || '').toLowerCase();
    if (!DOCS[doc]) return res.status(400).json({ error: 'Unknown document.' });
    const { rec, layout, ci } = await locate(code, req.query.batchId);
    let file;
    if (doc === 'cards') file = await buildCards(code, rec);
    else {
      const title = ci.titles[code] || (await titlesFor([code]))[code] || '';
      file = (await buildPythonDocs(code, rec, layout, title))[doc];
    }
    const name = `${code}_${DOCS[doc].label.replace(/\s+/g, '')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not build that PDF.' });
  }
};

/* ───────────── Excel (editable) invigilation roster ───────────── */

async function rosterWorkbook(layoutPath, code, title) {
  const L = JSON.parse(fs.readFileSync(layoutPath, 'utf-8'));
  const Teacher = require('../models/Teacher');
  const info = new Map();
  for (const t of await Teacher.find({}).select('name aliases facultyId designation').lean()) {
    for (const n of [t.name, ...(t.aliases || [])]) info.set(String(n).trim().toLowerCase(), t);
  }
  const who = (n) => info.get(String(n).trim().toLowerCase()) || {};
  const rows = [];
  let maxInv = 0;
  const perT = new Map();
  for (const s of L.sessions || []) {
    for (const rm of s.rooms || []) {
      const codes = [...new Set((rm.rows || []).map((r) => norm(r.course)))].sort();
      if (code && !codes.includes(code)) continue;
      const inv = rm.invigilators || [];
      maxInv = Math.max(maxInv, inv.length);
      rows.push({ date: s.date, day: s.day, slot: s.slot, room: rm.name, students: (rm.rows || []).length,
        courseStudents: code ? (rm.rows || []).filter((r) => norm(r.course) === code).length : null, codes, inv });
      for (const n of inv) {
        if (!perT.has(n)) perT.set(n, { duties: 0, dates: new Set(), list: [] });
        const p = perT.get(n); p.duties++; p.dates.add(s.date); p.list.push(`${s.date} ${s.slot} ${rm.name}`);
      }
    }
  }
  const head = ['Date', 'Day', 'Time', 'Room', 'Students in room', ...(code ? [`${code} students`] : []), 'Papers in room'];
  for (let i = 1; i <= Math.max(maxInv, 3); i++) head.push(`Invigilator ${i}`, `Faculty ID ${i}`);
  head.push('Signature / Remarks');
  const aoa = [head];
  for (const r of rows) {
    const line = [r.date, r.day, r.slot, r.room, r.students, ...(code ? [r.courseStudents] : []), r.codes.join(', ')];
    for (let i = 0; i < Math.max(maxInv, 3); i++) { const n = r.inv[i] || ''; line.push(n, n ? (who(n).facultyId || '') : ''); }
    line.push('');
    aoa.push(line);
  }
  // Exam Office duty-roster format (same as the PDF), built by admit_cards.py with openpyxl.
  // No old-style fallback any more: if Python fails the error is shown, never the old format.
  const byTeacher = [...perT.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([n, p]) => { const t = who(n); return [n, t.facultyId || '', t.designation || '', p.duties, p.dates.size, p.list.join('  |  ')]; });
  // Build the Excel IN-PROCESS with SheetJS — fast (~1-2s). The Python/openpyxl
  // path (rosterFiles) took 20-40s on the free tier (python startup + imports),
  // so the download felt stuck after the click. This gives the same data instantly
  // as a clean, autofiltered table + a By-teacher sheet.
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = head.map((h) => ({ wch: /Invigilator/.test(h) ? 30 : /Papers/.test(h) ? 34 : /Signature/.test(h) ? 24 : 13 }));
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(aoa.length - 1, 1), c: head.length - 1 } }) };
  XLSX.utils.book_append_sheet(wb, ws, 'Invigilation');
  const tAoa = [['Teacher', 'Faculty ID', 'Designation', 'Duties', 'Exam days', 'Duty list (date · time · room)'], ...byTeacher];
  const ts = XLSX.utils.aoa_to_sheet(tAoa);
  ts['!cols'] = [{ wch: 32 }, { wch: 11 }, { wch: 26 }, { wch: 8 }, { wch: 10 }, { wch: 90 }];
  XLSX.utils.book_append_sheet(wb, ts, 'By teacher');
  if (title) wb.Props = { Title: title };
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** fresh duty roster (Exam Office format) straight from the batch layout — xlsx and/or pdf buffers */
async function rosterFiles(layoutPath, code, { xlsx = false, pdf = false, byTeacher = null } = {}) {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const cfgPath = path.join(OUTPUT_DIR, `roster_${stamp}.json`);
  const xPath = path.join(OUTPUT_DIR, `roster_${stamp}.xlsx`);
  const pPath = path.join(OUTPUT_DIR, `roster_${stamp}.pdf`);
  fs.writeFileSync(cfgPath, JSON.stringify({ mode: 'roster_xlsx', layout_json: layoutPath, code: code || '',
    out_xlsx: xlsx ? xPath : '', out_pdf: pdf ? pPath : '', by_teacher: byTeacher }));
  try {
    const { code: rc, stdout, stderr } = await runPython(path.join(SCHEDULER_DIR, 'admit_cards.py'), ['--config', cfgPath], { timeoutMs: 3 * 60 * 1000 });
    const last = String(stdout || '').trim().split('\n').filter(Boolean).pop() || '{}';
    let r = {}; try { r = JSON.parse(last); } catch { r = {}; }
    const ok = rc === 0 && r.status === 'ok' && (!xlsx || fs.existsSync(xPath)) && (!pdf || fs.existsSync(pPath));
    if (!ok) {
      const why = r.error || String(stderr || stdout || '').trim().split('\n').slice(-3).join(' ').slice(-400) || `exit code ${rc}`;
      console.warn('⚠ duty roster (python) failed:', why);
      throw Object.assign(new Error(`Could not build the duty roster: ${why}`), { status: 500 });
    }
    return { xlsx: xlsx ? fs.readFileSync(xPath) : null, pdf: pdf ? fs.readFileSync(pPath) : null };
  } finally {
    for (const x of [cfgPath, xPath, pPath]) { try { fs.unlinkSync(x); } catch { /* ignore */ } }
  }
}

/** the batch's invigilation roster PDF, always re-built in the Exam Office format */
async function invigilationPdfOf(rec) {
  await ensureBatchFiles(rec);
  const layout = layoutOf(rec);
  if (!layout) return null;
  return (await rosterFiles(layout, null, { pdf: true })).pdf;
}

function sendXlsx(res, buf, name) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.end(buf);
}

// GET /api/generate/admit-course/:code/xlsx  → that course's invigilation (Excel)
exports.courseXlsx = async (req, res) => {
  try {
    const code = norm(req.params.code);
    const { layout } = await locate(code, req.query.batchId);
    sendXlsx(res, await rosterWorkbook(layout, code, `Invigilation — ${code}`), `${code}_Invigilation.xlsx`);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not build the Excel file.' });
  }
};

// GET /api/generate/invigilation-xlsx[?batchId=]  → the whole batch's invigilation (Excel)
exports.batchXlsx = async (req, res) => {
  try {
    const list = await batches(req.query.batchId);
    if (!list.length) return res.status(404).json({ error: 'No admit cards with seating data yet — generate the admit cards first.' });
    sendXlsx(res, await rosterWorkbook(list[0].layout, null, 'Invigilation Roster'), 'Invigilation_Roster.xlsx');
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not build the Excel file.' });
  }
};

// GET /api/generate/invigilation-pdf[?batchId=]  → the whole batch's duty roster (PDF, Exam Office format)
exports.batchPdf = async (req, res) => {
  try {
    const list = await batches(req.query.batchId);
    if (!list.length) return res.status(404).json({ error: 'No admit cards with seating data yet — generate the admit cards first.' });
    const buf = (await rosterFiles(list[0].layout, null, { pdf: true })).pdf;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="Invigilation_Roster.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(buf);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not build the duty roster PDF.' });
  }
};

exports.invigilationPdfOf = invigilationPdfOf;
module.exports._test = { norm, courseIndex, layoutOf, rosterFiles };
