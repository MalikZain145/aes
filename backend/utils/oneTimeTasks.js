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

const IMPORT_2026_10_15 = path.join(__dirname, '..', 'data', 'imports', '2026-10-15');

// 15 Oct data: Course_Registration_Report_15-10-26.xls (students) + odoocms.class.xlsx
// (ERP class list: every section with its program batch, faculty and enrollment).
// REPLACES the previous data: students not in the report are removed (backup), course
// rows not in the class list are deactivated. Faculty list untouched.
async function importData20261015() {
  const dir = IMPORT_2026_10_15;
  if (!fs.existsSync(dir)) throw new Error('backend/data/imports/2026-10-15 not found on this machine');
  const files = fs.readdirSync(dir);
  const find = (rx) => { const f = files.find((x) => rx.test(x)); return f ? path.join(dir, f) : null; };
  const students = find(/^Course_Registration_Report.*\.xls$/i);
  const classwise = find(/^odoocms\.class.*\.xlsx?$/i);
  if (!students || !classwise) throw new Error('2026-10-15: registration report or odoocms.class.xlsx missing');
  const { applyReports } = require('../scripts/importReports');
  const r = await applyReports({ students, classwise }, { keepMissing: false, log: (m) => console.log(`   ${m}`) });
  return r.summary;
}

// Existing BS / B.Tech / MS datesheets updated with the 15 Oct data (not regenerated).
async function refreshDatesheets20261015() {
  if (!(await Setting.findOne({ key: 'once:2026-10-15.import-data' }).lean())) throw new Error('waiting for the 15 Oct data import');
  const { refreshAllDatesheets } = require('./datesheetRefresh');
  const reports = await refreshAllDatesheets({ note: 'Updated with the 15 Oct 2026 registration + class data' });
  if (!reports.length) return 'no datesheets to update';
  const line = reports.map((r) => (r.error && !r.saved
    ? `${r.title}: NOT updated — ${r.error}`
    : `${r.title}: +${(r.added || []).length} added [${(r.added || []).map((x) => x.code).join(', ')}], ${(r.moved || []).length} moved, `
      + `${(r.dropped || []).length} removed [${(r.dropped || []).map((x) => x.code).join(', ')}], ${(r.unplaced || []).length} unplaced, students ${r.studentsBefore}→${r.studentsAfter}`)).join(' | ');
  if (reports.some((r) => r.error && r.saved !== true && !(r.unplaced || []).length)) throw new Error(line);
  return line;
}

// New admit cards for everyone with the new data: sections kept apart, each student
// with the section of his program batch, A seated first then B then C.
async function admitCards20261015() {
  if (!(await Setting.findOne({ key: 'once:2026-10-15.refresh-datesheets' }).lean())) throw new Error('waiting for the 15 Oct datesheet update');
  return require('./admitRegen').regenerateAdmitCards({ log: (m) => console.log(m) });
}

// Sections are never merged: re-order + re-print the issued admit-card batch
// (cards, seating plan, ID sheets per section, invigilation) — tags follow AV.
async function sections20261015() {
  // the 15 Oct admit cards are generated fresh with sections — nothing to re-print
  if (await Setting.findOne({ key: 'once:2026-10-15.admit-cards' }).lean()) return 'superseded — admit cards regenerated with sections (15 Oct data)';
  if (fs.existsSync(IMPORT_2026_10_15)) throw new Error('waiting for the 15 Oct admit cards');
  const r = await require('./sections').resectionAll();
  if (!r.length) return 'no admit-card batch with seating data';
  return r.map((x) => `${x.title}: ${x.courses} multi-section course(s), ${x.labelled} papers labelled, ${x.moved} seats re-ordered, ${x.studentsUpdated} cards updated`).join(' | ');
}

