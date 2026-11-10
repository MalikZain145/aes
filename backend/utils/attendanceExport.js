/**
 * Attendance Excel workbooks (Export Absentees / Presentees / All) — shared by the
 * Exam Attendance page and the exam archive. The rows are always built from the
 * LIVE Attendance collection at the moment of export, so every correction made by
 * the Exam Cell (P ⇄ A, added students) shows in the next file.
 *
 * The workbook itself (formatting, totals, native Excel charts) is drawn by
 * scheduler/attendance_export.py with openpyxl.
 */
const fs = require('fs');
const path = require('path');
const AdmitVerification = require('../models/AdmitVerification');
const Attendance = require('../models/Attendance');
const clock = require('./examClock');
const { runPython, OUTPUT_DIR, ensureOutputDir } = require('./pythonRunner');

const TYPES = ['absent', 'present', 'all'];
const FILE_WORD = { absent: 'Absentees', present: 'Presentees', all: 'Attendance_All' };

/** P (present) | A (absent: paper over, no present mark) | N (not yet held) */
function statusOf(row, mark) {
  if (mark && mark.present) return 'P';
  if (mark && !mark.present) return clock.slotPhase(row.date, row.slot) === 'after' ? 'A' : 'N';
  return clock.slotPhase(row.date, row.slot) === 'after' ? 'A' : 'N';
}

/** Admit-card verification docs (newest first) → one roster row per student-paper. */
function rosterFromDocs(docs) {
  const seen = new Set(); const rows = [];
  for (const d of docs) {
    for (const e of d.exams || []) {
      const k = `${d.studentId}|${e.code}|${e.date}|${e.slot}`;
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push({ studentId: d.studentId, name: d.name, program: d.program, batch: d.batch || '',
        code: e.code, courseName: e.name || '', date: e.date, dateDisp: e.dateDisp || e.date, day: e.day || '',
        slot: e.slot, room: e.room || '—', seat: e.seat || '', section: e.section || '' });
    }
  }
  return rows;
}

async function rosterForBatches(batchIds) {
  const docs = await AdmitVerification.find({ batchId: { $in: batchIds } })
    .select('studentId name program batch createdAt exams.code exams.name exams.date exams.dateDisp exams.day exams.slot exams.room exams.seat exams.section')
    .sort({ createdAt: -1 }).lean();
  return rosterFromDocs(docs);
}

/**
 * Roster rows + live attendance → rows with status. Students the Exam Cell ADDED
 * by hand to one of these papers are included too.
 */
async function withStatus(roster) {
  const dates = [...new Set(roster.map((r) => r.date))];
  const att = dates.length ? await Attendance.find({ date: { $in: dates } })
    .select('studentId name program batch code courseName date slot room seat section status source added editedAt booklet').lean() : [];
  const marks = new Map();
  for (const a of att) marks.set(`${a.studentId}|${a.code}|${a.date}|${a.slot}`, a);
  const keys = new Set(roster.map((r) => `${r.studentId}|${r.code}|${r.date}|${r.slot}`));
  const papers = new Map(roster.map((r) => [`${r.date}|${r.slot}|${r.code}`, r]));
  const rows = roster.map((r) => ({ ...r }));
  for (const a of att) {
    if (!a.added) continue;
    const k = `${a.studentId}|${a.code}|${a.date}|${a.slot}`;
    const p = papers.get(`${a.date}|${a.slot}|${a.code}`);
    if (keys.has(k) || !p) continue;
    rows.push({ studentId: a.studentId, name: a.name, program: a.program, batch: a.batch || '', code: a.code,
      courseName: a.courseName || p.courseName, date: a.date, dateDisp: p.dateDisp, day: p.day, slot: a.slot,
      room: a.room || '—', seat: a.seat || '', section: a.section || '', added: true });
  }
  return rows.map((r) => {
    const a = marks.get(`${r.studentId}|${r.code}|${r.date}|${r.slot}`);
    const mark = a ? { present: a.status !== 'absent' } : null;
    const manual = a && (a.source === 'manual' || a.editedAt);
    const st = statusOf(r, mark);
    let note = '';
    if (r.added) note = 'Added by Exam Cell';
    else if (a && a.source === 'sheet') note = st === 'P' ? 'Present on identification sheet' : 'Absent on identification sheet';
    else if (manual) note = st === 'P' ? 'Marked P by Exam Cell' : 'Marked A by Exam Cell';
    return { ...r, status: st, note, booklet: (a && a.booklet) || '' };
  });
}

function nowLabel() {
  const n = clock.now();
  return `${n.date} ${String(Math.floor(n.minutes / 60)).padStart(2, '0')}:${String(n.minutes % 60).padStart(2, '0')}`;
}

/**
 * Write one workbook. Returns { path, filename, stats }. The caller deletes `path`
 * after sending it (temporary file, never mirrored to the database).
 */
async function writeWorkbook(type, rows, { heading = 'Examination', levelLabel = '', preparedBy = '', fileTag = '', outDir } = {}) {
  if (!TYPES.includes(type)) type = 'all';
  ensureOutputDir();
  const dir = outDir || OUTPUT_DIR;
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const inPath = path.join(dir, `attx_${stamp}_in.json`);
  const outPath = path.join(dir, `attx_${stamp}.xlsx`);
  fs.writeFileSync(inPath, JSON.stringify({ type, heading, levelLabel, preparedBy, generatedAt: nowLabel(), rows }));
  try {
    const r = await runPython('attendance_export.py', [inPath, outPath], { timeoutMs: 5 * 60 * 1000 });
    if (r.code !== 0 || !fs.existsSync(outPath)) {
      throw new Error(`Could not build the Excel file. ${String(r.stderr || '').slice(-300)}`);
    }
    let stats = {};
    try { stats = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { /* ignore */ }
    const tag = fileTag ? `_${fileTag}` : '';
    const safeHead = String(heading).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const filename = `${FILE_WORD[type]}${safeHead ? `_${safeHead}` : ''}${tag}_${clock.now().date}.xlsx`;
    return { path: outPath, filename, stats };
  } finally {
    try { fs.unlinkSync(inPath); } catch { /* ignore */ }
  }
}

module.exports = { TYPES, FILE_WORD, rosterFromDocs, rosterForBatches, withStatus, writeWorkbook, nowLabel };
