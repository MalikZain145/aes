/**
 * importFaculty.js — load the faculty rosters (see utils/facultyImport.js).
 *
 *   node scripts/importFaculty.js                                  # files in data/imports/2026-10-14/
 *   node scripts/importFaculty.js --list Faculty_List.xlsx --all All_Faculity.xlsx
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const DIR = path.join(__dirname, '..', 'data', 'imports', '2026-10-14');

(async () => {
  const pick = (rx) => { if (!fs.existsSync(DIR)) return null; const f = fs.readdirSync(DIR).find((x) => rx.test(x)); return f ? path.join(DIR, f) : null; };
  const facultyList = arg('--list') || pick(/^Faculty_List\.xlsx$/i);
  const allFaculty = arg('--all') || pick(/^All_Facul.*\.xlsx$/i);
  if (!facultyList && !allFaculty) throw new Error('No faculty files found. Pass --list and/or --all.');
  await require('../config/db')(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/abasyn_scheduler');
  await require('../utils/facultyImport').importFaculty({ facultyList, allFaculty });
  await mongoose.disconnect();
})().catch(async (e) => { console.error('✗', e.message); try { await mongoose.disconnect(); } catch { /* ignore */ } process.exit(1); });
