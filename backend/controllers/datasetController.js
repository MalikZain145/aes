const fs = require('fs');
const path = require('path');
const os = require('os');

const Course = require('../models/Course');
const Teacher = require('../models/Teacher');
const StudentRegistration = require('../models/StudentRegistration');
const { parseDataset } = require('../utils/datasetImporter');
const { logActivity } = require('../utils/logger');

/**
 * POST /api/dataset/upload   (multipart, field "dataset")
 * Body (optional): replace=true|false  — if true, wipe existing courses+teachers first.
 *
 * Parses the uploaded .xlsx (same format as the bundled dataset) and imports
 * courses + teachers (with emails / faculty IDs) into MongoDB. After this the
 * scheduler can generate timetables and datesheets from the new data with no
 * Excel file involved at generation time.
 */
exports.uploadDataset = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Attach an .xlsx dataset.' });
  }

  const tmpPath = req.file.path;
  const replace = String(req.body.replace) === 'true';

  try {
    // Parse first so a bad file doesn't wipe the DB
    let parsed;
    try {
      parsed = parseDataset(tmpPath);
    } catch (err) {
      return res.status(400).json({ error: `Could not read the dataset: ${err.message}` });
    }

    const { courses, teachers, studentRegistrations = [] } = parsed;
    if (!courses.length) {
      return res.status(400).json({ error: 'No valid courses found. Check the column format matches the sample dataset.' });
    }

    if (replace) {
      await Promise.all([Course.deleteMany({}), Teacher.deleteMany({}), StudentRegistration.deleteMany({})]);
    }

    // Teachers
    let tCreated = 0;
    for (const t of teachers) {
      const exists = await Teacher.findOne({ name: t.name });
      if (!exists) {
        await Teacher.create({ name: t.name, email: t.email || '', facultyId: t.facultyId || '' });
        tCreated++;
      } else {
        let changed = false;
        if (!exists.email && t.email) { exists.email = t.email; changed = true; }
        if (!exists.facultyId && t.facultyId) { exists.facultyId = t.facultyId; changed = true; }
        if (changed) await exists.save();
      }
    }

    // Courses
    let cCreated = 0;
    let cSkipped = 0;
    const autoSec = courses.filter((c) => c.autoSectioned).length;
    for (const r of courses) {
      const exists = await Course.findOne({ fullCode: r.fullCode });
      if (exists) { cSkipped++; continue; }
      await Course.create({
        fullCode: r.fullCode, code: r.code, name: r.name, component: r.component,
        section: r.section, programBatch: r.programBatch, program: r.program,
        academicTerm: r.academicTerm, teacher: r.teacher, enrolled: r.enrolled,
        creditHours: r.creditHours,
        ...(r.department ? { department: r.department } : {}),
        ...(r.level ? { level: r.level } : {}),
        noExam: !!r.noExam, noTimetable: !!r.noTimetable,
      });
      cCreated++;
    }

    // Student registrations (per-student name + program + courses) — this is what
    // lets the scheduler AND admit cards run straight from the database, with no
    // Excel upload at generation time. Upsert by studentId so re-imports refresh.
    let rCreated = 0, rUpdated = 0;
    if (studentRegistrations.length) {
      const ops = studentRegistrations
        .filter((r) => r.studentId)
        .map((r) => ({
          updateOne: {
            filter: { studentId: r.studentId },
            update: { $set: { name: r.name || '', program: r.program || '', batch: r.batch || '', courses: r.courses || [] } },
            upsert: true,
          },
        }));
      if (ops.length) {
        const bw = await StudentRegistration.bulkWrite(ops, { ordered: false });
        rCreated = bw.upsertedCount || 0;
        rUpdated = bw.modifiedCount || 0;
      }
    }

    // Always derive program/department/level from the student data so BS/MS
    // department lists are correct (program-driven, not code-number driven).
    try { const { deriveCourseMeta } = require('../utils/deriveCourseMeta'); await deriveCourseMeta(); } catch (e) { console.error('deriveCourseMeta:', e.message); }

    await logActivity(
      'dataset.upload',
      `Dataset imported: ${cCreated} courses, ${tCreated} teachers, ${rCreated + rUpdated} student registrations${replace ? ' (replaced existing)' : ''}`,
      'success'
    );

    res.json({
      ok: true,
      replaced: replace,
      coursesCreated: cCreated,
      coursesSkipped: cSkipped,
      teachersCreated: tCreated,
      autoSectioned: autoSec,
      registrationsCreated: rCreated,
      registrationsUpdated: rUpdated,
      totalRegistrations: studentRegistrations.length,
      totalCourses: courses.length,
      totalTeachers: teachers.length,
    });
  } catch (err) {
    console.error('Dataset upload error:', err);
    res.status(500).json({ error: err.message || 'Dataset import failed.' });
  } finally {
    // Always clean up the temp upload
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
};
