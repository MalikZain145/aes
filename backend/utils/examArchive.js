/**
 * Exam archive — keeps every CONDUCTED examination of a semester as an organised,
 * downloadable record (ZIP), without changing anything in the live system.
 *
 * When does an exam get archived?
 *   • A new datesheet or admit-card run is started (or the one-click exam engine)
 *     and an earlier exam has completely ended — e.g. the mid-terms are held again
 *     in the same semester. The finished exam is archived BEFORE anything new is
 *     generated (generating a datesheet replaces the old one, so this is the last
 *     moment its files exist).
 *   • A new academic term is opened: every exam not archived yet is archived
 *     (even one that has not finished).
 *   • The Exam Cell presses "Archive conducted exams" on the Previous Semesters page.
 *
 * What is kept (copies in GridFS bucket "examarchive"):
 *   Date Sheets · Admit Cards · Seating Plans · Identification Sheets ·
 *   Invigilation Roster · Analysis Reports · Admit Card Updates, plus the frozen
 *   seating roster (who sat which paper, where). The ZIP adds Attendance workbooks
 *   (All / Absentees / Presentees) and a CSV of every student-paper, built at
 *   download time from the live attendance records.
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const GeneratedFile = require('../models/GeneratedFile');
const AdmitVerification = require('../models/AdmitVerification');
const ExamArchive = require('../models/ExamArchive');
const clock = require('./examClock');
const { OUTPUT_DIR } = require('./pythonRunner');
const ax = require('./attendanceExport');

const BUCKET = 'examarchive';
let _bucket = null;
function bucket() {
  if (!_bucket) _bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET });
  return _bucket;
}
function putBuffer(name, buf) {
  return new Promise((resolve, reject) => {
    const up = bucket().openUploadStream(name);
    up.on('error', reject).on('finish', () => resolve(up.id));
    up.end(buf);
  });
}
function putFile(name, src) {
  return new Promise((resolve, reject) => {
    const up = bucket().openUploadStream(name);
    fs.createReadStream(src).on('error', reject).pipe(up).on('error', reject).on('finish', () => resolve(up.id));
  });
}
function getBuffer(id) {
  return new Promise((resolve, reject) => {
    const parts = [];
    bucket().openDownloadStream(id).on('data', (c) => parts.push(c)).on('error', reject).on('end', () => resolve(Buffer.concat(parts)));
  });
}

const TYPE_LABEL = (t) => (String(t).toLowerCase().startsWith('mid') ? 'Mid Term' : 'Final Term');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dmy = (d) => { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]} ${MON[Number(m[2]) - 1]} ${m[1]}` : String(d || ''); };
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();

// Admit-card companion files → their own folders.
function admitFolder(filename) {
  if (/SeatingPlan/i.test(filename)) return 'Seating Plans';
  if (/Identification/i.test(filename)) return 'Identification Sheets';
  if (/Invigilation/i.test(filename)) return 'Invigilation Roster';
  if (/_Report\./i.test(filename) || /audit/i.test(filename)) return 'Analysis Reports';
  return 'Admit Cards';
}

const cohortOf = (b) => (b.meta && b.meta.cohort)
  || (/post/i.test((b.meta && b.meta.programLevel) || '') || /postgrad/i.test(b.title || '') ? 'pg' : 'bs');

/** first / last paper of a batch and whether its last paper has ended */
async function windowOf(batchId) {
  const g = await AdmitVerification.aggregate([
    { $match: { batchId } },
    { $unwind: '$exams' },
    { $group: { _id: { date: '$exams.date', slot: '$exams.slot' }, n: { $sum: 1 } } },
  ]);
  if (!g.length) return null;
  const sess = g.map((x) => x._id).filter((s) => s.date);
  if (!sess.length) return null;
  const endMin = (s) => clock.toMinutes(String(s.slot || '').split('-')[1] || '') || 0;
  sess.sort((a, b) => a.date.localeCompare(b.date) || endMin(a) - endMin(b));
  const first = sess[0]; const last = sess[sess.length - 1];
  return { start: first.date, end: last.date, lastSlot: last.slot, ended: clock.slotPhase(last.date, last.slot) === 'after' };
}

