/**
 * Digital exam attendance.
 *
 * The seating roster (who must sit where) comes from AdmitVerification (built
 * with the admit cards). Scanning a card during its slot writes a PRESENT row in
 * the Attendance collection. A sheet for a (date, slot, room) is therefore the
 * roster for that cell, each student marked:
 *   • PRESENT  — a scan exists for this paper-session
 *   • ABSENT   — no scan AND the slot's finish time has passed
 *   • PENDING  — no scan yet but the slot is still running
 * When the slot ends the sheet is FINAL and ready to download. Everything is
 * derived live, so many rooms scanning at once just keep flipping cells to green.
 */
const AdmitVerification = require('../models/AdmitVerification');
const Attendance = require('../models/Attendance');
const GeneratedFile = require('../models/GeneratedFile');

// The admit-card batches that are CURRENT for attendance: the most recent batch
// of each program level (latest Undergraduate + latest Postgraduate), never
// old/superseded batches. Merging stale batches — each built from a different
// datesheet — is what made a room show more students than its seats. Restricting
// to the latest batch per level keeps every room to its real, single seating.
// `level` ('ug' | 'pg') narrows to just that level so BS and MS attendance are
// tracked and downloaded SEPARATELY.
async function currentBatchIds(level) {
  const batches = await GeneratedFile.find({ kind: 'admit_cards', archived: { $ne: true } })
    .sort({ createdAt: -1 }).select('title meta.programLevel createdAt').lean();
  const seen = new Set();
  const ids = [];
  for (const b of batches) {
    const lvl = (b.meta && b.meta.programLevel) || (/postgrad/i.test(b.title || '') ? 'Postgraduate' : 'Undergraduate');
    const key = /post/i.test(lvl) ? 'pg' : 'ug';
    if (level && key !== level) continue;
    if (!seen.has(key)) { seen.add(key); ids.push(b._id); }
  }
  return ids;
}
const normLevel = (l) => (String(l || '').toLowerCase() === 'pg' ? 'pg' : (String(l || '').toLowerCase() === 'ug' ? 'ug' : null));

function toMinutes(hhmm) {
  const m = String(hhmm || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2]);
  if (h >= 1 && h <= 7) h += 12;     // 1–7 on the exam clock = afternoon
  return h * 60 + min;
}

// Has the slot's finish time passed? (date 'YYYY-MM-DD', finish/slot label)
function slotEnded(date, finish) {
  // Pakistan time, whatever zone the server runs in
  return require('../utils/examClock').slotPhase(date, `00:00-${finish}`) === 'after';
}
const finishOfSlot = (slot) => String(slot || '').split('-')[1] || '';

// Seat order: 1, 1A, 2, 2A, 3, 3A ... (numeric first, plain "N" before "NA").
function seatKey(seat) {
  const m = String(seat || '').match(/(\d+)\s*([A-Za-z]?)/);
  const n = m ? parseInt(m[1], 10) : 99999;
  const suf = m && m[2] ? 1 : 0;
  return n * 10 + suf;
}

// The full seating roster for a (date, slot[, room]) from the admit cards.
// DEDUPED by (student, course): if several admit-card batches exist, only the
// LATEST batch's seating for each student-paper is used, so a student can never
// appear twice on one sheet.
async function roster(match) {
  const ids = await currentBatchIds(match.level);
  const pipe = [
    { $match: { batchId: { $in: ids } } },        // current batches only (no stale)
    { $sort: { createdAt: -1, _id: -1 } },        // latest batch wins
    { $unwind: '$exams' },
    { $match: { 'exams.date': match.date, 'exams.slot': match.slot } },
    { $group: {
      _id: { sid: '$studentId', code: '$exams.code' },
      studentId: { $first: '$studentId' }, name: { $first: '$name' }, program: { $first: '$program' },
      code: { $first: '$exams.code' }, courseName: { $first: '$exams.name' },
      room: { $first: '$exams.room' }, seat: { $first: '$exams.seat' },
      date: { $first: '$exams.date' }, slot: { $first: '$exams.slot' }, finish: { $first: '$exams.finish' },
    } },
  ];
  if (match.room) pipe.push({ $match: { room: match.room } });
  pipe.push({ $project: { _id: 0 } });
  return AdmitVerification.aggregate(pipe);
}

