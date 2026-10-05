const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    capacity: { type: Number, required: true, min: 1 },
    // Exam seating capacity = number of BENCHES (each bench seats 2 students of
    // different papers). Optional: if unset, admit-card seating derives it from
    // the class capacity (benches ≈ capacity / 2).
    examCapacity: { type: Number, default: null, min: 1 },
    // 'classroom' (theory) or 'lab'. 'theory' kept for back-compat with old rows.
    type: { type: String, default: 'classroom', enum: ['theory', 'classroom', 'lab'] },
    building: { type: String, default: '' }, // block, e.g. "I Block", "J Block"
    active: { type: Boolean, default: true },
    // Only rooms with examVenue:true are used for EXAM seating (admit cards /
    // seating plan). When ANY venue is flagged, the exam seating is restricted to
    // the flagged set; timetable/datesheet still use all active rooms.
    examVenue: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Room', roomSchema);
