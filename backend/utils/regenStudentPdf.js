/**
 * Re-print ONE student's admit card + the seating plan for the slot(s) that
 * student moved in — after an Exam-Cell course edit/delete — WITHOUT re-seating
 * or moving anyone else. The authoritative seating is AdmitVerification (already
 * updated by studentCourseController); we simply read it back and hand the exact
 * card + affected-slot layout to scheduler/render_one.py, which reuses the same
 * renderers the full batch uses, so the output looks identical.
 *
 * The freed seat of a deleted/edited-away course is simply absent from the
 * rebuilt layout, so it prints EMPTY — no other student shifts to fill it.
 */
const fs = require('fs');
const path = require('path');
const AdmitVerification = require('../models/AdmitVerification');
const { OUTPUT_DIR, SCHEDULER_DIR, runPython, fileSize } = require('./pythonRunner');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const rowNum = (seat) => { const m = String(seat || '').match(/^(\d+)/); return m ? m[1] : String(seat || ''); };
const isRight = (seat) => /A$/i.test(String(seat || ''));

// 'YYYY-MM-DD' -> '27-Aug-2026'
function disp(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(dateStr || '');
  return `${m[3]}-${MONTHS[+m[2] - 1] || '?'}-${m[1]}`;
}
// 'YYYY-MM-DD' -> full weekday name
function dayName(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return DAYS[d.getUTCDay()] || '';
}
const t2m = (t) => { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : 0; };
const slotStart = (slot) => t2m(String(slot || '').split('-')[0]);

/**
 * Build the seating-plan `sessions_layout` straight from stored AdmitVerification
 * seats. `cellSet` (Set of "date|slot") limits it to those cells; null = ALL
 * sessions (used to re-render the whole Finance seating plan after an edit).
 * `filter` narrows the AV query (e.g. { batchId }).
 */
async function buildSessionsLayout(cellSet, filter = {}) {
  const all = await AdmitVerification.find(filter).select('studentId name program batch exams').lean();
  const byCell = {};
  for (const a of all) {
    for (const e of (a.exams || [])) {
      if (!e.room || !e.seat || e.room === 'UNASSIGNED') continue;
      const key = `${e.date}|${e.slot}`;
      if (cellSet && !cellSet.has(key)) continue;
      const cell = byCell[key] || (byCell[key] = { date: e.date, slot: e.slot, dateDisp: e.dateDisp, day: e.day, rooms: {} });
      (cell.rooms[e.room] = cell.rooms[e.room] || []).push({
        row: Number(rowNum(e.seat)) || 0, col: isRight(e.seat) ? 'R' : 'L', seat: e.seat,
        sid: a.studentId, name: a.name || '', program: a.program || '', batch: a.batch || '',
        course: String(e.code || '').toUpperCase(),
      });
    }
  }
  return Object.values(byCell)
    .sort((a, b) => (a.date === b.date ? slotStart(a.slot) - slotStart(b.slot) : String(a.date).localeCompare(String(b.date))))
    .map((cell) => ({
      date: cell.dateDisp || disp(cell.date),
      day: cell.day || dayName(cell.date),
      slot: cell.slot,
      rooms: Object.keys(cell.rooms).sort().map((name) => ({
        name,
        rows: cell.rooms[name].sort((x, y) => (x.row - y.row) || (x.col === 'L' ? -1 : 1)),
      })),
    }));
}

function metaFromAv(av, campusLine) {
  const examType = (av && av.examType) || 'finals';
  const term = [av && av.semester, av && av.year].filter(Boolean).join(' ').trim();
  const anyPG = ((av && av.exams) || []).some((e) => { const n = String(e.code || '').match(/(\d{3,})/); return n && +n[1] >= 500; });
  return {
    campus_line: campusLine || 'Abasyn University Islamabad Campus',
    heading: (av && av.heading) || '',
    exam_type: examType,
    program_level: anyPG ? 'Postgraduate' : 'Undergraduate',
    exam_label: examType === 'mids' ? 'Mid Term Examination' : 'Final Term Examination',
    term,
  };
}

/**
 * @param {object} args
 * @param {string} args.reg           student registration number
 * @param {Array<{date:string,slot:string}>} args.cells  affected (date,slot) cells to re-seat
 * @param {string} args.baseUrl       server host for the QR (from detectBaseUrl)
 * @param {string} [args.campusLine]
 * @returns {Promise<{admitFile?:string, seatingFile?:string, error?:string}>}
 */
