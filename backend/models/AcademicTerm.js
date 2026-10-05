const mongoose = require('mongoose');

/**
 * An academic term (e.g. "Fall 2026"). The admin creates terms and, per term,
 * opens/closes two independent windows:
 *   • registration — when students may submit course-registration forms
 *   • addDrop      — when students may submit add/drop forms (after registration)
 * Each window has enabled + opensAt/closesAt; the admin can extend closesAt any
 * time. Advisors/HoDs are assigned per term (see Assignment.term).
 */
const windowSchema = new mongoose.Schema({
  enabled: { type: Boolean, default: false },
  opensAt: { type: Date, default: null },
  closesAt: { type: Date, default: null },
  note: { type: String, default: '' },
}, { _id: false });

const academicTermSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },  // "Fall 2026"
    registration: { type: windowSchema, default: () => ({}) },
    addDrop: { type: windowSchema, default: () => ({}) },
    active: { type: Boolean, default: true },   // shown to students for new forms
  },
  { timestamps: true }
);

module.exports = mongoose.model('AcademicTerm', academicTermSchema);
