const mongoose = require('mongoose');

/**
 * A StudentRegistration document = one student and the exact set of course
 * codes they are registered in. This is what makes CLASH-FREE datesheets
 * possible: the scheduler needs to know, per real student, which papers must
 * never land in the same slot.
 *
 * Populated from the student-wise registration report ("Courses with Names"
 * column) at upload time. One document per student.
 */
const studentRegistrationSchema = new mongoose.Schema(
  {
    studentId: { type: String, required: true, index: true, trim: true },

    // Student's full name (for admit cards) — captured from the registration report.
    name: { type: String, default: '', trim: true },

    // Academic program only, e.g. "BS Computer Science" (no intake).
    program: { type: String, default: '', trim: true },

    // Program + batch intake, e.g. "BS Computer Science Fall 2023"
    batch: { type: String, default: '', trim: true },

    // Uppercased short course codes the student is enrolled in, e.g. ["CS313","MT201"]
    courses: { type: [String], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model('StudentRegistration', studentRegistrationSchema);
