const mongoose = require('mongoose');

/**
 * One timetable-generation run of the new CP-SAT engine (scheduler/timetable_engine).
 * A run produces BOTH the BS and MS timetables in a single engine invocation, so a
 * run is NOT per-level; `metrics` holds the per-level numbers. Exactly one run per
 * term may be `published` (the live timetable the portal shows).
 */
const timetableRunSchema = new mongoose.Schema(
  {
    term: { type: String, default: 'Fall 2026', index: true },
    status: { type: String, enum: ['queued', 'running', 'done', 'failed'], default: 'queued', index: true },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    // snapshot of config.json actually used for this run (rooms + rules)
    config: { type: mongoose.Schema.Types.Mixed, default: {} },
    // per-level metrics from the engine (BS + MS) and a parse/coverage summary
    metrics: { type: mongoose.Schema.Types.Mixed, default: {} },
    summary: { type: mongoose.Schema.Types.Mixed, default: {} },   // counts: courses, sections, students, verify
    log: { type: String, default: '' },      // streamed engine stdout/stderr
    error: { type: String, default: '' },
    published: { type: Boolean, default: false, index: true },
    publishedAt: { type: Date },
    xlsxFile: { type: String, default: '' },  // styled Excel filename (in scheduler/output)
    pdfFile: { type: String, default: '' },    // styled PDF filename (in scheduler/output)
    createdBy: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('TimetableRun', timetableRunSchema);
