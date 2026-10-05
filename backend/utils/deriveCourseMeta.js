const Course = require('../models/Course');
const StudentRegistration = require('../models/StudentRegistration');
const { levelOf, isPostgradCode } = require('./programMap');

const up = (s) => String(s || '').toUpperCase();

/**
 * After an import, set each course's PROGRAM, DEPARTMENT and LEVEL from the live
 * student-registration data (the classwise file has no program column):
 *   • program    = the majority Academic Program among students registered in the code
 *   • department = that program (so the datesheet dept filter groups by real programs,
 *                  and MS programs never borrow a UG department key like "mlt")
 *   • level      = UG/PG decided by the PROGRAM name (MS/MPhil/PhD → PG), NOT the code
 *                  number — so e.g. "BS Medical Lab Technology" never lands in Postgraduate.
 * Courses no student is registered in (no majority program) get a blank department so
 * they don't clutter the BS/MS department lists.
 */
// The two Engineering-Technology programs are the campus's B.Tech degrees — always
// display them with the "B.Tech" name. Normalised at the source (StudentRegistration)
// so the label propagates to every course, department list, timetable and portal.
const BTECH = [
  [/^BSc\s*Civil Engineering Technology/i, 'B.Tech Civil Engineering Technology'],
  [/^BSc\s*Electrical Engineering Technology/i, 'B.Tech Electrical Engineering Technology'],
];
async function normalizeBTech() {
  for (const [re, name] of BTECH) await StudentRegistration.updateMany({ program: re }, { $set: { program: name } });
}

async function deriveCourseMeta() {
  await normalizeBTech();
  const prog = {}; const batch = {};
  const regs = await StudentRegistration.find({}).select('program batch courses').lean();
  for (const r of regs) {
    for (const c of (r.courses || [])) {
      const k = up(c);
      if (r.program) (prog[k] = prog[k] || {})[r.program] = (prog[k][r.program] || 0) + 1;
      if (r.batch) (batch[k] = batch[k] || {})[r.batch] = (batch[k][r.batch] || 0) + 1;
    }
  }
  const top = (o) => (o ? Object.entries(o).sort((a, b) => b[1] - a[1])[0][0] : '');

  const courses = await Course.find({}).select('code').lean();
  const ops = [];
  for (const c of courses) {
    const p = top(prog[up(c.code)]);
    const b = top(batch[up(c.code)]);
    const set = {
      program: p || '',
      department: p || '',   // program-driven department (empty when no students → hidden from filters)
      level: p ? levelOf(p) : (isPostgradCode(c.code) ? 'PG' : 'UG'),
    };
    if (b) set.programBatch = b;
    ops.push({ updateOne: { filter: { _id: c._id }, update: { $set: set } } });
  }
  if (ops.length) await Course.bulkWrite(ops, { ordered: false });
  return ops.length;
}

module.exports = { deriveCourseMeta };