// ONE fresh set of admit cards: the title / teacher fixes in place (MG569 row, lecture
// teachers only), new cards for every student, and EVERY earlier admit-card batch
// (14 Oct, the two 15 Oct runs …) deleted — files, QR records and all. Paid fee kept.
async function freshAdmitCards20261015() {
  if (!(await Setting.findOne({ key: 'once:2026-10-15.refresh-datesheets' }).lean())) throw new Error('waiting for the 15 Oct datesheet update');
  const PT = require('./paperTeachers');
  const out = [];
  const dir = IMPORT_2026_10_15;
  const reg = fs.existsSync(dir) && fs.readdirSync(dir).find((x) => /^Course_Registration_Report.*\.xls$/i.test(x));
  if (reg) { const a = await PT.addRegisteredCourses(path.join(dir, reg)); if (a.length) out.push(`course rows added: ${a.join(', ')}`); }
  const { names } = await PT.paperTeacherMaps();
  const ds = await require('./datesheetRefresh').fillDatesheetTitles(names);
  if (ds.codes.length) out.push(`datesheet titles filled (${ds.codes.join(', ')})`);
  out.push(await require('./admitRegen').regenerateAdmitCards({ replaceAll: true, log: (m) => console.log(m) }));
  return out.join(' | ');
}

// Cards + tags printed the LAB instructor next to the lecture teacher (ERP class list
// has lecture + lab rows) and MG569 had no title. Fix the records of the admit-card
// batches made from the 15 Oct data and re-print them — seats and sections unchanged.
async function paperTeachers20261015() {
  if (await Setting.findOne({ key: 'once:2026-10-15.fresh-admit-cards' }).lean()) return 'superseded — fresh admit cards made';
  const imp = await Setting.findOne({ key: 'once:2026-10-15.import-data' }).lean();
  if (!imp) throw new Error('waiting for the 15 Oct data import');
  if (!(await Setting.findOne({ key: 'once:2026-10-15.admit-cards' }).lean())) throw new Error('waiting for the 15 Oct admit cards');
  const PT = require('./paperTeachers');
  const out = [];
  const dir = IMPORT_2026_10_15;
  const reg = fs.existsSync(dir) && fs.readdirSync(dir).find((x) => /^Course_Registration_Report.*\.xls$/i.test(x));
  if (reg) { const a = await PT.addRegisteredCourses(path.join(dir, reg)); if (a.length) out.push(`course rows added: ${a.join(', ')}`); }
  const { names } = await PT.paperTeacherMaps();
  const ds = await require('./datesheetRefresh').fillDatesheetTitles(names);
  if (ds.codes.length) out.push(`datesheet titles filled (${ds.codes.join(', ')}) on ${ds.sheets} sheet(s)${ds.failed.length ? ' — failed: ' + ds.failed.join('; ') : ''}`);
  const GeneratedFile = require('../models/GeneratedFile');
  const since = new Date((imp.value && imp.value.at) || 0);
  const batches = await GeneratedFile.find({ kind: 'admit_cards', createdAt: { $gte: since } }).sort({ createdAt: -1 }).lean();
  for (const b of batches) {
    const f = await PT.fixBatchPapers(b._id);
    const r = await require('./sections').resectionBatch(b._id);
    out.push(`${b.title} (${new Date(b.createdAt).toLocaleString()}): ${f.papers} paper(s) on ${f.students} card(s) corrected, re-printed (${r.moved} seats moved)`);
  }
  return out.join(' | ') || 'nothing to fix';
}

// MG403: the ERP list has Ms. Khola Ilyas's "Section-A" class AND Mr. Ali Nasir's
// class written "…-01-CE-lecture" (no letter). That class is section B (BE Civil
// Fall 23), so its students get their own ID sheet + tag with Mr. Ali Nasir. Re-reads
// the same 15 Oct files (nothing else changes).
async function mg403Sections20261016() {
  if (!(await Setting.findOne({ key: 'once:2026-10-15.fresh-admit-cards' }).lean())) throw new Error('waiting for the 15 Oct fresh admit cards');
  const dir = IMPORT_2026_10_15;
  if (!fs.existsSync(dir)) throw new Error('backend/data/imports/2026-10-15 not found on this machine');
  const files = fs.readdirSync(dir);
  const students = files.find((x) => /^Course_Registration_Report.*\.xls$/i.test(x));
  const classwise = files.find((x) => /^odoocms\.class.*\.xlsx?$/i.test(x));
  if (!students || !classwise) throw new Error('2026-10-15 files missing');
  const { applyReports } = require('../scripts/importReports');
  const r = await applyReports({ students: path.join(dir, students), classwise: path.join(dir, classwise) }, { keepMissing: false, log: (m) => console.log(`   ${m}`) });
  // the cards are re-issued by the next task (papers merged) — no re-print here
  return r.summary;
}

