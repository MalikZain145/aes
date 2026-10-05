/**
 * clearGenerated.js — wipe ALL previously generated timetables, datesheets,
 * admit cards and clash reports from the database (and their QR verification
 * records + output files on disk), so you can start fresh.
 *
 *   node scripts/clearGenerated.js            # clear everything
 *   node scripts/clearGenerated.js admit_cards  # clear one kind only
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const GeneratedFile = require('../models/GeneratedFile');
const AdmitVerification = require('../models/AdmitVerification');

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'scheduler', 'output');
const kind = process.argv.find((a) => ['timetable', 'datesheet', 'admit_cards', 'clash_report'].includes(a));

async function main() {
  await connectDB(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/abasyn_scheduler');
  const q = kind ? { kind } : {};
  const records = await GeneratedFile.find(q).lean();
  let removed = 0;
  for (const rec of records) {
    for (const f of (rec.files || [])) {
      const p = path.join(OUTPUT_DIR, path.basename(f.filename));
      try { if (fs.existsSync(p)) { fs.unlinkSync(p); removed++; } } catch { /* ignore */ }
    }
    if (rec.meta && rec.meta.scheduleFile) {
      const p = path.join(OUTPUT_DIR, path.basename(rec.meta.scheduleFile));
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
    }
  }
  const del = await GeneratedFile.deleteMany(q);
  const qr = (!kind || kind === 'admit_cards') ? await AdmitVerification.deleteMany({}) : { deletedCount: 0 };
  console.log(`\n✓ Cleared ${del.deletedCount} generated record(s)${kind ? ` (kind: ${kind})` : ''}, `
    + `${qr.deletedCount} QR verification record(s), ${removed} output file(s) removed.\n`);
  await mongoose.disconnect();
  process.exit(0);
}
main().catch((e) => { console.error('Clear failed:', e.message); process.exit(1); });
