/**
 * Admin → people & assignments (Phase 2 foundation).
 *   • upload students        → create Student login accounts (RegNo / student123)
 *   • list faculty           → for the advisor / HoD dropdowns
 *   • assign advisors (batch-wise) & HoDs (department-wise) → each assigned
 *     teacher also gets a Faculty login (email / faculty123) so they can later
 *     review forms.
 * Org-unit lists (departments / batches) come from the live data.
 */
const fs = require('fs');
const XLSX = require('xlsx');
const Teacher = require('../models/Teacher');
const User = require('../models/User');
const Assignment = require('../models/Assignment');
const StudentRegistration = require('../models/StudentRegistration');
const { logActivity } = require('../utils/logger');

const norm = (s) => String(s == null ? '' : s).replace(/[^a-z0-9]/gi, '').toLowerCase();
const HEAD = {
  reg: ['registrationnumber', 'registrationno', 'registration', 'regno', 'reg', 'studentid', 'rollno', 'roll', 'id'],
  name: ['studentname', 'name', 'student'],
  email: ['email', 'emailaddress', 'mail', 'studentemail'],
  batch: ['batch', 'batchintake', 'session', 'intake'],
  degree: ['degree', 'degreeprogram', 'program', 'programme'],
  dept: ['department', 'dept'],
  phone: ['phone', 'contact', 'contactnumber', 'mobile', 'cell'],
};
const matchHead = (h) => { const n = norm(h); for (const [k, a] of Object.entries(HEAD)) if (a.includes(n)) return k; return null; };

// The intake tail on a batch string, e.g. "BS Computer Science Fall 2023" → program
// "BS Computer Science". Teachers carry no department, so the program (the batch
// with its Fall/Spring/Summer YYYY intake stripped) is our department unit.
const stripIntake = (b) => String(b || '').replace(/\s+(Fall|Spring|Summer)\s+\d{4}\s*$/i, '').trim();

// ── org units for dropdowns ──────────────────────────────────────────────────
// Returns programs (department units) each with the batches that belong to it,
// derived from the live student registrations.
exports.orgUnits = async (_req, res) => {
  const rawBatches = (await StudentRegistration.distinct('batch')).filter(Boolean);
  const byProgram = {};
  for (const b of rawBatches) {
    const p = stripIntake(b) || b;
    (byProgram[p] = byProgram[p] || []).push(b);
  }
  const departments = Object.keys(byProgram).sort();
  for (const p of departments) byProgram[p].sort();
  res.json({ departments, batchesByProgram: byProgram, batches: rawBatches.sort() });
};

// ── faculty list ─────────────────────────────────────────────────────────────
exports.listFaculty = async (_req, res) => {
  const teachers = await Teacher.find({ active: true }).select('name email department').sort({ name: 1 }).lean();
  res.json({ items: teachers.map((t) => ({ id: t._id, name: t.name, email: t.email, department: t.department })) });
};

// ── assignments ──────────────────────────────────────────────────────────────
// Provision (or find) a Faculty login for a teacher who has an email.
async function provisionFaculty(teacher) {
  if (!teacher.email) return null;
  let u = await User.findOne({ username: teacher.email.toLowerCase() });
  if (!u) {
    u = new User({
      role: 'faculty', username: teacher.email.toLowerCase(), email: teacher.email.toLowerCase(),
      name: teacher.name, department: teacher.department, teacherId: teacher._id, mustChangePassword: true,
    });
    await u.setPassword('faculty123');
    await u.save();
  } else if (u.role !== 'admin') {
    u.role = 'faculty'; u.teacherId = teacher._id; u.name = u.name || teacher.name; await u.save();
  }
  return u;
}

exports.listAssignments = async (req, res) => {
  const q = {};
  if (req.query.term !== undefined) q.term = req.query.term;   // filter by term ('' = term-less)
  const items = await Assignment.find(q).sort({ type: 1, department: 1, batch: 1 }).lean();
  res.json({ items });
};

// POST /api/admin/assignments  { type, term?, department, program?, batch?, teacherId }
exports.upsertAssignment = async (req, res) => {
  try {
    const { type, term = '', department, program = '', batch = '', teacherId } = req.body || {};
    if (!['advisor', 'hod'].includes(type)) return res.status(400).json({ error: 'Type must be advisor or hod.' });
    if (!department) return res.status(400).json({ error: 'Choose a department.' });
    if (type === 'advisor' && !batch) return res.status(400).json({ error: 'Choose a batch for the advisor.' });
    const teacher = await Teacher.findById(teacherId).lean();
    if (!teacher) return res.status(400).json({ error: 'Choose a faculty member.' });

    const user = await provisionFaculty(teacher);
    const key = { type, term: term || '', department, program: type === 'advisor' ? program : '', batch: type === 'advisor' ? batch : '' };
    const doc = await Assignment.findOneAndUpdate(
      key,
      { ...key, teacherId: teacher._id, teacherName: teacher.name, teacherEmail: teacher.email || '', userId: user ? user._id : null },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    await logActivity('assignment.set', `${type === 'hod' ? 'HoD' : 'Advisor'} set: ${teacher.name} → ${department}${batch ? ` · ${batch}` : ''}${term ? ` (${term})` : ''}`, 'success');
    res.json({ ok: true, assignment: doc, facultyLogin: user ? user.username : null });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'That advisor/HoD slot already exists — it was updated.' });
    console.error('assignment error:', err);
    res.status(500).json({ error: err.message || 'Could not save the assignment.' });
  }
};

