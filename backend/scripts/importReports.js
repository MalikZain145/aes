/**
 * importReports.js — load the two Course Registration Reports into MongoDB.
 *
 *   node scripts/importReports.js                      # imports the files in backend/data/imports/
 *   node scripts/importReports.js --dry-run            # only shows what would change
 *   node scripts/importReports.js --students <file.xls> --classwise <file.xls>
 *   node scripts/importReports.js --keep-missing       # don't remove students absent from the report
 *
 * Uses the SAME parser as the app's "Import Data" page (utils/datasetImporter):
 *   • student-wise report ("Courses with Names")  → StudentRegistration (name, program, batch, courses)
 *   • class-wise report  ("Meta Details")         → Course rows per section (teacher, enrolled,
 *                                                   credit hours, no-exam flags) + Teacher names
 *
 * What it changes:
 *   Students  — upsert by Student ID; students NOT in the new report are removed (a JSON
 *               backup of every removed record is written to scheduler/output first).
 *               Pass --keep-missing to leave them.
 *   Courses   — upsert by fullCode (e.g. "CS114-A-Lecture"). A no-exam flag already in the
 *               DB (e.g. from an earlier yellow-highlighted report) is KEPT. Section rows the
 *               report no longer has are only deactivated (active:false), never deleted.
 *   Teachers  — missing names are added; nobody is deleted or edited.
 *   Then program / department / level are re-derived from the students (deriveCourseMeta),
 *   exactly like the Import Data page does, and every new reg number gets a Student
 *   Portal login (username = reg no, password student123).
 * Rooms, labs, users, timetables, datesheets and admit cards are not touched.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const { parseDataset } = require('../utils/datasetImporter');

const ROOT = path.join(__dirname, '..');
const DEFAULT_DIR = path.join(ROOT, 'data', 'imports');
const OUTPUT_DIR = path.join(ROOT, '..', 'scheduler', 'output');

const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const DRY = process.argv.includes('--dry-run');
const KEEP_MISSING = process.argv.includes('--keep-missing');

const up = (s) => String(s || '').trim().toUpperCase();
const sameList = (a, b) => JSON.stringify([...(a || [])].map(up).sort()) === JSON.stringify([...(b || [])].map(up).sort());
// fullCodes the importer itself creates ("CS114-A-Lecture") — only these are ever deactivated
const IMPORTER_FULLCODE = /^[A-Z]{1,8}\d{2,4}[A-Z0-9-]*-[A-Z0-9]{1,3}-(Lecture|Lab)$/i;

/** Pick the two report files: CLI flags, else auto-detect in data/imports by shape. */
function pickFiles() {
  let students = arg('--students');
  let classwise = arg('--classwise');
  if (students && classwise) return { students, classwise };
  if (!fs.existsSync(DEFAULT_DIR)) throw new Error(`No files given and ${DEFAULT_DIR} does not exist.`);
  for (const f of fs.readdirSync(DEFAULT_DIR).filter((x) => /\.(xls|xlsx|csv)$/i.test(x))) {
    const full = path.join(DEFAULT_DIR, f);
    const p = parseDataset(full);
    if ((p.studentRegistrations || []).length && !students) students = full;
    else if (!(p.studentRegistrations || []).length && (p.courses || []).length && !classwise) classwise = full;
  }
  if (!students || !classwise) throw new Error('Could not find both reports (student-wise + class-wise). Pass --students and --classwise.');
  return { students, classwise };
}

/**
 * Pure planning step (no DB access) — what to write, given the parsed reports and
 * the current DB state. Exported so it can be tested without a database.
 */
