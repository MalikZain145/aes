// Student-course editor (Exam Cell) — view every student's registered courses
// (one row per student, reg-number ascending) and ADD / EDIT / DELETE a single course.
// ADD seats the new paper at its datesheet time on a free bench (different course
// and different batch beside, room not over capacity) — refused if it would clash.
// A save also updates that ONE student's admit-card data (AdmitVerification): the
// old course's seat is freed (left empty — no one else is moved), and an edited
// course is re-seated into a room where that paper's students already sit. If the
// paper has ALREADY been sat (its date is in the past) the admit data is left
// untouched — only the registration record changes.
const os = require('os');
const path = require('path');
const StudentRegistration = require('../models/StudentRegistration');
const AdmitVerification = require('../models/AdmitVerification');
const Course = require('../models/Course');
const GeneratedFile = require('../models/GeneratedFile');
const admitCrypto = require('../utils/admitCrypto');
const { regenForStudent, renderBatchSeating, spliceCardPage, syncBatchDocs } = require('../utils/regenStudentPdf');
const { OUTPUT_DIR, fileSize } = require('../utils/pythonRunner');
const { logActivity } = require('../utils/logger');

// Same LAN-IP QR host the admit-card generator uses, so a re-printed card's QR
// points at this server exactly like the batch did.
function detectBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const port = process.env.PORT || 5000;
  const addrs = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family === 'IPv4' && !i.internal && !/^169\.254\./.test(i.address)) addrs.push(i.address);
    }
  }
  const pick = addrs.find((a) => a.startsWith('192.168.'))
    || addrs.find((a) => a.startsWith('10.'))
    || addrs.find((a) => /^172\.(1[6-9]|2\d|3[01])\./.test(a))
    || addrs[0];
  if (pick) return `http://${pick}:${port}`;
  return `${req.protocol}://${req.get('host')}`;
}

const up = (s) => String(s || '').trim().toUpperCase();
const rowNum = (seat) => { const m = String(seat || '').match(/^(\d+)/); return m ? m[1] : String(seat || ''); };

// GET /api/exam/student-courses?search=&page=&limit=
exports.list = async (req, res) => {
  const { search = '', page = 1, limit = 40 } = req.query;
  const q = { studentId: { $ne: '' } };
  if (search) {
    q.$or = [
      { studentId: new RegExp(search, 'i') },
      { name: new RegExp(search, 'i') },
      { program: new RegExp(search, 'i') },
      { courses: new RegExp(search, 'i') },
    ];
  }
  const pg = Math.max(1, parseInt(page, 10) || 1);
  const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 40));
  // reg-number ascending (numeric where possible)
  const [rows, total, allCourses] = await Promise.all([
    StudentRegistration.find(q).lean(),
    StudentRegistration.countDocuments(q),
    Course.find({}).select('code name').lean(),
  ]);
  const nameOf = {};
  for (const c of allCourses) { const k = up(c.code); if (k && !nameOf[k]) nameOf[k] = c.name || ''; }
  rows.sort((a, b) => {
    const na = Number(a.studentId), nb = Number(b.studentId);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    return String(a.studentId).localeCompare(String(b.studentId));
  });
  const items = rows.slice((pg - 1) * lim, pg * lim).map((r) => ({
    studentId: r.studentId, name: r.name, program: r.program, batch: r.batch,
    // each course as { code, name } so the UI shows the code WITH its title
    courses: (r.courses || []).map((c) => ({ code: c, name: nameOf[up(c)] || '' })),
  }));
  res.json({ items, total, page: pg, pages: Math.ceil(total / lim) });
};

// Does an admit card exist for this reg, and has the affected paper NOT been sat yet?
function paperPassed(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr + 'T23:59:00');
  return !Number.isNaN(d.getTime()) && d < new Date();
}

