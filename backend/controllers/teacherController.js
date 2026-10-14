const Teacher = require('../models/Teacher');
const { logActivity } = require('../utils/logger');

const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function newFacultyId() {
  const taken = new Set((await Teacher.find({ facultyId: /^\d{4}$/ }).select('facultyId').lean()).map((t) => t.facultyId));
  for (let i = 0; i < 20000; i++) {
    const id = String(1000 + Math.floor(Math.random() * 9000));
    if (!taken.has(id)) return id;
  }
  throw new Error('No free 4-digit Faculty ID left.');
}

async function stats() {
  const [total, allowed, visiting] = await Promise.all([
    Teacher.countDocuments({ active: true }),
    Teacher.countDocuments({ active: true, allowInvigilation: { $ne: false }, isVisiting: { $ne: true } }),
    Teacher.countDocuments({ active: true, isVisiting: true }),
  ]);
  return { total, allowed, visiting, blocked: total - allowed };
}

// GET /api/teachers
exports.list = async (req, res) => {
  const { search = '' } = req.query;
  const q = { active: true };
  if (search) {
    const rx = new RegExp(escapeRx(search), 'i');
    q.$or = [{ name: rx }, { email: rx }, { department: rx }, { facultyId: rx }, { designation: rx }, { aliases: rx }];
  }
  const items = await Teacher.find(q).sort({ name: 1 }).lean();
  res.json({ items, total: items.length, stats: await stats() });
};

// POST /api/teachers
exports.create = async (req, res) => {
  const { name, email, department, designation } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Teacher name is required.' });
  }
  const exists = await Teacher.findOne({ name: String(name).trim() });
  if (exists) {
    return res.status(409).json({ error: 'A teacher with this name already exists.' });
  }
  const isVisiting = req.body.isVisiting === true;
  const teacher = await Teacher.create({
    name: String(name).trim(),
    email: String(email || '').trim().toLowerCase(),
    facultyId: await newFacultyId(),
    department: department || '',
    designation: designation || '',
    isVisiting,
    allowInvigilation: isVisiting ? false : req.body.allowInvigilation !== false,
  });
  let login = null;
  try { const { ensureFacultyAccounts } = require('../utils/facultyImport'); await ensureFacultyAccounts(); login = (await Teacher.findById(teacher._id).lean()).userId; } catch { /* login is best-effort */ }
  await logActivity('teacher.create', `Teacher added: ${teacher.name} (Faculty ID ${teacher.facultyId})`, 'success');
  res.status(201).json({ teacher: await Teacher.findById(teacher._id).lean(), login: !!login });
};

// PUT /api/teachers/:id  — only these fields can be edited
exports.update = async (req, res) => {
  const b = req.body || {};
  const set = {};
  for (const k of ['name', 'email', 'department', 'designation']) if (typeof b[k] === 'string') set[k] = k === 'email' ? b[k].trim().toLowerCase() : b[k].trim();
  if (set.name === '') return res.status(400).json({ error: 'Teacher name is required.' });
  if (typeof b.facultyId === 'string') {
    const fid = b.facultyId.trim();
    if (!/^\d{4}$/.test(fid)) return res.status(400).json({ error: 'Faculty ID must be 4 digits.' });
    if (await Teacher.exists({ facultyId: fid, _id: { $ne: req.params.id } })) return res.status(409).json({ error: `Faculty ID ${fid} is already used.` });
    set.facultyId = fid;
  }
  if (typeof b.isVisiting === 'boolean') set.isVisiting = b.isVisiting;
  if (typeof b.allowInvigilation === 'boolean') set.allowInvigilation = b.allowInvigilation;
  const cur = await Teacher.findById(req.params.id).lean();
  if (!cur) return res.status(404).json({ error: 'Teacher not found.' });
  const visiting = set.isVisiting != null ? set.isVisiting : cur.isVisiting;
  if (visiting) set.allowInvigilation = false;               // visiting/adjunct never invigilate
  try {
    const teacher = await Teacher.findByIdAndUpdate(req.params.id, { $set: set }, { new: true }).lean();
    await logActivity('teacher.update', `Teacher updated: ${teacher.name}`, 'info');
    res.json({ teacher, stats: await stats() });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'Another teacher already has this name.' });
    throw e;
  }
};

// PATCH /api/teachers/:id/invigilation  { isVisiting?, allowInvigilation? }
exports.setInvigilation = async (req, res) => {
  const t = await Teacher.findById(req.params.id);
  if (!t) return res.status(404).json({ error: 'Teacher not found.' });
  const b = req.body || {};
  if (typeof b.isVisiting === 'boolean') t.isVisiting = b.isVisiting;
  if (typeof b.allowInvigilation === 'boolean') {
    if (b.allowInvigilation && t.isVisiting) {
      return res.status(400).json({ error: `${t.name} is Visiting/Adjunct — switch Visiting off first to allow invigilation.` });
    }
    t.allowInvigilation = b.allowInvigilation;
  }
  if (t.isVisiting) t.allowInvigilation = false;
  await t.save();
  await logActivity('teacher.invigilation', `${t.name}: ${t.isVisiting ? 'Visiting/Adjunct · ' : ''}invigilation ${t.allowInvigilation ? 'allowed' : 'off'}`, 'info');
  res.json({ teacher: t.toObject(), stats: await stats() });
};

// POST /api/teachers/invigilation/all  { allow: true|false }
// Enable all / Disable all. Visiting/Adjunct teachers always stay off.
exports.setInvigilationAll = async (req, res) => {
  const allow = !!(req.body && req.body.allow);
  const r = await Teacher.updateMany({ active: true, isVisiting: { $ne: true } }, { $set: { allowInvigilation: allow } });
  await Teacher.updateMany({ isVisiting: true }, { $set: { allowInvigilation: false } });
  await logActivity('teacher.invigilation', `Invigilation ${allow ? 'enabled' : 'disabled'} for all faculty (${r.modifiedCount || 0} changed; visiting/adjunct stay off)`, allow ? 'success' : 'warning');
  res.json({ ok: true, allow, changed: r.modifiedCount || 0, stats: await stats() });
};

// POST /api/teachers/invigilation/reset
// Back to the Faculty List defaults: ON for everyone except yellow rows and
// visiting/adjunct faculty.
exports.resetInvigilation = async (_req, res) => {
  const on = await Teacher.updateMany({ active: true, listYellow: { $ne: true }, isVisiting: { $ne: true } }, { $set: { allowInvigilation: true } });
  const off = await Teacher.updateMany({ $or: [{ listYellow: true }, { isVisiting: true }] }, { $set: { allowInvigilation: false } });
  await logActivity('teacher.invigilation', `Invigilation reset to the Faculty List defaults (${on.modifiedCount || 0} on, ${off.modifiedCount || 0} off)`, 'success');
  res.json({ ok: true, stats: await stats() });
};

// DELETE /api/teachers/:id
exports.remove = async (req, res) => {
  const teacher = await Teacher.findByIdAndDelete(req.params.id);
  if (!teacher) return res.status(404).json({ error: 'Teacher not found.' });
  await logActivity('teacher.delete', `Teacher removed: ${teacher.name}`, 'warning');
  res.json({ ok: true, message: `${teacher.name} removed.` });
};

// GET /api/teachers/count
exports.count = async (_req, res) => {
  const total = await Teacher.countDocuments({ active: true });
  res.json({ total });
};
