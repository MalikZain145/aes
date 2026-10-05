/**
 * keepLatestDatesheets.js — show what is in the DB, then keep ONLY the latest
 * datesheet run per program (BS · B.Tech, and MS with --keep-ms) and remove every
 * older datesheet + ALL admit-card batches (with their QR verification records and
 * their files on disk).
 *
 *   node scripts/keepLatestDatesheets.js            # DRY RUN — only lists, deletes nothing
 *   node scripts/keepLatestDatesheets.js --apply    # actually delete
 *   node scripts/keepLatestDatesheets.js --apply --keep-ms   # also keep the latest MS sheet
 *   node scripts/keepLatestDatesheets.js --apply --exam mids # only look at mid-term sheets
 *
 * A "run" = all sheets of one cohort created in one Generate click (department-split
 * BS PDFs are created within seconds of each other), so a split BS run is kept whole.
 * Archived (Previous Semesters) records are never touched.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const GeneratedFile = require('../models/GeneratedFile');
const AdmitVerification = require('../models/AdmitVerification');

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'scheduler', 'output');
const APPLY = process.argv.includes('--apply');
const KEEP_MS = process.argv.includes('--keep-ms');
const examIdx = process.argv.indexOf('--exam');
const EXAM = examIdx > -1 ? process.argv[examIdx + 1] : null;
const RUN_WINDOW_MS = 20 * 60 * 1000;   // sheets of one Generate click

const isPG = (p) => /( ms | mphil |mphil| master| mba | msc |postgrad| pgd | phd )/.test(' ' + String(p || '').toLowerCase().replace(/[.\-]/g, ' ') + ' ');
function cohortOf(d) {
  const m = d.meta || {};
  if (m.btech || m.cohort === 'btech') return 'btech';
  if (/post/i.test(m.programLevel || '') || m.cohort === 'pg' || isPG(d.title)) return 'pg';
  return 'bs';
}
const fmt = (d) => `${new Date(d.createdAt).toLocaleString('en-GB')}  [${cohortOf(d).toUpperCase()}] ${d.examType}  ${d.title}`;

function removeFiles(rec) {
  let n = 0;
  const names = (rec.files || []).map((f) => f.filename);
  if (rec.meta && rec.meta.scheduleFile) names.push(rec.meta.scheduleFile);
  if (rec.meta && rec.meta.verifyFile) names.push(rec.meta.verifyFile);
  for (const nm of names) {
    const p = path.join(OUTPUT_DIR, path.basename(String(nm || '')));
    try { if (nm && fs.existsSync(p)) { fs.unlinkSync(p); n++; } } catch { /* ignore */ }
  }
  return n;
}

async function main() {
  await connectDB(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/abasyn_scheduler');
  const q = { kind: 'datesheet', archived: { $ne: true } };
  if (EXAM) q.examType = EXAM;
  const sheets = await GeneratedFile.find(q).sort({ createdAt: -1 }).lean();
  const admits = await GeneratedFile.find({ kind: 'admit_cards', archived: { $ne: true } }).sort({ createdAt: -1 }).lean();

  console.log(`\nDatesheets in DB (${sheets.length}):`);
  sheets.forEach((d) => console.log('  ' + fmt(d)));
  console.log(`Admit-card batches in DB: ${admits.length}`);

  const keep = new Set();
  const cohorts = KEEP_MS ? ['bs', 'btech', 'pg'] : ['bs', 'btech'];
  for (const c of cohorts) {
    const list = sheets.filter((d) => cohortOf(d) === c);
    if (!list.length) { console.log(`\n⚠ No ${c.toUpperCase()} datesheet found in the DB — generate it again.`); continue; }
    const newest = new Date(list[0].createdAt).getTime();
    list.filter((d) => newest - new Date(d.createdAt).getTime() <= RUN_WINDOW_MS && d.examType === list[0].examType)
      .forEach((d) => keep.add(String(d._id)));
  }
  const dropSheets = sheets.filter((d) => !keep.has(String(d._id)));

  console.log(`\nKEEP (${keep.size}):`);
  sheets.filter((d) => keep.has(String(d._id))).forEach((d) => console.log('  ✓ ' + fmt(d)));
  console.log(`REMOVE: ${dropSheets.length} datesheet(s) + ${admits.length} admit-card batch(es)`);

  if (!APPLY) {
    console.log('\nDry run — nothing deleted. Run again with --apply to delete.\n');
    await mongoose.disconnect();
    return;
  }
  let files = 0;
  for (const d of [...dropSheets, ...admits]) files += removeFiles(d);
  const ids = [...dropSheets, ...admits].map((d) => d._id);
  const del = await GeneratedFile.deleteMany({ _id: { $in: ids } });
  const qr = await AdmitVerification.deleteMany({ batchId: { $in: admits.map((a) => a._id) } });
  console.log(`\n✓ Removed ${del.deletedCount} record(s), ${qr.deletedCount} QR record(s), ${files} file(s). Kept ${keep.size} datesheet(s).\n`);
  await mongoose.disconnect();
}
main().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
