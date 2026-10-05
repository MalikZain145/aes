/**
 * Student portal (Phase 2). Everything here is scoped to the signed-in student
 * (req.user.id → their User record); a student can only ever see their own data.
 *   • me            → profile, autofills the registration form's top block
 *   • timetable     → only the sessions for the student's registered courses
 *   • admitCard     → streams the student's own one-page admit card (if issued)
 *   • registrations → the student's submitted registration / add-drop forms
 *   • submit        → create a new registration / add-drop form (Phase 3 routes
 *                     it on to the advisor → HoD → admin)
 */
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const User = require('../models/User');
const StudentRegistration = require('../models/StudentRegistration');
const GeneratedFile = require('../models/GeneratedFile');
const AdmitVerification = require('../models/AdmitVerification');
const RegistrationForm = require('../models/RegistrationForm');
const AcademicTerm = require('../models/AcademicTerm');
const Course = require('../models/Course');
const { OUTPUT_DIR } = require('../utils/pythonRunner');
const {
  resolveApprovers, statusLine, stripIntake, getTermWindow,
  courseCredits, sumCredits, CREDIT_MIN, CREDIT_MAX, windowState,
} = require('../utils/registrationWorkflow');
const { sendMail, isConfigured } = require('../utils/mailer');
const { logActivity } = require('../utils/logger');
const { renderFormPdf } = require('./registrationAdminController');

const norm = (s) => String(s == null ? '' : s).replace(/[^a-z0-9]/gi, '').toUpperCase();
const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');
const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const slotStart = (slot) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(slot || '')); if (!m) return 9999;
  let h = +m[1]; if (h < 8) h += 12; return h * 60 + +m[2];
};

async function currentStudent(req) {
  const u = await User.findById(req.user.id).lean();
  if (!u || u.role !== 'student') return null;
  return u;
}

// The student's imported registration record (courses, batch) matched by RegNo.
async function regRecordFor(student) {
  const key = norm(student.regNo);
  const dig = digits(student.regNo);
  const all = await StudentRegistration.find({}).select('studentId courses batch program').lean();
  return all.find((r) => norm(r.studentId) === key || (dig && digits(r.studentId) === dig)) || null;
}

