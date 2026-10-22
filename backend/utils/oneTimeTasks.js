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

// The 16 Oct batch was seated WITH sections (A → B → C) — mark it so the dashboard
// strip stops saying "not applied" (no re-print).
async function markSections20261016() {
  if (!(await Setting.findOne({ key: 'once:2026-10-16.merge-papers' }).lean())) throw new Error('waiting for the merged admit cards');
  const GeneratedFile = require('../models/GeneratedFile');
  const b = await GeneratedFile.findOne({ kind: 'admit_cards' }).sort({ createdAt: -1 });
  if (!b) return 'no admit-card batch';
  if (b.meta && b.meta.sectionsAppliedAt) return 'already marked';
  b.meta = { ...(b.meta || {}), sectionsAppliedAt: new Date(b.createdAt || Date.now()).toISOString() };
  b.markModified('meta'); await b.save();
  return `${b.title}: sections marked as applied`;
}

// New exam-hall instructions on every admit card (ID card / CNIC; no phones, smartwatches,
// calculators, bags) and the Finance "no signature or stamp" line removed. The issued
// batch is re-printed from its own seating — same rooms, seats, sections, QR codes.
async function cardInstructions20261016() {
  return 'done together with 2026-10-16.roster-format (one re-print)';
}

// One re-print of the issued batch: new admit-card instructions AND the invigilation
// roster in the Exam Office duty-roster format (Room No · Course Code · Strength ·
// Invigilator 1-3, one line per paper). Same rooms, seats, sections, duties, QR codes.
async function rosterFormat20261016() {
  if (!(await Setting.findOne({ key: 'once:2026-10-16.merge-papers' }).lean())) throw new Error('waiting for the merged admit cards');
  const GeneratedFile = require('../models/GeneratedFile');
  const b = await GeneratedFile.findOne({ kind: 'admit_cards' }).sort({ createdAt: -1 }).lean();
  if (!b) return 'no admit-card batch';
  const r = await require('./sections').resectionBatch(b._id);
  return `${b.title}: ${r.cards || 0} admit cards re-printed with the new instructions + duty roster in the Exam Office format (${r.moved || 0} seats changed)`;
}

// instructions moved right under the course table (bigger font) — re-print the latest batch once
async function instructionsUnderTable20261016() {
  const GeneratedFile = require('../models/GeneratedFile');
  const b = await GeneratedFile.findOne({ kind: 'admit_cards' }).sort({ createdAt: -1 }).lean();
  if (!b) return 'no admit-card batch';
  const r = await require('./sections').resectionBatch(b._id);
  return `${b.title}: ${r.cards || 0} admit cards re-printed (instructions under the course table)`;
}

// Exam office (19 Oct): the Fall-2026 BS / BE / B.Tech intake sits no mid-term, so the
// courses that intake is registered in (Course Registration Report, "Batch Intake" =
// Fall 2026) get no paper either — for EVERY student who registered them. Six
// transfer / lateral Fall-2026 students also hold upper-semester courses (CS313,
// CS375, MT201 …); those stay (they are older batches' regular papers).
// Removed from the BS + B.Tech datesheets, the issued admit cards, seating plan,
// identification sheets and duty roster. Nobody else is re-seated.
const FALL26_FIRST_SEMESTER = ['CE1013', 'CE1113', 'CS1013', 'CS106', 'CS114', 'ENG102', 'ENG103', 'HM1033', 'LT102', 'LT103', 'LT107', 'MD1073', 'MG100', 'MG105', 'MG109', 'MT112', 'MT129', 'NS201', 'RT101', 'RT102', 'RT104', 'SS108', 'SS118', 'SS130', 'SS216', 'SS233', 'SU103'];
async function dropFall26Courses20261019() {
  const GeneratedFile = require('../models/GeneratedFile');
  const AdmitVerification = require('../models/AdmitVerification');
  const { OUTPUT_DIR } = require('./pythonRunner');
  const drop = new Set(FALL26_FIRST_SEMESTER);
  const up = (x) => String(x || '').trim().toUpperCase();

  // 1) datesheets — take the papers out (and keep them out on any later refresh)
  const fixed = new Set(); const offSheet = new Set();
  for (const rec of await GeneratedFile.find({ kind: 'datesheet', archived: { $ne: true } })) {
    const sf = rec.meta && rec.meta.scheduleFile;
    const p = sf ? path.join(OUTPUT_DIR, path.basename(sf)) : null;
    if (!p || !fs.existsSync(p)) continue;
    const snap = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const gone = (snap.courses || []).filter((c) => drop.has(up(c.code))).map((c) => up(c.code));
    if (!gone.length) continue;
    snap.courses = (snap.courses || []).filter((c) => !drop.has(up(c.code))).map((c) => {
      if (!c.group || !String(c.group).includes('+')) return c;
      const left = String(c.group).split('+').map(up).filter((x) => !drop.has(x));
      return { ...c, group: left.length > 1 ? left.join('+') : up(c.code) };
    });
    for (const sess of snap.sessions || []) if (Array.isArray(sess.codes)) sess.codes = sess.codes.filter((x) => !drop.has(up(x)));
    snap.excluded_codes = [...new Set([...(snap.excluded_codes || []), ...gone])];
    fs.writeFileSync(p, JSON.stringify(snap));
    const log = Array.isArray(rec.meta.editLog) ? rec.meta.editLog : [];
    log.push({ at: new Date().toISOString(), removed: gone, note: 'Fall-2026 intake courses removed (no mid-term for the Fall 2026 intake)' });
    rec.meta = { ...rec.meta, editLog: log.slice(-50) };
    rec.markModified('meta'); await rec.save();
    gone.forEach((c) => offSheet.add(c)); fixed.add(String(rec._id));
  }
  const ds = fixed.size ? await require('./datesheetRefresh').rerenderAllDatesheets({ only: fixed }) : { done: 0, failed: [] };
  if (ds.failed && ds.failed.length) throw new Error(`datesheet re-print failed: ${ds.failed.join('; ')}`);

  // 2) the issued admit-card batch — drop those papers, keep every other seat
  const b = await GeneratedFile.findOne({ kind: 'admit_cards', archived: { $ne: true } }).sort({ createdAt: -1 });
  if (!b) return `datesheets: ${fixed.size} re-printed (${offSheet.size} papers removed); no admit-card batch`;
  const cards = (b.files || []).find((f) => /admit cards/i.test(f.label || ''));
  const layoutPath = path.join(OUTPUT_DIR, path.basename(cards.filename).replace(/\.pdf$/i, '_layout.json'));
  if (!fs.existsSync(layoutPath)) throw new Error('the admit-card batch has no _layout.json');
  const avs = await AdmitVerification.find({ batchId: b._id }).lean();
  fs.writeFileSync(path.join(OUTPUT_DIR, `backup_fall26_drop_${Date.now()}.json`),
    JSON.stringify({ layout: path.basename(layoutPath), avs: avs.filter((a) => (a.exams || []).some((e) => drop.has(up(e.code)))) }));

  const L = JSON.parse(fs.readFileSync(layoutPath, 'utf-8'));
  let seatsFreed = 0; let roomsEmptied = 0;
  L.sessions = (L.sessions || []).map((s) => ({
    ...s,
    rooms: (s.rooms || []).map((rm) => {
      const before = (rm.rows || []).length;
      const rows = (rm.rows || []).filter((r) => !drop.has(up(r.course)));
      seatsFreed += before - rows.length;
      return { ...rm, rows };
    }).filter((rm) => { if (rm.rows.length) return true; roomsEmptied++; return false; }),
  })).filter((s) => s.rooms.length);
  const tmp = `${layoutPath}.tmp`; fs.writeFileSync(tmp, JSON.stringify(L)); fs.renameSync(tmp, layoutPath);

  // admit-card records: drop the papers; a student left with no paper loses the card;
  // the others keep their order → card pages renumbered 1..n
  const keep = avs.map((a) => ({ a, exams: (a.exams || []).filter((e) => !drop.has(up(e.code))) }));
  const noCard = keep.filter((k) => !k.exams.length && (k.a.exams || []).length);
  const order = keep.filter((k) => k.exams.length && (k.a.cardPage || 0) > 0).sort((x, y) => x.a.cardPage - y.a.cardPage);
  const page = new Map(order.map((k, i) => [String(k.a._id), i + 1]));
  const ops = [];
  for (const k of keep) {
    const changed = k.exams.length !== (k.a.exams || []).length;
    const np = page.get(String(k.a._id)) || 0;
    if (!changed && np === (k.a.cardPage || 0)) continue;
    ops.push({ updateOne: { filter: { _id: k.a._id }, update: { $set: { exams: k.exams, cardPage: np } } } });
  }
  for (let i = 0; i < ops.length; i += 500) await AdmitVerification.bulkWrite(ops.slice(i, i + 500), { ordered: false });

  // re-print only — no seat, room or invigilator moves (MS cards are already with the students)
  const before = new Map(avs.map((a) => [String(a.studentId), a.exams || []]));
  const r = await require('./sections').resectionBatch(b._id, { keepSeats: true });
  let seatMoves = 0;
  for (const a of await AdmitVerification.find({ batchId: b._id }).select('studentId exams').lean()) {
    const old = new Map((before.get(String(a.studentId)) || []).map((e) => [`${e.code}|${e.date}|${e.slot}`, e]));
    for (const e of a.exams || []) { const o = old.get(`${e.code}|${e.date}|${e.slot}`); if (o && (o.room !== e.room || o.seat !== e.seat)) seatMoves++; }
  }
  if (seatMoves) console.warn(`⚠ Fall-2026 removal: ${seatMoves} seats differ after the re-print`);
  await GeneratedFile.updateOne({ _id: b._id }, { $set: { 'summary.admitCards': order.length, 'meta.fall26DroppedAt': new Date().toISOString(), 'meta.fall26Dropped': [...drop] } });
  return `datesheets: ${fixed.size} re-printed, ${offSheet.size} papers removed | ${b.title}: ${seatsFreed} seats freed, ${roomsEmptied} room-sittings emptied, `
    + `${noCard.length} students left with no paper (${noCard.map((k) => k.a.studentId).join(', ') || '—'}), ${r.cards || order.length} admit cards re-printed, seats moved: ${seatMoves}`;
}

