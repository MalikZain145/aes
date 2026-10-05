const fs = require('fs');
const path = require('path');
const Course = require('../models/Course');
const Teacher = require('../models/Teacher');
const Room = require('../models/Room');
const Lab = require('../models/Lab');
const GeneratedFile = require('../models/GeneratedFile');
const ActivityLog = require('../models/ActivityLog');
const { OUTPUT_DIR } = require('../utils/pythonRunner');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function slotStart(slot) {
  const m = /(\d{1,2}):(\d{2})/.exec(String(slot || ''));
  return m ? (+m[1]) * 60 + (+m[2]) : 9999;
}

// GET /api/dashboard/summary
exports.summary = async (_req, res) => {
  const [
    teacherCount,
    courseCount,
    roomCount,
    labCount,
    lectureCount,
    labComponentCount,
    recentActivity,
    lastTimetable,
    pendingDatesheets,
  ] = await Promise.all([
    Teacher.countDocuments({ active: true }),
    Course.countDocuments({ active: true }),
    Room.countDocuments({ active: true }),
    Lab.countDocuments({ active: true }),
    Course.countDocuments({ active: true, component: 'Lecture' }),
    Course.countDocuments({ active: true, component: 'Lab' }),
    ActivityLog.find().sort({ createdAt: -1 }).limit(6).lean(),
    GeneratedFile.findOne({ kind: 'timetable' }).sort({ createdAt: -1 }).lean(),
    GeneratedFile.countDocuments({ kind: 'datesheet' }),
  ]);

  // Schedule composition for the donut chart
  const composition = {
    lecture: lectureCount,
    lab: labComponentCount,
    total: lectureCount + labComponentCount,
  };

  res.json({
    counts: {
      teachers: teacherCount,
      courses: courseCount,
      rooms: roomCount + labCount,
      roomsOnly: roomCount,
      labs: labCount,
    },
    composition,
    recentActivity,
    lastTimetable: lastTimetable
      ? {
          createdAt: lastTimetable.createdAt,
          fullyClashFree: lastTimetable.meta?.fullyClashFree,
          clashes: lastTimetable.summary,
        }
      : null,
    pendingDatesheets,
  });
};

// GET /api/dashboard/activity?limit=
exports.activity = async (req, res) => {
  const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
  const items = await ActivityLog.find().sort({ createdAt: -1 }).limit(limit).lean();
  res.json({ items });
};

// GET /api/dashboard/today  — the latest timetable grouped by weekday, with clashes
// flagged (room / teacher / time), so the dashboard can show any day's schedule.
function slotRange(slot) {
  const m = /(\d{1,2}):(\d{2})\D+(\d{1,2}):(\d{2})/.exec(String(slot || ''));
  return m ? [(+m[1]) * 60 + (+m[2]), (+m[3]) * 60 + (+m[4])] : [9999, 9999];
}
const overlaps = (a, b) => a[0] < b[1] && b[0] < a[1];

exports.todaySchedule = async (_req, res) => {
  // Reads the PUBLISHED CP-SAT timetable (TimetableEntry) — BS (Mon–Fri) + MS
  // (Sat–Sun) together — grouped by weekday for the dashboard's day schedule.
  const TimetableRun = require('../models/TimetableRun');
  const TimetableEntry = require('../models/TimetableEntry');
  const DAY_FULL = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };
  const today = DAY_NAMES[new Date().getDay()];
  const run = await TimetableRun.findOne({ published: true }).sort({ publishedAt: -1 }).lean()
    || await TimetableRun.findOne({ status: 'done' }).sort({ finishedAt: -1 }).lean();
  if (!run) return res.json({ hasTimetable: false, today, byDay: {} });
  const entries = await TimetableEntry.find({ runId: run._id }).lean();
  if (!entries.length) return res.json({ hasTimetable: false, today, byDay: {} });

  const byDay = {};
  DAY_NAMES.forEach((d) => { byDay[d] = []; });
  for (const e of entries) {
    const d = DAY_FULL[e.day] || e.day;
    (byDay[d] || (byDay[d] = [])).push({
      time: e.time, code: e.courseCode, name: e.courseTitle, section: e.section || '',
      faculty: e.teacher || '', room: e.room || '', type: e.tag || 'Theory',
      program: (e.cohorts && e.cohorts[0]) || '', clashes: [],
    });
  }
  // the engine guarantees a clash-free timetable, so just sort each day by time
  for (const d of Object.keys(byDay)) {
    byDay[d].sort((a, b) => slotRange(a.time)[0] - slotRange(b.time)[0] || String(a.room).localeCompare(String(b.room)));
  }
  res.json({ hasTimetable: true, today, generatedAt: run.publishedAt || run.finishedAt, byDay });
};