function readSchedule(record) {
  const name = record && record.meta && record.meta.scheduleFile;
  if (!name) return null;
  const p = path.join(OUTPUT_DIR, path.basename(name));
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

// BS (ug) and MS (pg) timetables coexist. A student only has courses in one of
// them, so we merge the newest of each level into a single schedule and remap
// each schedule's student_index onto the combined sessions array. That way a
// student sees their own sessions no matter which timetable was generated last.
async function loadLatestTimetable() {
  const all = await GeneratedFile.find({ kind: 'timetable', status: 'ready' }).sort({ createdAt: -1 }).lean();
  if (!all.length) return { record: null, schedule: null };

  const pickLevel = (lvl) => all.find((r) => ((r.meta && r.meta.level) || 'ug') === lvl) || null;
  const parts = [pickLevel('ug'), pickLevel('pg')].filter(Boolean);
  // De-dup in case both point at the same record (legacy single timetable).
  const seen = new Set();
  const records = parts.filter((r) => { const k = String(r._id); if (seen.has(k)) return false; seen.add(k); return true; });

  const sessions = [];
  const studentIndex = {};
  let anySchedule = false;
  for (const rec of records) {
    const sch = readSchedule(rec);
    if (!sch || !Array.isArray(sch.sessions)) continue;
    anySchedule = true;
    const offset = sessions.length;
    sessions.push(...sch.sessions);
    const si = sch.student_index || {};
    for (const [reg, idxs] of Object.entries(si)) {
      if (!Array.isArray(idxs)) continue;
      if (!studentIndex[reg]) studentIndex[reg] = [];
      for (const i of idxs) studentIndex[reg].push(i + offset);
    }
  }

  const record = all[0];
  if (!anySchedule) return { record, schedule: null };
  return { record, schedule: { sessions, student_index: studentIndex } };
}

// ── GET /api/student/me ───────────────────────────────────────────────────────
exports.me = async (req, res) => {
  const student = await currentStudent(req);
  if (!student) return res.status(404).json({ error: 'Student profile not found.' });
  const reg = await regRecordFor(student);
  res.json({
    profile: {
      regNo: student.regNo || '', name: student.name || '', email: student.email || '',
      phone: student.phone || '', batch: student.batch || (reg && reg.batch) || '',
      degree: student.degree || '', department: student.department || '',
      mustChangePassword: !!student.mustChangePassword,
    },
    registeredCourses: (reg && reg.courses) || [],
  });
};

// ── GET /api/student/timetable ────────────────────────────────────────────────
exports.timetable = async (req, res) => {
  const student = await currentStudent(req);
  if (!student) return res.status(404).json({ error: 'Student profile not found.' });
  const reg = await regRecordFor(student);
  const regNo = String((reg && reg.studentId) || student.username || '').trim();
  const { record, schedule } = await loadLatestTimetable();
  if (!record || !schedule || !Array.isArray(schedule.sessions)) {
    return res.json({ hasTimetable: false, sessions: [], title: '' });
  }
  const pick = (s) => ({ day: s.day, slot: s.slot, code: s.code, section: s.section, name: s.name, room: s.room, teacher: s.teacher, component: s.component });
  let mine = [];
  let bySection = false;
  const idx = schedule.student_index && schedule.student_index[regNo];
  if (Array.isArray(idx) && idx.length) {
    // EXACT sessions this student attends — with the correct SECTION (from the
    // scheduler's deterministic section partition). No other section leaks in.
    bySection = true;
    for (const i of idx) { const s = schedule.sessions[i]; if (s) mine.push(pick(s)); }
  } else if (reg && reg.courses && reg.courses.length) {
    // fallback for older timetables without a student index → match by code
    // (may show more than one section until the timetable is regenerated).
    const codes = new Set(reg.courses.map(norm));
    for (const s of schedule.sessions) if (codes.has(norm(s.code))) mine.push(pick(s));
  }

  // RECONCILE with the student's CURRENT registered courses, so a course the Exam
  // Cell edited/deleted after the timetable was generated is reflected live: drop
  // sessions for courses no longer registered, and pull in sessions for a newly
  // added course (its section chosen to match the student's own program/batch).
  if (reg && Array.isArray(reg.courses)) {
    const regSet = new Set(reg.courses.map(norm));
    mine = mine.filter((s) => regSet.has(norm(s.code)));
    const present = new Set(mine.map((s) => norm(s.code)));
    const missing = [...regSet].filter((c) => !present.has(c));
    if (missing.length) {
      const myProg = norm(reg.program || student.batch);
      const myBatch = norm(reg.batch);
      for (const code of missing) {
        const matches = schedule.sessions.filter((s) => norm(s.code) === code);
        if (!matches.length) continue;
        // prefer the section whose program/batch matches this student; else take all
        const byBatch = matches.filter((s) => myBatch && norm(s.programBatch || s.batch) === myBatch);
        const byProg = matches.filter((s) => myProg && norm(s.program) === myProg);
        const chosen = byBatch.length ? byBatch : (byProg.length ? byProg : matches);
        // keep the chosen section's sessions (Lecture + Lab of that one section)
        const sec = chosen[0] && chosen[0].section;
        const keep = sec != null ? chosen.filter((s) => (s.section || '') === (sec || '')) : chosen;
        for (const s of keep) mine.push(pick(s));
      }
    }
  }
  mine.sort((a, b) => (DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day)) || (slotStart(a.slot) - slotStart(b.slot)));
  res.json({
    hasTimetable: true, title: record.title || '', sessions: mine, bySection,
    student: { reg: regNo, name: student.name || '', program: (reg && reg.batch) || '' },
    courseCount: reg ? (reg.courses || []).length : 0,
  });
};

// Fee gate: 'Unpaid' contains "paid", so check UNPAID first. Blank → not paid.
function isFeePaid(s) {
  const v = String(s == null ? '' : s).toLowerCase();
  if (v.includes('unpaid') || v.includes('not paid')) return false;
  return v.includes('paid');
}

