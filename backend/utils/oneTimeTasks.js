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

const TASKS = [
  ['2026-10-12.clear-timetables', clearTimetables],
  ['2026-10-12.staff-usernames', staffUsernames],
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
