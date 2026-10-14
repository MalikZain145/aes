/**
 * oneTimeTasks.js — maintenance jobs that must run exactly ONCE per database.
 * Each job records its key in the Setting collection after it succeeds, so a
 * restart never repeats it. Runs automatically when the server starts.
 *
 *   2026-10-12.clear-timetables  remove every generated class timetable (engine runs,
 *                                their entries and old timetable files) so students and
 *                                faculty no longer see one. A JSON backup is written to
 *                                scheduler/output first.
 *   2026-10-12.staff-usernames   Exam Cell login  → examination@abasynisb.edu.pk
 *                                Finance login    → finance@abasynisb.edu.pk
 *                                (passwords are not touched)
 *   2026-10-14.import-data       replace the student / course data with the 14 Oct 2026
 *                                Course Registration Reports and load the faculty rosters
 *                                (Faculty_List + All_Faculity): 4-digit Faculty IDs, faculty
 *                                logins (faculty123), yellow rows → no invigilation,
 *                                visiting/adjunct flags. Files: backend/data/imports/2026-10-14/
 *   2026-10-14.faculty-list-only  faculty = ONLY the 148 people on Faculty_List.xlsx; every
 *                                other teacher record and its faculty login is removed
 *                                (backup in scheduler/output). E-mails from All_Faculity.
 *   2026-10-14.refresh-datesheets update the existing BS / B.Tech / MS datesheets with that
 *                                data (NOT regenerated): placements + merges kept, new
 *                                theory courses added clash-free, clashes from new students
 *                                fixed, PDFs re-rendered. Admit cards must be regenerated.
 */
const fs = require('fs');
const path = require('path');
const Setting = require('../models/Setting');

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'scheduler', 'output');

const EXAM_CELL_USERNAME = 'examination@abasynisb.edu.pk';
const FINANCE_USERNAME = 'finance@abasynisb.edu.pk';

async function clearTimetables() {
  const TimetableRun = require('../models/TimetableRun');
  const TimetableEntry = require('../models/TimetableEntry');
  const GeneratedFile = require('../models/GeneratedFile');
  const runs = await TimetableRun.find({}).lean();
  const files = await GeneratedFile.find({ kind: 'timetable' }).lean();
  const entryCount = await TimetableEntry.countDocuments({});
  if (runs.length || files.length || entryCount) {
    try {
      if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      const bk = path.join(OUTPUT_DIR, `backup_timetables_${Date.now()}.json`);
      fs.writeFileSync(bk, JSON.stringify({ runs, files, entries: await TimetableEntry.find({}).lean() }));
      console.log(`   backup of removed timetables → ${bk}`);
    } catch (e) { console.warn('   timetable backup failed:', e.message); }
  }
  await TimetableEntry.deleteMany({});
  await TimetableRun.deleteMany({});
  await GeneratedFile.deleteMany({ kind: 'timetable' });
  return `removed ${runs.length} timetable run(s), ${entryCount} entries, ${files.length} timetable file record(s)`;
}

async function staffUsernames() {
  const User = require('../models/User');
  const out = [];

  // Exam Cell (admin) — rename the default exam-cell account.
  if (!(await User.exists({ username: EXAM_CELL_USERNAME }))) {
    const old = ['examcell.abasynisb.edu.pk', 'examcell@abasynisb.edu.pk', 'admin', String(process.env.ADMIN_USERNAME || '').toLowerCase()].filter(Boolean);
    let admin = await User.findOne({ role: 'admin', username: { $in: old } });
    if (!admin && (await User.countDocuments({ role: 'admin' })) === 1) admin = await User.findOne({ role: 'admin' });
    if (admin) {
      out.push(`exam cell "${admin.username}" → "${EXAM_CELL_USERNAME}"`);
      admin.username = EXAM_CELL_USERNAME;
      admin.email = EXAM_CELL_USERNAME;
      await admin.save();
    }
  }

  // Finance — make sure the finance office signs in as finance@abasynisb.edu.pk.
  if (!(await User.exists({ username: FINANCE_USERNAME }))) {
    const fin = await User.findOne({ role: 'finance' }).sort({ createdAt: 1 });
    if (fin) {
      out.push(`finance "${fin.username}" → "${FINANCE_USERNAME}"`);
      fin.username = FINANCE_USERNAME;
      fin.email = FINANCE_USERNAME;
      await fin.save();
    }
  } else {
    const fin = await User.findOne({ username: FINANCE_USERNAME });
    if (fin && fin.email !== FINANCE_USERNAME) { fin.email = FINANCE_USERNAME; await fin.save(); }
  }
  return out.length ? out.join('; ') : 'usernames already correct';
}

const IMPORT_2026_10_14 = path.join(__dirname, '..', 'data', 'imports', '2026-10-14');

async function importData20261014() {
  const dir = IMPORT_2026_10_14;
  // not marked done until the files are there (backend/data is git-ignored — copy the
  // folder to the server, or run scripts/importReports.js + importFaculty.js there)
  if (!fs.existsSync(dir)) throw new Error('backend/data/imports/2026-10-14 not found on this machine');
  const files = fs.readdirSync(dir);
  const find = (rx) => { const f = files.find((x) => rx.test(x)); return f ? path.join(dir, f) : null; };
  const students = find(/^Course_Registration_Report_October.*\.xls$/i);
  const classwise = find(/classwise.*\.xls$/i);
  const facultyList = find(/^Faculty_List\.xlsx$/i);
  const allFaculty = find(/^All_Facul.*\.xlsx$/i);
  const out = [];
  if (students && classwise) {
    const { applyReports } = require('../scripts/importReports');
    const r = await applyReports({ students, classwise }, { keepMissing: false, log: (m) => console.log(`   ${m}`) });
    out.push(r.summary);
  }
  if (facultyList || allFaculty) {
    const { importFaculty } = require('./facultyImport');
    const r = await importFaculty({ facultyList, allFaculty, log: (m) => console.log(`   ${m}`) });
    out.push(r.summary);
  }
  return out.join(' || ') || 'nothing to import';
}

