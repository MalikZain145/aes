const mongoose = require('mongoose');

/**
 * Which SECTION of a course a student was placed in for a given run (the engine
 * partitions each course's students into sections). Lets "My Timetable" and rosters
 * resolve a student → their exact section quickly.
 */
const studentSectionSchema = new mongoose.Schema(
  {
    runId: { type: mongoose.Schema.Types.ObjectId, ref: 'TimetableRun', required: true, index: true },
    level: { type: String, enum: ['BS', 'MS'], default: 'BS' },
    studentId: { type: String, required: true, index: true },
    courseCode: { type: String, required: true },
    section: { type: String, default: '' },
  },
  { timestamps: true }
);

studentSectionSchema.index({ runId: 1, studentId: 1 });

module.exports = mongoose.model('StudentSection', studentSectionSchema);