// Exam office (19 Oct): four Fall-2026-intake students who are really transfer / lateral
// entries get admit cards for their upper-semester papers, added into the ISSUED batch:
// each paper goes to a free seat in a room that already writes it (same section where
// the course has sections), nobody else moves, new cards are appended at the end.
const LATERAL_ADD = {
  11440: ['CS412', 'CS313', 'CS375', 'CS304', 'CS242', 'CS432'],      // first-semester courses left out
  11536: ['MT201', 'CS375', 'SE350', 'SE321', 'CS313', 'CS432'],
  11506: ['MG302', 'MG212', 'MG444', 'MT205', 'MG306'],               // MG105 dropped; MG444 + MG306 same slot (both kept)
  19139: ['ENG308', 'ENG312', 'ENG401', 'SS402', 'ENG405', 'ENG309'],
};
async function addLateralStudents20261019() {
  if (!(await Setting.findOne({ key: 'once:2026-10-19.drop-fall26-first-semester' }).lean())) throw new Error('waiting for the Fall-2026 course removal');
  const crypto = require('crypto');
  const GeneratedFile = require('../models/GeneratedFile');
  const AdmitVerification = require('../models/AdmitVerification');
  const StudentRegistration = require('../models/StudentRegistration');
  const admitCrypto = require('./admitCrypto');
  const { OUTPUT_DIR } = require('./pythonRunner');
  const ed = require('../controllers/datesheetEditorController')._internals;
  const up = (x) => String(x || '').trim().toUpperCase();
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const disp = (iso) => { const [y, m, d] = iso.split('-'); return `${d}-${MON[Number(m) - 1]}-${y}`; };
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // where each paper sits on the BS datesheet
  const when = new Map();
  for (const rec of await GeneratedFile.find({ kind: 'datesheet', archived: { $ne: true } }).lean()) {
    if (ed.datesheetCohort(rec) !== 'bs') continue;
    const sf = rec.meta && rec.meta.scheduleFile; const p = sf ? path.join(OUTPUT_DIR, path.basename(sf)) : null;
    if (!p || !fs.existsSync(p)) continue;
    for (const c of JSON.parse(fs.readFileSync(p, 'utf-8')).courses || []) if (!when.has(up(c.code))) when.set(up(c.code), { date: c.date, slot: c.slot, name: c.name || '' });
  }

  const b = await GeneratedFile.findOne({ kind: 'admit_cards', archived: { $ne: true } }).sort({ createdAt: -1 });
  if (!b) throw new Error('no admit-card batch');
  const cards = (b.files || []).find((f) => /admit cards/i.test(f.label || ''));
  const layoutPath = path.join(OUTPUT_DIR, path.basename(cards.filename).replace(/\.pdf$/i, '_layout.json'));
  const L = JSON.parse(fs.readFileSync(layoutPath, 'utf-8'));
  const cap = new Map((L.venues || []).map((v) => [v.name, v]));
  const avs = await AdmitVerification.find({ batchId: b._id }).lean();
  const have = new Set(avs.map((a) => String(a.studentId)));
  const sample = avs.find((a) => a.heading) || avs[0];
  let page = Math.max(0, ...avs.map((a) => a.cardPage || 0));

  // section + teacher of every (course, program) from the issued cards
  const secByProg = new Map(); const secAll = new Map(); const teacher = new Map();
  for (const a of avs) {
    for (const e of a.exams || []) {
      const c = up(e.code);
      if (e.section) {
        const k1 = `${c}|${a.program}`; if (!secByProg.has(k1)) secByProg.set(k1, new Map());
        secByProg.get(k1).set(e.section, (secByProg.get(k1).get(e.section) || 0) + 1);
        if (!secAll.has(c)) secAll.set(c, new Map());
        secAll.get(c).set(e.section, (secAll.get(c).get(e.section) || 0) + 1);
      }
      if (e.teacher) teacher.set(`${c}|${e.section || ''}`, e.teacher);
      if (e.teacher && !teacher.has(`${c}|*`)) teacher.set(`${c}|*`, e.teacher);
    }
  }
  const top = (m) => (m && m.size ? [...m.entries()].sort((x, y) => y[1] - x[1])[0][0] : '');

  const placed = []; const docs = [];
  for (const [sidNum, codes] of Object.entries(LATERAL_ADD)) {
    const sid = String(sidNum);
    if (have.has(sid)) { placed.push(`${sid}: already has a card`); continue; }
    const reg = await StudentRegistration.findOne({ studentId: sid }).lean();
    if (!reg) throw new Error(`${sid} is not in the registrations`);
    const exams = [];
    for (const code of codes.map(up)) {
      const w = when.get(code);
      if (!w) throw new Error(`${sid}: ${code} is not on the BS datesheet`);
      const dd = disp(w.date);
      const sess = (L.sessions || []).find((s) => s.date === dd && s.slot === w.slot);
      if (!sess) throw new Error(`${sid}: no sitting ${dd} ${w.slot} in the seating`);
      const section = top(secByProg.get(`${code}|${reg.program}`)) || top(secAll.get(code)) || '';
      // rooms: same course + same section first, then same course, then any room with space
      const score = (rm) => {
        const rows = rm.rows || [];
        if (rows.some((r) => up(r.course) === code && (r.section || '') === section)) return 0;
        if (rows.some((r) => up(r.course) === code)) return 1;
        return 2;
      };
      let spot = null;
      for (const rm of [...sess.rooms].sort((x, y) => score(x) - score(y))) {
        const v = cap.get(rm.name); if (!v) continue;
        const nRows = v.rows || Math.ceil((v.exam_seats || 0) / 2);
        if ((rm.rows || []).length >= (v.exam_seats || nRows * 2)) continue;
        const at = new Map((rm.rows || []).map((r) => [`${r.row}|${r.col}`, r]));
        let best = null;
        for (let r = 1; r <= nRows && !best; r++) {
          for (const col of ['L', 'R']) {
            if (at.has(`${r}|${col}`)) continue;
            const mate = at.get(`${r}|${col === 'L' ? 'R' : 'L'}`);
            if (mate && up(mate.course) === code) continue;          // never two of the same paper on one bench
            best = { row: r, col }; break;
          }
        }
        if (best) { spot = { rm, ...best }; break; }
      }
      if (!spot) throw new Error(`${sid}: no free seat for ${code} on ${dd} ${w.slot}`);
      const seat = spot.col === 'L' ? String(spot.row) : `${spot.row}A`;
      spot.rm.rows.push({ row: spot.row, col: spot.col, seat, sid, name: reg.name, program: reg.program, batch: reg.batch || reg.program,
        course: code, time: w.slot, ...(section ? { section } : {}) });
      const [st, fi] = String(w.slot).split('-');
      exams.push({ code, name: w.name || (L.code_title || {})[code] || code, teacher: teacher.get(`${code}|${section}`) || teacher.get(`${code}|*`) || '',
        date: w.date, dateDisp: dd, day: sess.day || DAYS[new Date(`${w.date}T12:00:00`).getDay()], slot: w.slot, start: st, finish: fi,
        room: spot.rm.name, seat, section });
      placed.push(`${sid} ${code} → ${spot.rm.name} ${seat}${section ? ` (Sec ${section})` : ''}`);
    }
    const qid = crypto.randomBytes(8).toString('hex');
    const token = qid + admitCrypto.tokenSig(qid);
    page += 1;
    docs.push({ token, batchId: b._id, studentId: sid, name: reg.name, program: reg.program, batch: reg.batch || reg.program,
      cardPage: page, feeStatus: 'Unpaid', heading: sample.heading, examType: sample.examType, semester: sample.semester, year: sample.year,
      exams: exams.map((e) => ({ ...e, key: admitCrypto.paperKey(token, e.code, e.date, e.slot) })) });
  }
  if (!docs.length) return placed.join(' | ');
  const tmp = `${layoutPath}.tmp`; fs.writeFileSync(tmp, JSON.stringify(L)); fs.renameSync(tmp, layoutPath);
  await AdmitVerification.insertMany(docs, { ordered: true });
  const r = await require('./sections').resectionBatch(b._id, { keepSeats: true });
  await GeneratedFile.updateOne({ _id: b._id }, { $set: { 'summary.admitCards': page } });
  return `${docs.length} cards added (pages ${page - docs.length + 1}-${page}), ${r.cards || page} re-printed, nobody else moved | ${placed.join(' | ')}`;
}

