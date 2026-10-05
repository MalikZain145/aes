/**
 * Seed script — run once after install:  npm run seed
 *
 * Creates:
 *   • the single admin account (from .env)
 *   • rooms & labs from defaultRoomsLabs.js
 *   • teachers + courses parsed from timetable-dataset.xlsx (if present)
 *
 * Safe to re-run: it upserts rooms/labs and skips existing courses.
 * Use  npm run seed -- --fresh  to wipe collections first.
 */
require('dotenv').config();
const path = require('path');
const mongoose = require('mongoose');

const connectDB = require('../config/db');
const User = require('../models/User');
const Room = require('../models/Room');
const Lab = require('../models/Lab');
const Teacher = require('../models/Teacher');
const Course = require('../models/Course');

const { THEORY_ROOMS, LABS } = require('../config/defaultRoomsLabs');
const { parseDataset } = require('../utils/datasetImporter');
const { extractTeacher } = require('../utils/programMap');

const FRESH = process.argv.includes('--fresh');

// Staff portal accounts (students are created later via upload).
const STAFF_ACCOUNTS = [
  { role: 'admin',   username: 'examcell.abasynisb.edu.pk', password: 'admin123',   name: 'Exam Cell',      email: 'examcell@abasynisb.edu.pk' },
  { role: 'finance', username: 'finance@abasynisb.edu.pk',  password: 'finance123', name: 'Finance Office', email: 'finance@abasynisb.edu.pk' },
  { role: 'faculty', username: 'faculty@abasynisb.edu.pk',  password: 'faculty123', name: 'Faculty',        email: 'faculty@abasynisb.edu.pk' },
];

async function seedUsers() {
  for (const a of STAFF_ACCOUNTS) {
    let u = await User.findOne({ username: a.username });
    if (!u) {
      u = new User({ role: a.role, username: a.username, name: a.name, email: a.email });
      await u.setPassword(a.password);
      await u.save();
      console.log(`✓ ${a.role} account created — "${a.username}"  password: "${a.password}"`);
    } else {
      console.log(`• ${a.role} account "${a.username}" already exists — skipped.`);
    }
  }
  console.log('  ⚠  Change these default passwords for production.');
}

async function seedRooms() {
  let created = 0;
  for (const r of THEORY_ROOMS) {
    const exists = await Room.findOne({ name: r.name });
    if (!exists) {
      const building = r.name.startsWith('I') ? 'I Block' : r.name.startsWith('J') ? 'J Block' : '';
      await Room.create({ name: r.name, capacity: r.capacity, building });
      created++;
    }
  }
  console.log(`✓ Rooms: ${created} created, ${THEORY_ROOMS.length - created} already present.`);
}

async function seedLabs() {
  let created = 0;
  for (const l of LABS) {
    const exists = await Lab.findOne({ name: l.name });
    if (!exists) {
      await Lab.create({ name: l.name, capacity: l.capacity, departments: l.departments });
      created++;
    }
  }
  console.log(`✓ Labs: ${created} created, ${LABS.length - created} already present.`);
}

async function seedCoursesAndTeachers() {
  const datasetPath = path.join(__dirname, '..', '..', 'scheduler', 'timetable-dataset.xlsx');
  let parsed;
  try {
    parsed = parseDataset(datasetPath);
  } catch (err) {
    console.log(`• Skipping course import — ${err.message}`);
    return;
  }

  const { courses, teachers } = parsed;

  // Teachers (with email + facultyId pulled from the dataset)
  let tCreated = 0;
  for (const t of teachers) {
    const exists = await Teacher.findOne({ name: t.name });
    if (!exists) {
      await Teacher.create({ name: t.name, email: t.email || '', facultyId: t.facultyId || '' });
      tCreated++;
    } else {
      // Backfill email/id if they were missing
      let changed = false;
      if (!exists.email && t.email) { exists.email = t.email; changed = true; }
      if (!exists.facultyId && t.facultyId) { exists.facultyId = t.facultyId; changed = true; }
      if (changed) await exists.save();
    }
  }
  console.log(`✓ Teachers: ${tCreated} created, ${teachers.length - tCreated} already present (emails/IDs included).`);

  // Courses (including any auto-created sections)
  let cCreated = 0;
  let cSkipped = 0;
  const autoSec = courses.filter((c) => c.autoSectioned).length;
  for (const r of courses) {
    const exists = await Course.findOne({ fullCode: r.fullCode });
    if (exists) {
      cSkipped++;
      continue;
    }
    await Course.create(r);
    cCreated++;
  }
  console.log(`✓ Courses: ${cCreated} created, ${cSkipped} already present (${autoSec} from auto-sectioning of large classes).`);
}

async function main() {
  const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/abasyn_scheduler';
  await connectDB(MONGO_URI);

  if (FRESH) {
    console.log('🧹  --fresh mode: clearing all data (Admin account kept)…\n');
    const [r, l, t, c] = await Promise.all([
      Room.deleteMany({}),
      Lab.deleteMany({}),
      Teacher.deleteMany({}),
      Course.deleteMany({}),
    ]);
    console.log(`   Deleted: ${c.deletedCount} courses, ${t.deletedCount} teachers, ${r.deletedCount} rooms, ${l.deletedCount} labs.`);
    console.log('   Database is now clean. Reseeding fresh…\n');
  }

  console.log('\nSeeding Abasyn Scheduler…\n');
  await seedUsers();
  await seedRooms();
  await seedLabs();
  await seedCoursesAndTeachers();

  console.log('\n✓ Seed complete.\n');
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
