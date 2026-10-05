const mongoose = require('mongoose');

/**
 * A student's course-registration (or add/drop) form and its approval workflow.
 *
 * Flow (Phase 3):
 *   student submits ─▶ with_advisor ─▶ (advisor approves) ─▶ with_hod
 *                                   └▶ (advisor returns)  ─▶ returned_to_student
 *   with_hod ─▶ (HoD approves) ─▶ approved   (Exam Cell can download it)
 *            └▶ (HoD returns)   ─▶ returned_to_student
 *   returned_to_student ─▶ (student edits & resubmits) ─▶ with_advisor
 *
 * Routing keys: a form is matched to its advisor by `batch` (the full intake
 * string, e.g. "BS Computer Science Fall 2023") and to its HoD by `program`
 * (that batch with the intake stripped). Both are captured on submit.
 */
const courseLine = new mongoose.Schema({
  code: String, title: String, creditHours: String,   // creditHours e.g. "3+0"
  // For an Add/Drop form each line is either an added or a dropped course.
  // Registration forms leave this blank (all lines are registrations).
  action: { type: String, default: '', enum: ['', 'add', 'drop'] },
}, { _id: false });

// One entry per event in the form's life — powers the student's live timeline.
const historyEntry = new mongoose.Schema({
  stage: { type: String, enum: ['student', 'advisor', 'hod', 'admin'], required: true },
  action: { type: String, required: true },   // submitted | resubmitted | seen | approved | returned
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  byName: { type: String, default: '' },
  remark: { type: String, default: '' },
  at: { type: Date, default: Date.now },
}, { _id: false });

const registrationFormSchema = new mongoose.Schema(
  {
    kind: { type: String, default: 'registration', enum: ['registration', 'add_drop'] },
    term: { type: String, default: '', index: true },     // academic term, e.g. "Fall 2026"
    regNo: { type: String, required: true, index: true, trim: true },
    name: { type: String, default: '' },
    batch: { type: String, default: '', index: true },   // advisor routing key
    program: { type: String, default: '', index: true },  // HoD routing key (batch w/o intake)
    degree: { type: String, default: '' },
    department: { type: String, default: '' },
    phone: { type: String, default: '' },
    email: { type: String, default: '' },
    semester: { type: String, default: '' },
    courses: { type: [courseLine], default: [] },
    totalCredits: { type: Number, default: 0 },   // sum of course credit hours

    status: {
      type: String,
      default: 'with_advisor',
      enum: ['with_advisor', 'returned_to_student', 'with_hod', 'approved'],
      index: true,
    },

    // Who it is routed to (resolved on submit from the Assignment records).
    advisorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    advisorName: { type: String, default: '' },
    hodId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    hodName: { type: String, default: '' },

    // Stage markers for the live status line.
    seenByAdvisorAt: { type: Date, default: null },
    advisorActionAt: { type: Date, default: null },
    seenByHodAt: { type: Date, default: null },
    hodActionAt: { type: Date, default: null },
    returnedBy: { type: String, default: '' },       // '' | 'advisor' | 'hod'
    lastRemark: { type: String, default: '' },       // the remark shown to the student now

    submittedAt: { type: Date, default: Date.now },
    resubmitCount: { type: Number, default: 0 },
    approvedAt: { type: Date, default: null },

    history: { type: [historyEntry], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model('RegistrationForm', registrationFormSchema);