/**
 * Papers merged on the BS datesheet (same date + time, one sitting), as the exam office
 * asked — saved through the datesheet editor, so its clash check (every student, every
 * datesheet of the cohort) must pass or nothing is saved:
 *   MG403 (A Khola Ilyas, B Ali Nasir) + MG404  → Tue 03-Nov-2026 11:00-12:30
 *        (the only BS slot where none of their 82 students sits another paper)
 *   MG116 + MG202 (Principles of Accounting)    → MG116's slot, Sat 07-Nov-2026 09:00-10:30
 * Then ONE fresh set of admit cards (all old batches removed, Paid fee kept). Sections
 * stay exactly as in the class list; ID sheets / tags per section (MG403-A, MG403-B, MG404).
 */
async function mergePapers20261016() {
  if (!(await Setting.findOne({ key: 'once:2026-10-16.mg403-sections' }).lean())) throw new Error('waiting for the MG403 sections');
  // exam office: 9841 Osama Ud Din (BE Civil Fall 24) sits with Mr. Ali Nasir's class → MG403-B
  await require('./sectionPlan').setSectionOverrides({ '9841|MG403': 'B' });
  const GeneratedFile = require('../models/GeneratedFile');
  const ed = require('../controllers/datesheetEditorController');
  const I = ed._internals;
  const sheets = await GeneratedFile.find({ kind: 'datesheet', archived: { $ne: true } }).sort({ createdAt: -1 }).lean();
  const bs = sheets.find((d) => I.datesheetCohort(d) === 'bs');
  if (!bs) throw new Error('no BS datesheet');
  const { snap } = await I.loadRecord(bs._id);
  const dates = snap.dates || [];
  const { slots } = I.gridFor('bs', snap.slots || [], dates);
  const courses = I.snapToCourses(snap, slots);
  const at = (code) => courses.find((c) => c.code === code);
  for (const c of ['MG403', 'MG404', 'MG116', 'MG202']) if (!at(c)) throw new Error(`${c} is not on the BS datesheet`);
  const d1 = dates.indexOf('2026-11-03'); const s1 = slots.indexOf('11:00-12:30');
  if (d1 < 0 || s1 < 0) throw new Error('03-Nov-2026 11:00-12:30 is not on the BS datesheet');
  const m116 = at('MG116');
  for (const c of courses) {
    if (c.code === 'MG403' || c.code === 'MG404') Object.assign(c, { d: d1, s: s1, group: 'MG403+MG404' });
    if (c.code === 'MG116' || c.code === 'MG202') Object.assign(c, { d: m116.d, s: m116.s, group: 'MG116+MG202' });
  }
  const res = { code: 200, body: null, status(x) { this.code = x; return this; }, json(o) { this.body = o; return this; } };
  await ed.saveEditor({ params: { id: String(bs._id) }, body: { courses, removed: [], note: 'Merged MG403+MG404 (03-Nov 11:00) and MG116+MG202 (07-Nov 09:00)' } }, res);
  if (res.code !== 200 || !res.body || !res.body.ok) {
    const cl = (res.body && res.body.clashes) || [];
    throw new Error(`${(res.body && res.body.error) || 'datesheet not saved'} ${cl.slice(0, 5).map((x) => JSON.stringify(x)).join(' ')}`);
  }
  const cards = await require('./admitRegen').regenerateAdmitCards({ replaceAll: true, log: (m) => console.log(m) });
  return `BS datesheet: MG403+MG404 → 03-Nov 11:00-12:30, MG116+MG202 → ${dates[m116.d]} ${slots[m116.s]}; 9841 → MG403-B | ${cards}`;
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
  ['2026-10-15.import-data', importData20261015],
  ['2026-10-15.refresh-datesheets', refreshDatesheets20261015],
  ['2026-10-15.admit-cards', admitCards20261015],
  ['2026-10-15.sections-apart', sections20261015],
  ['2026-10-15.fresh-admit-cards', freshAdmitCards20261015],
  ['2026-10-15.paper-teachers', paperTeachers20261015],
  ['2026-10-16.mg403-sections', mg403Sections20261016],
  ['2026-10-16.merge-papers', mergePapers20261016],
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
