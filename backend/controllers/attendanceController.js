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
  const now = new Date();
  const [Y, M, D] = String(date || '').split('-').map(Number);
  if (!Y) return false;
  const fm = toMinutes(finish);
  const end = new Date(Y, (M || 1) - 1, D || 1, Math.floor((fm ?? 1439) / 60), (fm ?? 1439) % 60, 0);
  return now.getTime() > end.getTime();
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
      { $group: { _id: { date: '$date', slot: '$slot', room: '$room' }, present: { $sum: 1 }, prog: { $first: '$program' } } },
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
  let marks = await Attendance.find({ date, slot, ...(room ? { room } : {}) }).lean();
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
