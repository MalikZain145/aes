const mongoose = require('mongoose');

/**
 * Digital exam attendance — one row per (student, paper-session) that was
 * actually SCANNED during its exam slot. A row here means PRESENT; a student who
 * is on the seating roster (AdmitVerification) but has NO row here, once the
 * slot's finish time has passed, is ABSENT. Rooms are marked independently and
 * concurrently — the unique index makes each scan an atomic, idempotent upsert,
 * so many scanners in many rooms at once can never double-write or clash.
 */
const attendanceSchema = new mongoose.Schema(
  {
    studentId: { type: String, required: true },
    name: { type: String, default: '' },
    program: { type: String, default: '' },
    code: { type: String, required: true },     // course code (the paper)
    courseName: { type: String, default: '' },
    date: { type: String, required: true },     // 'YYYY-MM-DD'
    slot: { type: String, required: true },     // '09:00-10:30'
    room: { type: String, default: '' },
    seat: { type: String, default: '' },
    status: { type: String, enum: ['present'], default: 'present' },
    scannedAt: { type: Date, default: Date.now },
    batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'GeneratedFile', default: null },
    examType: { type: String, default: '' },
  },
  { timestamps: true }
);

// One attendance mark per student per paper-session. The upsert on this key is
// atomic, so concurrent scans of the same card (or races between rooms) are safe.
attendanceSchema.index({ studentId: 1, code: 1, date: 1, slot: 1 }, { unique: true });
// Fast room/slot sheet lookups.
attendanceSchema.index({ date: 1, slot: 1, room: 1 });

module.exports = mongoose.model('Attendance', attendanceSchema);