const cohortOf = (p) => {
  const t = ' ' + String(p || '').toLowerCase().replace(/[.\-]/g, ' ') + ' ';
  if (/( ms | mphil |mphil| master| mba | msc |postgrad| pgd | phd )/.test(t)) return 'pg';
  if (t.includes('btech') || t.includes(' b tech') || t.includes('engineering technology')) return 'btech';
  return 'bs';
};
const span = (slot) => { const m = String(slot || '').match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/); if (!m) return null; const f = (h, mm) => ((+h < 8 ? +h + 12 : +h) * 60 + +mm); return [f(m[1], m[2]), f(m[3], m[4])]; };

/** The (date, slot) a paper is written at in this batch — for the student's OWN
 *  program cohort when a shared code sits at different times per program. */
async function paperCell(code, batchId, program) {
  const CODE = up(code);
  const avs = await AdmitVerification.find({ batchId, 'exams.code': CODE }).select('program exams').lean();
  const tally = new Map();
  const mine = cohortOf(program);
  for (const a of avs) for (const e of a.exams || []) {
    if (up(e.code) !== CODE || !e.date || !e.room || e.room === 'UNASSIGNED') continue;
    const k = `${e.date}|${e.slot}`;
    const t = tally.get(k) || { date: e.date, slot: e.slot, dateDisp: e.dateDisp, day: e.day, same: 0, n: 0 };
    t.n++; if (cohortOf(a.program) === mine) t.same++;
    tally.set(k, t);
  }
  const best = [...tally.values()].sort((x, y) => y.same - x.same || y.n - x.n)[0];
  if (best) return best;
  // nobody sits it yet → take its time from the student's own datesheet
  try {
    const fs = require('fs');
    const ed = require('./datesheetEditorController')._internals;
    const sheets = await GeneratedFile.find({ kind: 'datesheet', archived: { $ne: true } }).sort({ createdAt: -1 }).lean();
    for (const d of sheets) {
      if (ed.datesheetCohort(d) !== mine) continue;
      const sf = d.meta && d.meta.scheduleFile;
      const p = sf ? path.join(OUTPUT_DIR, path.basename(sf)) : null;
      if (!p || !fs.existsSync(p)) continue;
      const c = (JSON.parse(fs.readFileSync(p, 'utf-8')).courses || []).find((x) => up(x.code) === CODE);
      if (c) {
        const [y, m, dd] = String(c.date).split('-');
        const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(`${c.date}T00:00:00`).getDay()];
        return { date: c.date, slot: c.slot, dateDisp: `${dd}-${MON[+m - 1]}-${y}`, day };
      }
    }
  } catch { /* fall through */ }
  return null;
}

// Find a free seat for `code` at its (date, slot): a bench in a room where the paper
// already sits, whose partner is a DIFFERENT course AND a different batch (or the
// bench is empty), never beyond the room's exam seats. Returns { room, seat } or null.
// Never moves an existing student.
async function findSeatForCourse(code, batchId, cell, myBatch, capOf = {}) {
  const CODE = up(code);
  if (!cell) cell = await paperCell(code, batchId, '');
  if (!cell) return null;   // paper not seated in this batch (e.g. nobody sits it)
  const { date, slot } = cell;
  const avs = await AdmitVerification.find({ batchId }).select('batch exams').lean();
  const roomSeats = {};   // room -> { rowNum -> { L:{seat,course,batch}, R:{...} } }
  for (const a of avs) for (const e of (a.exams || [])) {
    if (e.date !== date || e.slot !== slot || !e.room || e.room === 'UNASSIGNED') continue;
    const rn = rowNum(e.seat); const side = /A$/i.test(e.seat) ? 'R' : 'L';
    ((roomSeats[e.room] = roomSeats[e.room] || {})[rn] = roomSeats[e.room][rn] || {})[side] = { seat: e.seat, course: up(e.code), batch: String(a.batch || '').trim().toLowerCase() };
  }
  const mb = String(myBatch || '').trim().toLowerCase();
  const okPartner = (p) => p.course !== CODE && (!mb || p.batch !== mb);
  const hasCourse = (room) => Object.values(roomSeats[room]).some((r) => (r.L && r.L.course === CODE) || (r.R && r.R.course === CODE));
  const rooms = Object.keys(roomSeats).sort((a, b) => (hasCourse(b) ? 1 : 0) - (hasCourse(a) ? 1 : 0));
  for (const room of rooms) {
    const rowsMap = roomSeats[room];
    for (const rn of Object.keys(rowsMap).sort((a, b) => Number(a) - Number(b))) {
      const b = rowsMap[rn];
      if (b.L && !b.R && okPartner(b.L)) return { room, seat: `${rn}A`, date, slot };
      if (b.R && !b.L && okPartner(b.R)) return { room, seat: `${rn}`, date, slot };
    }
  }
  // else a brand-new empty bench (next row) in a room with spare exam seats
  for (const room of rooms) {
    const rowsMap = roomSeats[room];
    const maxRow = Math.max(0, ...Object.keys(rowsMap).map(Number));
    const cap = Number(capOf[room]) || 0;
    if (cap && (maxRow + 1) * 2 > cap) continue;
    return { room, seat: `${maxRow + 1}`, date, slot };
  }
  return null;
}

