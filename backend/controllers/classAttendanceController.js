/**
 * Class attendance — faculty mark & save (locked), students view "My Attendance".
 *
 * Teacher → courses: matched by the teacher's DISPLAY NAME against Course.teacher
 * (the same name the dataset carries). Roster of a class: every StudentRegistration
 * whose `courses` array contains the code, narrowed to the course's program (the
 * closest thing to a "section" the registration data has — a code taught to two
 * programs is two classes). A saved sheet is immutable; re-saving the same
 * (teacher, code, section, date) overwrites that one sheet.
 */
const fs = require('fs');
const path = require('path');
const User = require('../models/User');
const Teacher = require('../models/Teacher');
const Course = require('../models/Course');
const StudentRegistration = require('../models/StudentRegistration');
const ClassAttendance = require('../models/ClassAttendance');
const { logActivity } = require('../utils/logger');

const up = (s) => String(s || '').trim().toUpperCase();
const norm = (s) => String(s == null ? '' : s).replace(/[^a-z0-9]/gi, '').toLowerCase();
const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');

// The signed-in teacher's display name(s) to match against Course.teacher.
async function teacherNamesFor(req) {
  const u = await User.findById(req.user.id).lean();
  if (!u) return { user: null, names: [] };
  const names = new Set();
  if (u.name) names.add(u.name);
  if (u.teacherId) {
    const t = await Teacher.findById(u.teacherId).lean();
    if (t && t.name) names.add(t.name);
  }
  // also any Teacher whose email matches this user's email
  if (u.email) {
    const t = await Teacher.findOne({ email: u.email }).lean();
    if (t && t.name) names.add(t.name);
  }
  return { user: u, names: [...names] };
}

// ── GET /api/faculty/my-courses ───────────────────────────────────────────────
// The distinct classes this teacher teaches (one row per code+section+program),
// each with its registered-student count. Admins get every course (name filter).
exports.myCourses = async (req, res) => {
  const { user, names } = await teacherNamesFor(req);
  if (!user) return res.status(404).json({ error: 'Profile not found.' });
  const nameSet = new Set(names.map(norm));

  const all = await Course.find({ active: true }).lean();
  const mine = user.role === 'admin'
    ? all
    : all.filter((c) => nameSet.has(norm(c.teacher)));

  // registered counts per code (+ per program), from StudentRegistration
  const regs = await StudentRegistration.find({}).select('courses program').lean();
  const countByCode = {};        // code -> total
  const countByCodeProg = {};    // code|prog -> count
  for (const r of regs) {
    const prog = norm(r.program);
    for (const c of (r.courses || [])) {
      const k = up(c);
      countByCode[k] = (countByCode[k] || 0) + 1;
      countByCodeProg[`${k}|${prog}`] = (countByCodeProg[`${k}|${prog}`] || 0) + 1;
    }
  }

  // one class per (code, section, program) the teacher teaches
  const seen = new Map();
  for (const c of mine) {
    const code = up(c.code);
    const key = `${code}|${c.section || ''}|${norm(c.program)}`;
    if (seen.has(key)) continue;
    const progCount = countByCodeProg[`${code}|${norm(c.program)}`] || 0;
    seen.set(key, {
      code, name: c.name || '', section: c.section || '', program: c.program || '',
      programBatch: c.programBatch || '', component: c.component || 'Lecture',
      registered: progCount || countByCode[code] || 0,
    });
  }
  const items = [...seen.values()].sort((a, b) =>
    a.code.localeCompare(b.code) || String(a.program).localeCompare(String(b.program)) || String(a.section).localeCompare(String(b.section)));
  res.json({ teacher: names[0] || user.name || '', items });
};

