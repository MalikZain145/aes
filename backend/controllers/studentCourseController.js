// Student-course editor (Exam Cell) — view every student's registered courses
// (one row per student, reg-number ascending) and EDIT / DELETE a single course.
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
const { regenForStudent, renderBatchSeating, spliceCardPage } = require('../utils/regenStudentPdf');
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

// Find a free seat for `code` at its (date, slot): a bench in a room where the paper
// already sits, whose partner seat is a DIFFERENT course (or empty). Returns
// { room, seat } or null. Never moves an existing student.
async function findSeatForCourse(code, batchId) {
  const CODE = up(code);
  // gather this batch's seat map for the paper's cell
  const avs = await AdmitVerification.find({ batchId }).select('exams').lean();
  let date = null, slot = null;
  const roomSeats = {};   // room -> { rowNum -> { L:{seat,course}, R:{seat,course} } }
  for (const a of avs) for (const e of (a.exams || [])) {
    if (up(e.code) === CODE && e.room && e.room !== 'UNASSIGNED') { date = e.date; slot = e.slot; }
  }
  if (!date) return null;   // paper not seated in this batch (e.g. nobody sits it)
  for (const a of avs) for (const e of (a.exams || [])) {
    if (e.date !== date || e.slot !== slot || !e.room || e.room === 'UNASSIGNED') continue;
    const rn = rowNum(e.seat); const side = /A$/i.test(e.seat) ? 'R' : 'L';
    ((roomSeats[e.room] = roomSeats[e.room] || {})[rn] = roomSeats[e.room][rn] || {})[side] = { seat: e.seat, course: up(e.code) };
  }
  // prefer a room that already has this course; fill an empty partner side (diff course)
  const rooms = Object.keys(roomSeats).sort((a, b) => {
    const ac = Object.values(roomSeats[a]).some((r) => (r.L && r.L.course === CODE) || (r.R && r.R.course === CODE));
    const bc = Object.values(roomSeats[b]).some((r) => (r.L && r.L.course === CODE) || (r.R && r.R.course === CODE));
    return (bc ? 1 : 0) - (ac ? 1 : 0);
  });
  for (const room of rooms) {
    const rowsMap = roomSeats[room];
    for (const rn of Object.keys(rowsMap).sort((a, b) => Number(a) - Number(b))) {
      const b = rowsMap[rn];
      if (b.L && !b.R && b.L.course !== CODE) return { room, seat: `${rn}A`, date, slot };
      if (b.R && !b.L && b.R.course !== CODE) return { room, seat: `${rn}`, date, slot };
    }
    // else a brand-new empty bench (next row) in a room that has this course
    if (Object.values(rowsMap).some((r) => (r.L && r.L.course === CODE) || (r.R && r.R.course === CODE))) {
      const maxRow = Math.max(0, ...Object.keys(rowsMap).map(Number));
      return { room, seat: `${maxRow + 1}`, date, slot };
    }
  }
  return null;
}

// POST /api/exam/student-courses/:reg/course  { action:'delete'|'edit', code, newCode? }
exports.editCourse = async (req, res) => {
  const reg = String(req.params.reg || '').trim();
  const action = String((req.body || {}).action || '').toLowerCase();
  const code = up((req.body || {}).code);
  const newCode = up((req.body || {}).newCode);
  if (!reg || !code || !['edit', 'delete'].includes(action)) {
    return res.status(400).json({ error: 'reg, code and a valid action (edit|delete) are required.' });
  }
  const student = await StudentRegistration.findOne({ studentId: reg });
  if (!student) return res.status(404).json({ error: 'Student not found.' });
  const cur = (student.courses || []).map(up);
  if (!cur.includes(code)) return res.status(400).json({ error: `${code} is not in this student's courses.` });

  if (action === 'edit') {
    if (!newCode) return res.status(400).json({ error: 'newCode is required for edit.' });
    const exists = await Course.findOne({ code: new RegExp('^' + newCode + '$', 'i') }).lean();
    if (!exists) return res.status(400).json({ error: `${newCode} is not a known course code.` });
    if (cur.includes(newCode) && newCode !== code) return res.status(400).json({ error: `Student already has ${newCode}.` });
  }

  // 1) update the registration record
  student.courses = action === 'delete'
    ? cur.filter((c) => c !== code)
    : cur.map((c) => (c === code ? newCode : c));
  await student.save();

  // 2) update the admit-card data (only the newest batch, only if paper not passed)
  const av = await AdmitVerification.findOne({ studentId: reg }).sort({ createdAt: -1 });
  let admitUpdated = false, note = '';
  const cells = [];   // affected (date,slot) cells whose seating must be re-printed
  if (av) {
    const oldExam = (av.exams || []).find((e) => up(e.code) === code);
    if (oldExam && paperPassed(oldExam.date)) {
      note = `${code}'s paper (${oldExam.date}) has already been sat — registration updated, admit card left unchanged.`;
    } else {
      if (oldExam && oldExam.date && oldExam.slot) cells.push({ date: oldExam.date, slot: oldExam.slot });
      // remove the old course's exam (its seat is freed and left EMPTY)
      av.exams = (av.exams || []).filter((e) => up(e.code) !== code);
      if (action === 'edit') {
        // seat the new course where its students already sit
        const spot = await findSeatForCourse(newCode, av.batchId);
        const c = await Course.findOne({ code: new RegExp('^' + newCode + '$', 'i') }).lean();
        if (spot) {
          av.exams.push({
            code: newCode, name: (c && c.name) || newCode, teacher: (c && c.teacher) || '',
            date: spot.date, slot: spot.slot, room: spot.room, seat: spot.seat,
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

  await logActivity('exam.edit_course', `${action} ${code}${action === 'edit' ? '→' + newCode : ''} for ${reg}`, 'warning');
  res.json({ ok: true, courses: student.courses, admitUpdated, financeSyncing, note, pdfStale, downloads });
};
