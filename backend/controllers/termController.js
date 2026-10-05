/**
 * Admin → Academic Terms. Create a term, then open/close (and extend) its
 * registration and add/drop windows independently. Advisors/HoDs are assigned
 * per term via the People page.
 */
const AcademicTerm = require('../models/AcademicTerm');
const RegistrationForm = require('../models/RegistrationForm');
const { logActivity } = require('../utils/logger');
const { windowState } = require('../utils/registrationWorkflow');

const shape = (t) => ({
  _id: t._id, name: t.name, active: t.active,
  registration: windowState(t.registration || {}),
  addDrop: windowState(t.addDrop || {}),
  createdAt: t.createdAt,
});

exports.list = async (_req, res) => {
  const terms = await AcademicTerm.find().sort({ createdAt: -1 }).lean();
  // form counts per term (for the admin overview)
  const items = [];
  for (const t of terms) {
    const forms = await RegistrationForm.countDocuments({ term: t.name });
    items.push({ ...shape(t), forms });
  }
  res.json({ items });
};

exports.create = async (req, res) => {
  try {
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ error: 'Enter a term name (e.g. "Fall 2026").' });
    const exists = await AcademicTerm.findOne({ name });
    if (exists) return res.status(409).json({ error: 'That term already exists.' });

    // Opening a new term ARCHIVES the outgoing term's whole generated record
    // (datesheets, admit cards, seating plans, reports, timetables) under its
    // name → it moves to the "Previous Semesters" page. The new term starts clean.
    const GeneratedFile = require('../models/GeneratedFile');
    const prev = await AcademicTerm.findOne({ active: true }).sort({ createdAt: -1 }).lean();
    const prevName = prev ? prev.name : 'Previous Semester';
    const arch = await GeneratedFile.updateMany(
      { archived: { $ne: true }, kind: { $in: ['datesheet', 'admit_cards', 'clash_report', 'timetable'] } },
      { $set: { archived: true, archivedTerm: prevName } },
    );
    await AcademicTerm.updateMany({ active: true }, { $set: { active: false } });

    const t = await AcademicTerm.create({ name });   // new term is active by default

    // Advisors / HoDs are NOT archived — they normally stay the same term to
    // term, so the outgoing term's assignments are COPIED into the new term.
    // The admin can then edit or delete any of them from the People page.
    let carried = 0;
    try {
      const Assignment = require('../models/Assignment');
      const src = prev ? await Assignment.find({ term: prev.name }).lean() : [];
      for (const a of src) {
        const key = { type: a.type, term: name, department: a.department, program: a.program || '', batch: a.batch || '' };
        await Assignment.updateOne(key, {
          $set: {
            ...key,
            teacherId: a.teacherId || null, teacherName: a.teacherName || '',
            teacherEmail: a.teacherEmail || '', userId: a.userId || null,
          },
        }, { upsert: true });
        carried += 1;
      }
    } catch (e) { console.error('carry advisors:', e.message); }

    await logActivity('term.create',
      `Academic term created: ${name}. Archived ${arch.modifiedCount || 0} file(s) under ${prevName}`
      + `${carried ? `, carried forward ${carried} advisor/HoD assignment(s)` : ''}.`, 'success');
    res.json({ ok: true, term: shape(t.toObject()), archived: arch.modifiedCount || 0, archivedTerm: prevName, carriedAssignments: carried });
  } catch (err) {
    console.error('term create error:', err);
    res.status(500).json({ error: err.message || 'Could not create the term.' });
  }
};

// PUT /:id  { registration?:{enabled,opensAt,closesAt,note}, addDrop?:{...}, active? }
exports.update = async (req, res) => {
  try {
    const t = await AcademicTerm.findById(req.params.id);
    if (!t) return res.status(404).json({ error: 'Term not found.' });
    const b = req.body || {};
    const applyWin = (dst, src) => {
      if (!src) return;
      if ('enabled' in src) dst.enabled = !!src.enabled;
      if ('opensAt' in src) dst.opensAt = src.opensAt ? new Date(src.opensAt) : null;
      if ('closesAt' in src) dst.closesAt = src.closesAt ? new Date(src.closesAt) : null;
      if ('note' in src) dst.note = String(src.note || '');
    };
    if (b.registration) { t.registration = t.registration || {}; applyWin(t.registration, b.registration); }
    if (b.addDrop) { t.addDrop = t.addDrop || {}; applyWin(t.addDrop, b.addDrop); }
    if ('active' in b) t.active = !!b.active;
    await t.save();
    const which = b.registration ? 'registration' : (b.addDrop ? 'add/drop' : 'settings');
    await logActivity('term.window', `Term "${t.name}" ${which} updated by admin.`, 'info');
    res.json({ ok: true, term: shape(t.toObject()) });
  } catch (err) {
    console.error('term update error:', err);
    res.status(500).json({ error: err.message || 'Could not update the term.' });
  }
};

exports.remove = async (req, res) => {
  const t = await AcademicTerm.findById(req.params.id).lean();
  if (!t) return res.status(404).json({ error: 'Term not found.' });
  const used = await RegistrationForm.countDocuments({ term: t.name });
  if (used > 0) return res.status(400).json({ error: `Cannot delete — ${used} form(s) already use this term.` });
  await AcademicTerm.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
};
