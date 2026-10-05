const Course = require('../models/Course');
const { logActivity } = require('../utils/logger');
const { pbToProgram, resolveProgram, resolveDepartment, levelOf } = require('../utils/programMap');

// GET /api/courses  (supports ?search= &program= &component= &page= &limit=)
exports.list = async (req, res) => {
  const { search = '', program = '', component = '', level = '', page = 1, limit = 50 } = req.query;
  const q = { active: true };
  if (program) q.program = program;
  if (component) q.component = component;
  if (level === 'UG' || level === 'PG') q.level = level;   // datesheet builder filters by program level
  if (search) {
    q.$or = [
      { code: new RegExp(search, 'i') },
      { name: new RegExp(search, 'i') },
      { teacher: new RegExp(search, 'i') },
      { programBatch: new RegExp(search, 'i') },
    ];
  }

  const pg = Math.max(1, parseInt(page, 10) || 1);
  // Cap raised to 10000 so callers that need EVERY course (e.g. the datesheet
  // course-remove picker) get them all — a 500 cap was silently dropping the
  // tail of the alphabet (e.g. VS / Vision Sciences courses never showed).
  const lim = Math.min(10000, Math.max(1, parseInt(limit, 10) || 50));

  const [items, total] = await Promise.all([
    Course.find(q).sort({ code: 1, component: 1 }).skip((pg - 1) * lim).limit(lim).lean(),
    Course.countDocuments(q),
  ]);

  res.json({ items, total, page: pg, pages: Math.ceil(total / lim) });
};

// GET /api/courses/programs  (distinct list for filters)
exports.programs = async (_req, res) => {
  const programs = await Course.distinct('program', { active: true });
  res.json({ programs: programs.filter(Boolean).sort() });
};

// GET /api/courses/departments  (dept key + course count + a sample program name)
// Used by the datesheet builder to offer per-department datesheets.
const DEPT_LABELS = {
  cs: 'Computer Science', ai: 'Artificial Intelligence', ee: 'Electrical Engineering',
  civil: 'Civil Engineering', btech: 'B.Tech', bba: 'Business Administration',
  af: 'Accounting & Finance', eng: 'English', psy: 'Psychology', math: 'Mathematics',
  pharmd: 'Pharmacy', dpt: 'Physical Therapy', mlt: 'Medical Lab Technology', vs: 'Vision Sciences',
  ot: 'Operation Theatre', rt: 'Radiology', hnd: 'Human Nutrition & Dietetics', common: 'General / Common',
};
exports.departments = async (req, res) => {
  const match = { active: true };
  if (req.query.level === 'UG' || req.query.level === 'PG') match.level = req.query.level;
  const rows = await Course.aggregate([
    { $match: match },
    { $group: { _id: '$department', courses: { $sum: 1 } } },
    { $sort: { courses: -1 } },
  ]);
  // B.Tech Civil + B.Tech Electrical Engineering Technology share ONE combined
  // datesheet, so they are offered as ONE department: "B.Tech" (key 'btech').
  // (The DB department names are left as they are — only the picker merges them.)
  const isBtech = (d) => {
    const s = ' ' + String(d || '').toLowerCase().replace(/[.\-]/g, ' ') + ' ';
    return d === 'btech' || s.includes('btech') || s.includes(' b tech') || s.includes('engineering technology');
  };
  const items = [];
  let bt = 0;
  for (const r of rows.filter((x) => x._id)) {
    if (isBtech(r._id)) { bt += r.courses; continue; }
    items.push({ key: r._id, label: DEPT_LABELS[r._id] || (String(r._id).includes(' ') ? r._id : String(r._id).toUpperCase()), courses: r.courses });
  }
  if (bt) items.push({ key: 'btech', label: 'B.Tech', courses: bt });
  items.sort((a, b) => b.courses - a.courses);
  res.json({ items });
};

// POST /api/courses
exports.create = async (req, res) => {
  const body = req.body || {};
  if (!body.code || !body.name || !body.component) {
    return res.status(400).json({ error: 'Code, name and component are required.' });
  }

  // Build a fullCode if not supplied
  const section = (body.section || '').toUpperCase();
  const pb = body.programBatch || '';
  const fullCode =
    body.fullCode ||
    `${body.code}-${body.academicTerm || 'Spring 2026'}-${pb}${section ? '-' + section : ''}-${body.component.toLowerCase()}`;

  const exists = await Course.findOne({ fullCode });
  if (exists) {
    return res.status(409).json({ error: 'A course with this exact code already exists.' });
  }

  const program = resolveProgram(pb);
  const course = await Course.create({
    fullCode,
    code: body.code,
    name: body.name,
    component: body.component,
    section,
    programBatch: pb,
    program,
    level: levelOf(program, body.code),
    department: body.department || resolveDepartment(body.code, body.name, program),
    academicTerm: body.academicTerm || 'Spring 2026',
    teacher: body.teacher || 'TBA',
    enrolled: Number(body.enrolled) || 0,
    creditHours: Number(body.creditHours) || 3,
  });

  await logActivity('course.create', `Course added: ${course.name} (${course.code})`, 'success');
  res.status(201).json({ course });
};

// PUT /api/courses/:id
exports.update = async (req, res) => {
  const body = req.body || {};
  const existing = await Course.findById(req.params.id).lean();
  if (!existing) return res.status(404).json({ error: 'Course not found.' });

  if (body.section !== undefined) body.section = (body.section || '').toUpperCase();

  // Final values after the edit (fall back to existing when a field isn't sent).
  const code = body.code !== undefined ? body.code : existing.code;
  const name = body.name !== undefined ? body.name : existing.name;
  let program = existing.program;
  if (body.programBatch !== undefined) { program = resolveProgram(body.programBatch); body.program = program; }
  else if (body.program !== undefined) program = body.program;

  // Department: honor an explicit choice, otherwise recompute so the course moves
  // to the right department automatically (was falling into "Graduate Program").
  if (body.department === undefined) body.department = resolveDepartment(code, name, program);
  body.level = levelOf(program, code);

  const course = await Course.findByIdAndUpdate(req.params.id, body, { new: true });
  await logActivity('course.update', `Course updated: ${course.name} (${course.code})`, 'info');
  res.json({ course });
};

// DELETE /api/courses/:id
exports.remove = async (req, res) => {
  const course = await Course.findByIdAndDelete(req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found.' });

  await logActivity('course.delete', `Course removed: ${course.name} (${course.code})`, 'warning');
  res.json({ ok: true, message: `${course.name} removed.` });
};

// GET /api/courses/count
exports.count = async (_req, res) => {
  const total = await Course.countDocuments({ active: true });
  res.json({ total });
};
