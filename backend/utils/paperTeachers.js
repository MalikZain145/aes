/**
 * paperTeachers.js — the teacher (and title) a PAPER carries on admit cards and tags.
 *
 * The ERP class list has a lecture row AND a lab row per section (CS313-A lecture →
 * Ms. Naveen Ahmed, CS313-A lab → Ahsan Karam). The written paper is the lecture's,
 * so only lecture teachers count; lab rows are used only for a course with no lecture.
 * A multi-section course prints that SECTION's teacher.
 *
 *   paperTeacherMaps()               → { byCode: {CODE: 'T1 / T2'}, bySec: {'CODE|A': T}, names: {CODE: title} }
 *   addRegisteredCourses(regFile)    → Course rows for codes students are registered in that
 *                                      no row covers (e.g. MG569) — name/credit from the report
 *   fixBatchPapers(batchId)          → correct teacher + title on an issued batch's records
 */
const NO_T = /^\s*(tba|tbd|tbc|nan|none|null|n\/?a|-+|—|–|no\s*teacher|not\s*assigned|unassigned)\s*\.?\s*$/i;
const up = (s) => String(s || '').trim().toUpperCase();

async function paperTeacherMaps() {
  const Course = require('../models/Course');
  const all = await Course.find({ active: true }).select('code name section teacher enrolled erpEnrolled component').lean();
  const hasLec = new Set(all.filter((c) => c.component !== 'Lab').map((c) => up(c.code)));
  const rows = all.filter((c) => (c.component === 'Lab' ? !hasLec.has(up(c.code)) : true));
  const votes = {}; const bySec = {}; const names = {};
  for (const c of rows) {
    const code = up(c.code); if (!code) continue;
    if (c.name && c.name.toUpperCase() !== code && !names[code]) names[code] = c.name;
    const t = String(c.teacher || '').trim();
    if (!t || NO_T.test(t)) continue;
    const w = Math.max(1, Number(c.erpEnrolled != null ? c.erpEnrolled : c.enrolled) || 0);
    (votes[code] = votes[code] || {})[t] = (votes[code][t] || 0) + w;
    const L = up(c.section);
    if (/^[A-Z]$/.test(L)) {
      const k = `${code}|${L}`;
      if (!bySec[k] || w > bySec[k].w) bySec[k] = { t, w };
    }
  }
  const byCode = Object.fromEntries(Object.entries(votes).map(([code, v]) => [code,
    Object.entries(v).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t).join(' / ')]));
  return { byCode, bySec: Object.fromEntries(Object.entries(bySec).map(([k, v]) => [k, v.t])), names };
}

async function addRegisteredCourses(regFile) {
  const Course = require('../models/Course');
  const { parseDataset } = require('./datasetImporter');
  const sw = parseDataset(regFile);
  const have = new Set((await Course.find({ active: true }).select('code').lean()).map((c) => up(c.code)));
  const info = new Map();
  for (const c of sw.courses || []) if (c.code && !info.has(up(c.code))) info.set(up(c.code), c);
  const added = [];
  for (const code of new Set((sw.studentRegistrations || []).flatMap((r) => (r.courses || []).map(up)))) {
    if (have.has(code) || !info.has(code)) continue;
    const c = info.get(code);
    const fullCode = `${code}-A-Lecture`;
    let department = ''; try { department = require('./programMap').resolveDepartment(code, c.name, '') || ''; } catch { department = ''; }
    let level = 'UG'; try { level = require('./programMap').isPostgradCode(code) ? 'PG' : 'UG'; } catch { level = 'UG'; }
    await Course.updateOne({ fullCode }, { $set: { code, name: c.name || code, component: 'Lecture', section: 'A', teacher: 'TBA',
      creditHours: c.creditHours != null ? Number(c.creditHours) : 3, active: true, noExam: false, department, level } }, { upsert: true });
    added.push(`${code} (${c.name || '?'})`);
  }
  return added;
}

async function fixBatchPapers(batchId) {
  const AdmitVerification = require('../models/AdmitVerification');
  const { byCode, bySec, names } = await paperTeacherMaps();
  const avs = await AdmitVerification.find({ batchId }).select('_id studentId exams').lean();
  // a paper whose section is about to change (re-print pending) uses the planned section
  let plan = {}; try { plan = await require('./sectionPlan').studentSectionMap(); } catch { plan = {}; }
  const ops = []; let papers = 0;
  for (const av of avs) {
    let changed = false;
    const exams = (av.exams || []).map((e) => {
      const code = up(e.code);
      const sec = plan[`${av.studentId}|${code}`] || e.section || '';
      const teacher = (sec && bySec[`${code}|${up(sec)}`]) || byCode[code] || e.teacher || '';
      const name = (!e.name || up(e.name) === code) && names[code] ? names[code] : e.name;
      if (teacher !== e.teacher || name !== e.name) { changed = true; papers++; return { ...e, teacher, name }; }
      return e;
    });
    if (changed) ops.push({ updateOne: { filter: { _id: av._id }, update: { $set: { exams } } } });
  }
  if (ops.length) await AdmitVerification.bulkWrite(ops, { ordered: false });
  return { students: ops.length, papers };
}

module.exports = { paperTeacherMaps, addRegisteredCourses, fixBatchPapers };
