/**
 * One-off import of the two Course Registration Report .xls files:
 *   File 2 (student-wise "Courses with Names")  → course spine + per-student regs
 *   File 1 (course-wise "Meta Details")         → teacher roster + teacher→course
 * Then wipes generated timetables, datesheets and admit cards for a fresh build.
 *
 * Run:  node _import_reg.js
 */
require('dotenv').config();
const path = require('path');
const mongoose = require('mongoose');
const xlsx = require('xlsx');

const { parseDataset } = require('./utils/datasetImporter');
const { extractTeacher, getDeptKey } = require('./utils/programMap');

// "BS Computer Science Fall 2025" → "BS Computer Science"
const stripBatch = (pb) => String(pb || '').replace(/\s+(Fall|Spring|Summer|Autumn|Winter)\s+\d{4}\s*$/i, '').trim();
// undergraduate vs postgraduate (BS/BE/BSc/BBA/Pharm-D/DPT = UG;  MS/MPhil/PhD = PG)
const levelOf = (program) => (/^(m\.?s\b|msc\b|mphil\b|m\.?\s?phil|master of philosophy|master of|ph\.?d\b|doctor of philosophy)/i.test(String(program || '').trim()) ? 'PG' : 'UG');

const Course = require('./models/Course');
const Teacher = require('./models/Teacher');
const StudentRegistration = require('./models/StudentRegistration');
const GeneratedFile = require('./models/GeneratedFile');
const AdmitVerification = require('./models/AdmitVerification');

const FILE_STUDENT = 'C:/Users/malik/Downloads/Course_Registration_Report 21-9-2026.xls';
const FILE_CLASS = 'C:/Users/malik/Downloads/Course_Registration_Report_classwise (1).xls';

