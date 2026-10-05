const mongoose = require('mongoose');

/**
 * Who reviews a student's registration form.
 *   type 'advisor' → a Student Advisor for ONE (department, program, batch).
 *                    A department can have many advisors (one per batch).
 *   type 'hod'     → the Head of Department for a department (exactly one).
 *
 * A student's form flows to the advisor of its (department, program, batch),
 * then to that department's HoD (Phase 3 workflow).
 */
const assignmentSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, enum: ['advisor', 'hod'], index: true },
    term: { type: String, default: '', index: true },   // academic term this applies to ('' = any)
    department: { type: String, required: true, trim: true, index: true },
    program: { type: String, default: '' },   // advisor only
    batch: { type: String, default: '' },      // advisor only

    teacherId: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', default: null },
    teacherName: { type: String, default: '' },
    teacherEmail: { type: String, default: '' },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // faculty login provisioned
  },
  { timestamps: true }
);

// One advisor per (term, department, program, batch); one HoD per (term, department).
assignmentSchema.index(
  { type: 1, term: 1, department: 1, program: 1, batch: 1 },
  { unique: true }
);

module.exports = mongoose.model('Assignment', assignmentSchema);
