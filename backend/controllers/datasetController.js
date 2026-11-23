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
      return res.status(400).json({ error: `Could not read the dataset: ${err.message}`, report: err.report || null });
    }

    const { courses, teachers, studentRegistrations = [], report = null } = parsed;
    if (!courses.length) {
      return res.status(400).json({ error: 'No valid courses found in the file. See the column report below for what was read and what is missing.', report });
    }

    if (replace) {
      // Teachers are NOT wiped: they carry Faculty IDs, faculty logins and invigilation
      // settings. New names from the report are added below.
      await Promise.all([Course.deleteMany({}), StudentRegistration.deleteMany({})]);
    }

    const progress = (msg) => { try { if (req.job) req.job.progress(msg); } catch { /* optional */ } };
    progress('Saving teachers and courses…');

    // Teachers — one read + one bulk write (was one round-trip per teacher)
    let tCreated = 0;
    // once the Faculty List is loaded it is the only source of teachers
    const rosterLoaded = await Teacher.exists({ inFacultyList: true });
    const tList = rosterLoaded ? [] : teachers.filter((t) => t && t.name);
    if (tList.length) {
      const have = new Map((await Teacher.find({ name: { $in: tList.map((t) => t.name) } }).lean()).map((t) => [t.name, t]));
      const toAdd = []; const toFix = []; const added = new Set();
      for (const t of tList) {
        const ex = have.get(t.name);
        if (!ex) {
          if (added.has(t.name)) continue;
          added.add(t.name);
          toAdd.push({ name: t.name, email: t.email || '', facultyId: t.facultyId || '' });
        } else {
          const set = {};
          if (!ex.email && t.email) set.email = t.email;
          if (!ex.facultyId && t.facultyId) set.facultyId = t.facultyId;
          if (Object.keys(set).length) { toFix.push({ updateOne: { filter: { _id: ex._id }, update: { $set: set } } }); Object.assign(ex, set); }
        }
      }
      if (toAdd.length) {
        try { tCreated = (await Teacher.insertMany(toAdd, { ordered: false })).length; }
        catch (e) { tCreated = (e.insertedDocs || []).length; if (!(e.code === 11000 || (e.writeErrors || []).length)) throw e; }
      }
      if (toFix.length) await Teacher.bulkWrite(toFix, { ordered: false });
    }

    // Courses — existing ones are kept as they are; only new ones are inserted (bulk)
    let cCreated = 0;
    let cSkipped = 0;
    const autoSec = courses.filter((c) => c.autoSectioned).length;
    const existing = new Set((await Course.find({ fullCode: { $in: courses.map((c) => c.fullCode) } }).select('fullCode').lean()).map((c) => c.fullCode));
    const newDocs = []; const queued = new Set();
    for (const r of courses) {
      if (existing.has(r.fullCode) || queued.has(r.fullCode)) { cSkipped++; continue; }
      queued.add(r.fullCode);
      newDocs.push({
        fullCode: r.fullCode, code: r.code, name: r.name, component: r.component,
        section: r.section, programBatch: r.programBatch, program: r.program,
        academicTerm: r.academicTerm, teacher: r.teacher, enrolled: r.enrolled,
        creditHours: r.creditHours != null ? r.creditHours : 3,
        ...(r.department ? { department: r.department } : {}),
        ...(r.level ? { level: r.level } : {}),
        noExam: !!r.noExam, noTimetable: !!r.noTimetable,
        // ERP class list: the section's program batches + its ERP size (seating by section)
        ...(Array.isArray(r.programBatches) ? { programBatches: r.programBatches, erpEnrolled: Number(r.enrolled) || 0 } : {}),
      });
    }
    if (newDocs.length) {
      try { cCreated = (await Course.insertMany(newDocs, { ordered: false })).length; }
      catch (e) {
        cCreated = (e.insertedDocs || []).length || (e.result && e.result.insertedCount) || 0;
        if (!(e.code === 11000 || (e.writeErrors || []).length)) throw e;
      }
    }
    progress('Saving student registrations…');

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

    progress('Creating portal logins and refreshing enrollment…');
    // New reg numbers → their Student Portal logins are created right away.
    let studentLogins = null;
    if (studentRegistrations.length) {
      try { studentLogins = await require('../utils/studentAccounts').kickStudentAccountSync(); } catch (e) { console.error('student logins:', e.message); }
    }
    // enrollment = students actually registered in each course (fresh count)
    if (studentRegistrations.length) { try { await require('../utils/enrollment').recomputeEnrollment(); } catch (e) { console.error('enrollment:', e.message); } }
    // every teacher gets a 4-digit Faculty ID + Faculty Portal login (faculty123)
    try { await require('../utils/facultyImport').ensureFacultyAccounts(); } catch (e) { console.error('faculty logins:', e.message); }

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
      studentLoginsCreated: (studentLogins && studentLogins.created) || 0,
      report,   // columns found / missing, rows used / skipped, what data came in
    });
  } catch (err) {
    console.error('Dataset upload error:', err);
    res.status(500).json({ error: err.message || 'Dataset import failed.' });
  } finally {
    // Always clean up the temp upload
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
};
