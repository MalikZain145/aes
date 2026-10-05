/**
 * importOffering.js — load a STUDENT-WISE "Course Registration Report" (the
 * Summer offering) into the database as Courses + Teachers (+ StudentRegistrations),
 * so a timetable / datesheet can be generated on it.
 *
 * The normal Import Data flow parses this shape too, but leaves every teacher as
 * "TBA" (the registration report has no faculty column). This script fills the
 * teacher in by MATCHING each course code against the teachers already in the DB
 * (e.g. from the previous timetable dataset), falling back to "TBA".
 *
 * Usage:
 *   node scripts/importOffering.js "<path to .xls/.xlsx>" --term "Summer 2025" --replace
 *
 *   --replace   wipe existing courses + student registrations first (recommended,
 *               so the timetable reflects only this offering). Teachers are kept.
 *   --term      academic term label stored on each course (default "Summer 2025").
 *
 * Existing courses are recoverable any time with:  npm run seed
 */
require('dotenv').config();
const path = require('path');
const mongoose = require('mongoose');

const connectDB = require('../config/db');
const Course = require('../models/Course');
const Teacher = require('../models/Teacher');
const StudentRegistration = require('../models/StudentRegistration');
const { parseDataset } = require('../utils/datasetImporter');

const args = process.argv.slice(2);
const REPLACE = args.includes('--replace');
const termIdx = args.indexOf('--term');
const TERM = termIdx >= 0 ? args[termIdx + 1] : 'Summer 2025';
const filePath = args.find((a) => /\.(xlsx|xls)$/i.test(a))
  || 'C:/Users/malik/Downloads/Course_Registration_Report(25).xls';

function extractCode(raw) {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  const m = s.match(/^([A-Za-z]{2,6}[-\s]?\d{3,4})/);
  return m ? m[1].replace(/\s/g, '').toUpperCase() : (s.split(/[\s-]/)[0] || '').toUpperCase();
}

async function main() {
  const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/abasyn_scheduler';
  await connectDB(MONGO_URI);

  console.log(`\nImporting offering from:\n  ${filePath}\n  term: "${TERM}"  replace: ${REPLACE}\n`);

  // 1) Snapshot the teacher currently assigned to each course code (before any wipe).
  const existing = await Course.find({}).lean();
  const teacherByCode = {};
  for (const c of existing) {
    const code = extractCode(c.code || c.fullCode);
    if (c.teacher && c.teacher !== 'TBA' && !teacherByCode[code]) teacherByCode[code] = c.teacher;
  }
  console.log(`• Found ${existing.length} existing courses; ${Object.keys(teacherByCode).length} codes carry a named teacher.`);

  // 2) Parse the registration report (auto-detects the student-wise shape).
  const parsed = parseDataset(filePath);
  const courses = parsed.courses || [];
  const regs = parsed.studentRegistrations || [];
  if (!courses.length) throw new Error('No courses parsed from the file. Is it the Course Registration Report?');

  // 3) Assign teachers by code match; keep fullCodes unique; stamp the term.
  const usedFull = new Set();
  let matched = 0;
  const toInsert = courses.map((c) => {
    const code = extractCode(c.code);
    const teacher = teacherByCode[code] || 'TBA';
    if (teacher !== 'TBA') matched++;
    let fullCode = (c.fullCode || code).toString();
    while (usedFull.has(fullCode)) fullCode = `${fullCode}_x`;
    usedFull.add(fullCode);
    return {
      fullCode,
      code,
      name: c.name,
      component: c.component || 'Lecture',
      section: c.section || '',
      programBatch: c.programBatch || '',
      program: c.program || '',
      academicTerm: TERM,
      teacher,
      enrolled: c.enrolled || 0,
      creditHours: c.creditHours || 3,
      active: true,
    };
  });

  // 4) Make sure every named teacher exists in the Teacher collection.
  const teacherNames = [...new Set(toInsert.map((c) => c.teacher).filter((t) => t && t !== 'TBA'))];
  let tCreated = 0;
  for (const name of teacherNames) {
    const exists = await Teacher.findOne({ name });
    if (!exists) { await Teacher.create({ name }); tCreated++; }
  }

  // 5) Write.
  if (REPLACE) {
    const [dc, dr] = await Promise.all([
      Course.deleteMany({}),
      StudentRegistration.deleteMany({}),
    ]);
    console.log(`• Cleared ${dc.deletedCount} old courses and ${dr.deletedCount} old student registrations (teachers kept).`);
  }
  await Course.insertMany(toInsert, { ordered: false });
  if (regs.length) {
    await StudentRegistration.insertMany(
      regs.map((r) => ({ studentId: r.studentId, batch: r.batch, courses: r.courses })),
      { ordered: false }
    );
  }

  const totalStudents = regs.length;
  const secCourses = toInsert.filter((c) => c.section).length;
  console.log(`\n✓ Offering imported for "${TERM}":`);
  console.log(`  • Courses:  ${toInsert.length} inserted  (${secCourses} are auto-sectioned parts of large classes)`);
  console.log(`  • Teachers: ${matched}/${toInsert.length} course-parts matched a named teacher; ${tCreated} new teacher record(s) created.`);
  console.log(`  • Student registrations: ${totalStudents} stored (enables clash-free datesheets/admit cards from the DB).`);
  console.log('\n  You can now generate the timetable on this data. To restore the previous dataset: npm run seed\n');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