async function termFor(batches) {
  for (const b of batches) if (b.archived && b.archivedTerm) return b.archivedTerm;
  try {   // same name the semester archive uses when a new term is opened
    const AcademicTerm = require('../models/AcademicTerm');
    const t = await AcademicTerm.findOne({ active: true }).sort({ createdAt: -1 }).lean();
    if (t && t.name) return t.name;
  } catch { /* fall through */ }
  for (const b of batches) {
    const m = b.meta || {};
    if (m.semester && m.year) return `${String(m.semester).trim()} ${m.year}`;
  }
  return 'Current Semester';
}

let running = null;
/**
 * Archive every exam that is fully conducted (or, with includeUnfinished, every
 * exam) and not archived yet. Never changes or removes live data. Safe to call
 * often; returns the archives it created.
 */
function archiveConductedExams(opts = {}) {
  if (running) return running.then(() => archiveConductedExams(opts));
  running = doArchive(opts).finally(() => { running = null; });
  return running;
}

async function doArchive({ includeUnfinished = false, reason = '' } = {}) {
  if (mongoose.connection.readyState !== 1) return [];
  const prev = await ExamArchive.find({}).select('batchIds supersededIds datesheetIds updateIds term examType').lean();
  const done = new Set(); const dsDone = new Set(); const upDone = new Set();
  for (const a of prev) {
    (a.batchIds || []).concat(a.supersededIds || []).forEach((id) => done.add(String(id)));
    (a.datesheetIds || []).forEach((id) => dsDone.add(String(id)));
    (a.updateIds || []).forEach((id) => upDone.add(String(id)));
  }
  const all = await GeneratedFile.find({ kind: 'admit_cards' }).sort({ createdAt: 1 }).lean();
  const cand = [];
  for (const b of all) {
    if (done.has(String(b._id))) continue;
    const w = await windowOf(b._id);
    if (!w) continue;                                  // no seating records left — nothing to archive
    if (!w.ended && !includeUnfinished) continue;      // exam still running / upcoming
    cand.push({ b, w, type: String(b.examType || 'finals').toLowerCase().startsWith('mid') ? 'mids' : 'finals', cohort: cohortOf(b) });
  }
  if (!cand.length) return [];

  // A batch replaced by a newer one of the same cohort for the SAME exam window was never used.
  const overlap = (x, y) => x.w.start <= y.w.end && y.w.start <= x.w.end;
  for (const x of cand) {
    x.superseded = cand.some((y) => y !== x && y.type === x.type && overlap(x, y)
      && (y.cohort === x.cohort || y.cohort === 'all') && new Date(y.b.createdAt) > new Date(x.b.createdAt));
  }
  // Group into exams: same type, windows overlapping or within 3 days of each other.
  const DAY = 86400000;
  const near = (x, y) => Math.abs(new Date(x.w.start) - new Date(y.w.end)) <= 3 * DAY
    || Math.abs(new Date(y.w.start) - new Date(x.w.end)) <= 3 * DAY || overlap(x, y);
  const groups = [];
  for (const x of cand.sort((a, b) => a.w.start.localeCompare(b.w.start))) {
    const g = groups.find((gg) => gg.type === x.type && gg.items.some((y) => near(x, y)));
    if (g) g.items.push(x); else groups.push({ type: x.type, items: [x] });
  }

  const laterBatchTimes = (t) => all.filter((b) => new Date(b.createdAt) > t).map((b) => new Date(b.createdAt));
  const created = [];
  for (const g of groups) {
    const eff = g.items.filter((x) => !x.superseded);
    const sup = g.items.filter((x) => x.superseded);
    if (!eff.length) continue;
    const batches = eff.map((x) => x.b);
    const term = await termFor(g.items.map((x) => x.b));
    const start = eff.map((x) => x.w.start).sort()[0];
    const end = eff.map((x) => x.w.end).sort().slice(-1)[0];
    const complete = eff.every((x) => x.w.ended);
    const round = (await ExamArchive.countDocuments({ term, examType: g.type })) + 1;
    const label = `${TYPE_LABEL(g.type)} Examination (${dmy(start)} – ${dmy(end)})`;
    const minCreated = new Date(Math.min(...g.items.map((x) => new Date(x.b.createdAt))));
    const maxCreated = new Date(Math.max(...g.items.map((x) => new Date(x.b.createdAt))));
    const nextBatch = laterBatchTimes(maxCreated).filter((t) => !g.items.some((x) => +new Date(x.b.createdAt) === +t)).sort((a, b) => a - b)[0];

    const datesheets = (await GeneratedFile.find({ kind: 'datesheet', examType: g.type, createdAt: { $lte: maxCreated } }).lean())
      .filter((d) => !dsDone.has(String(d._id)) && !(d.archived && d.archivedTerm && d.archivedTerm !== term));
    const updates = (await GeneratedFile.find({ kind: 'admit_update', createdAt: { $gte: minCreated, ...(nextBatch ? { $lt: nextBatch } : {}) } }).lean())
      .filter((u) => !upDone.has(String(u._id)) && !(u.archived && u.archivedTerm && u.archivedTerm !== term));

    const arc = await ExamArchive.create({
      term, examType: g.type, label, round, startDate: start, endDate: end, complete,
      batchIds: batches.map((b) => b._id), supersededIds: sup.map((x) => x.b._id),
      datesheetIds: datesheets.map((d) => d._id), updateIds: updates.map((u) => u._id),
      reason,
    });
    datesheets.forEach((d) => dsDone.add(String(d._id)));
    updates.forEach((u) => upDone.add(String(u._id)));

    // copy the files
    const { ensureLocal } = require('./fileStore');
    const files = []; const used = new Set();
    const copy = async (rec, folderFn) => {
      for (const f of rec.files || []) {
        const name = path.basename(String(f.filename || ''));
        if (!name) continue;
        const ok = await ensureLocal(name).catch(() => false);
        const src = path.join(OUTPUT_DIR, name);
        if (!ok && !fs.existsSync(src)) continue;
        const folder = folderFn(name);
        let n = name;
        while (used.has(`${folder}/${n}`)) n = n.replace(/(\.[^.]+)?$/, (m) => `_2${m || ''}`);
        used.add(`${folder}/${n}`);
        try {
          const id = await putFile(`${arc._id}/${folder}/${n}`, src);
          files.push({ folder, name: n, fileId: id, sizeBytes: fs.statSync(src).size, sourceId: rec._id });
        } catch (e) { console.warn('exam archive copy:', name, e.message); }
      }
    };
    for (const d of datesheets) await copy(d, () => 'Date Sheets');
    for (const b of batches) await copy(b, admitFolder);
    for (const u of updates) await copy(u, () => 'Admit Card Updates');

    // frozen seating roster
    const roster = await ax.rosterForBatches(batches.map((b) => b._id));
    const rosterFileId = await putBuffer(`${arc._id}/roster.json`, Buffer.from(JSON.stringify(roster)));
    const stats = {
      students: new Set(roster.map((r) => r.studentId)).size,
      sittings: roster.length,
      papers: new Set(roster.map((r) => `${r.date}|${r.slot}|${r.code}`)).size,
      rooms: new Set(roster.map((r) => r.room)).size,
      files: files.length,
      sizeBytes: files.reduce((n, f) => n + (f.sizeBytes || 0), 0),
    };
    await ExamArchive.updateOne({ _id: arc._id }, { $set: { files, rosterFileId, stats } });
    try {
      const { logActivity } = require('./logger');
      await logActivity('archive.exam', `Archived ${label} — ${term} (${stats.students} students, ${files.length} files)${reason ? ` · ${reason}` : ''}.`, 'success');
    } catch { /* logging is best-effort */ }
    created.push({ id: arc._id, term, label, round, stats });
  }
  return created;
}