// ── GET /api/faculty/attendance/roster?code=&program=&section=&date= ───────────
// The students registered in this class + any already-saved marks for that date.
exports.roster = async (req, res) => {
  const { user, names } = await teacherNamesFor(req);
  if (!user) return res.status(404).json({ error: 'Profile not found.' });
  const code = up(req.query.code);
  if (!code) return res.status(400).json({ error: 'A course code is required.' });
  const program = String(req.query.program || '').trim();
  const section = up(req.query.section || '');
  const date = String(req.query.date || '').trim();

  // authorise: the teacher must actually teach this code (admins bypass)
  if (user.role !== 'admin') {
    const nameSet = new Set(names.map(norm));
    const teaches = await Course.findOne({ code, teacher: { $exists: true } }).lean()
      ? (await Course.find({ code }).lean()).some((c) => nameSet.has(norm(c.teacher)))
      : false;
    if (!teaches) return res.status(403).json({ error: 'You do not teach this course.' });
  }

  const progN = norm(program);
  const regs = await StudentRegistration.find({ courses: code }).select('studentId name program batch courses').lean();
  let students = regs.filter((r) => (r.courses || []).map(up).includes(code));
  if (progN) students = students.filter((r) => norm(r.program) === progN);
  students.sort((a, b) => {
    const na = Number(a.studentId), nb = Number(b.studentId);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    return String(a.studentId).localeCompare(String(b.studentId));
  });

  // if a sheet for this exact class+date already exists, return its (locked) marks
  let existing = null;
  if (date) {
    existing = await ClassAttendance.findOne({ teacherName: names[0] || user.name, code, section, date }).lean();
  }
  const markOf = {};
  if (existing) for (const r of existing.records || []) markOf[String(r.studentId)] = r.status;

  res.json({
    code, program, section,
    total: students.length,
    locked: !!existing,
    savedAt: existing ? existing.updatedAt : null,
    present: existing ? existing.present : 0,
    students: students.map((s) => ({
      studentId: s.studentId, name: s.name || '', program: s.program || '', batch: s.batch || '',
      status: markOf[String(s.studentId)] || null,   // null = not yet marked
    })),
  });
};

// ── POST /api/faculty/attendance ──────────────────────────────────────────────
// Save (lock) a class's attendance. Body: { code, courseName, section, program,
// programBatch, component, date, slot, records:[{studentId,name,program,status}] }
exports.save = async (req, res) => {
  const { user, names } = await teacherNamesFor(req);
  if (!user) return res.status(404).json({ error: 'Profile not found.' });
  const b = req.body || {};
  const code = up(b.code);
  const date = String(b.date || '').trim();
  const section = up(b.section || '');
  if (!code || !date) return res.status(400).json({ error: 'Course and date are required.' });
  const records = Array.isArray(b.records) ? b.records : [];
  if (!records.length) return res.status(400).json({ error: 'No students to mark.' });

  const teacherName = names[0] || user.name || '';
  // locked: never overwrite an already-saved sheet (immutable after save)
  const prior = await ClassAttendance.findOne({ teacherName, code, section, date }).lean();
  if (prior && prior.locked) {
    return res.status(409).json({ error: 'Attendance for this class and date is already saved and locked. It cannot be changed.' });
  }

  const clean = records.map((r) => ({
    studentId: String(r.studentId || '').trim(),
    name: String(r.name || '').trim(),
    program: String(r.program || '').trim(),
    status: r.status === 'present' ? 'present' : 'absent',
  })).filter((r) => r.studentId);
  const present = clean.filter((r) => r.status === 'present').length;

  const doc = await ClassAttendance.findOneAndUpdate(
    { teacherName, code, section, date },
    {
      teacherName, teacherUserId: user._id, code,
      courseName: String(b.courseName || '').trim(),
      section, program: String(b.program || '').trim(),
      programBatch: String(b.programBatch || '').trim(),
      component: String(b.component || 'Lecture').trim(),
      date, slot: String(b.slot || '').trim(),
      total: clean.length, present, records: clean, locked: true,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  await logActivity('attendance.save', `${teacherName} saved attendance for ${code}${section ? ' ' + section : ''} on ${date} (${present}/${clean.length}).`, 'success');
  res.json({ ok: true, id: doc._id, present, total: clean.length });
};

// ── GET /api/faculty/attendance ───────────────────────────────────────────────
// This teacher's saved attendance sheets (newest first).
exports.list = async (req, res) => {
  const { user, names } = await teacherNamesFor(req);
  if (!user) return res.status(404).json({ error: 'Profile not found.' });
  const q = user.role === 'admin' ? {} : { teacherName: { $in: names.length ? names : ['\u0000'] } };
  const items = await ClassAttendance.find(q).sort({ date: -1, createdAt: -1 }).limit(300)
    .select('code courseName section program date slot present total createdAt').lean();
  res.json({ items });
};

// ── GET /api/faculty/attendance/:id/pdf ───────────────────────────────────────
// A saved sheet as a read-only PDF (view / download; never editable).
exports.pdf = async (req, res) => {
  try {
    const { user, names } = await teacherNamesFor(req);
    if (!user) return res.status(404).json({ error: 'Profile not found.' });
    const doc = await ClassAttendance.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'Attendance sheet not found.' });
    if (user.role !== 'admin' && !names.map(norm).includes(norm(doc.teacherName))) {
      return res.status(403).json({ error: 'This sheet is not yours.' });
    }
    const bytes = await renderAttendancePdf(doc);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Attendance_${doc.code}_${doc.date}.pdf"`);
    res.send(Buffer.from(bytes));
  } catch (e) {
    console.error('attendance pdf error:', e);
    res.status(500).json({ error: e.message || 'Could not build the PDF.' });
  }
};

