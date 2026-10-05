/**
 * Schedule data API for the "Timetable Views" screen.
 *
 * Serves the structured schedule that every timetable generation stores
 * (scheduler writes <prefix>_schedule.json). The frontend Views page reads this
 * and re-arranges it department-wise / faculty-wise / room-wise / program-wise /
 * time-slot-wise, plus a room-utilization matrix, and exports each view to
 * Excel / PDF. Master data (course list, department list, faculty list, room
 * list) is derived from the same sessions so it always matches the live
 * timetable.
 */
const fs = require('fs');
const path = require('path');
const GeneratedFile = require('../models/GeneratedFile');
const { OUTPUT_DIR } = require('../utils/pythonRunner');

function loadSchedule(record) {
  const name = record && record.meta && record.meta.scheduleFile;
  if (!name) return null;
  const p = path.join(OUTPUT_DIR, path.basename(name));
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

// GET /api/schedule/latest?level=ug|pg
// Returns the newest timetable's full structured schedule for the requested
// level, or { hasTimetable:false }. BS (ug) and MS (pg) timetables coexist, so
// the Views screen can flip between them. Records made before meta.level existed
// count as ug. When no timetable exists for the asked level, fall back to the
// newest of any level so the screen still shows something.
exports.getLatest = async (req, res) => {
  try {
    const want = String((req.query || {}).level || 'ug').toLowerCase() === 'pg' ? 'pg' : 'ug';
    const all = await GeneratedFile.find({ kind: 'timetable', status: 'ready' })
      .sort({ createdAt: -1 })
      .lean();

    let record = all.find((r) => (r.meta && r.meta.level ? r.meta.level : 'ug') === want) || null;
    const levelMatched = !!record;
    if (!record) record = all[0] || null;

    if (!record) return res.json({ hasTimetable: false });

    const schedule = loadSchedule(record);
    if (!schedule || !Array.isArray(schedule.sessions)) {
      // A record exists but its schedule JSON is missing (old generation) —
      // tell the client to regenerate rather than showing an empty screen.
      return res.json({
        hasTimetable: false,
        stale: true,
        message: 'The latest timetable was generated before structured views were '
          + 'available. Please regenerate the timetable.',
      });
    }

    return res.json({
      hasTimetable: true,
      recordId: record._id,
      title: record.title,
      level: (record.meta && record.meta.level) || 'ug',
      levelMatched, // false = no timetable for the asked level; this is a fallback
      generatedAt: record.createdAt,
      clashes: record.summary || {},
      accuracy: record.meta && record.meta.accuracy,
      meta: {
        days: schedule.days || [],
        theorySlots: schedule.theory_slots || [],
        labSlots: schedule.lab_slots || [],
        rooms: schedule.rooms || [],
        allRooms: schedule.all_rooms || [],
        labs: schedule.labs || [],
        roomCaps: schedule.room_caps || {},
        programs: schedule.programs || [],
      },
      sessions: schedule.sessions,
    });
  } catch (err) {
    console.error('schedule.getLatest error:', err);
    return res.status(500).json({ message: 'Could not load the schedule.' });
  }
};

module.exports.loadSchedule = loadSchedule;