// GET /api/attendance/sessions  → every (date, slot) that has a paper, with a
// per-room breakdown + present/absent/pending counts. Powers the picker.
exports.sessions = async (req, res) => {
  try {
    const level = normLevel(req.query.level);
    // Attendance appears ONLY where scanning has STARTED — a (date, slot, room)
    // shows up the moment its first card is scanned, and fills live. Before any
    // scan, nothing is shown (no pre-built roster of the whole exam).
    const scans = await Attendance.aggregate([
      { $group: { _id: { date: '$date', slot: '$slot', room: '$room' }, present: { $sum: { $cond: [{ $eq: ['$status', 'absent'] }, 0, 1] } }, prog: { $first: '$program' } } },
    ]);
    let rooms = scans.map((s) => ({ date: s._id.date, slot: s._id.slot, room: s._id.room, present: s.present, prog: s.prog }));
    if (level) rooms = rooms.filter((r) => (progIsPG(r.prog) ? 'pg' : 'ug') === level);
    if (!rooms.length) return res.json({ sessions: [] });

    // Expected head-count per room (from the seating plan) — only for the slots
    // that already have scans, so we can show "X of Y" and the absent count.
    const totalMap = new Map();
    for (const ds of [...new Set(rooms.map((r) => `${r.date}|${r.slot}`))]) {
      const [date, slot] = ds.split('|');
      const rs = await roster({ date, slot, level });
      const byRoom = {};
      for (const r of rs) byRoom[r.room] = (byRoom[r.room] || 0) + 1;
      for (const [rm, n] of Object.entries(byRoom)) totalMap.set(`${date}|${slot}|${rm}`, n);
    }

    const byslot = new Map();
    for (const r of rooms) {
      const key = `${r.date}|${r.slot}`;
      const total = totalMap.get(`${r.date}|${r.slot}|${r.room}`) || r.present;
      const ended = slotEnded(r.date, finishOfSlot(r.slot));
      if (!byslot.has(key)) byslot.set(key, { date: r.date, slot: r.slot, rooms: [], total: 0, present: 0 });
      const s = byslot.get(key);
      s.rooms.push({ room: r.room, total, present: r.present, absent: ended ? Math.max(0, total - r.present) : 0, final: ended });
      s.total += total; s.present += r.present;
    }
    const sessions = [...byslot.values()].map((s) => {
      const ended = slotEnded(s.date, finishOfSlot(s.slot));
      s.rooms.sort((a, b) => String(a.room).localeCompare(String(b.room)));
      return { ...s, final: ended, absent: ended ? Math.max(0, s.total - s.present) : 0 };
    }).sort((a, b) => a.date.localeCompare(b.date) || (toMinutes(a.slot) - toMinutes(b.slot)));
    res.json({ sessions });
  } catch (e) {
    console.error('attendance.sessions:', e.message);
    res.status(500).json({ error: 'Could not load attendance sessions.' });
  }
};

// A student's level from their degree program (BS/BE/Doctor → ug, MS/MPhil/PhD → pg).
const progIsPG = (p) => /\b(ms|m\.?s|m\.?phil|mphil|ph\.?d|phd|master)\b/i.test(String(p || '')) || /post/i.test(String(p || ''));
const _seatSort = (a, b) => String(a.room).localeCompare(String(b.room))
  || seatKey(a.seat) - seatKey(b.seat) || String(a.seat).localeCompare(String(b.seat));

// Build a sheet for a (date, slot[, room], level).
//  • WHILE the slot is running  → LIVE list: ONLY the students already SCANNED
//    (present), each shown with the seat read from their card, in seat order —
//    the sheet fills up as scanning happens (no pre-built pending roster).
//  • ONCE the slot's finish time passes → COMPLETE list: every student on the
//    seating plan, the un-scanned ones now ABSENT, ready to download.
async function buildSheet(date, slot, room, level) {
  const ended = slotEnded(date, finishOfSlot(slot));
  let marks = await Attendance.find({ date, slot, status: { $ne: 'absent' }, ...(room ? { room } : {}) }).lean();
  if (level) marks = marks.filter((m) => (progIsPG(m.program) ? 'pg' : 'ug') === level);

  if (!ended) {
    const rows = marks.map((m) => ({
      studentId: m.studentId, name: m.name, program: m.program, code: m.code,
      courseName: m.courseName, room: m.room, seat: m.seat, status: 'present', scannedAt: m.scannedAt,
    }));
    rows.sort(_seatSort);
    const expected = (await roster({ date, slot, room, level })).length;   // for "X of Y"
    return { date, slot, room: room || null, final: false, rows,
      counts: { total: expected, present: rows.length, absent: 0, pending: Math.max(0, expected - rows.length) } };
  }

  const rosterRows = await roster({ date, slot, room, level });
  const pset = new Map(marks.map((m) => [`${m.studentId}|${m.code}`, m.scannedAt]));
  const out = rosterRows.map((r) => {
    const at = pset.get(`${r.studentId}|${r.code}`);
    return { ...r, status: at ? 'present' : 'absent', scannedAt: at || null };
  });
  out.sort(_seatSort);
  const present = out.filter((r) => r.status === 'present').length;
  return { date, slot, room: room || null, final: true, rows: out,
    counts: { total: out.length, present, absent: out.length - present, pending: 0 } };
}

// GET /api/attendance/sheet?date=&slot=&room=
exports.sheet = async (req, res) => {
  try {
    const { date, slot, room } = req.query;
    if (!date || !slot) return res.status(400).json({ error: 'date and slot are required.' });
    res.json(await buildSheet(date, slot, room || null, normLevel(req.query.level)));
  } catch (e) {
    console.error('attendance.sheet:', e.message);
    res.status(500).json({ error: 'Could not build the attendance sheet.' });
  }
};

