const mongoose = require('mongoose');

/**
 * CLASS attendance (distinct from the exam-scan Attendance model). A teacher opens
 * a course they teach, marks each registered student present/absent, and SAVES —
 * which writes ONE locked ClassAttendance document. Once saved it is immutable
 * (viewable / downloadable as a PDF, never editable), and the student sees it under
 * "My Attendance". One document per (teacher, course, section, date).
 */
const recordSchema = new mongoose.Schema({
  studentId: { type: String, required: true },
  name: { type: String, default: '' },
  program: { type: String, default: '' },
  status: { type: String, enum: ['present', 'absent'], default: 'absent' },
}, { _id: false });

const classAttendanceSchema = new mongoose.Schema(
  {
    teacherName: { type: String, required: true, index: true },
    teacherUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    code: { type: String, required: true, uppercase: true, trim: true, index: true },
    courseName: { type: String, default: '' },
    section: { type: String, default: '', uppercase: true, trim: true },
    program: { type: String, default: '' },
    programBatch: { type: String, default: '' },
    component: { type: String, default: 'Lecture' },

    date: { type: String, required: true },        // 'YYYY-MM-DD' (the class day)
    slot: { type: String, default: '' },           // optional class time label

    total: { type: Number, default: 0 },           // Y — registered students
    present: { type: Number, default: 0 },         // X — marked present
    records: { type: [recordSchema], default: [] },

    locked: { type: Boolean, default: true },       // immutable after save
  },
  { timestamps: true }
);

// One saved sheet per (teacher, course, section, date) — re-saving the same class
// on the same day updates that one sheet rather than duplicating.
classAttendanceSchema.index({ teacherName: 1, code: 1, section: 1, date: 1 }, { unique: true });
// Fast "my attendance" lookups for a student.
classAttendanceSchema.index({ 'records.studentId': 1 });

module.exports = mongoose.model('ClassAttendance', classAttendanceSchema);
