/**
 * "Ask Abasyn Scheduler" — a search assistant over generated timetables and
 * datesheets. Reads the structured schedule each generation now stores, and
 * answers natural-ish, typo-tolerant queries:
 *   • room-wise      : "J212", "room 212", "class 212 monday"
 *   • teacher-wise   : "Mr. Salman", "salmaan" (fuzzy)
 *   • course-wise    : "CS313", "operating systems"
 *   • day-wise       : "friday classes"
 *   • program/batch  : "BS Computer Science"
 *   • datesheet      : "when is CS313 paper", "papers on 27 aug"
 */
const fs = require('fs');
const path = require('path');
const GeneratedFile = require('../models/GeneratedFile');
const { OUTPUT_DIR } = require('../utils/pythonRunner');

const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_ALIASES = {
  mon: 'Monday', tue: 'Tuesday', tues: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  thur: 'Thursday', thurs: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};

// ── fuzzy helpers ────────────────────────────────────────────────────────────
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();

function levenshtein(a, b) {
  a = norm(a); b = norm(b);
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

/** similarity 0..1 (1 = identical). Substring gets a boost. */
function sim(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.9;
  const d = levenshtein(a, b);
  return 1 - d / Math.max(a.length, b.length);
}

/** best match of `q` among candidates (array of strings). Returns {value, score}. */
function bestMatch(q, candidates, threshold = 0.55) {
  let best = null;
  for (const c of candidates) {
    const s = sim(q, c);
    if (!best || s > best.score) best = { value: c, score: s };
  }
  return best && best.score >= threshold ? best : null;
}

// ── schedule loading ─────────────────────────────────────────────────────────
function loadSchedule(record) {
  const name = record && record.meta && record.meta.scheduleFile;
  if (!name) return null;
  const p = path.join(OUTPUT_DIR, path.basename(name));
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function slotIndex(schedule, slot) {
  const all = [...(schedule.theory_slots || []), ...(schedule.lab_slots || [])];
  const i = all.indexOf(slot);
  return i < 0 ? 999 : i;
}

// ── sources (for the filter panel) ───────────────────────────────────────────
exports.getSources = async (_req, res) => {
  const items = await GeneratedFile.find({ kind: { $in: ['timetable', 'datesheet'] } })
    .sort({ createdAt: -1 }).limit(100).lean();

  const sources = items.map((r) => {
    const hasSchedule = !!(r.meta && r.meta.scheduleFile
      && fs.existsSync(path.join(OUTPUT_DIR, path.basename(r.meta.scheduleFile))));
    const term = (r.meta && (r.meta.term || (r.meta.semester && `${r.meta.semester} ${r.meta.year || ''}`))) || '';
    return {
      id: r._id, kind: r.kind, title: r.title, createdAt: r.createdAt,
      term: term.trim(),
      semester: (r.meta && r.meta.semester) || (term.split(' ')[0] || ''),
      year: (r.meta && r.meta.year) || (term.match(/\d{4}/) ? Number(term.match(/\d{4}/)[0]) : null),
      programs: (r.meta && r.meta.programs) || [],
      examType: r.examType || null,
      searchable: hasSchedule,
    };
  });

  const years = [...new Set(sources.map((s) => s.year).filter(Boolean))].sort((a, b) => b - a);
  const semesters = [...new Set(sources.map((s) => s.semester).filter(Boolean))];
  res.json({ sources, years, semesters });
};

// ── main search ──────────────────────────────────────────────────────────────
exports.search = async (req, res) => {
  const { sourceId, kind, query } = req.body || {};
  const q = norm(query);
  if (!q && !sourceId) return res.status(400).json({ error: 'Type something to search.' });

  // resolve the source
  let record = null;
  if (sourceId) {
    record = await GeneratedFile.findById(sourceId).lean().catch(() => null);
  }
  if (!record) {
    const filter = { kind: kind && ['timetable', 'datesheet'].includes(kind) ? kind : 'timetable' };
    record = await GeneratedFile.findOne(filter).sort({ createdAt: -1 }).lean();
  }
  if (!record) return res.json({ ok: true, answer: 'No timetables or datesheets have been generated yet.', results: null });

  const schedule = loadSchedule(record);
  if (!schedule) {
    return res.json({
      ok: true, source: sourceMeta(record),
      answer: 'This item has no searchable schedule stored. Re-generate it to enable search.',
      results: null,
    });
  }

  if (record.kind === 'datesheet') return res.json(searchDatesheet(record, schedule, q));
  return res.json(searchTimetable(record, schedule, q));
};

function sourceMeta(record) {
  return {
    id: record._id, kind: record.kind, title: record.title,
    term: (record.meta && (record.meta.term)) || '',
  };
}

// ── TIMETABLE search ─────────────────────────────────────────────────────────
function searchTimetable(record, schedule, q) {
  const sessions = schedule.sessions || [];
  const usedRooms = schedule.rooms || [];
  // match against every room in the DB (so empty rooms answer "no classes"),
  // falling back to used rooms for older schedules.
  const rooms = (schedule.all_rooms && schedule.all_rooms.length)
    ? [...schedule.all_rooms, ...(schedule.labs || [])] : usedRooms;
  const teachers = [...new Set(sessions.map((s) => s.teacher).filter((t) => t && t !== 'TBA'))];
  const codes = [...new Set(sessions.map((s) => s.code))];
  const names = [...new Set(sessions.map((s) => s.name))];
  const programs = schedule.programs || [];

  const out = { ok: true, source: sourceMeta(record), matched: {}, corrections: [] };

  // detect a day mention
  let day = null;
  for (const tok of q.split(/[^a-z]+/).filter(Boolean)) {
    if (DAY_ALIASES[tok]) { day = DAY_ALIASES[tok]; break; }
    const dm = bestMatch(tok, DAY_ORDER, 0.7);
    if (dm && tok.length >= 3) { day = dm.value; break; }
  }
  if (day) out.matched.day = day;

  // strip day words to help other matchers
  const qNoDay = q.replace(/\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g, ' ').trim();

  // ── explicit COURSE CODE first (2–6 letters + digits, e.g. CS313) so it is
  //    never mistaken for a room number like 313 ──
  const codeTok = (qNoDay.toUpperCase().match(/[A-Z]{2,6}[-\s]?\d{3,4}/) || [])[0];
  if (codeTok) {
    const cm = bestMatch(codeTok.replace(/[\s-]/g, ''), codes.map((c) => c.replace(/[\s-]/g, '')), 0.7);
    if (cm) {
      const courseCode = codes.find((c) => c.replace(/[\s-]/g, '') === cm.value) || codeTok;
      out.matched.course = courseCode;
      return finalizeCourse(out, sessions, schedule, courseCode, day);
    }
  }

  // ── ROOM detection (e.g. "J212", "212", "room 212") ──
  const roomMatch = detectRoom(qNoDay, rooms);
  if (roomMatch) {
    if (roomMatch.corrected) out.corrections.push(`Showing results for room "${roomMatch.value}".`);
    out.matched.room = roomMatch.value;
    return finalizeRoom(out, sessions, schedule, roomMatch.value, day);
  }

  // ── COURSE by NAME (e.g. "operating systems") ──
  if (qNoDay.length >= 4) {
    const nm = bestMatch(qNoDay, names, 0.6);
    if (nm) {
      const s = sessions.find((x) => x.name === nm.value);
      if (s) { out.matched.course = s.code; return finalizeCourse(out, sessions, schedule, s.code, day); }
    }
  }

  // ── TEACHER detection ──
  if (qNoDay.length >= 3) {
    const tm = bestMatch(qNoDay, teachers, 0.5);
    if (tm) {
      if (norm(tm.value) !== qNoDay) out.corrections.push(`Closest teacher: "${tm.value}".`);
      out.matched.teacher = tm.value;
      return finalizeTeacher(out, sessions, schedule, tm.value, day);
    }
  }

  // ── PROGRAM detection ──
  if (qNoDay.length >= 3) {
    const pm = bestMatch(qNoDay, programs, 0.5);
    if (pm) {
      out.matched.program = pm.value;
      return finalizeProgram(out, sessions, schedule, pm.value, day);
    }
  }

  // ── day only ──
  if (day) return finalizeDay(out, sessions, schedule, day);

  // ── overview / no match ──
  out.answer = `This timetable (${record.meta && record.meta.term ? record.meta.term : 'current'}) has `
    + `${sessions.length} sessions across ${rooms.length} rooms. Try a room (e.g. "J212"), a teacher, `
    + `a course code (e.g. "CS313"), or a day (e.g. "Friday").`;
  out.results = { type: 'overview', rooms, totalSessions: sessions.length, programs };
  return out;
}

function detectRoom(q, rooms) {
  const toks = q.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  // explicit like J212 / I212 / GP LAB 1 / Auditorium
  for (const tok of toks) {
    const exact = rooms.find((r) => r.toUpperCase().replace(/\s/g, '') === tok);
    if (exact) return { value: exact, corrected: false };
  }
  // "212" alone → any room whose trailing number matches
  const numTok = toks.find((t) => /^\d{2,4}$/.test(t));
  if (numTok) {
    const hits = rooms.filter((r) => (r.match(/\d{2,4}/) || [])[0] === numTok);
    if (hits.length) return { value: hits[0], corrected: hits[0].toUpperCase() !== numTok, alts: hits };
  }
  // fuzzy on the whole room token (typos like "audotorium")
  const joined = q.replace(/\b(room|class|hall|lab|in|the|of)\b/gi, ' ').trim();
  if (joined.length >= 3) {
    const m = bestMatch(joined, rooms, 0.6);
    if (m) return { value: m.value, corrected: norm(m.value) !== norm(joined) };
  }
  return null;
}

function groupByDay(list, schedule) {
  const byDay = {};
  for (const s of list) (byDay[s.day] = byDay[s.day] || []).push(s);
  const days = DAY_ORDER.filter((d) => byDay[d]).map((d) => ({
    day: d,
    sessions: byDay[d].sort((a, b) => slotIndex(schedule, a.slot) - slotIndex(schedule, b.slot)),
  }));
  return days;
}

function finalizeRoom(out, sessions, schedule, room, day) {
  let list = sessions.filter((s) => s.room === room);
  if (day) list = list.filter((s) => s.day === day);
  const days = groupByDay(list, schedule);
  const cnt = list.length;
  out.answer = cnt === 0
    ? `Room ${room} has no classes${day ? ` on ${day}` : ''} in this timetable.`
    : `Room ${room} has ${cnt} class${cnt === 1 ? '' : 'es'}${day ? ` on ${day}` : ' across the week'}`
      + (day ? '.' : `, busiest on ${days.reduce((a, b) => (b.sessions.length > (a?.sessions.length || 0) ? b : a), null).day}.`);
  out.results = { type: 'room_schedule', room, days };
  return out;
}

function finalizeTeacher(out, sessions, schedule, teacher, day) {
  let list = sessions.filter((s) => s.teacher === teacher);
  if (day) list = list.filter((s) => s.day === day);
  const days = groupByDay(list, schedule);
  out.answer = `${teacher} teaches ${list.length} session${list.length === 1 ? '' : 's'}${day ? ` on ${day}` : ' this week'}.`;
  out.results = { type: 'teacher_schedule', teacher, days };
  return out;
}

function finalizeCourse(out, sessions, schedule, code, day) {
  let list = sessions.filter((s) => s.code === code);
  if (day) list = list.filter((s) => s.day === day);
  const name = (list[0] && list[0].name) || code;
  const days = groupByDay(list, schedule);
  out.answer = list.length
    ? `${code} — ${name}: ${list.length} session${list.length === 1 ? '' : 's'}${day ? ` on ${day}` : ' this week'}.`
    : `${code} has no sessions${day ? ` on ${day}` : ''} in this timetable.`;
  out.results = { type: 'course_schedule', code, name, days };
  return out;
}

function finalizeProgram(out, sessions, schedule, program, day) {
  let list = sessions.filter((s) => s.program === program);
  if (day) list = list.filter((s) => s.day === day);
  const days = groupByDay(list, schedule);
  out.answer = `${program}: ${list.length} session${list.length === 1 ? '' : 's'}${day ? ` on ${day}` : ' this week'}.`;
  out.results = { type: 'program_schedule', program, days };
  return out;
}

function finalizeDay(out, sessions, schedule, day) {
  const list = sessions.filter((s) => s.day === day);
  // group by room for readability
  const byRoom = {};
  for (const s of list) (byRoom[s.room] = byRoom[s.room] || []).push(s);
  const rooms = Object.keys(byRoom).sort().map((r) => ({
    room: r, sessions: byRoom[r].sort((a, b) => slotIndex(schedule, a.slot) - slotIndex(schedule, b.slot)),
  }));
  out.answer = `${day}: ${list.length} classes scheduled across ${rooms.length} rooms.`;
  out.results = { type: 'day_schedule', day, rooms };
  return out;
}

// ── DATESHEET search ─────────────────────────────────────────────────────────
function searchDatesheet(record, schedule, q) {
  const courses = schedule.courses || [];
  const out = { ok: true, source: sourceMeta(record), matched: {}, corrections: [] };

  const codes = [...new Set(courses.map((c) => c.code))];
  const names = [...new Set(courses.map((c) => c.name))];

  // course code or name
  const codeTok = (q.toUpperCase().match(/[A-Z]{2,6}[-\s]?\d{3,4}/) || [])[0];
  let code = null;
  if (codeTok) {
    const cm = bestMatch(codeTok.replace(/[\s-]/g, ''), codes.map((c) => c.replace(/[\s-]/g, '')), 0.7);
    if (cm) code = codes.find((c) => c.replace(/[\s-]/g, '') === cm.value);
  }
  if (!code && q.length >= 4) {
    const nm = bestMatch(q, names, 0.6);
    if (nm) { const c = courses.find((x) => x.name === nm.value); code = c && c.code; }
  }
  if (code) {
    const c = courses.find((x) => x.code === code);
    out.matched.course = code;
    out.answer = c
      ? `${c.code} — ${c.name}: paper on ${c.day}, ${c.date_disp || c.date} at ${c.slot}.`
      : `${code} is not in this datesheet.`;
    out.results = c ? { type: 'exam', course: c } : null;
    return out;
  }

  // a date like "27 aug" or "27-aug"
  const dm = q.match(/(\d{1,2})[\s-]*([a-z]{3,})/);
  if (dm) {
    const day = courses.filter((c) => norm(c.date_disp || '').includes(norm(dm[1])) && norm(c.date_disp || '').includes(norm(dm[2].slice(0, 3))));
    if (day.length) {
      out.answer = `${day.length} paper(s) on ${day[0].date_disp}.`;
      out.results = { type: 'exam_day', date: day[0].date_disp, courses: day };
      return out;
    }
  }

  out.answer = `This datesheet (${record.meta && record.meta.heading ? record.meta.heading : ''}) has ${courses.length} papers `
    + `from ${schedule.start_date} to ${schedule.end_date}. Try a course code (e.g. "CS313") or a date (e.g. "27 Aug").`;
  out.results = { type: 'datesheet_overview', total: courses.length, start: schedule.start_date, end: schedule.end_date };
  return out;
}