// PUT /api/admin/assignments/:id  { type?, term?, department?, program?, batch?, teacherId? }
// Edit an existing advisor/HoD assignment in place (change the faculty member,
// or move it to another term / department / batch).
exports.updateAssignment = async (req, res) => {
  try {
    const a = await Assignment.findById(req.params.id);
    if (!a) return res.status(404).json({ error: 'Assignment not found.' });
    const { type, term, department, program, batch, teacherId } = req.body || {};
    if (type && !['advisor', 'hod'].includes(type)) return res.status(400).json({ error: 'Type must be advisor or hod.' });
    if (type) a.type = type;
    if (term !== undefined) a.term = term || '';
    if (department !== undefined && department) a.department = department;
    if (a.type === 'advisor') {
      if (program !== undefined) a.program = program;
      if (batch !== undefined) a.batch = batch;
    } else { a.program = ''; a.batch = ''; }
    if (teacherId) {
      const teacher = await Teacher.findById(teacherId).lean();
      if (!teacher) return res.status(400).json({ error: 'Choose a faculty member.' });
      const user = await provisionFaculty(teacher);
      a.teacherId = teacher._id; a.teacherName = teacher.name;
      a.teacherEmail = teacher.email || ''; a.userId = user ? user._id : null;
    }
    if (a.type === 'advisor' && !a.batch) return res.status(400).json({ error: 'Choose a batch for the advisor.' });
    await a.save();
    await logActivity('assignment.update',
      `${a.type === 'hod' ? 'HoD' : 'Advisor'} updated: ${a.teacherName} → ${a.department}${a.batch ? ` · ${a.batch}` : ''}${a.term ? ` (${a.term})` : ''}`, 'success');
    res.json({ ok: true, assignment: a });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Another assignment already fills that exact slot.' });
    console.error('assignment update error:', err);
    res.status(500).json({ error: err.message || 'Could not update the assignment.' });
  }
};

exports.deleteAssignment = async (req, res) => {
  await Assignment.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
};

// ── student account upload ───────────────────────────────────────────────────
// POST /api/admin/students/upload  (multipart: file)  → create Student logins.
exports.uploadStudents = async (req, res) => {
  const uploadPath = req.file && req.file.path;
  try {
    if (!uploadPath) return res.status(400).json({ error: 'Upload a student list (Excel/CSV).' });
    const wb = XLSX.readFile(uploadPath);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false, defval: '' });
    if (!rows.length) return res.status(400).json({ error: 'The file is empty.' });
    let hIdx = rows.findIndex((r) => r.some((c) => matchHead(c) === 'reg'));
    if (hIdx < 0) hIdx = 0;
    const header = rows[hIdx].map(matchHead);
    const col = (k) => header.indexOf(k);
    const cReg = col('reg'); if (cReg < 0) return res.status(400).json({ error: 'No Registration Number column found.' });
    const cName = col('name'), cEmail = col('email'), cBatch = col('batch'), cDeg = col('degree'), cDept = col('dept'), cPhone = col('phone');

    let created = 0, updated = 0, skipped = 0;
    for (let i = hIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      const reg = String(r[cReg] || '').trim();
      if (!reg) { skipped += 1; continue; }
      const username = norm(reg);
      const fields = {
        role: 'student', regNo: reg,
        name: cName >= 0 ? String(r[cName] || '').trim() : '',
        email: cEmail >= 0 ? String(r[cEmail] || '').trim().toLowerCase() : '',
        batch: cBatch >= 0 ? String(r[cBatch] || '').trim() : '',
        degree: cDeg >= 0 ? String(r[cDeg] || '').trim() : '',
        department: cDept >= 0 ? String(r[cDept] || '').trim() : '',
        phone: cPhone >= 0 ? String(r[cPhone] || '').trim() : '',
      };
      let u = await User.findOne({ username });
      if (u) {
        Object.assign(u, fields); await u.save(); updated += 1;
      } else {
        u = new User({ username, mustChangePassword: true, ...fields });
        await u.setPassword('student123'); await u.save(); created += 1;
      }
    }
    await logActivity('students.upload', `Student accounts uploaded — ${created} created, ${updated} updated.`, 'success');
    res.json({ ok: true, created, updated, skipped, total: created + updated });
  } catch (err) {
    console.error('student upload error:', err);
    res.status(500).json({ error: err.message || 'Student upload failed.' });
  } finally {
    try { if (uploadPath && fs.existsSync(uploadPath)) fs.unlinkSync(uploadPath); } catch { /* ignore */ }
  }
};

