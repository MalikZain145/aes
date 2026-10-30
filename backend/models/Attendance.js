const mongoose = require('mongoose');

/**
 * Digital exam attendance — one row per (student, paper-session) that was
 * SCANNED during its exam slot (status 'present'), or corrected by the Exam Cell
 * after the paper (status 'present' / 'absent', or a student `added` by hand).
 * A student on the seating roster (AdmitVerification) with NO row, once the
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
    // 'present' = scanned (or set P by the Exam Cell); 'absent' = set A by the Exam Cell
    // after the paper. A student with NO row is absent once the paper is over.
    status: { type: String, enum: ['present', 'absent'], default: 'present' },
    scannedAt: { type: Date, default: Date.now },
    // Manual corrections (only after a paper's time is over):
    source: { type: String, default: 'scan' },        // 'scan' | 'manual'
    added: { type: Boolean, default: false },         // a student added to this paper by hand (not on the seating plan)
    batch: { type: String, default: '' },
    section: { type: String, default: '' },
    editedBy: { type: String, default: '' },
    editedAt: { type: Date, default: null },
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