// ── GET /api/student/admit-card/status ────────────────────────────────────────
exports.admitStatus = async (req, res) => {
  const student = await currentStudent(req);
  if (!student) return res.status(404).json({ error: 'Student profile not found.' });
  const av = await findAdmit(student);
  const feePaid = !!(av && av.card && isFeePaid(av.card.feeStatus));
  res.json({
    // The card only becomes available once Finance has cleared the fee.
    available: !!(av && av.rec && av.card.cardPage && feePaid),
    feePaid,
    feeStatus: av && av.card ? (feePaid ? 'Paid' : 'Unpaid') : '',
    title: av && av.rec ? av.rec.title : '',
    issuedAt: av && av.rec ? av.rec.createdAt : null,
  });
};

// Locate the student's most recent admit-card record + its page in the batch PDF.
async function findAdmit(student) {
  const key = norm(student.regNo);
  const dig = digits(student.regNo);
  const cards = await AdmitVerification.find({
    $or: [{ studentId: student.regNo }, { studentId: student.regNo.toUpperCase() }],
  }).sort({ createdAt: -1 }).lean();
  let card = cards[0];
  if (!card) {
    // fall back to a tolerant scan (normalised match)
    const recent = await AdmitVerification.find({}).sort({ createdAt: -1 }).limit(5000).select('studentId batchId cardPage name program batch feeStatus createdAt').lean();
    card = recent.find((c) => norm(c.studentId) === key || (dig && digits(c.studentId) === dig));
  }
  if (!card) return null;
  const rec = await GeneratedFile.findById(card.batchId).lean();
  return { card, rec };
}

// ── GET /api/student/admit-card ───────────────────────────────────────────────
// Streams the student's own single-page admit card as a PDF.
exports.admitCard = async (req, res) => {
  try {
    const student = await currentStudent(req);
    if (!student) return res.status(404).json({ error: 'Student profile not found.' });
    const found = await findAdmit(student);
    if (!found || !found.rec) return res.status(404).json({ error: 'Your admit card has not been issued yet.' });
    const { card, rec } = found;
    // Fee gate — the card is withheld until the Finance Office clears the fee.
    if (!isFeePaid(card.feeStatus)) {
      return res.status(403).json({ error: 'Your admit card is on hold until your fee is cleared. Please contact the Finance Office.' });
    }
    const pdfFile = (rec.files || []).find((f) => f.format === 'pdf' && /admit/i.test(f.label));
    if (!pdfFile) return res.status(404).json({ error: 'The admit-card file is missing.' });
    const pdfPath = path.join(OUTPUT_DIR, path.basename(pdfFile.filename));
    if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: 'The admit-card file could not be found on the server.' });
    if (!card.cardPage || card.cardPage < 1) return res.status(404).json({ error: 'Your admit-card page is not available. Please contact the Finance Office.' });

    const src = await PDFDocument.load(fs.readFileSync(pdfPath));
    if (card.cardPage > src.getPageCount()) return res.status(404).json({ error: 'Your admit-card page is not available.' });
    const one = await PDFDocument.create();
    const [pg] = await one.copyPages(src, [card.cardPage - 1]);
    one.addPage(pg);
    const bytes = Buffer.from(await one.save());
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="AdmitCard_${student.regNo}.pdf"`);
    res.send(bytes);
  } catch (err) {
    console.error('student admit-card error:', err);
    res.status(500).json({ error: err.message || 'Could not build your admit card.' });
  }
};

// Attach the human status line (+ window info) to each form for the portal.
const withStatus = (f) => ({ ...f, statusLine: statusLine(f) });

// Email the advisor that a form is waiting (dev-mode aware, non-blocking).
async function notifyApprover(email, name, { studentName, regNo, role }) {
  if (!email) return;
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#12261c;max-width:560px">
    <div style="background:linear-gradient(135deg,#198754,#0f3d2e);color:#fff;padding:18px;border-radius:14px 14px 0 0">
      <h2 style="margin:0;font-size:17px">Abasyn University Islamabad Campus</h2>
      <p style="margin:3px 0 0;font-size:12.5px;opacity:.92">Registration approval pending</p></div>
    <div style="border:1px solid #d7e6dd;border-top:0;border-radius:0 0 14px 14px;padding:18px;font-size:13.5px">
      <p>Dear <b>${name || 'Colleague'}</b>,</p>
      <p>A course-registration form from <b>${studentName || regNo}</b> (${regNo}) is awaiting your review as ${role}.</p>
      <p>Please sign in to the Abasyn Scheduler portal to approve it or return it with a remark.</p>
      <p style="margin-top:14px;font-size:11.5px;color:#8a978f">Automated message from the Abasyn University portal.</p></div></div>`;
  try { await sendMail({ to: email, subject: 'A registration form is awaiting your review', html, text: `A registration form from ${studentName || regNo} (${regNo}) is awaiting your review as ${role}.` }); }
  catch { /* non-blocking */ }
}

