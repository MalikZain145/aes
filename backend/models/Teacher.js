const mongoose = require('mongoose');

const teacherSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, default: '', trim: true, lowercase: true },
    facultyId: { type: String, default: '', trim: true }, // random unique 4-digit Faculty ID, e.g. "4821"
    department: { type: String, default: '' }, // dept key or readable label
    designation: { type: String, default: '', trim: true }, // from the Faculty List ("Lecturer", "Assistant Professor")
    // Other spellings of the same person (Faculty List / All-Faculty export) — used to match rosters.
    aliases: { type: [String], default: [] },
    inFacultyList: { type: Boolean, default: false },
    // highlighted yellow on the Faculty List → no invigilation by default
    listYellow: { type: Boolean, default: false },

    // Visiting / adjunct faculty never invigilate while this is on.
    isVisiting: { type: Boolean, default: false },
    // Off → the teacher gets NO invigilation duty in any paper, anywhere.
    allowInvigilation: { type: Boolean, default: true },

    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // faculty portal login
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Same name shouldn't be duplicated
teacherSchema.index({ name: 1 }, { unique: true });
teacherSchema.index({ facultyId: 1 });

// A visiting / adjunct teacher can never be an invigilator.
teacherSchema.pre('save', function (next) {
  if (this.isVisiting) this.allowInvigilation = false;
  next();
});

module.exports = mongoose.model('Teacher', teacherSchema);