exports.studentStats = async (_req, res) => {
  const total = await User.countDocuments({ role: 'student' });
  const withEmail = await User.countDocuments({ role: 'student', email: { $ne: '' } });
  const registrations = await StudentRegistration.countDocuments({ studentId: { $ne: '' } });
  res.json({ total, withEmail, registrations });
};

// POST /api/admin/students/provision — create Student logins from the reg numbers
// already imported into StudentRegistration (RegNo / student123). Existing
// accounts are left untouched; only missing ones are created.
exports.provisionStudents = async (_req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const regs = await StudentRegistration.find({ studentId: { $ne: '' } }).select('studentId batch').lean();
    if (!regs.length) return res.status(400).json({ error: 'No imported student registrations found to create logins from.' });

    const existing = new Set((await User.find({ role: 'student' }).select('username').lean()).map((u) => u.username));
    const passwordHash = await bcrypt.hash('student123', await bcrypt.genSalt(10)); // shared default hash
    const seen = new Set();
    const docs = [];
    for (const r of regs) {
      const username = norm(r.studentId);
      if (!username || existing.has(username) || seen.has(username)) continue;
      seen.add(username);
      docs.push({ username, role: 'student', regNo: r.studentId, batch: r.batch || '', passwordHash, mustChangePassword: true, active: true });
    }
    if (docs.length) await User.insertMany(docs, { ordered: false }).catch((e) => { if (e.code !== 11000) throw e; });
    await logActivity('students.provision', `Student logins created from imported registrations — ${docs.length} new account(s).`, 'success');
    const total = await User.countDocuments({ role: 'student' });
    res.json({ ok: true, created: docs.length, skippedExisting: existing.size, total });
  } catch (err) {
    console.error('provision students error:', err);
    res.status(500).json({ error: err.message || 'Could not create student logins.' });
  }
};

// ── registration window ───────────────────────────────────────────────────────
const Setting = require('../models/Setting');
const { getWindow } = require('../utils/registrationWorkflow');

exports.getWindow = async (_req, res) => res.json(await getWindow());

// PUT /api/admin/registration-window { enabled, opensAt, closesAt, note }
exports.setWindow = async (req, res) => {
  const { enabled = false, opensAt = null, closesAt = null, note = '' } = req.body || {};
  const value = { enabled: !!enabled, opensAt: opensAt || null, closesAt: closesAt || null, note: String(note || '') };
  await Setting.findOneAndUpdate({ key: 'registration_window' }, { key: 'registration_window', value }, { upsert: true, setDefaultsOnInsert: true });
  await logActivity('registration.window', `Registration window ${value.enabled ? 'opened' : 'closed'} by admin.`, 'info');
  res.json(await getWindow());
};

// POST /api/admin/registration-remind — email advisors/HoDs with pending forms.
exports.remindApprovers = async (_req, res) => {
  const { sendMail } = require('../utils/mailer');
  const RegistrationForm = require('../models/RegistrationForm');
  const withAdvisor = await RegistrationForm.aggregate([{ $match: { status: 'with_advisor' } }, { $group: { _id: '$advisorName', email: { $first: '$advisorId' }, n: { $sum: 1 } } }]);
  const withHod = await RegistrationForm.aggregate([{ $match: { status: 'with_hod' } }, { $group: { _id: '$hodName', n: { $sum: 1 } } }]);
  // resolve emails from Assignment
  let sent = 0;
  const pendAdvisor = await RegistrationForm.distinct('batch', { status: 'with_advisor' });
  const pendHod = await RegistrationForm.distinct('program', { status: 'with_hod' });
  const advisorAsgs = await Assignment.find({ type: 'advisor', batch: { $in: pendAdvisor } }).lean();
  const hodAsgs = await Assignment.find({ type: 'hod', department: { $in: pendHod } }).lean();
  for (const a of [...advisorAsgs, ...hodAsgs]) {
    if (!a.teacherEmail) continue;
    try { await sendMail({ to: a.teacherEmail, subject: 'Reminder: registration forms awaiting your review', text: `Dear ${a.teacherName}, you have registration forms awaiting your review in the Abasyn University portal. Please sign in to action them.` }); sent += 1; } catch { /* ignore */ }
  }
  await logActivity('registration.remind', `Reminder emails sent to ${sent} pending approver(s).`, 'info');
  res.json({ ok: true, reminded: sent, advisorGroups: withAdvisor.length, hodGroups: withHod.length });
};
