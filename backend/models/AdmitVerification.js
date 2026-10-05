const mongoose = require('mongoose');

/**
 * One record per student per admit-card batch, addressed by the QR `token`.
 * The public /verify/:token page reads this to show the student their exam for
 * the day (with hall/seat/time) and their fee status — with no login.
 */
const examSchema = new mongoose.Schema({
  code: String,
  name: String,
  teacher: String,
  date: String,       // 'YYYY-MM-DD'
  dateDisp: String,   // '27-Aug-2025'
  day: String,
  slot: String,       // '09:00-12:00'
  start: String,      // '09:00'
  finish: String,     // '12:00'
  room: String,
  seat: String,
  key: String,        // 64-bit HMAC verification key for THIS student's THIS paper
}, { _id: false });

const admitVerificationSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true, index: true },
    batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'GeneratedFile', default: null },
    studentId: { type: String, default: '' },
    name: { type: String, default: '' },
    program: { type: String, default: '' },
    batch: { type: String, default: '' },
    program: { type: String, default: '' },          // degree program (used as department in reports)
    feeStatus: { type: String, default: 'Paid' },   // later driven by a defaulters list
    heading: { type: String, default: '' },
    examType: { type: String, default: '' },
    semester: { type: String, default: '' },
    year: { type: mongoose.Schema.Types.Mixed, default: null },
    // 1-based page number of THIS student's card inside the batch admit-card
    // PDF (one card per page) — lets Finance email each student just their card.
    cardPage: { type: Number, default: 0 },
    exams: { type: [examSchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AdmitVerification', admitVerificationSchema);