// ── GET /api/faculty/timetable  (teacher's own weekly class timetable) ────────
const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const slotStart = (slot) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(slot || '')); if (!m) return 9999; let h = +m[1]; if (h < 8) h += 12; return h * 60 + +m[2]; };
exports.facultyTimetable = async (req, res) => {
  const { user, names } = await teacherNamesFor(req);
  if (!user) return res.status(404).json({ error: 'Profile not found.' });
  const { loadLatestTimetable } = require('./studentController');
  const { record, schedule } = await loadLatestTimetable();
  if (!record || !schedule || !Array.isArray(schedule.sessions)) {
    return res.json({ hasTimetable: false, sessions: [], title: '' });
  }
  const nameSet = new Set(names.map(norm));
  const mine = schedule.sessions
    .filter((s) => nameSet.has(norm(s.teacher)))
    .map((s) => ({ day: s.day, slot: s.slot, code: s.code, section: s.section, name: s.name, room: s.room, program: s.program || s.programBatch || '', component: s.component }));
  mine.sort((a, b) => (DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day)) || (slotStart(a.slot) - slotStart(b.slot)));
  res.json({ hasTimetable: true, title: record.title || 'My Timetable', sessions: mine, teacher: names[0] || user.name || '' });
};

// ── GET /api/student/attendance  (student portal "My Attendance") ─────────────
exports.myAttendance = async (req, res) => {
  const u = await User.findById(req.user.id).lean();
  if (!u || u.role !== 'student') return res.status(404).json({ error: 'Student profile not found.' });
  const reg = u.regNo || u.username || '';
  const key = norm(reg); const dig = digits(reg);

  const sheets = await ClassAttendance.find({}).sort({ date: 1, createdAt: 1 })
    .select('code courseName section teacherName date slot records').lean();

  const byCourse = {};   // code -> { code, name, teacher, present, total, sessions:[] }
  for (const s of sheets) {
    const mine = (s.records || []).find((r) => {
      const rid = String(r.studentId);
      return norm(rid) === key || (dig && digits(rid) === dig);
    });
    if (!mine) continue;
    const c = byCourse[s.code] || (byCourse[s.code] = { code: s.code, name: s.courseName || '', teacher: s.teacherName || '', present: 0, total: 0, sessions: [] });
    c.total += 1;
    if (mine.status === 'present') c.present += 1;
    if (!c.name && s.courseName) c.name = s.courseName;
    c.sessions.push({ date: s.date, slot: s.slot || '', status: mine.status });
  }
  const courses = Object.values(byCourse).map((c) => ({
    ...c,
    percent: c.total ? Math.round((c.present / c.total) * 100) : 0,
  })).sort((a, b) => a.code.localeCompare(b.code));
  res.json({ reg, courses });
};