// Exam office (19 Oct, 11:03): SS108, SS118, MT129 and SS216 come BACK — exactly as issued
// before the Fall-2026 removal: same datesheet cell, same room, same seat, same QR / card.
// Rebuilt from the backup taken by that removal. A just-added lateral student who had been
// given one of those freed seats is moved to another free seat (their cards are new).
const RESTORE4 = new Set(['SS108', 'SS118', 'MT129', 'SS216']);
const RESTORE4_SHEET = {"bs":[{"code":"MT129","name":"Quantitative Reasoning -1","date":"2026-11-02","date_disp":"02-Nov-2026","day":"Monday","day_index":1,"slot_index":0,"slot":"09:00-10:30","students":["10242","10483","10781","10811","10900","10910","10911","10915","10916","10921","10931","10932","10933","10936","10957","10960","10965","10968","10980","10994","10995","11000","11005","11006","11008","11011","11029","11034","11035","11036","11037","11038","11047","11052","11057","11061","11066","11078","11098","11104","11106","11117","11120","11136","11140","11143","6006"],"group":"MT129","_sess":["2026-11-02","09:00-10:30"]},{"code":"SS118","name":"Pakistan Studies","date":"2026-11-03","date_disp":"03-Nov-2026","day":"Tuesday","day_index":2,"slot_index":2,"slot":"01:00-02:30","students":["10034","10072","10097","10149","10179","10208","10210","10246","10247","10287","10289","10290","10294","10295","10328","10329","10331","10333","10334","10366","10407","10410","10462","10464","10465","10466","10472","10473","10474","10546","10548","10549","10593","10594","10596","10597","10599","10600","10602","10605","10606","10607","10609","10610","10633","10656","10657","10661","10680","10681","10682","10683","10701","10719","10723","10729","10746","10763","10773","10774","10777","10795","10804","10814","10851","10852","10875","10888","10891","10900","10907","10915","10916","10922","10931","10932","10933","10957","10965","10972","10994","11000","11008","11020","11044","11066","11087","11098","11117","3758","5938","6209","6696","6953","7050","7414","7806","8020","8032","9417","9440","9517","9578","9649","9750","9946","9964"],"group":"SS118","_sess":["2026-11-03","01:00-02:30"]},{"code":"SS216","name":"Introduction to Sociology(3)","date":"2026-11-06","date_disp":"06-Nov-2026","day":"Friday","day_index":5,"slot_index":0,"slot":"09:00-10:30","students":["10208","10210","10247","10287","10289","10290","10294","10295","10328","10329","10333","10334","10366","10407","10410","10462","10464","10466","10474","10546","10548","10593","10594","10596","10597","10599","10600","10602","10605","10606","10607","10609","10610","10639","10656","10657","10661","10680","10682","10683","10701","10719","10723","10725","10729","10746","10747","10763","10773","10774","10804","10814","10851","10852","10888","10891","10907","10922","10972","11020","11044","11087","11142","5938","6209","7228","7369","7531","7537","8371","8629","8711","9160","9338","9440","9517","9578","9612","9649","9964","9995"],"group":"SS216","_sess":["2026-11-06","09:00-10:30"]},{"code":"SS108","name":"Islamic Studies","date":"2026-11-07","date_disp":"07-Nov-2026","day":"Saturday","day_index":6,"slot_index":1,"slot":"11:00-12:30","students":["10038","10115","10120","10136","10165","10663","10869","10910","10911","10921","10936","10960","10968","10980","10995","11005","11006","11011","11029","11034","11035","11036","11037","11038","11047","11052","11057","11061","11078","11104","11106","11115","11120","11136","11140","11143","11167","5814","6209","7168","7305","7486","7911","8020","8994","9887","9937","9998"],"group":"SS108","_sess":["2026-11-07","11:00-12:30"]}],"btech":[{"code":"SS118","name":"Pakistan Studies","date":"2026-11-02","date_disp":"02-Nov-2026","day":"Monday","day_index":2,"slot_index":2,"slot":"03:00-04:30","students":["10955","10956","10970","11017","11021","11109","11119","11127","11128","6764"],"group":"SS118","_sess":["2026-11-02","03:00-04:30"]}]};
async function restoreFourCourses20261019() {
  if (!(await Setting.findOne({ key: 'once:2026-10-19.add-lateral-students' }).lean())) throw new Error('waiting for the lateral students');
  const GeneratedFile = require('../models/GeneratedFile');
  const AdmitVerification = require('../models/AdmitVerification');
  const { OUTPUT_DIR } = require('./pythonRunner');
  const ed = require('../controllers/datesheetEditorController')._internals;
  const up = (x) => String(x || '').trim().toUpperCase();

  // 1) datesheets — the four papers back in their original cells
  const fixed = new Set();
  for (const rec of await GeneratedFile.find({ kind: 'datesheet', archived: { $ne: true } })) {
    const add = RESTORE4_SHEET[ed.datesheetCohort(rec)];
    if (!add) continue;
    const sf = rec.meta && rec.meta.scheduleFile; const p = sf ? path.join(OUTPUT_DIR, path.basename(sf)) : null;
    if (!p || !fs.existsSync(p)) continue;
    const snap = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const on = new Set((snap.courses || []).map((c) => up(c.code)));
    let ch = false;
    for (const c0 of add) {
      const { _sess, ...c } = c0;
      if (!on.has(c.code)) { snap.courses.push(c); ch = true; }
      if (_sess) for (const ss of snap.sessions || []) if (ss.date === _sess[0] && ss.slot === _sess[1] && Array.isArray(ss.codes) && !ss.codes.includes(c.code)) { ss.codes.push(c.code); ch = true; }
    }
    const ex = (snap.excluded_codes || []).filter((x) => !RESTORE4.has(up(x)));
    if (ex.length !== (snap.excluded_codes || []).length) { snap.excluded_codes = ex; ch = true; }
    if (!ch) continue;
    fs.writeFileSync(p, JSON.stringify(snap));
    const log = Array.isArray(rec.meta.editLog) ? rec.meta.editLog : [];
    log.push({ at: new Date().toISOString(), restored: add.map((c) => c.code), note: 'SS108, SS118, MT129, SS216 restored to their original slots' });
    rec.meta = { ...rec.meta, editLog: log.slice(-50) }; rec.markModified('meta'); await rec.save();
    fixed.add(String(rec._id));
  }
  if (fixed.size) {
    const r = await require('./datesheetRefresh').rerenderAllDatesheets({ only: fixed });
    if (r.failed && r.failed.length) throw new Error(`datesheet re-print failed: ${r.failed.join('; ')}`);
  }

  // 2) admit cards / seating — from the backup of the removal
  const bkName = fs.readdirSync(OUTPUT_DIR).filter((f) => /^backup_fall26_drop_\d+\.json$/.test(f)).sort().pop();
  if (!bkName) throw new Error('backup_fall26_drop_*.json not found');
  const bk = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, bkName), 'utf-8'));
  const b = await GeneratedFile.findOne({ kind: 'admit_cards', archived: { $ne: true } }).sort({ createdAt: -1 });
  const cards = (b.files || []).find((f) => /admit cards/i.test(f.label || ''));
  const layoutPath = path.join(OUTPUT_DIR, path.basename(cards.filename).replace(/\.pdf$/i, '_layout.json'));
  const L = JSON.parse(fs.readFileSync(layoutPath, 'utf-8'));
  const sessOf = (dd, slot) => (L.sessions || []).find((s) => s.date === dd && s.slot === slot);
  const avNow = await AdmitVerification.find({ batchId: b._id }).lean();
  const byId = new Map(avNow.map((a) => [String(a.studentId), a]));

  // rows to put back (seat "12A" = row 12, right; "12" = row 12, left)
  const back = [];
  for (const a of bk.avs || []) {
    for (const e of a.exams || []) {
      if (!RESTORE4.has(up(e.code))) continue;
      const m = String(e.seat || '').match(/^(\d+)(A?)$/);
      if (!m) throw new Error(`${a.studentId} ${e.code}: seat "${e.seat}" not understood`);
      back.push({ a, e, row: { row: Number(m[1]), col: m[2] ? 'R' : 'L', seat: e.seat, sid: String(a.studentId), name: a.name, program: a.program,
        batch: a.batch, course: up(e.code), time: e.slot, ...(e.section ? { section: e.section } : {}) } });
    }
  }
  // free the original seats: a new lateral student sitting there moves to another free seat
  const cap = new Map((L.venues || []).map((v) => [v.name, v]));
  const lateral = new Set(Object.keys(LATERAL_ADD).map(String));
  const want = new Set(back.map((x) => `${x.e.dateDisp}|${x.e.slot}|${x.e.room}|${x.row.row}|${x.row.col}`));
  const moves = [];
  for (const x of back) {
    const s = sessOf(x.e.dateDisp, x.e.slot);
    if (!s) throw new Error(`no sitting ${x.e.dateDisp} ${x.e.slot}`);
    const rm = s.rooms.find((r) => r.name === x.e.room);
    if (!rm) throw new Error(`room ${x.e.room} missing on ${x.e.dateDisp} ${x.e.slot}`);
    const i = rm.rows.findIndex((r) => r.row === x.row.row && r.col === x.row.col);
    if (i < 0) continue;
    const occ = rm.rows[i];
    if (occ.sid === x.row.sid && up(occ.course) === x.row.course) { x.skip = true; continue; }
    if (!lateral.has(String(occ.sid))) throw new Error(`seat ${x.e.room} ${x.e.seat} (${x.e.dateDisp} ${x.e.slot}) is now taken by ${occ.sid}`);
    rm.rows.splice(i, 1);
    moves.push({ s, occ });
  }
  for (const x of back) {
    if (x.skip) continue;
    sessOf(x.e.dateDisp, x.e.slot).rooms.find((r) => r.name === x.e.room).rows.push(x.row);
  }
  const moved = [];
  for (const { s, occ } of moves) {
    const code = up(occ.course);
    const rooms = [...s.rooms].sort((p, q) => (q.rows.some((r) => up(r.course) === code) ? 1 : 0) - (p.rows.some((r) => up(r.course) === code) ? 1 : 0));
    let spot = null;
    for (const rm of rooms) {
      const v = cap.get(rm.name); if (!v) continue;
      const nRows = v.rows || Math.ceil((v.exam_seats || 0) / 2);
      if (rm.rows.length >= (v.exam_seats || nRows * 2)) continue;
      const at = new Map(rm.rows.map((r) => [`${r.row}|${r.col}`, r]));
      for (let r = 1; r <= nRows && !spot; r++) {
        for (const col of ['L', 'R']) {
          if (at.has(`${r}|${col}`) || want.has(`${s.date}|${s.slot}|${rm.name}|${r}|${col}`)) continue;
          const mate = at.get(`${r}|${col === 'L' ? 'R' : 'L'}`);
          if (mate && up(mate.course) === code) continue;
          spot = { rm, row: r, col }; break;
        }
      }
      if (spot) break;
    }
    if (!spot) throw new Error(`no free seat to move ${occ.sid} ${code}`);
    const seat = spot.col === 'L' ? String(spot.row) : `${spot.row}A`;
    spot.rm.rows.push({ ...occ, row: spot.row, col: spot.col, seat });
    moved.push({ sid: String(occ.sid), code, date: s.date, slot: s.slot, room: spot.rm.name, seat });
  }
  const tmp = `${layoutPath}.tmp`; fs.writeFileSync(tmp, JSON.stringify(L)); fs.renameSync(tmp, layoutPath);

  // admit-card records: the original paper entries (same token → same QR, same keys)
  let page = Math.max(0, ...avNow.map((a) => a.cardPage || 0));
  const ops = []; const revived = [];
  const bySid = new Map();
  for (const x of back) { if (!bySid.has(x.row.sid)) bySid.set(x.row.sid, []); bySid.get(x.row.sid).push(x.e); }
  for (const [sid, list] of bySid) {
    const cur = byId.get(sid);
    if (!cur) throw new Error(`${sid}: admit-card record missing`);
    const have = new Set((cur.exams || []).map((e) => `${up(e.code)}|${e.date}|${e.slot}`));
    const exams = [...(cur.exams || []), ...list.filter((e) => !have.has(`${up(e.code)}|${e.date}|${e.slot}`))];
    const set = { exams };
    if (!(cur.cardPage > 0)) { page += 1; set.cardPage = page; revived.push(sid); }
    ops.push({ updateOne: { filter: { _id: cur._id }, update: { $set: set } } });
  }
  for (const mv of moved) {
    const cur = byId.get(mv.sid);
    const exams = (cur.exams || []).map((e) => (up(e.code) === mv.code && e.dateDisp === mv.date && e.slot === mv.slot ? { ...e, room: mv.room, seat: mv.seat } : e));
    ops.push({ updateOne: { filter: { _id: cur._id }, update: { $set: { exams } } } });
  }
  for (let i = 0; i < ops.length; i += 500) await AdmitVerification.bulkWrite(ops.slice(i, i + 500), { ordered: true });

  const r = await require('./sections').resectionBatch(b._id, { keepSeats: true });
  await GeneratedFile.updateOne({ _id: b._id }, { $set: { 'summary.admitCards': page } });
  return `datesheets: ${fixed.size} re-printed | ${back.filter((x) => !x.skip).length} papers restored to their original seats for ${bySid.size} students`
    + `${revived.length ? `, cards back for ${revived.join(', ')} (same QR)` : ''} | lateral seats moved: ${moved.map((m) => `${m.sid} ${m.code} → ${m.room} ${m.seat}`).join(', ') || 'none'} | ${r.cards || page} cards re-printed`;
}