const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// ── parse File 1 (classwise) → { teacherSet, teachersByCode, titleByCode, creditByCode } ──
function parseClasswise(file) {
  const wb = xlsx.readFile(file);
  const rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  const teacherSet = new Set();
  const teachersByCode = new Map();   // code → [names] (order = section order, "no teacher" dropped)
  const titleByCode = new Map();
  const creditByCode = new Map();

  for (const r of rows) {
    const code = norm(r['Course Code']).toUpperCase();
    if (!code) continue;
    const title = norm(r['Course Title']);
    const credit = parseFloat(r['Credit Hours']);
    if (title && !titleByCode.has(code)) titleByCode.set(code, title);
    if (!Number.isNaN(credit)) creditByCode.set(code, credit);

    const meta = String(r['Meta Details'] || '');
    const entries = meta.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    const list = teachersByCode.get(code) || [];
    for (const e of entries) {
      const seg = e.split(' - ').map((x) => x.trim());
      let name = seg[seg.length - 1] || '';
      name = norm(name);
      if (!name || /^no teacher$/i.test(name)) continue;
      name = extractTeacher(name) || name;   // clean via programMap
      list.push(name);
      teacherSet.add(name);
    }
    teachersByCode.set(code, list);
  }
  return { teacherSet, teachersByCode, titleByCode, creditByCode };
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/abasyn_scheduler');
  console.log('Connected to', mongoose.connection.name);

  // 1) student-wise file → courses + student registrations
  const parsed = parseDataset(FILE_STUDENT);
  const srcCourses = parsed.courses || [];
  const studentRegs = parsed.studentRegistrations || [];
  console.log(`File2 parsed: ${srcCourses.length} course rows, ${studentRegs.length} student registrations`);

  // 2) classwise file → teachers
  const cls = parseClasswise(FILE_CLASS);
  console.log(`File1 parsed: ${cls.teacherSet.size} distinct teachers, ${cls.teachersByCode.size} courses with meta`);

  // 3) assign teachers to courses (round-robin across a code's real teachers)
  const rrIdx = new Map();
  const courseDocs = [];
  const seenFull = new Set();
  for (const c of srcCourses) {
    if (seenFull.has(c.fullCode)) continue;         // fullCode is unique
    seenFull.add(c.fullCode);
    let teacher = 'TBA';
    const list = cls.teachersByCode.get(c.code);
    if (list && list.length) {
      const i = rrIdxNext(rrIdx, c.code);
      teacher = list[i % list.length];
    }
    // ── lab auto-detection (robust) ──
    //  1) explicit "(a+b)" marker, b>=1  → Lecture(a) + Lab(b)   [authoritative]
    //  2) title has "(Lab)"              → single Lab component
    //  3) credit hours == 4             → treat as 3+1 → Lecture(3) + Lab(1)
    //  4) otherwise (2+0, 3+0, 2, 3, …) → Lecture only, NO lab
    const cr = c.creditHours != null ? c.creditHours : 3;
    const m = String(c.name).match(/\((\d+)\s*\+\s*(\d+)\)/);
    const isLabOnly = /\(\s*lab\s*\)/i.test(String(c.name));
    let theory = null, labCr = 0;
    if (m) { theory = parseInt(m[1], 10); labCr = parseInt(m[2], 10); }
    else if (isLabOnly) { labCr = -1; }              // -1 → single Lab, no lecture
    else if (cr === 4) { theory = 3; labCr = 1; }    // 3+1 convention

    const program = stripBatch(c.programBatch) || c.program || '';
    // BTech = the "… Engineering Technology" programs → their own department so
    // they can get a separate datesheet (one paper/day, 3:00–4:30).
    const dept = /engineering technology/i.test(program) ? 'btech' : (getDeptKey(c.code, c.name) || '');
    const base = {
      code: c.code, name: c.name, section: c.section || '',
      programBatch: c.programBatch || '', program,
      level: levelOf(program), department: dept,
      academicTerm: c.academicTerm || '', teacher, enrolled: c.enrolled || 0, active: true,
    };
    const secTag = (c.section || 'X');
    if (labCr === -1) {
      // standalone lab course (title marked "(Lab)")
      courseDocs.push({
        ...base, component: 'Lab',
        fullCode: `${c.code}-${c.programBatch}-LAB-${secTag}`.replace(/\s+/g, '_'),
        creditHours: cr,
      });
    } else {
      courseDocs.push({
        ...base, component: 'Lecture',
        fullCode: `${c.code}-${c.programBatch}-LEC-${secTag}`.replace(/\s+/g, '_'),
        creditHours: theory != null ? theory : cr,
      });
      if (labCr >= 1) {
        courseDocs.push({
          ...base, component: 'Lab',
          fullCode: `${c.code}-${c.programBatch}-LAB-${secTag}`.replace(/\s+/g, '_'),
          creditHours: labCr,
        });
      }
    }
  }
  // dedupe on fullCode (unique index) — keep first
  const seenDoc = new Set();
  const dedup = [];
  for (const d of courseDocs) { if (seenDoc.has(d.fullCode)) continue; seenDoc.add(d.fullCode); dedup.push(d); }
  courseDocs.length = 0; courseDocs.push(...dedup);
  const withTeacher = courseDocs.filter((c) => c.teacher !== 'TBA').length;
  const labCount = courseDocs.filter((c) => c.component === 'Lab').length;

  // teacher docs
  const teacherDocs = [...cls.teacherSet].map((name) => ({ name, email: '', facultyId: '', active: true }));

  // student registration docs (dedupe by studentId)
  const seenSid = new Set();
  const regDocs = [];
  for (const r of studentRegs) {
    const sid = norm(r.studentId);
    if (!sid || seenSid.has(sid)) continue;
    seenSid.add(sid);
    regDocs.push({ studentId: sid, batch: r.batch || '', courses: r.courses || [] });
  }

  // 4) WRITE — replace course/teacher/registration data
  await Promise.all([Course.deleteMany({}), Teacher.deleteMany({}), StudentRegistration.deleteMany({})]);
  await Course.insertMany(courseDocs, { ordered: false });
  await Teacher.insertMany(teacherDocs, { ordered: false });
  await StudentRegistration.insertMany(regDocs, { ordered: false });
  console.log(`Inserted: ${courseDocs.length} courses (${labCount} lab components, ${withTeacher} with a real teacher), ${teacherDocs.length} teachers, ${regDocs.length} student registrations`);

  // 5) WIPE generated artifacts (timetables, datesheets, admit cards)
  const delGen = await GeneratedFile.deleteMany({});
  const delAdmit = await AdmitVerification.deleteMany({});
  console.log(`Deleted: ${delGen.deletedCount} generated files (timetables+datesheets), ${delAdmit.deletedCount} admit-card records`);

  // report
  const [tc, cc, sc] = await Promise.all([
    Teacher.countDocuments({}), Course.countDocuments({}), StudentRegistration.countDocuments({}),
  ]);
  console.log(`\nDB now: courses=${cc}, teachers=${tc}, studentRegistrations=${sc}, generatedFiles=0, admitCards=0`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error('IMPORT FAILED:', e); process.exit(1); });

function rrIdxNext(map, key) {
  const cur = map.get(key) || 0;
  map.set(key, cur + 1);
  return cur;
}