// ── PDF renderer (reportlab-free; uses pdfkit-style via pdf-lib text) ──────────
// Kept simple & dependency-light: build with pdf-lib (already a dependency).
async function renderAttendancePdf(doc) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontB = await pdf.embedFont(StandardFonts.HelveticaBold);
  const green = rgb(0.098, 0.529, 0.329);
  const dark = rgb(0.07, 0.15, 0.11);
  const gray = rgb(0.42, 0.46, 0.44);
  const line = rgb(0.85, 0.88, 0.86);

  let logoImg = null;
  try {
    const lp = path.join(__dirname, '..', '..', 'frontend', 'public', 'favicon.png');
    if (fs.existsSync(lp)) logoImg = await pdf.embedPng(fs.readFileSync(lp));
  } catch { /* no logo */ }

  const W = 595.28, H = 841.89, M = 42;      // A4 portrait
  const rows = doc.records || [];
  const perPage = 30;
  const pages = Math.max(1, Math.ceil(rows.length / perPage));

  for (let pg = 0; pg < pages; pg++) {
    const page = pdf.addPage([W, H]);
    let y = H - M;
    if (logoImg) { const s = 34; page.drawImage(logoImg, { x: W - M - s, y: y - s + 6, width: s, height: s }); }
    page.drawText('Abasyn University Islamabad Campus', { x: M, y, size: 13, font: fontB, color: dark });
    y -= 17;
    page.drawText('Class Attendance Sheet', { x: M, y, size: 10.5, font, color: green });
    y -= 22;

    const info = [
      ['Course', `${doc.code}${doc.section ? '  (' + doc.section + ')' : ''}  ${doc.courseName || ''}`],
      ['Program', doc.program || '-'],
      ['Teacher', doc.teacherName || '-'],
      ['Date', `${doc.date}${doc.slot ? '   ' + doc.slot : ''}`],
      ['Present', `${doc.present} / ${doc.total}`],
    ];
    for (const [k, v] of info) {
      page.drawText(`${k}:`, { x: M, y, size: 9.5, font: fontB, color: gray });
      page.drawText(String(v), { x: M + 62, y, size: 9.5, font, color: dark });
      y -= 14;
    }
    y -= 6;

    // table header
    const cols = [M, M + 34, M + 150, M + 430];   // #, RegNo, Name, Status
    page.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 18, color: rgb(0.90, 0.95, 0.92) });
    page.drawText('#', { x: cols[0] + 4, y, size: 9, font: fontB, color: dark });
    page.drawText('Reg No', { x: cols[1], y, size: 9, font: fontB, color: dark });
    page.drawText('Student Name', { x: cols[2], y, size: 9, font: fontB, color: dark });
    page.drawText('Status', { x: cols[3], y, size: 9, font: fontB, color: dark });
    y -= 18;

    const slice = rows.slice(pg * perPage, (pg + 1) * perPage);
    slice.forEach((r, i) => {
      const idx = pg * perPage + i + 1;
      const present = r.status === 'present';
      page.drawText(String(idx), { x: cols[0] + 4, y, size: 9, font, color: dark });
      page.drawText(String(r.studentId || ''), { x: cols[1], y, size: 9, font, color: dark });
      page.drawText(String(r.name || '').slice(0, 46), { x: cols[2], y, size: 9, font, color: dark });
      page.drawText(present ? 'Present' : 'Absent', { x: cols[3], y, size: 9, font: fontB, color: present ? green : rgb(0.77, 0.19, 0.19) });
      page.drawLine({ start: { x: M, y: y - 4 }, end: { x: W - M, y: y - 4 }, thickness: 0.4, color: line });
      y -= 16;
    });

    page.drawText(`Generated by the Abasyn University portal — this is a system record and does not require a signature.  Page ${pg + 1}/${pages}`,
      { x: M, y: 26, size: 7.5, font, color: gray });
  }
  return pdf.save();
}