/** Add one archived exam (files + attendance + records) into an AdmZip under `prefix`. */
async function addExamToZip(zip, arc, prefix, { preparedBy = '' } = {}) {
  let added = 0;
  for (const f of arc.files || []) {
    try { zip.addFile(`${prefix}/${f.folder}/${f.name}`, await getBuffer(f.fileId)); added++; } catch (e) { console.warn('exam archive read:', f.name, e.message); }
  }
  let roster = [];
  if (arc.rosterFileId) { try { roster = JSON.parse((await getBuffer(arc.rosterFileId)).toString('utf-8')); } catch { roster = []; } }
  if (roster.length) {
    const rows = await ax.withStatus(roster);
    const heading = `${arc.label.replace(/\s*\(.*\)$/, '')} ${arc.term}`.trim();
    for (const type of ['all', 'absent', 'present']) {
      let out = null;
      try {
        out = await ax.writeWorkbook(type, rows, { heading, levelLabel: 'All students', preparedBy });
        zip.addFile(`${prefix}/Attendance/${ax.FILE_WORD[type]}.xlsx`, fs.readFileSync(out.path)); added++;
      } catch (e) {
        zip.addFile(`${prefix}/Attendance/${ax.FILE_WORD[type]}_ERROR.txt`, Buffer.from(String(e.message || e)));
      } finally { if (out) { try { fs.unlinkSync(out.path); } catch { /* ignore */ } } }
    }
    const ST = { P: 'Present', A: 'Absent', N: 'Not yet held' };
    const q = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ['Reg No', 'Student Name', 'Degree', 'Batch', 'Course', 'Course Name', 'Section', 'Date', 'Day', 'Time', 'Room', 'Seat', 'Attendance', 'Note'];
    const lines = [head.join(',')].concat(rows.map((r) => [r.studentId, r.name, r.program, r.batch, r.code, r.courseName, r.section,
      r.dateDisp, r.day, r.slot, r.room, r.seat, ST[r.status], r.note].map(q).join(',')));
    zip.addFile(`${prefix}/Records/Student_Paper_Records.csv`, Buffer.from(`﻿${lines.join('\r\n')}`)); added++;
  }
  const readme = [
    `${arc.label} — ${arc.term}`,
    `Archived: ${new Date(arc.createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC${arc.reason ? ` (${arc.reason})` : ''}`,
    arc.complete ? '' : 'Note: this exam had not finished when it was archived; papers not yet held show as "Not yet held".',
    '',
    'Date Sheets            the datesheets of this exam',
    'Admit Cards            the admit-card PDFs issued',
    'Seating Plans          room-wise seating plans',
    'Identification Sheets  room-wise identification / signature sheets',
    'Invigilation Roster    invigilation duties',
    'Admit Card Updates     update batches issued after the main run (if any)',
    'Attendance             Attendance_All / Absentees / Presentees workbooks (course-wise, totals, charts)',
    'Records                Student_Paper_Records.csv — every student-paper with room, seat and attendance',
    '',
    'Attendance files are built from the attendance records at the moment of download,',
    'so any later correction by the Exam Cell is included.',
  ].filter((l, i) => i !== 2 || l).join('\r\n');
  zip.addFile(`${prefix}/README.txt`, Buffer.from(readme));
  return added;
}

function folderName(arc) {
  return safeName(`${arc.round > 1 ? `${arc.round}. ` : ''}${arc.label}`);
}

module.exports = { archiveConductedExams, addExamToZip, folderName, safeName };
