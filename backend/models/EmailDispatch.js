const mongoose = require('mongoose');

/**
 * One row per (scope, batch/timetable, recipient) that was SUCCESSFULLY emailed.
 * Used to make "Email now" incremental: on a repeat click we skip anyone already
 * emailed and only send to the students/teachers still missing (e.g. those who
 * were unpaid or had no email on the previous run).
 *
 *   scope : 'admit'        → admit card for a student   (refId = admit batch id)
 *           'student_tt'   → personal timetable / student (refId = timetable id)
 *           'teacher_tt'   → personal timetable / teacher (refId = timetable id)
 *   ident : registration number (students) or teacher name (teachers), normalised
 */
const emailDispatchSchema = new mongoose.Schema(
  {
    scope: { type: String, required: true, enum: ['admit', 'student_tt', 'teacher_tt'], index: true },
    refId: { type: String, required: true, index: true },
    ident: { type: String, required: true },
    email: { type: String, default: '' },
    name: { type: String, default: '' },
    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// A recipient is emailed at most once per (scope, batch/timetable).
emailDispatchSchema.index({ scope: 1, refId: 1, ident: 1 }, { unique: true });

module.exports = mongoose.model('EmailDispatch', emailDispatchSchema);
