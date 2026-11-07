const mongoose = require('mongoose');

/**
 * One archived examination (e.g. "Mid Term Examination, 27 Oct – 05 Nov 2026")
 * of a semester. Created automatically when a new datesheet / admit-card run starts
 * after an exam has been fully conducted (a re-conducted exam in the same term),
 * and for every remaining exam when a new academic term is opened.
 *
 * It is a SNAPSHOT: copies of the datesheets, admit cards, seating plans,
 * identification sheets, invigilation rosters and update batches are kept in
 * GridFS (bucket "examarchive"), together with the frozen seating roster. Nothing
 * in the live system is changed or removed by archiving. The attendance workbooks
 * in its ZIP are built at download time from the live Attendance records, so later
 * corrections are always included.
 */
const archiveFileSchema = new mongoose.Schema({
  folder: String,      // 'Date Sheets' | 'Admit Cards' | 'Seating Plans' | ...
  name: String,        // file name inside the folder
  fileId: mongoose.Schema.Types.ObjectId,   // GridFS id (bucket examarchive)
  sizeBytes: { type: Number, default: 0 },
  sourceId: mongoose.Schema.Types.ObjectId, // GeneratedFile it was copied from
}, { _id: false });

const examArchiveSchema = new mongoose.Schema({
  term: { type: String, default: '' },          // "Fall 2026"
  examType: { type: String, default: '' },      // 'mids' | 'finals'
  label: { type: String, default: '' },         // "Mid Term Examination (27 Oct – 05 Nov 2026)"
  round: { type: Number, default: 1 },          // 1st, 2nd (re-conducted) … exam of this type in the term
  startDate: { type: String, default: '' },     // 'YYYY-MM-DD'
  endDate: { type: String, default: '' },
  batchIds: [{ type: mongoose.Schema.Types.ObjectId }],       // admit-card batches whose seating was used
  supersededIds: [{ type: mongoose.Schema.Types.ObjectId }],  // older batches for the same exam (replaced before it)
  datesheetIds: [{ type: mongoose.Schema.Types.ObjectId }],
  updateIds: [{ type: mongoose.Schema.Types.ObjectId }],
  files: { type: [archiveFileSchema], default: [] },
  rosterFileId: { type: mongoose.Schema.Types.ObjectId, default: null },   // frozen seating roster (JSON)
  stats: { type: mongoose.Schema.Types.Mixed, default: {} },
  reason: { type: String, default: '' },
  complete: { type: Boolean, default: true },   // false if the exam had not ended when archived (new term)
}, { timestamps: true });

module.exports = mongoose.model('ExamArchive', examArchiveSchema);
