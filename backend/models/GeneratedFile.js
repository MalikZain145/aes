const mongoose = require('mongoose');

/**
 * Tracks every generated artifact (timetable, datesheet, clash report)
 * so the Reports page can list, preview, and download them.
 */
const generatedFileSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      required: true,
      enum: ['timetable', 'datesheet', 'clash_report', 'admit_cards', 'admit_update'],
    },
    // For datesheets: 'mids' | 'finals'
    examType: { type: String, default: '' },

    // Original display title shown in UI
    title: { type: String, required: true },

    // Stored filenames on disk (relative to scheduler/output)
    files: [
      {
        label: { type: String }, // "Excel", "PDF", "Report"
        filename: { type: String },
        format: { type: String }, // "xlsx" | "pdf" | "txt"
        sizeBytes: { type: Number, default: 0 },
      },
    ],

    // Summary stats captured from the generator (clash counts etc.)
    summary: { type: mongoose.Schema.Types.Mixed, default: {} },

    // Snapshot of how many courses/teachers/rooms were used
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },

    status: { type: String, default: 'ready', enum: ['ready', 'failed'] },

    // Semester archive: when the admin opens a NEW term, the outgoing term's
    // datesheets / admit cards / seating plans / reports are archived under its
    // name and shown on the "Previous Semesters" page (download as a ZIP).
    archived: { type: Boolean, default: false },
    archivedTerm: { type: String, default: '' },   // e.g. "Fall 2026"
  },
  { timestamps: true }
);

module.exports = mongoose.model('GeneratedFile', generatedFileSchema);