// GET /api/attendance/sheet.pdf?date=&slot=&room=   (room optional → all rooms)
exports.sheetPdf = async (req, res) => {
  try {
    const { date, slot, room } = req.query;
    if (!date || !slot) return res.status(400).json({ error: 'date and slot are required.' });
    const sheet = await buildSheet(date, slot, room || null, normLevel(req.query.level));
    if (!sheet.rows.length) return res.status(404).json({ error: 'No students on this session.' });
    // Download ONLY after the slot is fully over — until then attendance is still
    // being taken (e.g. a 09:00-10:30 sheet becomes downloadable at 10:31).
    if (!sheet.final) {
      return res.status(409).json({ error: `This attendance sheet will be ready to download once the ${slot} slot ends.` });
    }

    const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const GREEN = rgb(0.06, 0.32, 0.18), GREY = rgb(0.36, 0.42, 0.39);
    const RED = rgb(0.55, 0.12, 0.16), OK = rgb(0.06, 0.4, 0.24);

    // group rows by room so each room is its own set of pages
    const byRoom = new Map();
    for (const r of sheet.rows) { const k = r.room || '—'; (byRoom.get(k) || byRoom.set(k, []).get(k)).push(r); }

    const A4 = [595.28, 841.89];
    const M = 40; const rowH = 18; const perPage = 34;
    for (const [rm, rrows] of [...byRoom.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
      // SEAT-WISE order inside the room: 1, 1A, 2, 2A, … (already sorted in
      // buildSheet, but keep it explicit here).
      const flat = [...rrows].sort((a, b) => seatKey(a.seat) - seatKey(b.seat) || String(a.seat).localeCompare(String(b.seat)));

      for (let i = 0; i < flat.length; i += perPage) {
        const chunk = flat.slice(i, i + perPage);
        const pg = pdf.addPage(A4);
        let y = A4[1] - M;
        pg.drawText('ABASYN UNIVERSITY — EXAM ATTENDANCE SHEET', { x: M, y, size: 13, font: bold, color: GREEN }); y -= 16;
        pg.drawText(`Room: ${rm}    Date: ${date}    Time: ${slot}    FINAL`, { x: M, y, size: 10, font, color: GREY }); y -= 12;
        const pres = rrows.filter((r) => r.status === 'present').length;
        const abs = rrows.filter((r) => r.status === 'absent').length;
        pg.drawText(`Present: ${pres}    Absent: ${abs}    Total: ${rrows.length}`, { x: M, y, size: 10, font, color: GREY }); y -= 16;
        // header — SEAT-led, no serial, no signature
        const cols = [M, M + 60, M + 150, M + 350, M + 450]; // Seat, Reg No, Name, Course, Status
        const H = ['Seat', 'Reg No', 'Name', 'Course', 'Status'];
        H.forEach((h, k) => pg.drawText(h, { x: cols[k], y, size: 9, font: bold, color: GREEN }));
        y -= 4; pg.drawLine({ start: { x: M, y }, end: { x: A4[0] - M, y }, thickness: 0.8, color: GREEN }); y -= rowH;
        chunk.forEach((r) => {
          const st = r.status === 'present' ? 'PRESENT' : r.status === 'absent' ? 'ABSENT' : '—';
          const col = r.status === 'present' ? OK : r.status === 'absent' ? RED : GREY;
          pg.drawText(String(r.seat || ''), { x: cols[0], y, size: 9, font: bold, color: GREEN });
          pg.drawText(String(r.studentId || ''), { x: cols[1], y, size: 8.5, font });
          pg.drawText(String(r.name || '').slice(0, 34), { x: cols[2], y, size: 8.5, font });
          pg.drawText(String(r.code || ''), { x: cols[3], y, size: 8.5, font });
          pg.drawText(st, { x: cols[4], y, size: 8.5, font: bold, color: col });
          pg.drawLine({ start: { x: M, y: y - 5 }, end: { x: A4[0] - M, y: y - 5 }, thickness: 0.3, color: rgb(0.85, 0.9, 0.87) });
          y -= rowH;
        });
      }
    }
    const bytes = await pdf.save();
    const safe = `Attendance_${date}_${String(slot).replace(/[^0-9]/g, '')}${room ? '_' + String(room).replace(/[^A-Za-z0-9]/g, '') : ''}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
    res.send(Buffer.from(bytes));
  } catch (e) {
    console.error('attendance.sheetPdf:', e.message);
    res.status(500).json({ error: 'Could not build the attendance PDF.' });
  }
};

/* ═══════════════ Room-wise attendance files (per paper) ═══════════════
 * Every room that has a paper shows as a strip. Inside it, one FILE per paper
 * (course code + date + time). Before / during the paper each student is "-";
 * a scan turns it into "P"; when the paper's time is over the rest become "A"
 * and only then the file can be downloaded. Times are Pakistan time. */
const clock = require('../utils/examClock');

let _rc = { key: '', at: 0, rows: [] };
async function allRoster() {
  const ids = await currentBatchIds(null);
  const key = ids.map(String).join(',');
  if (_rc.key === key && Date.now() - _rc.at < 30000) return _rc.rows;
  const docs = await AdmitVerification.find({ batchId: { $in: ids } })
    .select('studentId name program batch createdAt exams.code exams.name exams.date exams.dateDisp exams.day exams.slot exams.room exams.seat exams.section')
    .sort({ createdAt: -1 }).lean();
  const seen = new Set(); const rows = [];
  for (const d of docs) {
    for (const e of d.exams || []) {
      const k = `${d.studentId}|${e.code}|${e.date}|${e.slot}`;
      if (seen.has(k)) continue;           // latest batch wins
      seen.add(k);
      rows.push({ studentId: d.studentId, name: d.name, program: d.program, batch: d.batch,
        code: e.code, courseName: e.name || '', date: e.date, dateDisp: e.dateDisp || e.date, day: e.day || '',
        slot: e.slot, room: e.room || '—', seat: e.seat || '', section: e.section || '' });
    }
  }
  _rc = { key, at: Date.now(), rows };
  return rows;
}
// key "sid|code|date|slot" → { present, at, manual, added } for every attendance row
async function scanMap(match) {
  const m = new Map();
  for (const a of await Attendance.find(match).select('studentId code date slot scannedAt createdAt status source added editedBy editedAt').lean()) {
    m.set(`${a.studentId}|${a.code}|${a.date}|${a.slot}`, {
      present: a.status !== 'absent', at: a.scannedAt || null, manual: a.source === 'manual' || !!a.editedAt,
      added: !!a.added, editedBy: a.editedBy || '', editedAt: a.editedAt || null,
    });
  }
  return m;
}
// Students the Exam Cell ADDED by hand to a paper (not on the seating plan) —
// they appear in the room / paper lists exactly like seated students.
async function addedRoster(match) {
  const docs = await Attendance.find({ ...match, added: true }).lean();
  return docs.map((a) => ({ studentId: a.studentId, name: a.name, program: a.program, batch: a.batch,
    code: a.code, courseName: a.courseName || '', date: a.date, dateDisp: a.dateDisp || a.date, day: a.day || '',
    slot: a.slot, room: a.room || '—', seat: a.seat || '', section: a.section || '', added: true }));
}
// Roster + hand-added students (an added student already on the plan is ignored).
async function fullRoster(match = {}) {
  const base = await allRoster();
  const keys = new Set(base.map((r) => `${r.studentId}|${r.code}|${r.date}|${r.slot}`));
  const extra = (await addedRoster(match)).filter((r) => !keys.has(`${r.studentId}|${r.code}|${r.date}|${r.slot}`));
  if (!extra.length) return base;
  // borrow date labels / course name from the plan
  const lab = new Map(base.map((r) => [`${r.date}|${r.slot}|${r.code}`, r]));
  for (const x of extra) { const l = lab.get(`${x.date}|${x.slot}|${x.code}`); if (l) { x.dateDisp = l.dateDisp; x.day = l.day; x.courseName = x.courseName || l.courseName; } }
  return base.concat(extra);
}
const phaseState = (p) => (p === 'after' ? 'final' : p === 'during' ? 'live' : 'upcoming');
const levelOk = (level) => (r) => !level || (progIsPG(r.program) ? 'pg' : 'ug') === level;

// GET /api/attendance/rooms[?date=YYYY-MM-DD][&level=ug|pg]
exports.rooms = async (req, res) => {
  try {
    const level = normLevel(req.query.level);
    const all = (await fullRoster()).filter(levelOk(level));
    const dates = new Map();
    for (const r of all) if (!dates.has(r.date)) dates.set(r.date, { date: r.date, dateDisp: r.dateDisp, day: r.day });
    const date = req.query.date && req.query.date !== 'all' ? String(req.query.date) : null;
    const rows = date ? all.filter((r) => r.date === date) : all;
    const scans = await scanMap(date ? { date } : {});

    const rooms = new Map();
    for (const r of rows) {
      if (!rooms.has(r.room)) rooms.set(r.room, new Map());
      const pk = `${r.date}|${r.slot}|${r.code}`;
      const pm = rooms.get(r.room);
      if (!pm.has(pk)) pm.set(pk, { date: r.date, dateDisp: r.dateDisp, day: r.day, slot: r.slot, code: r.code, courseName: r.courseName, total: 0, present: 0, secs: new Map() });
      const p = pm.get(pk);
      const sm = scans.get(`${r.studentId}|${r.code}|${r.date}|${r.slot}`);
      const hit = !!(sm && sm.present);
      p.total++;
      if (hit) p.present++;
      const sk = r.section || '';
      if (!p.secs.has(sk)) p.secs.set(sk, { section: sk, total: 0, present: 0 });
      const sc = p.secs.get(sk); sc.total++; if (hit) sc.present++;
    }
    const order = (a, b) => a.date.localeCompare(b.date) || (clock.toMinutes(a.slot) - clock.toMinutes(b.slot)) || a.code.localeCompare(b.code);
    const out = [...rooms.entries()].map(([room, pm]) => {
      const papers = [...pm.values()].map((p) => {
        const state = phaseState(clock.slotPhase(p.date, p.slot));
        const fin = state === 'final';
        // a course taught in sections (A / B / C) → one attendance list per section
        const secList = [...p.secs.values()].sort((a, b) => (a.section || '~').localeCompare(b.section || '~'));
        const sections = secList.some((x) => x.section)
          ? secList.map((x) => ({ ...x, absent: fin ? x.total - x.present : 0 }))
          : [];
        const { secs, ...rest } = p; void secs;
        return { ...rest, sections, state, absent: fin ? p.total - p.present : 0, downloadable: fin };
      }).sort(order);
      const sum = (k) => papers.reduce((n, p) => n + p[k], 0);
      const state = papers.some((p) => p.state === 'live') ? 'live' : papers.every((p) => p.state === 'final') ? 'final' : 'upcoming';
      return { room, papers, total: sum('total'), present: sum('present'), absent: sum('absent'), state,
        sittings: new Set(papers.map((p) => `${p.date}|${p.slot}`)).size };
    }).sort((a, b) => String(a.room).localeCompare(String(b.room), undefined, { numeric: true }));
    const now = clock.now();
    res.json({ now: { ...now, tz: clock.TZ }, dates: [...dates.values()].sort((a, b) => a.date.localeCompare(b.date)), date: date || 'all', rooms: out, examEnd: examEndOf(all) });
  } catch (e) {
    console.error('attendance.rooms:', e.message);
    res.status(500).json({ error: 'Could not load the exam rooms.' });
  }
};

async function paperSheet(q) {
  const { date, slot, room, code } = q;
  const level = normLevel(q.level);
  const section = q.section == null ? null : String(q.section);   // '' = students with no section
  const rows = (await fullRoster({ date, slot, code })).filter((r) => r.date === date && r.slot === slot && r.room === room && r.code === code)
    .filter((r) => section === null || (r.section || '') === section).filter(levelOk(level));
  const scans = await scanMap({ date, slot, code });
  const phase = clock.slotPhase(date, slot);
  const state = phaseState(phase);
  const out = rows.map((r) => {
    const sm = scans.get(`${r.studentId}|${r.code}|${r.date}|${r.slot}`) || null;
    const isP = !!(sm && sm.present);
    return { seat: r.seat, studentId: r.studentId, name: r.name, program: r.program, batch: r.batch, section: r.section,
      mark: isP ? 'P' : (state === 'final' ? 'A' : '-'), scannedAt: sm && sm.present && !sm.manual ? sm.at : null,
      manual: !!(sm && sm.manual), added: !!r.added, editedBy: (sm && sm.editedBy) || '' };
  }).sort((a, b) => seatKey(a.seat) - seatKey(b.seat) || String(a.seat).localeCompare(String(b.seat)));
  const present = out.filter((r) => r.mark === 'P').length;
  const first = rows[0] || {};
  return { date, dateDisp: first.dateDisp || date, day: first.day || '', slot, room, code, courseName: first.courseName || '',
    section, state, downloadable: state === 'final', rows: out,
    counts: { total: out.length, present, absent: state === 'final' ? out.length - present : 0, notYet: state === 'final' ? 0 : out.length - present } };
}

// GET /api/attendance/paper?date=&slot=&room=&code=
exports.paper = async (req, res) => {
  try {
    const { date, slot, room, code } = req.query;
    if (!date || !slot || !room || !code) return res.status(400).json({ error: 'date, slot, room and code are required.' });
    res.json(await paperSheet(req.query));
  } catch (e) {
    console.error('attendance.paper:', e.message);
    res.status(500).json({ error: 'Could not load the attendance file.' });
  }
};

// GET /api/attendance/paper.pdf?date=&slot=&room=&code=   (only after the paper's time is over)
exports.paperPdf = async (req, res) => {
  try {
    const { date, slot, room, code } = req.query;
    if (!date || !slot || !room || !code) return res.status(400).json({ error: 'date, slot, room and code are required.' });
    const sh = await paperSheet(req.query);
    if (!sh.rows.length) return res.status(404).json({ error: 'No students are seated for this paper in this room.' });
    if (!sh.downloadable) {
      const fm = clock.toMinutes(String(slot).split('-')[1] || '');
      const end = fm == null ? '' : `${((Math.floor(fm / 60) + 11) % 12) + 1}:${String(fm % 60).padStart(2, '0')} ${fm >= 720 ? 'PM' : 'AM'}`;
      return res.status(409).json({ error: `${code}${sh.section ? ` Section ${sh.section}` : ''} attendance (${room}) can be downloaded after the paper ends — ${sh.dateDisp} at ${end}.` });
    }
    const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const GREEN = rgb(0.06, 0.32, 0.18); const GREY = rgb(0.36, 0.42, 0.39);
    const RED = rgb(0.6, 0.1, 0.14); const OK = rgb(0.05, 0.42, 0.24); const LINE = rgb(0.82, 0.88, 0.85);
    const A4 = [595.28, 841.89]; const M = 36; const rowH = 17; const perPage = 38;
    const fit = (t, f, size, w) => { let s = String(t || ''); while (s && f.widthOfTextAtSize(s, size) > w) s = s.slice(0, -1); return s; };
    const pages = Math.max(1, Math.ceil(sh.rows.length / perPage));
    const hasSec = sh.rows.some((r) => r.section);
    const cols = hasSec
      ? [['Seat', 0, 40], ['Reg No', 40, 55], ['Student Name', 95, 165], ['Degree / Batch', 260, 170], ['Sec', 430, 30], ['Attendance', 460, 63]]
      : [['Seat', 0, 40], ['Reg No', 40, 55], ['Student Name', 95, 175], ['Degree / Batch', 270, 190], ['Attendance', 460, 63]];
    for (let pi = 0; pi < pages; pi++) {
      const pg = pdf.addPage(A4);
      let y = A4[1] - M;
      pg.drawText('ABASYN UNIVERSITY ISLAMABAD CAMPUS', { x: M, y, size: 13, font: bold, color: GREEN }); y -= 15;
      pg.drawText('Examination Attendance', { x: M, y, size: 10.5, font: bold, color: GREY }); y -= 18;
      pg.drawText(fit(`${sh.code} — ${sh.courseName}${sh.section ? `   ·   Section ${sh.section}` : ''}`, bold, 11, A4[0] - 2 * M), { x: M, y, size: 11, font: bold }); y -= 14;
      pg.drawText(`Room: ${sh.room}     Date: ${sh.day ? sh.day + ', ' : ''}${sh.dateDisp}     Time: ${sh.slot}`, { x: M, y, size: 9.5, font, color: GREY }); y -= 13;
      pg.drawText(`Present (P): ${sh.counts.present}     Absent (A): ${sh.counts.absent}     Total: ${sh.counts.total}     Page ${pi + 1} of ${pages}`, { x: M, y, size: 9.5, font: bold, color: GREEN }); y -= 16;
      for (const [h, x] of cols) pg.drawText(h, { x: M + x + 2, y, size: 8.8, font: bold, color: GREEN });
      y -= 5; pg.drawLine({ start: { x: M, y }, end: { x: A4[0] - M, y }, thickness: 0.9, color: GREEN }); y -= rowH - 4;
      for (const r of sh.rows.slice(pi * perPage, (pi + 1) * perPage)) {
        const vals = hasSec
          ? [r.seat, r.studentId, r.name, r.batch || r.program, r.section || '', r.mark]
          : [r.seat, r.studentId, r.name, r.batch || r.program, r.mark];
        vals.forEach((v, k) => {
          const [, x, w] = cols[k];
          const isMark = k === vals.length - 1;
          pg.drawText(fit(v, isMark ? bold : font, isMark ? 10 : 8.5, w - 4), {
            x: M + x + 2 + (isMark ? 20 : 0), y, size: isMark ? 10 : 8.5, font: isMark || k === 0 ? bold : font,
            color: isMark ? (v === 'P' ? OK : RED) : (k === 0 ? GREEN : rgb(0, 0, 0)) });
        });
        pg.drawLine({ start: { x: M, y: y - 5 }, end: { x: A4[0] - M, y: y - 5 }, thickness: 0.3, color: LINE });
        y -= rowH;
      }
      pg.drawText(`P = present (admit card scanned during the paper)   A = absent   ·   generated ${(() => { const n = clock.now(); return `${n.date} ${String(Math.floor(n.minutes / 60)).padStart(2, '0')}:${String(n.minutes % 60).padStart(2, '0')}`; })()} (PKT)`, { x: M, y: 24, size: 7.5, font, color: GREY });
    }
    const bytes = await pdf.save();
    const safe = `Attendance_${code}${sh.section ? `-${sh.section}` : ''}_${room}_${date}_${String(slot).replace(/[^0-9]/g, '')}`.replace(/[^A-Za-z0-9_-]+/g, '') + '.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(bytes));
  } catch (e) {
    console.error('attendance.paperPdf:', e.message);
    res.status(500).json({ error: 'Could not build the attendance PDF.' });
  }
};

/* ═══════════════ Corrections after a paper (Exam Cell) ═══════════════
 * Once a paper's time is over its list is FINAL. The Exam Cell can then
 *   • switch any student P ⇄ A                        POST /mark
 *   • add a student who sat the paper but is not on the seating plan   POST /add
 *   • remove a student it added by mistake           POST /remove-added
 * Every change is stamped with who made it and when. Nothing can be changed
 * while a paper is upcoming or running (scanning owns those). */
const str = (v, n = 120) => String(v == null ? '' : v).trim().slice(0, n);
const isFinal = (date, slot) => clock.slotPhase(date, slot) === 'after';
function paperKeyOk(b) {
  const date = str(b.date, 10); const slot = str(b.slot, 20); const code = str(b.code, 20).toUpperCase(); const room = str(b.room, 60);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(slot) || !code || !room) return null;
  return { date, slot, code, room };
}
function bumpCache() { _rc = { key: '', at: 0, rows: [] }; }

// POST /api/attendance/mark  { date, slot, code, room, studentId, mark: 'P' | 'A' }
exports.mark = async (req, res) => {
  try {
    const k = paperKeyOk(req.body || {});
    const sid = str(req.body && req.body.studentId, 40);
    const mark = String((req.body && req.body.mark) || '').toUpperCase();
    if (!k || !sid || !['P', 'A'].includes(mark)) return res.status(400).json({ error: 'date, slot, code, room, studentId and mark (P or A) are required.' });
    if (!isFinal(k.date, k.slot)) return res.status(409).json({ error: 'Attendance can be changed only after the paper has ended.' });
    const r = (await fullRoster({ date: k.date, slot: k.slot, code: k.code }))
      .find((x) => x.studentId === sid && x.code === k.code && x.date === k.date && x.slot === k.slot && x.room === k.room);
    if (!r) return res.status(404).json({ error: `${sid} is not on the ${k.code} list in ${k.room}.` });
    await Attendance.updateOne(
      { studentId: sid, code: k.code, date: k.date, slot: k.slot },
      {
        $set: { status: mark === 'P' ? 'present' : 'absent', editedBy: (req.user && req.user.username) || '', editedAt: new Date() },
        $setOnInsert: { name: r.name, program: r.program, batch: r.batch || '', courseName: r.courseName, room: r.room, seat: r.seat,
          section: r.section || '', source: 'manual', scannedAt: null },
      },
      { upsert: true },
    );
    try { await require('../utils/logger').logActivity('attendance.edit', `${k.code} ${k.date} ${k.slot} ${k.room}: ${sid} set to ${mark}`, 'info'); } catch { /* optional */ }
    res.json({ ok: true, studentId: sid, mark });
  } catch (e) {
    console.error('attendance.mark:', e.message);
    res.status(500).json({ error: 'Could not change the attendance.' });
  }
};

// POST /api/attendance/add  { date, slot, code, room, studentId, name, program?, batch?, seat?, section?, mark }
exports.add = async (req, res) => {
  try {
    const b = req.body || {};
    const k = paperKeyOk(b);
    const sid = str(b.studentId, 40); const name = str(b.name, 100);
    const mark = String(b.mark || '').toUpperCase();
    if (!k) return res.status(400).json({ error: 'Open a paper first (date, time, course and room are needed).' });
    if (!sid || !name) return res.status(400).json({ error: 'Registration No and Student Name are required.' });
    if (!['P', 'A'].includes(mark)) return res.status(400).json({ error: 'Choose P (present) or A (absent).' });
    if (!isFinal(k.date, k.slot)) return res.status(409).json({ error: 'A student can be added only after the paper has ended.' });
    const onList = (await fullRoster({ date: k.date, slot: k.slot, code: k.code }))
      .find((x) => x.studentId === sid && x.code === k.code && x.date === k.date && x.slot === k.slot);
    if (onList) return res.status(409).json({ error: `${sid} is already on the ${k.code} list (${onList.room}${onList.seat ? `, seat ${onList.seat}` : ''}) — change P / A there.` });
    const plan = (await allRoster()).find((x) => x.code === k.code && x.date === k.date && x.slot === k.slot);
    await Attendance.create({
      studentId: sid, name, program: str(b.program, 120), batch: str(b.batch, 120), code: k.code,
      courseName: (plan && plan.courseName) || str(b.courseName, 120), date: k.date, slot: k.slot, room: k.room,
      seat: str(b.seat, 10), section: str(b.section, 5).toUpperCase(), status: mark === 'P' ? 'present' : 'absent',
      scannedAt: null, source: 'manual', added: true, editedBy: (req.user && req.user.username) || '', editedAt: new Date(),
    });
    bumpCache();
    try { await require('../utils/logger').logActivity('attendance.add', `${k.code} ${k.date} ${k.slot} ${k.room}: added ${sid} ${name} as ${mark}`, 'info'); } catch { /* optional */ }
    res.json({ ok: true });
  } catch (e) {
    if (e && e.code === 11000) return res.status(409).json({ error: 'This student is already on this paper.' });
    console.error('attendance.add:', e.message);
    res.status(500).json({ error: 'Could not add the student.' });
  }
};

// POST /api/attendance/remove-added  { date, slot, code, studentId }  — only hand-added students
exports.removeAdded = async (req, res) => {
  try {
    const b = req.body || {};
    const date = str(b.date, 10); const slot = str(b.slot, 20); const code = str(b.code, 20).toUpperCase(); const sid = str(b.studentId, 40);
    if (!date || !slot || !code || !sid) return res.status(400).json({ error: 'date, slot, code and studentId are required.' });
    const r = await Attendance.deleteOne({ studentId: sid, code, date, slot, added: true });
    if (!r.deletedCount) return res.status(404).json({ error: 'Only a student added by hand can be removed.' });
    try { await require('../utils/logger').logActivity('attendance.remove', `${code} ${date} ${slot}: removed added student ${sid}`, 'info'); } catch { /* optional */ }
    res.json({ ok: true });
  } catch (e) {
    console.error('attendance.removeAdded:', e.message);
    res.status(500).json({ error: 'Could not remove the student.' });
  }
};

// GET /api/attendance/student?sid=  → name / degree / batch to pre-fill "Add a student"
exports.student = async (req, res) => {
  try {
    const sid = str(req.query.sid, 40);
    if (!sid) return res.json({ found: false });
    const d = await AdmitVerification.findOne({ studentId: sid }).sort({ createdAt: -1 }).select('studentId name program batch').lean();
    if (d) return res.json({ found: true, studentId: d.studentId, name: d.name, program: d.program, batch: d.batch });
    try {
      const SR = require('../models/StudentRegistration');
      const r = await SR.findOne({ studentId: sid }).lean();
      if (r) return res.json({ found: true, studentId: sid, name: r.name || '', program: r.program || '', batch: r.batch || '' });
    } catch { /* model shape differs — no pre-fill */ }
    res.json({ found: false });
  } catch (e) {
    res.json({ found: false });
  }
};

/* ═══════════════ Export Absentees (after the LAST paper) ═══════════════ */
// The last paper of the whole exam: { date, slot, dateDisp, day, ended }
function examEndOf(rows) {
  let last = null;
  for (const r of rows) {
    const end = clock.toMinutes(String(r.slot).split('-')[1] || '') || 0;
    if (!last || r.date > last.date || (r.date === last.date && end > last.end)) last = { date: r.date, slot: r.slot, end, dateDisp: r.dateDisp, day: r.day };
  }
  if (!last) return null;
  return { date: last.date, slot: last.slot, dateDisp: last.dateDisp, day: last.day, ended: isFinal(last.date, last.slot) };
}

// GET /api/attendance/absentees[?level=ug|pg]  → every paper's totals + every absent student
exports.absentees = async (req, res) => {
  try {
    const level = normLevel(req.query.level);
    const all = (await fullRoster()).filter(levelOk(level));
    const end = examEndOf(all);
    if (!end) return res.status(404).json({ error: 'No papers found.' });
    if (!end.ended) {
      const fm = clock.toMinutes(String(end.slot).split('-')[1] || '');
      const t = fm == null ? '' : `${((Math.floor(fm / 60) + 11) % 12) + 1}:${String(fm % 60).padStart(2, '0')} ${fm >= 720 ? 'PM' : 'AM'}`;
      return res.status(409).json({ error: `Absentees can be exported after the last paper ends — ${end.day ? `${end.day}, ` : ''}${end.dateDisp} at ${t}.` });
    }
    const scans = await scanMap({});
    const papers = new Map(); const absentees = [];
    for (const r of all) {
      const sm = scans.get(`${r.studentId}|${r.code}|${r.date}|${r.slot}`);
      const present = !!(sm && sm.present);
      const pk = `${r.date}|${r.slot}|${r.code}|${r.room}`;
      if (!papers.has(pk)) papers.set(pk, { date: r.date, dateDisp: r.dateDisp, day: r.day, slot: r.slot, code: r.code, courseName: r.courseName, room: r.room, total: 0, present: 0, absent: 0 });
      const p = papers.get(pk); p.total++; if (present) p.present++; else p.absent++;
      if (!present) {
        absentees.push({ date: r.date, dateDisp: r.dateDisp, day: r.day, slot: r.slot, code: r.code, courseName: r.courseName,
          section: r.section || '', room: r.room, seat: r.seat, studentId: r.studentId, name: r.name, program: r.program, batch: r.batch || '',
          note: sm && sm.manual ? 'Marked A by Exam Cell' : (r.added ? 'Added by Exam Cell' : '') });
      }
    }
    const byTime = (a, b) => a.date.localeCompare(b.date) || (clock.toMinutes(a.slot) - clock.toMinutes(b.slot));
    absentees.sort((a, b) => byTime(a, b) || a.code.localeCompare(b.code) || String(a.room).localeCompare(String(b.room), undefined, { numeric: true }) || seatKey(a.seat) - seatKey(b.seat));
    const list = [...papers.values()].sort((a, b) => byTime(a, b) || a.code.localeCompare(b.code) || String(a.room).localeCompare(String(b.room), undefined, { numeric: true }));
    const n = clock.now();
    res.json({ level: level || 'all', examEnd: end, generatedAt: `${n.date} ${String(Math.floor(n.minutes / 60)).padStart(2, '0')}:${String(n.minutes % 60).padStart(2, '0')}`,
      papers: list, absentees });
  } catch (e) {
    console.error('attendance.absentees:', e.message);
    res.status(500).json({ error: 'Could not build the absentee list.' });
  }
};