async function facultyListOnly20261014() {
  const dir = IMPORT_2026_10_14;
  const f = (rx) => { if (!fs.existsSync(dir)) return null; const x = fs.readdirSync(dir).find((n) => rx.test(n)); return x ? path.join(dir, x) : null; };
  const facultyList = f(/^Faculty_List\.xlsx$/i);
  if (!facultyList) throw new Error('backend/data/imports/2026-10-14/Faculty_List.xlsx not found on this machine');
  const { importFaculty } = require('./facultyImport');
  const r = await importFaculty({ facultyList, allFaculty: f(/^All_Facul.*\.xlsx$/i), log: (m) => console.log(`   ${m}`) });
  return r.summary;
}

async function refreshDatesheets20261014() {
  if (!(await Setting.findOne({ key: 'once:2026-10-14.import-data' }).lean())) throw new Error('waiting for the 14 Oct data import');
  const { refreshAllDatesheets } = require('./datesheetRefresh');
  const reports = await refreshAllDatesheets({ note: 'Updated with the 14 Oct 2026 registration data' });
  if (!reports.length) return 'no datesheets to update';
  const failed = reports.filter((r) => r.error && r.saved !== true && !(r.unplaced || []).length);
  const line = reports.map((r) => (r.error && !r.saved
    ? `${r.title}: NOT updated — ${r.error}`
    : `${r.title}: +${(r.added || []).length} added [${(r.added || []).map((x) => x.code).join(', ')}], ${(r.moved || []).length} moved, `
      + `${(r.dropped || []).length} removed [${(r.dropped || []).map((x) => x.code).join(', ')}], ${(r.unplaced || []).length} unplaced, students ${r.studentsBefore}→${r.studentsAfter}`)).join(' | ');
  if (failed.length) throw new Error(line);
  return line;
}

// Faculty List defaults again (123 on: everyone except yellow rows + visiting/adjunct),
// whatever was toggled since — and the yellow flag is stored for the Reset button.
async function invigilationDefaults20261014() {
  return facultyListOnly20261014();
}

// Re-render every active datesheet: landscape pages + BS Friday 01:00-02:30 → 03:00-04:30
async function bsFridayLandscape20261014() {
  if (!(await Setting.findOne({ key: 'once:2026-10-14.import-data' }).lean())) throw new Error('waiting for the 14 Oct data import');
  const { refreshAllDatesheets } = require('./datesheetRefresh');
  const reports = await refreshAllDatesheets({ note: 'Landscape layout + BS Friday 03:00-04:30 rule' });
  const bad = reports.filter((r) => r.saved !== true);
  const line = reports.map((r) => `${r.title}: ${r.saved ? 'updated' : 'NOT updated — ' + (r.error || '')}${(r.moved || []).length ? `, ${r.moved.length} moved` : ''}`).join(' | ');
  if (bad.length) throw new Error(line);
  return line || 'no datesheets';
}

// Every existing datesheet PDF (incl. archived terms) → landscape, papers unchanged.
async function landscapeAll20261014() {
  const { rerenderAllDatesheets } = require('./datesheetRefresh');
  const r = await rerenderAllDatesheets();
  if (r.failed.length) throw new Error(`${r.done} done; failed: ${r.failed.join(' | ')}`);
  return `${r.done} datesheet PDF(s) now landscape${r.skipped.length ? `; skipped (no saved schedule): ${r.skipped.join(', ')}` : ''}`;
}

// Fresh enrollment for every course from all students' registrations.
async function enrollmentFresh20261014() {
  if (!(await Setting.findOne({ key: 'once:2026-10-14.import-data' }).lean())) throw new Error('waiting for the 14 Oct data import');
  const r = await require('./enrollment').recomputeEnrollment();
  return `${r.courses} course group(s) recounted from ${r.students} students — ${r.changed} row(s) changed`;
}

const TASKS = [
  ['2026-10-12.clear-timetables', clearTimetables],
  ['2026-10-12.staff-usernames', staffUsernames],
  ['2026-10-14.import-data', importData20261014],
  ['2026-10-14.faculty-list-only', facultyListOnly20261014],
  ['2026-10-14.refresh-datesheets', refreshDatesheets20261014],
  ['2026-10-14.invigilation-defaults', invigilationDefaults20261014],
  ['2026-10-14.bs-friday-landscape', bsFridayLandscape20261014],
  ['2026-10-14.landscape-all', landscapeAll20261014],
  ['2026-10-14.enrollment-fresh', enrollmentFresh20261014],
];

async function runOneTimeTasks() {
  for (const [key, fn] of TASKS) {
    const done = await Setting.findOne({ key: `once:${key}` }).lean();
    if (done) continue;
    try {
      const msg = await fn();
      await Setting.updateOne({ key: `once:${key}` }, { $set: { value: { at: new Date(), result: msg } } }, { upsert: true });
      console.log(`✓ one-time task ${key}: ${msg}`);
      try { await require('./logger').logActivity('system.maintenance', `${key}: ${msg}`, 'info'); } catch { /* optional */ }
    } catch (e) {
      console.warn(`⚠ one-time task ${key} failed (will retry next start): ${e.message}`);
    }
  }
}

module.exports = { runOneTimeTasks, EXAM_CELL_USERNAME, FINANCE_USERNAME };
