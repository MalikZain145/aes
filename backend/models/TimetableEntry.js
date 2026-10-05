const mongoose = require('mongoose');

/**
 * One weekly class session in a timetable run — a row of `timetables.<level>.entries[]`
 * from the engine's timetable.json. Read filtered by level + (class group / teacher /
 * room / course). `studentIds` powers each student's "My Timetable".
 */
const timetableEntrySchema = new mongoose.Schema(
  {
    runId: { type: mongoose.Schema.Types.ObjectId, ref: 'TimetableRun', required: true, index: true },
    level: { type: String, enum: ['BS', 'MS'], required: true, index: true },
    day: { type: String, required: true },      // 'Mon'…'Sun'
    slotIndex: { type: Number, required: true },
    time: { type: String, default: '' },        // '08:30-10:00'
    room: { type: String, default: '' },
    block: { type: String, default: '' },
    roomCapacity: { type: Number, default: 0 },
    courseCode: { type: String, default: '', index: true },
    courseTitle: { type: String, default: '' },
    section: { type: String, default: '' },
    sectionUid: { type: String, default: '' },
    teacher: { type: String, default: 'TBA', index: true },
    tag: { type: String, default: '' },          // '', '[2Hrs]', '[1Hr]', '[3Hrs]'
    type: { type: String, default: 'theory' },
    sessionNo: { type: Number, default: 1 },
    durationSlots: { type: Number, default: 1 },
    students: { type: Number, default: 0 },
    studentIds: { type: [String], default: [] },
    cohorts: { type: [String], default: [] },
    classes: { type: [String], default: [] },    // class groups (for the "class" view)
  },
  { timestamps: true }
);

// Fast published-run reads by level + view key.
timetableEntrySchema.index({ runId: 1, level: 1, room: 1 });
timetableEntrySchema.index({ runId: 1, level: 1, teacher: 1 });
timetableEntrySchema.index({ runId: 1, level: 1, courseCode: 1 });

module.exports = mongoose.model('TimetableEntry', timetableEntrySchema);
