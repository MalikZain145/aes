const Teacher = require('../models/Teacher');
const { logActivity } = require('../utils/logger');

// GET /api/teachers
exports.list = async (req, res) => {
  const { search = '' } = req.query;
  const q = { active: true };
  if (search) {
    q.$or = [
      { name: new RegExp(search, 'i') },
      { email: new RegExp(search, 'i') },
      { department: new RegExp(search, 'i') },
    ];
  }
  const items = await Teacher.find(q).sort({ name: 1 }).lean();
  res.json({ items, total: items.length });
};

// POST /api/teachers
exports.create = async (req, res) => {
  const { name, email, facultyId, department } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Teacher name is required.' });
  }

  const exists = await Teacher.findOne({ name: name.trim() });
  if (exists) {
    return res.status(409).json({ error: 'A teacher with this name already exists.' });
  }

  const teacher = await Teacher.create({
    name: name.trim(),
    email: email || '',
    facultyId: facultyId || '',
    department: department || '',
  });

  await logActivity('teacher.create', `Teacher added: ${teacher.name}`, 'success');
  res.status(201).json({ teacher });
};

// PUT /api/teachers/:id
exports.update = async (req, res) => {
  const teacher = await Teacher.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!teacher) return res.status(404).json({ error: 'Teacher not found.' });
  await logActivity('teacher.update', `Teacher updated: ${teacher.name}`, 'info');
  res.json({ teacher });
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