function planImport(sw, cw, current, { keepMissing = false } = {}) {
  const plan = { studentUpserts: [], studentsNew: 0, studentsChanged: 0, studentsSame: 0, studentsRemoved: [],
    courseUpserts: [], coursesNew: 0, coursesUpdated: 0, coursesDeactivated: [], keptNoExam: [], teachersNew: [] };

  // ── students ──
  const curStu = new Map(current.students.map((r) => [String(r.studentId), r]));
  const seen = new Set();
  for (const r of sw.studentRegistrations || []) {
    const sid = String(r.studentId || '').trim();
    if (!sid || seen.has(sid)) continue;
    seen.add(sid);
    const doc = { studentId: sid, name: r.name || '', program: r.program || '', batch: r.batch || '', courses: [...new Set((r.courses || []).map(up))] };
    const cur = curStu.get(sid);
    if (!cur) plan.studentsNew++;
    else if ((cur.name || '') === doc.name && (cur.program || '') === doc.program && (cur.batch || '') === doc.batch && sameList(cur.courses, doc.courses)) { plan.studentsSame++; continue; }
    else plan.studentsChanged++;
    plan.studentUpserts.push(doc);
  }
  if (!keepMissing) plan.studentsRemoved = current.students.filter((r) => !seen.has(String(r.studentId)));

  // ── courses ──
  const curByFull = new Map(current.courses.map((c) => [c.fullCode, c]));
  const oldNoExam = new Set(current.courses.filter((c) => c.noExam).map((c) => up(c.code)));
  const newFull = new Set();
  for (const c of cw.courses || []) {
    if (!c.fullCode || newFull.has(c.fullCode)) continue;
    newFull.add(c.fullCode);
    const keep = !c.noExam && oldNoExam.has(up(c.code));
    if (keep) plan.keptNoExam.push(up(c.code));
    const set = {
      code: up(c.code), name: c.name || up(c.code), component: c.component === 'Lab' ? 'Lab' : 'Lecture',
      section: c.section || '', teacher: c.teacher || 'TBA', enrolled: Number(c.enrolled) || 0,
      creditHours: c.creditHours != null ? Number(c.creditHours) : 3,
      noExam: !!c.noExam || keep, noTimetable: !!c.noTimetable, active: true,
      ...(c.academicTerm ? { academicTerm: c.academicTerm } : {}),
    };
    if (curByFull.has(c.fullCode)) plan.coursesUpdated++; else plan.coursesNew++;
    plan.courseUpserts.push({ fullCode: c.fullCode, set, insertOnly: { department: c.department || '', level: c.level === 'PG' ? 'PG' : 'UG', program: c.program || '', programBatch: c.programBatch || '' } });
  }
  plan.keptNoExam = [...new Set(plan.keptNoExam)].sort();
  plan.coursesDeactivated = current.courses
    .filter((c) => c.active !== false && !newFull.has(c.fullCode) && IMPORTER_FULLCODE.test(c.fullCode || ''))
    .map((c) => c.fullCode);

  // ── teachers ──
  const haveT = new Set(current.teachers.map((n) => String(n).trim().toLowerCase()));
  for (const t of cw.teachers || []) {
    const n = String(t.name || '').trim();
    if (!n || /^(tba|no teacher)$/i.test(n) || haveT.has(n.toLowerCase())) continue;
    haveT.add(n.toLowerCase());
    plan.teachersNew.push({ name: n, email: t.email || '', facultyId: t.facultyId || '' });
  }

  // registered codes with no course row at all (would silently miss the datesheet)
  const codes = new Set((cw.courses || []).map((c) => up(c.code)));
  plan.regCodesWithoutCourse = [...new Set((sw.studentRegistrations || []).flatMap((r) => (r.courses || []).map(up)))].filter((c) => !codes.has(c));
  return plan;
}

function printPlan(plan, files) {
  console.log('\nFiles');
  console.log(`  student-wise : ${files.students}`);
  console.log(`  class-wise   : ${files.classwise}`);
  console.log('\nStudents');
  console.log(`  new ${plan.studentsNew} · changed ${plan.studentsChanged} · unchanged ${plan.studentsSame} · removed ${plan.studentsRemoved.length}${KEEP_MISSING ? ' (--keep-missing)' : ''}`);
  if (plan.studentsRemoved.length) console.log(`  removed IDs: ${plan.studentsRemoved.map((r) => r.studentId).join(', ').slice(0, 800)}`);
  console.log('Courses');
  console.log(`  new ${plan.coursesNew} · updated ${plan.coursesUpdated} · deactivated (no longer in report) ${plan.coursesDeactivated.length}`);
  if (plan.coursesDeactivated.length) console.log(`  deactivated: ${plan.coursesDeactivated.join(', ').slice(0, 800)}`);
  if (plan.keptNoExam.length) console.log(`  no-exam flag kept from the DB (${plan.keptNoExam.length}): ${plan.keptNoExam.join(', ').slice(0, 800)}`);
  if (plan.regCodesWithoutCourse.length) console.log(`  ⚠ registered but missing in class-wise report: ${plan.regCodesWithoutCourse.join(', ')}`);
  console.log(`Teachers\n  new ${plan.teachersNew.length}`);
}