async function roomCapacities(batchId) {
  try {
    const batch = await GeneratedFile.findById(batchId).lean();
    const f = batch && (batch.files || []).find((x) => /admit cards/i.test(x.label || ''));
    if (!f) return {};
    const lp = path.join(OUTPUT_DIR, path.basename(f.filename).replace(/\.pdf$/i, '_layout.json'));
    const L = JSON.parse(require('fs').readFileSync(lp, 'utf-8'));
    return Object.fromEntries((L.venues || []).map((v) => [v.name, v.exam_seats || v.seats || 0]));
  } catch { return {}; }
}

// POST /api/exam/student-courses/:reg/course  { action:'delete'|'edit', code, newCode? }
exports.editCourse = async (req, res) => {
  const reg = String(req.params.reg || '').trim();
  const action = String((req.body || {}).action || '').toLowerCase();
  const code = up((req.body || {}).code);
  const newCode = up((req.body || {}).newCode);
  if (!reg || !code || !['edit', 'delete', 'add'].includes(action)) {
    return res.status(400).json({ error: 'reg, code and a valid action (add|edit|delete) are required.' });
  }
  const student = await StudentRegistration.findOne({ studentId: reg });
  if (!student) return res.status(404).json({ error: 'Student not found.' });
  const cur = (student.courses || []).map(up);
  if (action === 'add') {
    if (cur.includes(code)) return res.status(400).json({ error: `${reg} already has ${code}.` });
    const exists = await Course.findOne({ code: new RegExp('^' + code.replace(/[^A-Z0-9-]/g, '') + '$', 'i') }).lean();
    if (!exists) return res.status(400).json({ error: `${code} is not a known course code.` });
  } else if (!cur.includes(code)) return res.status(400).json({ error: `${code} is not in this student's courses.` });

  if (action === 'edit') {
    if (!newCode) return res.status(400).json({ error: 'newCode is required for edit.' });
    const exists = await Course.findOne({ code: new RegExp('^' + newCode + '$', 'i') }).lean();
    if (!exists) return res.status(400).json({ error: `${newCode} is not a known course code.` });
    if (cur.includes(newCode) && newCode !== code) return res.status(400).json({ error: `Student already has ${newCode}.` });
  }

  // the course that needs a seat (add → code, edit → newCode)
  const seatCode = action === 'add' ? code : action === 'edit' ? newCode : null;
  const av = await AdmitVerification.findOne({ studentId: reg }).sort({ createdAt: -1 });
  let spot = null;
  if (av && seatCode) {
    const cell = await paperCell(seatCode, av.batchId, av.program || student.program);
    if (cell && !paperPassed(cell.date)) {
      // the new paper must not overlap another paper of this student
      const sp = span(cell.slot);
      const hit = (av.exams || []).find((e) => up(e.code) !== code && e.date === cell.date && e.room && (() => { const o = span(e.slot); return o && sp && o[0] < sp[1] && sp[0] < o[1]; })());
      if (hit) {
        return res.status(409).json({ error: `${seatCode} is written on ${cell.dateDisp || cell.date} at ${cell.slot} — ${reg} already sits ${hit.code} then. Not ${action === 'add' ? 'added' : 'changed'} (it would be a clash).` });
      }
      spot = await findSeatForCourse(seatCode, av.batchId, cell, av.batch || student.batch, await roomCapacities(av.batchId));
      if (!spot) return res.status(409).json({ error: `No free seat for ${seatCode} on ${cell.dateDisp || cell.date} ${cell.slot} (rooms full or only same-batch benches). Not ${action === 'add' ? 'added' : 'changed'}.` });
      spot.dateDisp = cell.dateDisp; spot.day = cell.day;
    }
  }

  // 1) update the registration record
  student.courses = action === 'delete'
    ? cur.filter((c) => c !== code)
    : action === 'add' ? [...cur, code]
      : cur.map((c) => (c === code ? newCode : c));
  await student.save();
  // enrollment of the course(s) involved follows the registration at once
  try { await require('../utils/enrollment').recomputeEnrollment([code, newCode].filter(Boolean)); } catch (e) { console.error('enrollment:', e.message); }

  // 2) update the admit-card data (only the newest batch, only if paper not passed)
  let admitUpdated = false, note = '';
  const cells = [];   // affected (date,slot) cells whose seating must be re-printed
  if (av && action === 'add') {
    const c = await Course.findOne({ code: new RegExp('^' + code.replace(/[^A-Z0-9-]/g, '') + '$', 'i') }).lean();
    if (spot) {
      av.exams.push({
        code, name: (c && c.name) || code, teacher: (c && c.teacher) || '',
        date: spot.date, dateDisp: spot.dateDisp, day: spot.day, slot: spot.slot, room: spot.room, seat: spot.seat,
        start: String(spot.slot).split('-')[0], finish: String(spot.slot).split('-')[1],
        key: av.token ? admitCrypto.paperKey(av.token, code, spot.date, spot.slot) : '',
      });
      await av.save();
      admitUpdated = true;
      cells.push({ date: spot.date, slot: spot.slot });
      note = `${code} added — ${spot.dateDisp || spot.date} ${spot.slot}, ${spot.room} seat ${spot.seat}.`;
    } else {
      note = `${code} added to the registration, but it has no paper in the current datesheet${av ? '' : ''} — add it to the datesheet (Date Sheets → Update / Edit), then regenerate the admit cards.`;
    }
  } else if (!av && action === 'add') {
    note = `${code} added to the registration. ${reg} has no admit card in the current batch (e.g. a removed batch) — nothing else to update.`;
  } else if (av) {
    const oldExam = (av.exams || []).find((e) => up(e.code) === code);
    if (oldExam && paperPassed(oldExam.date)) {
      note = `${code}'s paper (${oldExam.date}) has already been sat — registration updated, admit card left unchanged.`;
    } else {
      if (oldExam && oldExam.date && oldExam.slot) cells.push({ date: oldExam.date, slot: oldExam.slot });
      // remove the old course's exam (its seat is freed and left EMPTY)
      av.exams = (av.exams || []).filter((e) => up(e.code) !== code);
      if (action === 'edit') {
        // seat the new course where its students already sit (spot found above)
        const c = await Course.findOne({ code: new RegExp('^' + newCode + '$', 'i') }).lean();
        if (spot) {
          av.exams.push({
            code: newCode, name: (c && c.name) || newCode, teacher: (c && c.teacher) || '',
            date: spot.date, dateDisp: spot.dateDisp, day: spot.day, slot: spot.slot, room: spot.room, seat: spot.seat,
            // per-(student,paper) verification key, keyed like the batch generator
            key: av.token ? admitCrypto.paperKey(av.token, newCode, spot.date, spot.slot) : '',
          });
          cells.push({ date: spot.date, slot: spot.slot });
        } else {
          av.exams.push({ code: newCode, name: (c && c.name) || newCode, teacher: (c && c.teacher) || '', room: '', seat: '' });
          note = `${newCode} added to the card, but it is not scheduled in this exam (no seat).`;
        }
      }
      await av.save();
      admitUpdated = true;
    }
  }

  // 3) re-print from the (updated) stored seating — no one else is moved, the freed
  //    seat simply prints empty. Split into a FAST hot path and a background sync:
  //    • HOT (awaited, ~5s): render just THIS student's 1-page corrected admit card.
  //      studentCardPdf serves it immediately, so Finance's per-student card/print/
  //      email is correct the instant the edit returns.
  //    • BACKGROUND (~1 min): splice that page into the whole-batch admit PDF and
  //      re-render the full seating plan, so the Finance batch downloads catch up too.
  let downloads = null, financeSyncing = false, pdfStale = admitUpdated;
  if (admitUpdated) {
    try {
      const campusLine = 'Abasyn University Islamabad Campus';
      const r = await regenForStudent({ reg, cells: [], baseUrl: detectBaseUrl(req), campusLine });
      if (!r.error && r.admitFile) {
        const prev = await GeneratedFile.findOne({ kind: 'admit_update', 'meta.reg': reg });
        const rec = prev || new GeneratedFile({ kind: 'admit_update' });
        rec.title = `Updated Admit Card — ${reg}`;
        rec.examType = (av && av.examType) || '';
        rec.files = [{ label: 'Updated Admit Card', filename: r.admitFile.filename, format: 'pdf', sizeBytes: r.admitFile.sizeBytes }];
        rec.meta = { reg, cardPage: av.cardPage, batchId: av.batchId, updatedAt: new Date().toISOString(), lastAction: `${action} ${code}${action === 'edit' ? '→' + newCode : ''}` };
        rec.status = 'ready';
        await rec.save();
        downloads = { id: rec._id, files: rec.files.map((f) => ({ label: f.label, filename: f.filename })) };
        pdfStale = false;

        // ── BACKGROUND Finance-batch sync (non-blocking) ──
        const batchId = av.batchId, cardPage = av.cardPage, admitPath = r.admitPath;
        if (batchId) {
          financeSyncing = true;
          setImmediate(async () => {
            try {
              const batch = await GeneratedFile.findById(batchId);
              if (!batch) return;
              const cardsFile = (batch.files || []).find((f) => /Admit Cards/i.test(f.label));
              const seatFile = (batch.files || []).find((f) => /Seating/i.test(f.label));
              let changed = false;
              if (cardsFile && cardPage && admitPath) {
                const sp = await spliceCardPage({
                  batchPdfPath: path.join(OUTPUT_DIR, path.basename(cardsFile.filename)),
                  pageIndex: cardPage - 1, cardPdfPath: admitPath,
                });
                if (sp.ok) { cardsFile.sizeBytes = sp.sizeBytes; changed = true; }
                else console.error('[edit] splice failed:', sp.error);
              }
              if (seatFile) {
                const rs = await renderBatchSeating({
                  batchId: batch._id, campusLine,
                  outPath: path.join(OUTPUT_DIR, path.basename(seatFile.filename)),
                });
                if (rs.ok) { seatFile.sizeBytes = rs.sizeBytes; changed = true; }
                else console.error('[edit] seating re-render failed:', rs.error);
              }
              // ID sheets, invigilation roster and the course search follow the new seat too
              const sd = await syncBatchDocs({ batch });
              if (sd.ok) changed = true;
              else console.error('[edit] ID sheets / invigilation re-render:', sd.error);
              if (changed) { batch.markModified('files'); await batch.save(); }
              console.log(`[edit] Finance batch synced for ${reg} (${action} ${code}${action === 'edit' ? '→' + newCode : ''})`);
            } catch (e) {
              console.error('[edit] Finance batch sync error:', e.message);
            }
          });
        }
      } else if (r.error) {
        note = (note ? note + ' ' : '') + `(Data updated, but the card re-print reported: ${r.error})`;
      }
    } catch (e) {
      note = (note ? note + ' ' : '') + `(Data updated; card re-print failed: ${e.message})`;
    }
  }

  await logActivity('exam.edit_course', `${action} ${code}${action === 'edit' ? '→' + newCode : ''} for ${reg}${spot ? ` (${spot.room} ${spot.seat})` : ''}`, 'warning');
  res.json({ ok: true, courses: student.courses, admitUpdated, financeSyncing, note, pdfStale, downloads });
};