// ── GET /api/student/terms ────────────────────────────────────────────────────
// Active terms + which windows are open, so the student can pick a term & see
// whether registration or add/drop is currently accepting forms.
exports.terms = async (req, res) => {
  const student = await currentStudent(req);
  if (!student) return res.status(404).json({ error: 'Student profile not found.' });
  const terms = await AcademicTerm.find({ active: true }).sort({ createdAt: -1 }).lean();
  res.json({
    items: terms.map((t) => ({
      name: t.name,
      registration: windowState(t.registration || {}),
      addDrop: windowState(t.addDrop || {}),
    })),
  });
};

// ── GET /api/student/courses ──────────────────────────────────────────────────
// Distinct course code → title, for the registration form's autocomplete
// (so students pick a real course and don't mistype codes).
exports.courses = async (_req, res) => {
  const rows = await Course.find({}).select('code name creditHours').lean();
  const byCode = new Map();
  for (const c of rows) {
    const code = String(c.code || '').trim().toUpperCase();
    if (!code || byCode.has(code)) continue;
    byCode.set(code, { code, title: c.name || '', creditHours: c.creditHours || 3 });
  }
  res.json({ items: [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code)) });
};

// ── GET /api/student/registrations ────────────────────────────────────────────
exports.listRegistrations = async (req, res) => {
  const student = await currentStudent(req);
  if (!student) return res.status(404).json({ error: 'Student profile not found.' });
  const items = await RegistrationForm.find({ regNo: student.regNo }).sort({ createdAt: -1 }).lean();
  res.json({ items: items.map(withStatus) });
};

// ── GET /api/student/registrations/:id/pdf ────────────────────────────────────
// The student's own form as a PDF (with advisor/HoD stamps once approved).
exports.formPdf = async (req, res) => {
  try {
    const student = await currentStudent(req);
    if (!student) return res.status(404).json({ error: 'Student profile not found.' });
    const form = await RegistrationForm.findOne({ _id: req.params.id, regNo: student.regNo }).lean();
    if (!form) return res.status(404).json({ error: 'Form not found.' });
    const bytes = await renderFormPdf(form);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${form.kind === 'add_drop' ? 'AddDrop' : 'Registration'}_${form.regNo}.pdf"`);
    res.send(bytes);
  } catch (err) {
    console.error('student form pdf error:', err);
    res.status(500).json({ error: err.message || 'Could not build the PDF.' });
  }
};

// ── GET /api/student/registered?term=Fall%202026 ──────────────────────────────
// The courses the student is registered in for a term — the droppable set in add/drop.
exports.registered = async (req, res) => {
  const student = await currentStudent(req);
  if (!student) return res.status(404).json({ error: 'Student profile not found.' });
  const courses = await registeredCoursesFor(student.regNo, String(req.query.term || '').trim());
  res.json({ courses });
};

// The student's already-registered courses for a term (the approved registration,
// else the latest registration form) — the base an add/drop acts on.
async function registeredCoursesFor(regNo, term) {
  const q = { regNo, kind: 'registration' };
  if (term) q.term = term;
  const approved = await RegistrationForm.findOne({ ...q, status: 'approved' }).sort({ approvedAt: -1 }).lean();
  const base = approved || await RegistrationForm.findOne(q).sort({ createdAt: -1 }).lean();
  return base ? (base.courses || []).filter((c) => !c.action || c.action === 'add') : [];
}