async function main() {
  const files = pickFiles();
  const sw = parseDataset(files.students);
  const cw = parseDataset(files.classwise);
  if (!(sw.studentRegistrations || []).length) throw new Error(`${files.students} has no student registrations (expected the student-wise report).`);
  if (!(cw.courses || []).length) throw new Error(`${files.classwise} has no courses (expected the class-wise report).`);

  const connectDB = require('../config/db');
  await connectDB(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/abasyn_scheduler');
  const Course = require('../models/Course');
  const Teacher = require('../models/Teacher');
  const StudentRegistration = require('../models/StudentRegistration');

  const current = {
    students: await StudentRegistration.find({}).lean(),
    courses: await Course.find({}).select('fullCode code noExam active').lean(),
    teachers: (await Teacher.find({}).select('name').lean()).map((t) => t.name),
  };
  const plan = planImport(sw, cw, current, { keepMissing: KEEP_MISSING });
  printPlan(plan, files);

  if (DRY) { console.log('\nDry run — nothing written.\n'); await mongoose.disconnect(); return; }

  if (plan.studentsRemoved.length) {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const bk = path.join(OUTPUT_DIR, `backup_removed_students_${Date.now()}.json`);
    fs.writeFileSync(bk, JSON.stringify(plan.studentsRemoved, null, 1));
    console.log(`\nBackup of removed students → ${bk}`);
    await StudentRegistration.deleteMany({ _id: { $in: plan.studentsRemoved.map((r) => r._id) } });
  }
  if (plan.studentUpserts.length) {
    await StudentRegistration.bulkWrite(plan.studentUpserts.map((d) => ({
      updateOne: { filter: { studentId: d.studentId }, update: { $set: { name: d.name, program: d.program, batch: d.batch, courses: d.courses } }, upsert: true },
    })), { ordered: false });
  }
  if (plan.courseUpserts.length) {
    await Course.bulkWrite(plan.courseUpserts.map((u) => ({
      updateOne: { filter: { fullCode: u.fullCode }, update: { $set: u.set, $setOnInsert: { fullCode: u.fullCode, ...u.insertOnly } }, upsert: true },
    })), { ordered: false });
  }
  if (plan.coursesDeactivated.length) {
    await Course.updateMany({ fullCode: { $in: plan.coursesDeactivated } }, { $set: { active: false } });
  }
  if (plan.teachersNew.length) await Teacher.insertMany(plan.teachersNew, { ordered: false }).catch(() => null);

  const { deriveCourseMeta } = require('../utils/deriveCourseMeta');
  await deriveCourseMeta();

  // Student Portal logins for every reg number (new ones get password student123)
  const { ensureStudentAccounts } = require('../utils/studentAccounts');
  const logins = await ensureStudentAccounts();
  console.log(`Student logins: ${logins.created} new (password "student123") · ${logins.total} total`);

  const [sc, cc, ac, tc] = await Promise.all([
    StudentRegistration.countDocuments({}), Course.countDocuments({}), Course.countDocuments({ active: true }), Teacher.countDocuments({}),
  ]);
  console.log(`\n✓ Imported. DB now: ${sc} students · ${ac} active course rows (${cc} total) · ${tc} teachers\n`);
  try { const { logActivity } = require('../utils/logger'); await logActivity('dataset.upload', `Reports imported via script: ${path.basename(files.students)} + ${path.basename(files.classwise)}`, 'success'); } catch { /* optional */ }
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async (e) => { console.error('\n✗ Import failed:', e.message); try { await mongoose.disconnect(); } catch { /* ignore */ } process.exit(1); });
}
module.exports = { planImport };
