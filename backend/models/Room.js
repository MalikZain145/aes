const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    capacity: { type: Number, required: true, min: 1 },
    // Exam seating capacity = number of exam SEATS (students). Benches = seats / 2;
    // a bench seats 2 students of different papers. Optional: if unset, the class
    // capacity is used.
    examCapacity: { type: Number, default: null, min: 1 },
    // EXAM HALL (Auditorium, Main Hall): when a session's largest merged paper is
    // too big for one-per-bench seating in the chosen rooms, the system may seat
    // that ONE paper on both seats of some benches here — as few benches as needed,
    // and never more than hallSeats students in the hall. Every other room (and
    // every session that fits) keeps the normal rule: two different papers per bench.
    examHall: { type: Boolean, default: false },
    hallSeats: { type: Number, default: null, min: 2 },
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