async function regenForStudent({ reg, cells = [], baseUrl = '', campusLine = 'Abasyn University Islamabad Campus' }) {
  const av = await AdmitVerification.findOne({ studentId: reg }).sort({ createdAt: -1 }).lean();
  if (!av) return { error: 'No admit-card record for this student.' };

  // ---- meta (matches admit_cards.run) ----
  const meta = metaFromAv(av, campusLine);

  // ---- QR: REUSE the student's existing token so the card stays verifiable ----
  let srv = String(baseUrl || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const qrUrl = av.token
    ? (srv ? `Only a valid scanner can scan.  ABASYN-ADMIT:${av.token}|${srv}`
      : `Only a valid scanner can scan.  ABASYN-ADMIT:${av.token}`)
    : '';

  // ---- admit-card rows (chronological, exactly like the batch) ----
  const rows = (av.exams || [])
    .filter((e) => e.room && e.seat && e.room !== 'UNASSIGNED')
    .slice()
    .sort((a, b) => (a.date === b.date ? slotStart(a.slot) - slotStart(b.slot) : String(a.date).localeCompare(String(b.date))))
    .map((e, i) => ({
      sr: i + 1, code: e.code, title: e.name || e.code, teacher: e.teacher || '',
      date: e.dateDisp || disp(e.date), day: (e.day || dayName(e.date)).slice(0, 3),
      time: e.slot, room: e.room, seat: e.seat,
    }));

  const student = {
    sid: av.studentId, name: av.name || '', program: av.program || '', batch: av.batch || '',
    _qr_url: qrUrl,
  };

  // ---- affected-slot seating layout (from ALL students' stored seats) ----
  const cellSet = new Set((cells || []).map((c) => `${c.date}|${c.slot}`));
  const sessions_layout = cellSet.size ? await buildSessionsLayout(cellSet) : [];

  // ---- write config + render ----
  const stamp = Date.now();
  const safeReg = String(reg).replace(/[^A-Za-z0-9_-]/g, '');
  const admitName = `AdmitCard_${safeReg}_${stamp}.pdf`;
  const seatingName = `Seating_${safeReg}_${stamp}.pdf`;
  const cfg = {
    out_admit: path.join(OUTPUT_DIR, admitName),
    out_seating: sessions_layout.length ? path.join(OUTPUT_DIR, seatingName) : undefined,
    meta, student, rows, sessions_layout,
  };
  const cfgPath = path.join(OUTPUT_DIR, `regen_${safeReg}_${stamp}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg), 'utf-8');

  let out;
  try {
    out = await runPython(path.join(SCHEDULER_DIR, 'render_one.py'), [cfgPath], { timeoutMs: 120000 });
  } finally {
    try { fs.unlinkSync(cfgPath); } catch { /* ignore */ }
  }
  const parsed = (() => { try { return JSON.parse((out.stdout || '').trim().split('\n').pop()); } catch { return {}; } })();
  if (parsed.error) return { error: `PDF render failed: ${parsed.error}` };
  if (out.code !== 0) return { error: `PDF render exited ${out.code}. ${(out.stderr || '').slice(-200)}` };

  const result = {};
  if (fs.existsSync(cfg.out_admit)) result.admitFile = { filename: admitName, sizeBytes: fileSize(cfg.out_admit) };
  if (cfg.out_seating && fs.existsSync(cfg.out_seating)) result.seatingFile = { filename: seatingName, sizeBytes: fileSize(cfg.out_seating) };
  result.admitPath = cfg.out_admit;   // absolute path of the 1-page corrected card (for splicing)
  return result;
}

/**
 * Re-render the WHOLE seating plan of a batch from stored AdmitVerification seats
 * (render only — nothing is re-seated) and overwrite `outPath`. This keeps the
 * Finance-side seating-plan PDF in sync after a course edit, since the freed seat
 * is now absent and the moved student now sits with their new course's group.
 */
async function renderBatchSeating({ batchId, campusLine, outPath }) {
  const sample = await AdmitVerification.findOne(batchId ? { batchId } : {}).sort({ createdAt: -1 }).lean();
  if (!sample) return { error: 'No admit-card records to render seating from.' };
  const meta = metaFromAv(sample, campusLine);
  const sessions_layout = await buildSessionsLayout(null, batchId ? { batchId } : {});
  if (!sessions_layout.length) return { error: 'No seated sessions found.' };

  const cfg = { out_seating: outPath, meta, sessions_layout };
  const cfgPath = outPath.replace(/\.pdf$/i, '') + `_seatcfg_${Date.now()}.json`;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg), 'utf-8');
  let out;
  try {
    out = await runPython(path.join(SCHEDULER_DIR, 'render_one.py'), [cfgPath], { timeoutMs: 180000 });
  } finally {
    try { fs.unlinkSync(cfgPath); } catch { /* ignore */ }
  }
  const parsed = (() => { try { return JSON.parse((out.stdout || '').trim().split('\n').pop()); } catch { return {}; } })();
  if (parsed.error) return { error: `Seating render failed: ${parsed.error}` };
  if (out.code !== 0) return { error: `Seating render exited ${out.code}. ${(out.stderr || '').slice(-200)}` };
  return { ok: fs.existsSync(outPath), sizeBytes: fileSize(outPath) };
}

/**
 * Replace ONE page of an existing multi-page PDF (the batch admit-card PDF) with
 * the single corrected page — so the whole-batch PDF and the per-student extract
 * (studentCardPdf, which slices by cardPage) both show the edited card. Fast:
 * pure pdf-lib page surgery, no re-render of the other ~2,500 cards.
 */
async function spliceCardPage({ batchPdfPath, pageIndex, cardPdfPath }) {
  const { PDFDocument } = require('pdf-lib');
  if (!fs.existsSync(batchPdfPath) || !fs.existsSync(cardPdfPath)) return { error: 'batch or card PDF missing' };
  const batch = await PDFDocument.load(fs.readFileSync(batchPdfPath));
  if (pageIndex < 0 || pageIndex >= batch.getPageCount()) return { error: `page ${pageIndex + 1} out of range` };
  const card = await PDFDocument.load(fs.readFileSync(cardPdfPath));
  const [copied] = await batch.copyPages(card, [0]);
  // insert the new page right after the old one, then remove the old one
  batch.insertPage(pageIndex + 1, copied);
  batch.removePage(pageIndex);
  fs.writeFileSync(batchPdfPath, Buffer.from(await batch.save()));
  return { ok: true, sizeBytes: fileSize(batchPdfPath) };
}

module.exports = { regenForStudent, renderBatchSeating, spliceCardPage };