// Exam office (19 Oct): SE432 was merged with CS432 on the BS datesheet (Wed 04-Nov
// 11:00-12:30). The 2 SE432 students move to free seats in the CS432 rooms of that sitting;
// same card / QR (only the paper key for the new time is re-derived), nobody else moves.
async function se432WithCs432_20261019() {
  if (!(await Setting.findOne({ key: 'once:2026-10-19.restore-ss108-ss118-mt129-ss216' }).lean())) throw new Error('waiting for the restore');
  const GeneratedFile = require('../models/GeneratedFile');
  const AdmitVerification = require('../models/AdmitVerification');
  const admitCrypto = require('./admitCrypto');
  const { OUTPUT_DIR } = require('./pythonRunner');
  const up = (x) => String(x || '').trim().toUpperCase();
  const NEW = { date: '2026-11-04', dateDisp: '04-Nov-2026', day: 'Wednesday', slot: '11:00-12:30', start: '11:00', finish: '12:30' };
  const MATES = new Set(['CS432', 'SE432']);
  const b = await GeneratedFile.findOne({ kind: 'admit_cards', archived: { $ne: true } }).sort({ createdAt: -1 });
  const cards = (b.files || []).find((f) => /admit cards/i.test(f.label || ''));
  const layoutPath = path.join(OUTPUT_DIR, path.basename(cards.filename).replace(/\.pdf$/i, '_layout.json'));
  const L = JSON.parse(fs.readFileSync(layoutPath, 'utf-8'));
  const cap = new Map((L.venues || []).map((v) => [v.name, v]));
  const dest = (L.sessions || []).find((s) => s.date === NEW.dateDisp && s.slot === NEW.slot);
  if (!dest) throw new Error('no 04-Nov 11:00-12:30 sitting');
  const movers = [];
  for (const s of L.sessions || []) {
    if (s === dest) continue;
    for (const rm of s.rooms || []) {
      for (let i = rm.rows.length - 1; i >= 0; i--) if (up(rm.rows[i].course) === 'SE432') { movers.push(rm.rows[i]); rm.rows.splice(i, 1); }
    }
    s.rooms = (s.rooms || []).filter((rm) => rm.rows.length);
  }
  L.sessions = (L.sessions || []).filter((s) => (s.rooms || []).length);
  if (!movers.length) return 'SE432 already sits with CS432';
  const moved = [];
  for (const m of movers) {
    let spot = null;
    for (const pass of [0, 1]) {                       // pass 0: avoid a CS432/SE432 bench-mate
      for (const rm of dest.rooms.filter((r) => r.rows.some((x) => MATES.has(up(x.course))))) {
        const v = cap.get(rm.name); if (!v) continue;
        const nRows = v.rows || Math.ceil((v.exam_seats || 0) / 2);
        if (rm.rows.length >= (v.exam_seats || nRows * 2)) continue;
        const at = new Map(rm.rows.map((r) => [`${r.row}|${r.col}`, r]));
        for (let r = 1; r <= nRows && !spot; r++) {
          for (const col of ['L', 'R']) {
            if (at.has(`${r}|${col}`)) continue;
            const mate = at.get(`${r}|${col === 'L' ? 'R' : 'L'}`);
            if (mate && (up(mate.course) === 'SE432' || (pass === 0 && MATES.has(up(mate.course))))) continue;
            spot = { rm, row: r, col }; break;
          }
        }
        if (spot) break;
      }
      if (spot) break;
    }
    if (!spot) throw new Error(`no free seat in the CS432 rooms for ${m.sid}`);
    const seat = spot.col === 'L' ? String(spot.row) : `${spot.row}A`;
    spot.rm.rows.push({ ...m, row: spot.row, col: spot.col, seat, time: NEW.slot });
    moved.push({ sid: String(m.sid), room: spot.rm.name, seat });
  }
  const tmp = `${layoutPath}.tmp`; fs.writeFileSync(tmp, JSON.stringify(L)); fs.renameSync(tmp, layoutPath);
  for (const mv of moved) {
    const a = await AdmitVerification.findOne({ batchId: b._id, studentId: mv.sid }).lean();
    if (!a) throw new Error(`${mv.sid}: admit-card record missing`);
    const exams = (a.exams || []).map((e) => (up(e.code) !== 'SE432' ? e : {
      ...e, ...NEW, room: mv.room, seat: mv.seat, key: admitCrypto.paperKey(a.token, e.code, NEW.date, NEW.slot) }));
    await AdmitVerification.updateOne({ _id: a._id }, { $set: { exams } });
  }
  const r = await require('./sections').resectionBatch(b._id, { keepSeats: true });
  return `SE432 → Wed 04-Nov 11:00-12:30 with CS432: ${moved.map((m) => `${m.sid} ${m.room} ${m.seat}`).join(', ')} | ${r.cards || ''} cards re-printed, same QR`;
}

