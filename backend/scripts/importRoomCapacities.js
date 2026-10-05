/**
 * importRoomCapacities.js — load per-room CLASS and EXAM capacities from the
 * "Classes Report" spreadsheet into the Room collection.
 *
 *   Room.capacity      = class capacity   (e.g. 60)
 *   Room.examCapacity  = exam capacity    (e.g. 42)  → students the room seats
 *                                                       in an exam (2 columns).
 *
 * File columns: "Class No" | "For Classes" | "For Exam"  (e.g. j.209 | 60 | 42)
 * Room names are normalised: "j.209" → "J209" to match the DB.
 * Labs are left untouched.
 *
 * Usage: node scripts/importRoomCapacities.js "C:/path/Classes Report.xlsx"
 */
require('dotenv').config();
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const connectDB = require('../config/db');
const Room = require('../models/Room');

const normRoom = (n) => String(n).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
const numOf = (s) => { const m = String(s).match(/\d+/); return m ? Number(m[0]) : null; };

function parseFile(file) {
  const wb = XLSX.readFile(file);
  const out = [];
  for (const sn of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' });
    for (const r of rows) {
      const c0 = String(r[0] || '').trim();
      if (!c0 || /block/i.test(c0) || /class ?no/i.test(c0)) continue;
      if (!/^[a-z]\.?\s?\d/i.test(c0)) continue;
      const cls = numOf(r[1]); const exam = numOf(r[2]);
      if (cls || exam) out.push({ room: normRoom(c0), cls, exam });
    }
  }
  return out;
}

async function main() {
  const file = process.argv.find((a) => /\.xlsx?$/i.test(a))
    || 'C:/Users/malik/Downloads/Classes Report.xlsx';
  await connectDB(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/abasyn_scheduler');

  const items = parseFile(file);
  console.log(`\nParsed ${items.length} room capacities from:\n  ${file}\n`);

  let updated = 0, created = 0, missing = [];
  for (const it of items) {
    const set = {};
    if (it.cls) set.capacity = it.cls;
    if (it.exam) set.examCapacity = it.exam;
    const room = await Room.findOne({ name: it.room });
    if (room) {
      Object.assign(room, set);
      await room.save();
      updated++;
    } else {
      // create it (theory room) so its exam capacity is available for seating
      await Room.create({ name: it.room, capacity: it.cls || it.exam || 30, examCapacity: it.exam || null, building: it.room[0] === 'J' ? 'J Block' : 'I Block' });
      created++;
      missing.push(it.room);
    }
  }
  console.log(`✓ Rooms updated: ${updated}, created: ${created}`);
  if (missing.length) console.log(`  (created because not present: ${missing.join(', ')})`);
  const withExam = await Room.countDocuments({ examCapacity: { $ne: null, $gt: 0 } });
  console.log(`  Rooms with an exam capacity now: ${withExam}\n`);

  await mongoose.disconnect();
  process.exit(0);
}
main().catch((e) => { console.error('Import failed:', e.message); process.exit(1); });