// Validate a submission, enforce credit + drop rules, and build the routed doc.
// Throws { status, error } on any rule violation. Returns the field bundle.
async function buildAndValidate(student, body) {
  const kind = body && body.kind === 'add_drop' ? 'add_drop' : 'registration';
  const term = String((body && body.term) || '').trim();
  const semester = String((body && body.semester) || '').trim();
  const rawCourses = Array.isArray(body && body.courses) ? body.courses : [];

  if (!term) throw { status: 400, error: 'Choose an academic term.' };
  const termDoc = await AcademicTerm.findOne({ name: term, active: true }).lean();
  if (!termDoc) throw { status: 400, error: 'That academic term is not available.' };

  const clean = rawCourses
    .map((c) => ({
      code: String(c.code || '').trim(), title: String(c.title || '').trim(),
      creditHours: String(c.creditHours || '').trim(),
      action: kind === 'add_drop' ? (c.action === 'drop' ? 'drop' : 'add') : '',
    }))
    .filter((c) => c.code);
  if (!clean.length) throw { status: 400, error: 'Add at least one course (a course code is required).' };

  // ── credit-hour rules ──
  let total;
  if (kind === 'registration') {
    total = sumCredits(clean);
  } else {
    // add/drop: drops must come from the student's registered courses; net total must stay valid.
    const registered = await registeredCoursesFor(student.regNo, term);
    if (!registered.length) throw { status: 400, error: 'You have no registered courses for this term to add/drop against.' };
    const regByCode = new Map(registered.map((c) => [norm(c.code), c]));
    const drops = clean.filter((c) => c.action === 'drop');
    const adds = clean.filter((c) => c.action === 'add');
    for (const d of drops) {
      if (!regByCode.has(norm(d.code))) {
        throw { status: 400, error: `You can only drop a course you are registered in — "${d.code}" is not in your registration.` };
      }
    }
    const droppedCodes = new Set(drops.map((d) => norm(d.code)));
    const remaining = registered.filter((c) => !droppedCodes.has(norm(c.code)));
    total = sumCredits(remaining) + sumCredits(adds);
  }
  if (total < CREDIT_MIN) throw { status: 400, error: `Total credit hours must be at least ${CREDIT_MIN}. Your ${kind === 'add_drop' ? 'resulting' : ''} total is ${total}.` };
  if (total > CREDIT_MAX) throw { status: 400, error: `Total credit hours cannot exceed ${CREDIT_MAX}. Your ${kind === 'add_drop' ? 'resulting' : ''} total is ${total}.` };

  const reg = await regRecordFor(student);
  const batch = student.batch || (reg && reg.batch) || '';
  const program = stripIntake(batch);
  const { advisor, hod } = await resolveApprovers({ batch, program, term });
  return { kind, term, semester, clean, total, batch, program, advisor, hod, termDoc };
}

function routeFields(f, advisor, hod) {
  f.advisorId = advisor ? advisor.userId : null; f.advisorName = advisor ? advisor.teacherName : '';
  f.hodId = hod ? hod.userId : null; f.hodName = hod ? hod.teacherName : '';
  f.status = 'with_advisor';
  f.returnedBy = ''; f.lastRemark = '';
  f.seenByAdvisorAt = null; f.advisorActionAt = null; f.seenByHodAt = null; f.hodActionAt = null;
}