// Exam office (20 Oct): 7319 Alina Imdad (BS Computer Science) — one course, CS412 Natural
// Language Processing, Section A. Added to the registrations and to the ISSUED batch: a free seat
// in the room where BS Section A writes CS412, a new card appended at the end (her own QR);
// nobody else moves, every other QR stays the same.
async function addAlina7319_20261020() {
  if (!(await Setting.findOne({ key: 'once:2026-10-19.se432-with-cs432' }).lean())) throw new Error('waiting for the SE432 move');
  const crypto = require('crypto');
  const GeneratedFile = require('../models/GeneratedFile');
  const AdmitVerification = require('../models/AdmitVerification');
  const StudentRegistration = require('../models/StudentRegistration');
  const admitCrypto = require('./admitCrypto');
  const { OUTPUT_DIR } = require('./pythonRunner');
  const up = (x) => String(x || '').trim().toUpperCase();
  const SID = '7319'; const CODE = 'CS412'; const SEC = 'A';

  const reg0 = await StudentRegistration.findOne({ studentId: SID }).lean();
  const name = (reg0 && reg0.name) || 'Alina Imdad';
  const program = (reg0 && reg0.program) || 'BS Computer Science';
  const batchName = (reg0 && reg0.batch) || program;
  await StudentRegistration.updateOne({ studentId: SID },
    { $set: { name, program, batch: batchName }, $addToSet: { courses: CODE } }, { upsert: true });
  await require('./sectionPlan').setSectionOverrides({ [`${SID}|${CODE}`]: SEC });

  const b = await GeneratedFile.findOne({ kind: 'admit_cards', archived: { $ne: true } }).sort({ createdAt: -1 });
  const avs = await AdmitVerification.find({ batchId: b._id }).lean();
  if (avs.some((a) => String(a.studentId) === SID && (a.exams || []).length)) return `${SID} already has a card`;
  const cards = (b.files || []).find((f) => /admit cards/i.test(f.label || ''));
  const layoutPath = path.join(OUTPUT_DIR, path.basename(cards.filename).replace(/\.pdf$/i, '_layout.json'));
  const L = JSON.parse(fs.readFileSync(layoutPath, 'utf-8'));
  const cap = new Map((L.venues || []).map((v) => [v.name, v]));

  // the paper's sitting + its template exam entry, from a BS Section-A student already carded for it
  const tmpl = avs.flatMap((a) => (a.exams || []).map((e) => ({ a, e })))
    .find((x) => up(x.e.code) === CODE && (x.e.section || '') === SEC && /^BS /i.test(x.a.program || ''));
  if (!tmpl) throw new Error(`no BS ${CODE}-${SEC} paper in the issued cards`);
  const E = tmpl.e;
  const sess = (L.sessions || []).find((s) => s.date === E.dateDisp && s.slot === E.slot);
  if (!sess) throw new Error(`no sitting ${E.dateDisp} ${E.slot}`);
  // seat search: the BS Section-A room first (a bench-mate of another paper if possible,
  // else the last free seat there), then other rooms writing CS412, then any room of the sitting
  const findSeat = (rm, avoidSame) => {
    const v = cap.get(rm.name); if (!v) return null;
    const nRows = v.rows || Math.ceil((v.exam_seats || 0) / 2);
    if (rm.rows.length >= (v.exam_seats || nRows * 2)) return null;
    const at = new Map(rm.rows.map((r) => [`${r.row}|${r.col}`, r]));
    for (let r = 1; r <= nRows; r++) {
      for (const col of ['L', 'R']) {
        if (at.has(`${r}|${col}`)) continue;
        const mate = at.get(`${r}|${col === 'L' ? 'R' : 'L'}`);
        const same = !!(mate && up(mate.course) === CODE);
        if (avoidSame && same) continue;
        return { rm, row: r, col, same };
      }
    }
    return null;
  };
  const home = sess.rooms.find((rm) => rm.name === E.room);
  const others = sess.rooms.filter((rm) => rm !== home);
  const withCode = others.filter((rm) => rm.rows.some((r) => up(r.course) === CODE));
  let spot = (home && (findSeat(home, true) || findSeat(home, false)));
  for (const rm of withCode) { if (spot) break; spot = findSeat(rm, true); }
  for (const rm of others) { if (spot) break; spot = findSeat(rm, true) || findSeat(rm, false); }
  const sharedBench = !!(spot && spot.same);
  if (!spot) throw new Error(`no free seat for ${SID} on ${E.dateDisp} ${E.slot}`);
  const seat = spot.col === 'L' ? String(spot.row) : `${spot.row}A`;
  spot.rm.rows.push({ row: spot.row, col: spot.col, seat, sid: SID, name, program, batch: batchName, course: CODE, time: E.slot, section: SEC });
  const tmp = `${layoutPath}.tmp`; fs.writeFileSync(tmp, JSON.stringify(L)); fs.renameSync(tmp, layoutPath);

  const qid = crypto.randomBytes(8).toString('hex');
  const token = qid + admitCrypto.tokenSig(qid);
  const page = Math.max(0, ...avs.map((a) => a.cardPage || 0)) + 1;
  const sample = tmpl.a;
  const exam = { code: CODE, name: E.name, teacher: E.teacher || '', date: E.date, dateDisp: E.dateDisp, day: E.day, slot: E.slot,
    start: E.start, finish: E.finish, room: spot.rm.name, seat, section: SEC, key: admitCrypto.paperKey(token, CODE, E.date, E.slot) };
  const old = avs.find((a) => String(a.studentId) === SID);
  if (old) await AdmitVerification.updateOne({ _id: old._id }, { $set: { exams: [exam], cardPage: page, name, program, batch: batchName } });
  else {
    await AdmitVerification.create({ token, batchId: b._id, studentId: SID, name, program, batch: batchName, cardPage: page, feeStatus: 'Unpaid',
      heading: sample.heading, examType: sample.examType, semester: sample.semester, year: sample.year, exams: [exam] });
  }
  const r = await require('./sections').resectionBatch(b._id, { keepSeats: true });
  await GeneratedFile.updateOne({ _id: b._id }, { $set: { 'summary.admitCards': page } });
  return `${SID} ${name}: ${CODE}-${SEC} ${E.dateDisp} ${E.slot} → ${spot.rm.name} seat ${seat}${sharedBench ? ' (room full — only seat left, next to a CS412 student)' : ''}; card page ${page}, own QR | ${r.cards || page} cards re-printed, nobody else moved`;
}

