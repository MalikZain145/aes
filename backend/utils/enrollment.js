/**
 * enrollment.js — course enrollment straight from the students' registrations.
 *
 * Course.enrolled (shown on Courses, Timetable views, the dashboard) is the number of
 * students registered in that course code. A code with several section rows keeps the
 * report's split between its sections, scaled to the new total (largest-remainder
 * rounding, so the sections always add up exactly); if every section had 0 they share evenly.
 *
 *   recomputeEnrollment()             → every course, from all registrations ("fresh")
 *   recomputeEnrollment(['CS114',…])  → only those codes (after one student's change)
 */
const Course = require('../models/Course');
const StudentRegistration = require('../models/StudentRegistration');

const up = (s) => String(s || '').trim().toUpperCase();

function split(total, weights) {
  const n = weights.length;
  if (!n) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  const w = sum > 0 ? weights : weights.map(() => 1);
  const ws = sum > 0 ? sum : n;
  const raw = w.map((x) => (total * x) / ws);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; k < order.length && left > 0; k++, left--) out[order[k][1]]++;
  return out;
}

async function recomputeEnrollment(codes = null) {
  const only = codes ? new Set(codes.map(up).filter(Boolean)) : null;
  if (only && !only.size) return { courses: 0, changed: 0 };
  const q = only ? { courses: { $in: [...only, ...[...only].map((c) => c.toLowerCase())] } } : { studentId: { $ne: '' } };
  const regs = await StudentRegistration.find(q).select('studentId courses').lean();
  const count = new Map();
  for (const r of regs) {
    for (const c of new Set((r.courses || []).map(up))) {
      if (only && !only.has(c)) continue;
      if (!count.has(c)) count.set(c, new Set());
      count.get(c).add(String(r.studentId));
    }
  }
  const rows = await Course.find(only ? { code: { $in: [...only] } } : {}).select('_id code component enrolled active').lean();
  // one group per code + component (Lecture rows and Lab rows each carry the class size)
  const groups = new Map();
  for (const c of rows) {
    const k = `${up(c.code)}|${c.component || 'Lecture'}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const ops = [];
  let changed = 0;
  for (const [k, list] of groups) {
    const code = k.split('|')[0];
    const total = (count.get(code) || new Set()).size;
    const act = list.filter((c) => c.active !== false);
    const target = act.length ? act : list;
    const parts = split(total, target.map((c) => Math.max(0, Number(c.enrolled) || 0)));
    target.forEach((c, i) => {
      if ((Number(c.enrolled) || 0) !== parts[i]) {
        changed++;
        ops.push({ updateOne: { filter: { _id: c._id }, update: { $set: { enrolled: parts[i] } } } });
      }
    });
    for (const c of list) {
      if (!target.includes(c) && Number(c.enrolled)) { changed++; ops.push({ updateOne: { filter: { _id: c._id }, update: { $set: { enrolled: 0 } } } }); }
    }
  }
  if (ops.length) await Course.bulkWrite(ops, { ordered: false });
  return { courses: groups.size, changed, students: regs.length };
}

module.exports = { recomputeEnrollment, split };
