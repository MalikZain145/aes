const mongoose = require('mongoose');

/**
 * A Course document = one schedulable component (Lecture OR Lab).
 * Mirrors the dataset rows. The same subject can have a Lecture row
 * and a Lab row, possibly with different teachers.
 */
const courseSchema = new mongoose.Schema(
  {
    // Full code from the source, e.g. "CS386-Spring 2026-01-Section-A-lecture"
    fullCode: { type: String, required: true, trim: true },

    // Short subject code, e.g. "CS386"
    code: { type: String, required: true, trim: true, uppercase: true },

    name: { type: String, required: true, trim: true },

    // 'Lecture' or 'Lab'
    component: { type: String, required: true, enum: ['Lecture', 'Lab'] },

    // Section letter A/B/C (may be empty)
    section: { type: String, default: '', uppercase: true, trim: true },

    // e.g. "BSCS-Spring 24"
    programBatch: { type: String, default: '', trim: true },

    // Readable program name resolved from programBatch (e.g. "BS Computer Science")
    program: { type: String, default: '' },

    // 'UG' (BS/BE/BSc/BBA/Pharm-D/DPT…) or 'PG' (MS/MPhil/PhD) — for the BS/MS scope toggle
    level: { type: String, default: 'UG', enum: ['UG', 'PG'] },

    // Department key (cs/ee/civil/bba/mlt/…) — for department-wise datesheets
    department: { type: String, default: '' },

    academicTerm: { type: String, default: 'Spring 2026' },

    // Teacher display name (or "TBA")
    teacher: { type: String, default: 'TBA', trim: true },

    enrolled: { type: Number, default: 0, min: 0 },

    creditHours: { type: Number, default: 3, min: 0 },

    // Excluded from the DATESHEET (yellow-highlighted in the import, or a project/
    // thesis/internship-type course with no formal exam).
    noExam: { type: Boolean, default: false },
    // Excluded from the TIMETABLE (FYP/thesis/internship/dissertation — no class slot).
    noTimetable: { type: Boolean, default: false },

    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

courseSchema.index({ fullCode: 1 }, { unique: true });
courseSchema.index({ code: 1, component: 1, section: 1, programBatch: 1 });

module.exports = mongoose.model('Course', courseSchema);