// ── POST /api/student/registrations ───────────────────────────────────────────
// Create OR edit (while the window is open) the student's form for a term+kind.
// { kind, term, semester, courses:[{code,title,creditHours,action}] }
exports.submitRegistration = async (req, res) => {
  try {
    const student = await currentStudent(req);
    if (!student) return res.status(404).json({ error: 'Student profile not found.' });

    const v = await buildAndValidate(student, req.body);
    const which = v.kind === 'add_drop' ? 'addDrop' : 'registration';
    const win = await getTermWindow(v.term, which);

    // one form per (student, term, kind) — edit it while the window is open
    const existing = await RegistrationForm.findOne({ regNo: student.regNo, term: v.term, kind: v.kind });
    if (existing && existing.status === 'approved') {
      return res.status(400).json({ error: 'This form is already processed and cannot be changed.' });
    }
    const canEditReturned = existing && existing.status === 'returned_to_student';
    if (!win.open && !canEditReturned) {
      return res.status(403).json({ error: win.closesAt && Date.now() > new Date(win.closesAt).getTime()
        ? `The ${v.kind === 'add_drop' ? 'add/drop' : 'registration'} window for ${v.term} has closed.`
        : `The ${v.kind === 'add_drop' ? 'add/drop' : 'registration'} window for ${v.term} is not open yet.` });
    }

    const now = new Date();
    let form = existing;
    const firstTime = !existing;
    if (!form) {
      form = new RegistrationForm({
        kind: v.kind, term: v.term, regNo: student.regNo, name: student.name,
        batch: v.batch, program: v.program, degree: student.degree || '', department: student.department || '',
        phone: student.phone || '', email: student.email || '', submittedAt: now, history: [],
      });
    }
    form.semester = v.semester; form.courses = v.clean; form.totalCredits = v.total;
    form.batch = v.batch; form.program = v.program;
    routeFields(form, v.advisor, v.hod);
    if (firstTime) form.submittedAt = now;
    form.resubmitCount = (form.resubmitCount || 0) + (firstTime ? 0 : 1);
    form.history.push({
      stage: 'student', action: firstTime ? 'submitted' : 'resubmitted', by: student._id, byName: student.name, at: now,
      remark: v.advisor ? '' : 'No advisor is assigned for this batch/term yet — the Exam Cell will route it.',
    });
    await form.save();

    if (v.advisor && v.advisor.teacherEmail) {
      notifyApprover(v.advisor.teacherEmail, v.advisor.teacherName, { studentName: student.name, regNo: student.regNo, role: 'the student advisor' });
    }
    await logActivity('registration.submit',
      `${v.kind === 'add_drop' ? 'Add/Drop' : 'Registration'} form ${firstTime ? 'submitted' : 'edited'} by ${student.name || student.regNo} (${student.regNo}) — ${v.term}.`, 'info');
    res.json({ ok: true, form: withStatus(form.toObject()), routedTo: v.advisor ? v.advisor.teacherName : null });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.error });
    console.error('submit registration error:', err);
    res.status(500).json({ error: err.message || 'Could not submit your form.' });
  }
};

// ── PUT /api/student/registrations/:id ────────────────────────────────────────
// Edit-and-resubmit a RETURNED form (fixing the reviewer's remarks) → back to advisor.
exports.resubmitRegistration = async (req, res) => {
  try {
    const student = await currentStudent(req);
    if (!student) return res.status(404).json({ error: 'Student profile not found.' });
    const form = await RegistrationForm.findOne({ _id: req.params.id, regNo: student.regNo });
    if (!form) return res.status(404).json({ error: 'Form not found.' });
    if (form.status !== 'returned_to_student') return res.status(400).json({ error: 'Only a returned form can be edited and resubmitted.' });

    const body = { ...req.body, kind: form.kind, term: form.term };
    const v = await buildAndValidate(student, body);

    const now = new Date();
    form.semester = v.semester || form.semester; form.courses = v.clean; form.totalCredits = v.total;
    form.batch = v.batch; form.program = v.program;
    routeFields(form, v.advisor, v.hod);
    form.resubmitCount = (form.resubmitCount || 0) + 1;
    form.history.push({ stage: 'student', action: 'resubmitted', by: student._id, byName: student.name, at: now });
    await form.save();

    if (v.advisor && v.advisor.teacherEmail) {
      notifyApprover(v.advisor.teacherEmail, v.advisor.teacherName, { studentName: student.name, regNo: student.regNo, role: 'the student advisor' });
    }
    res.json({ ok: true, form: withStatus(form.toObject()) });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.error });
    console.error('resubmit registration error:', err);
    res.status(500).json({ error: err.message || 'Could not resubmit your form.' });
  }
};

// Reused by the faculty portal to build a teacher's own weekly timetable.
exports.loadLatestTimetable = loadLatestTimetable;
