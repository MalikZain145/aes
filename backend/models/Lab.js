const mongoose = require('mongoose');

const labSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    capacity: { type: Number, required: true, min: 1 },
    // Exam seating capacity in BENCHES (each bench seats 2 students). Optional;
    // derived from class capacity when unset.
    examCapacity: { type: Number, default: null, min: 1 },
    // Which department keys may use this lab, in priority order.
    // e.g. ['cs', 'ai', 'common']
    departments: { type: [String], default: [] },
    active: { type: Boolean, default: true },
    // Only labs with examVenue:true are used for EXAM seating, and labs are always
    // LEAST priority (overflow only) — filled after every exam room is full.
    examVenue: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Lab', labSchema);
