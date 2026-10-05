/**
 * Hard reset — wipes ALL courses, teachers, rooms, labs and reseeds fresh.
 * No flags needed. Just run:   node scripts/reset.js
 *
 * The admin account is preserved. Use this whenever the database has
 * duplicate or stale data and you want a clean, single copy.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');

const connectDB = require('../config/db');
const Admin = require('../models/Admin');
const Room = require('../models/Room');
const Lab = require('../models/Lab');
const Teacher = require('../models/Teacher');
const Course = require('../models/Course');
const GeneratedFile = require('../models/GeneratedFile');

const path = require('path');
const { THEORY_ROOMS, LABS } = require('../config/defaultRoomsLabs');
const { parseDataset } = require('../utils/datasetImporter');

async function main() {
  const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/abasyn_scheduler';
  await connectDB(MONGO_URI);

  console.log('\n🧹  HARD RESET — clearing all data (Admin kept)…\n');

  // ── Delete every generated datesheet / timetable / report PDF from disk ──
  const OUTPUT_DIR = path.join(__dirname, '..', '..', 'scheduler', 'output');
  let filesDeleted = 0;
  try {
    const records = await GeneratedFile.find({}).lean();
    for (const rec of records) {
      for (const f of rec.files || []) {
        const p = path.join(OUTPUT_DIR, f.filename);
        try { if (fs.existsSync(p)) { fs.unlinkSync(p); filesDeleted++; } } catch { /* ignore */ }
      }
    }
    // also sweep any leftover PDFs/JSON in the output dir (keep .gitkeep)
    if (fs.existsSync(OUTPUT_DIR)) {
      for (const name of fs.readdirSync(OUTPUT_DIR)) {
        if (name === '.gitkeep') continue;
        if (/\.(pdf|xlsx|json)$/i.test(name)) {
          try { fs.unlinkSync(path.join(OUTPUT_DIR, name)); } catch { /* ignore */ }
        }
      }
    }
  } catch (err) {
    console.log(`• Could not sweep output files — ${err.message}`);
  }

  const [c, t, r, l, g] = await Promise.all([
    Course.deleteMany({}),
    Teacher.deleteMany({}),
    Room.deleteMany({}),
    Lab.deleteMany({}),
    GeneratedFile.deleteMany({}),
  ]);
  console.log(`   Deleted: ${c.deletedCount} courses, ${t.deletedCount} teachers, ${r.deletedCount} rooms, ${l.deletedCount} labs.`);
  console.log(`   Deleted: ${g.deletedCount} generated datesheets/timetables (${filesDeleted} PDF/Excel files removed from disk).\n`);

  // ── Reseed rooms ──
  for (const room of THEORY_ROOMS) {
    const building = room.name.startsWith('I') ? 'I Block' : room.name.startsWith('J') ? 'J Block' : '';
    await Room.create({ name: room.name, capacity: room.capacity, building });
  }
  console.log(`✓ Rooms: ${THEORY_ROOMS.length} created.`);

  // ── Reseed labs ──
  for (const lab of LABS) {
    await Lab.create({ name: lab.name, capacity: lab.capacity, departments: lab.departments });
  }
  console.log(`✓ Labs: ${LABS.length} created.`);

  // ── Reseed teachers + courses from dataset ──
  const datasetPath = path.join(__dirname, '..', '..', 'scheduler', 'timetable-dataset.xlsx');
  let parsed;
  try {
    parsed = parseDataset(datasetPath);
  } catch (err) {
    console.log(`• Could not read dataset — ${err.message}`);
    await mongoose.disconnect();
    process.exit(0);
  }

  const { courses, teachers } = parsed;

  for (const teacher of teachers) {
    await Teacher.create({ name: teacher.name, email: teacher.email || '', facultyId: teacher.facultyId || '' });
  }
  console.log(`✓ Teachers: ${teachers.length} created (with emails/IDs).`);

  const autoSec = courses.filter((x) => x.autoSectioned).length;
  for (const course of courses) {
    await Course.create(course);
  }
  console.log(`✓ Courses: ${courses.length} created (${autoSec} from auto-sectioning).`);

  // Ensure admin exists
  const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  let admin = await Admin.findOne({ username });
  if (!admin) {
    admin = new Admin({ username, displayName: 'Super Admin' });
    await admin.setPassword(password);
    await admin.save();
    console.log(`✓ Admin created — "${username}" / "${password}"`);
  } else {
    console.log(`• Admin "${username}" kept.`);
  }

  console.log('\n✓ Database reset complete — clean single copy of all data.\n');
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Reset failed:', err);
  process.exit(1);
});