// Add one student to the ISSUED batch for the given papers: each paper keeps its datesheet sitting,
// goes to a free seat (same room / section as that paper first, never beside the same paper if
// avoidable), a new card is appended at the end with the student's own QR; nobody else moves.
async function addStudentToBatch({ sid, name, program, batch, papers }) {
  const crypto = require('crypto');
  const GeneratedFile = require('../models/GeneratedFile');
  const AdmitVerification = require('../models/AdmitVerification');
  const StudentRegistration = require('../models/StudentRegistration');
  const admitCrypto = require('./admitCrypto');
  const { OUTPUT_DIR } = require('./pythonRunner');
  const up = (x) => String(x || '').trim().toUpperCase();
  sid = String(sid);

  const reg0 = await StudentRegistration.findOne({ studentId: sid }).lean();
  name = (reg0 && reg0.name) || name; program = (reg0 && reg0.program) || program; batch = (reg0 && reg0.batch) || batch || program;
  await StudentRegistration.updateOne({ studentId: sid },
    { $set: { name, program, batch }, $addToSet: { courses: { $each: papers.map((p) => up(p.code)) } } }, { upsert: true });

  const b = await GeneratedFile.findOne({ kind: 'admit_cards', archived: { $ne: true } }).sort({ createdAt: -1 });
  const avs = await AdmitVerification.find({ batchId: b._id }).lean();
  const mine = avs.find((a) => String(a.studentId) === sid);
  if (mine && (mine.exams || []).length) return `${sid} already has a card`;
  const cards = (b.files || []).find((f) => /admit cards/i.test(f.label || ''));
  const layoutPath = path.join(OUTPUT_DIR, path.basename(cards.filename).replace(/\.pdf$/i, '_layout.json'));
  const L = JSON.parse(fs.readFileSync(layoutPath, 'utf-8'));
  const cap = new Map((L.venues || []).map((v) => [v.name, v]));
  const findSeat = (rm, code, avoidSame) => {
    const v = cap.get(rm.name); if (!v) return null;
    const nRows = v.rows || Math.ceil((v.exam_seats || 0) / 2);
    if (rm.rows.length >= (v.exam_seats || nRows * 2)) return null;
    const at = new Map(rm.rows.map((r) => [`${r.row}|${r.col}`, r]));
    for (let r = 1; r <= nRows; r++) {
      for (const col of ['L', 'R']) {
        if (at.has(`${r}|${col}`)) continue;
        const mate = at.get(`${r}|${col === 'L' ? 'R' : 'L'}`);
        const same = !!(mate && up(mate.course) === code);
        if (avoidSame && same) continue;
        return { rm, row: r, col, same };
      }
    }
    return null;
  };

  const exams = []; const notes = []; const skipped = [];
  const taken = new Set();
  for (const p of papers) {
    const code = up(p.code);
    const all = avs.flatMap((a) => (a.exams || []).map((e) => ({ a, e }))).filter((x) => up(x.e.code) === code);
    if (!all.length) { skipped.push(code); continue; }                     // no paper in the mids
    const hasSec = all.some((x) => x.e.section);
    const sec = hasSec ? up(p.section || '') : '';
    const t = (sec && all.find((x) => (x.e.section || '') === sec)) || all.find((x) => !sec || !x.e.section) || all[0];
    const E = t.e;
    if (taken.has(`${E.date}|${E.slot}`)) notes.push(`${code} clashes with another of her papers`);
    taken.add(`${E.date}|${E.slot}`);
    const sess = (L.sessions || []).find((s) => s.date === E.dateDisp && s.slot === E.slot);
    if (!sess) throw new Error(`${code}: no sitting ${E.dateDisp} ${E.slot}`);
    const rooms = sess.rooms.filter((rm) => rm.rows.some((r) => up(r.course) === code && (!sec || (r.section || '') === sec)));
    const rest = sess.rooms.filter((rm) => !rooms.includes(rm));
    let spot = null;
    for (const rm of rooms) { spot = spot || findSeat(rm, code, true); }
    for (const rm of rest) { spot = spot || findSeat(rm, code, true); }
    for (const rm of rooms) { spot = spot || findSeat(rm, code, false); }
    if (!spot) throw new Error(`${code}: no free seat on ${E.dateDisp} ${E.slot}`);
    const seat = spot.col === 'L' ? String(spot.row) : `${spot.row}A`;
    spot.rm.rows.push({ row: spot.row, col: spot.col, seat, sid, name, program, batch, course: code, time: E.slot, ...(sec ? { section: sec } : {}) });
    if (sec) await require('./sectionPlan').setSectionOverrides({ [`${sid}|${code}`]: sec });
    exams.push({ code, name: E.name, teacher: E.teacher || '', date: E.date, dateDisp: E.dateDisp, day: E.day, slot: E.slot,
      start: E.start, finish: E.finish, room: spot.rm.name, seat, section: sec });
    notes.push(`${code} ${E.dateDisp} ${E.slot} → ${spot.rm.name} ${seat}${sec ? ` (Sec ${sec})` : ''}${spot.same ? ' [beside same paper]' : ''}`);
  }
  if (!exams.length) return `${sid}: none of the papers is in the mids (${skipped.join(', ')})`;
  const tmp = `${layoutPath}.tmp`; fs.writeFileSync(tmp, JSON.stringify(L)); fs.renameSync(tmp, layoutPath);
  const qid = crypto.randomBytes(8).toString('hex');
  const token = (mine && mine.token) || (qid + admitCrypto.tokenSig(qid));
  const page = Math.max(0, ...avs.map((a) => a.cardPage || 0)) + 1;
  const keyed = exams.map((e) => ({ ...e, key: admitCrypto.paperKey(token, e.code, e.date, e.slot) }));
  const sample = avs.find((a) => a.heading) || avs[0];
  if (mine) await AdmitVerification.updateOne({ _id: mine._id }, { $set: { exams: keyed, cardPage: page, name, program, batch } });
  else await AdmitVerification.create({ token, batchId: b._id, studentId: sid, name, program, batch, cardPage: page, feeStatus: FEE_VERIFIED,
    heading: sample.heading, examType: sample.examType, semester: sample.semester, year: sample.year, exams: keyed });
  const r = await require('./sections').resectionBatch(b._id, { keepSeats: true });
  await GeneratedFile.updateOne({ _id: b._id }, { $set: { 'summary.admitCards': page } });
  return `${sid} ${name}: card page ${page}, own QR | ${notes.join(' | ')}${skipped.length ? ` | no mid paper (left out): ${skipped.join(', ')}` : ''} | ${r.cards || page} cards re-printed, nobody else moved`;
}

// Exam office (21 Oct): 11652 Eman Ghouri (Fall 2026, DPT) — her courses, Section A.
async function addEman11652_20261021() {
  if (!(await Setting.findOne({ key: 'once:2026-10-20.add-7319-cs412-a' }).lean())) throw new Error('waiting for 7319');
  return addStudentToBatch({ sid: '11652', name: 'Eman Ghouri', program: 'Doctor of Physical Therapy', batch: 'Doctor of Physical Therapy Fall 2026',
    papers: ['DP203', 'DP204', 'DP201', 'MT210', 'SS121', 'SS130', 'DP208'].map((code) => ({ code, section: 'A' })) });
}

// Exam office (22 Oct): fees were checked by hand — every admit card now shows
// "Paid (Verified Manually)" on a scan (app + web). Only the fee text changes:
// QR tokens, papers, rooms and seats are untouched.
const FEE_VERIFIED = 'Paid (Verified Manually)';
async function feePaidManual20261022() {
  const AdmitVerification = require('../models/AdmitVerification');
  const r = await AdmitVerification.updateMany({ feeStatus: { $ne: FEE_VERIFIED } }, { $set: { feeStatus: FEE_VERIFIED } });
  const n = r.modifiedCount != null ? r.modifiedCount : r.nModified;
  return `${n} admit card(s) set to "${FEE_VERIFIED}"`;
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
  ['2026-10-16.mark-sections', markSections20261016],
  ['2026-10-16.card-instructions', cardInstructions20261016],
  ['2026-10-16.roster-format', rosterFormat20261016],
  ['2026-10-16.instructions-under-table', instructionsUnderTable20261016],
  ['2026-10-19.drop-fall26-first-semester', dropFall26Courses20261019],
  ['2026-10-19.add-lateral-students', addLateralStudents20261019],
  ['2026-10-19.restore-ss108-ss118-mt129-ss216', restoreFourCourses20261019],
  ['2026-10-19.se432-with-cs432', se432WithCs432_20261019],
  ['2026-10-20.add-7319-cs412-a', addAlina7319_20261020],
  ['2026-10-22.fee-paid-verified-manually', feePaidManual20261022],
  // ['2026-10-21.add-11652-eman', addEman11652_20261021],   // ON HOLD (exam office, 21 Oct) — enable when told
];

// ONE_TIME_TASKS (env) — which tasks this server may run:
//   unset / 'all' → every pending task (the office PC)
//   'off'         → none
//   'key1,key2'   → only these keys (e.g. a hosted server sharing a live database)
function allowedTask(key) {
  const v = String(process.env.ONE_TIME_TASKS || 'all').trim();
  if (!v || v.toLowerCase() === 'all') return true;
  if (v.toLowerCase() === 'off') return false;
  return v.split(',').map((x) => x.trim()).includes(key);
}

async function runOneTimeTasks() {
  for (const [key, fn] of TASKS) {
    if (!allowedTask(key)) continue;
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
