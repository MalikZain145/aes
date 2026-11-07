/**
 * Previous Semesters archive. When the admin opens a new term, that term's
 * generated record (date sheets, admit cards, seating plans, reports, timetables)
 * is flagged archived + archivedTerm. This lists those terms as folders and
 * streams a whole term's files back as ONE ZIP (organised into sub-folders).
 */
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const GeneratedFile = require('../models/GeneratedFile');
const { OUTPUT_DIR } = require('../utils/pythonRunner');
const ExamArchive = require('../models/ExamArchive');
const examArchive = require('../utils/examArchive');

const KIND_FOLDER = {
  datesheet: 'Date Sheets',
  admit_cards: 'Admit Cards',
  clash_report: 'Reports',
  timetable: 'Timetables',
};
// A finer sub-folder for the admit-card companion files.
function subFolder(filename) {
  if (/SeatingPlan/i.test(filename)) return 'Seating Plans';
  if (/Identification/i.test(filename)) return 'Identification Sheets';
  if (/Invigilation/i.test(filename)) return 'Invigilation Roster';
  if (/_Report\./i.test(filename)) return 'Analysis Reports';
  return '';
}

// GET /api/archive/terms → one entry per archived term (folder card).
exports.terms = async (_req, res) => {
  try {
    const agg = await GeneratedFile.aggregate([
      { $match: { archived: true } },
      { $group: {
        _id: '$archivedTerm',
        records: { $sum: 1 },
        files: { $sum: { $size: { $ifNull: ['$files', []] } } },
        kinds: { $addToSet: '$kind' },
        latest: { $max: '$createdAt' },
      } },
      { $sort: { latest: -1 } },
    ]);
    res.json({ terms: agg.map((t) => ({
      term: t._id || 'Previous Semester', records: t.records, files: t.files,
      kinds: t.kinds, latest: t.latest,
    })) });
  } catch (e) {
    console.error('archive.terms:', e.message);
    res.status(500).json({ error: 'Could not load previous semesters.' });
  }
};

// GET /api/archive/files?term=Fall%202026 → records grouped into folders.
exports.files = async (req, res) => {
  try {
    const term = String(req.query.term || '');
    if (!term) return res.status(400).json({ error: 'term is required.' });
    const recs = await GeneratedFile.find({ archived: true, archivedTerm: term })
      .sort({ createdAt: -1 }).lean();
    const folders = {};
    for (const r of recs) {
      const f = KIND_FOLDER[r.kind] || r.kind;
      (folders[f] = folders[f] || []).push({
        id: r._id, title: r.title, kind: r.kind, createdAt: r.createdAt,
        files: (r.files || []).map((x) => ({ filename: x.filename, label: x.label, sizeBytes: x.sizeBytes })),
      });
    }
    res.json({ term, folders });
  } catch (e) {
    console.error('archive.files:', e.message);
    res.status(500).json({ error: 'Could not load the term record.' });
  }
};

// GET /api/archive/download?term=Fall%202026 → the whole term as one ZIP.
exports.download = async (req, res) => {
  try {
    const term = String(req.query.term || '');
    if (!term) return res.status(400).json({ error: 'term is required.' });
    const recs = await GeneratedFile.find({ archived: true, archivedTerm: term }).lean();
    const exams = await ExamArchive.find({ term }).sort({ startDate: 1 }).lean();
    if (!recs.length && !exams.length) return res.status(404).json({ error: 'No archived record for this term.' });

    const safe = term.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const zip = new AdmZip();
    let added = 0;
    const seen = new Set();
    for (const r of recs) {
      const folder = KIND_FOLDER[r.kind] || r.kind;
      for (const f of (r.files || [])) {
        if (!f.filename) continue;
        const src = path.join(OUTPUT_DIR, path.basename(f.filename));
        if (!fs.existsSync(src)) continue;
        const sub = subFolder(f.filename);
        const zipFolder = `${term}/${folder}${sub ? '/' + sub : ''}`;
        let name = f.filename;
        while (seen.has(`${zipFolder}/${name}`)) name = name.replace(/(\.[^.]+)?$/, (m) => `_dup${m || ''}`);
        seen.add(`${zipFolder}/${name}`);
        zip.addLocalFile(src, zipFolder, name);
        added += 1;
      }
    }
    for (const a of exams) {
      added += await examArchive.addExamToZip(zip, a, `${term}/Examinations/${examArchive.folderName(a)}`,
        { preparedBy: (req.user && req.user.username) || '' });
    }
    if (!added) zip.addFile(`${term}/README.txt`, Buffer.from(`No files on disk for ${term}.`));
    const buf = zip.toBuffer();
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${safe}_Record.zip"`,
      'Content-Length': buf.length,
    });
    res.end(buf);
  } catch (e) {
    console.error('archive.download:', e.message);
    try { res.status(500).json({ error: 'Could not build the ZIP.' }); } catch { /* noop */ }
  }
};

/* ═══════════════ Archived examinations (one exam = one folder / ZIP) ═══════════════ */

// GET /api/archive/exams → archived exams grouped by semester
exports.exams = async (_req, res) => {
  try {
    const list = await ExamArchive.find({}).select('-files.fileId').sort({ startDate: -1, createdAt: -1 }).lean();
    const terms = [];
    for (const a of list) {
      let t = terms.find((x) => x.term === a.term);
      if (!t) { t = { term: a.term, exams: [] }; terms.push(t); }
      const folders = {};
      for (const f of a.files || []) folders[f.folder] = (folders[f.folder] || 0) + 1;
      t.exams.push({ id: a._id, label: a.label, examType: a.examType, round: a.round, startDate: a.startDate, endDate: a.endDate,
        complete: a.complete !== false, stats: a.stats || {}, folders, createdAt: a.createdAt, reason: a.reason || '' });
    }
    res.json({ terms });
  } catch (e) {
    console.error('archive.exams:', e.message);
    res.status(500).json({ error: 'Could not load the archived exams.' });
  }
};

// POST /api/archive/exams/run → archive every exam that has completely ended (and is not archived yet)
exports.runExams = async (_req, res) => {
  try {
    const created = await examArchive.archiveConductedExams({ reason: 'archived from Previous Semesters' });
    res.json({ ok: true, created });
  } catch (e) {
    console.error('archive.runExams:', e.message);
    res.status(500).json({ error: e.message || 'Could not archive the exams.' });
  }
};

// GET /api/archive/exams/:id/download → that exam as one ZIP (organised folders)
exports.downloadExam = async (req, res) => {
  try {
    const a = await ExamArchive.findById(req.params.id).lean();
    if (!a) return res.status(404).json({ error: 'Archived exam not found.' });
    const zip = new AdmZip();
    const root = examArchive.safeName(`${a.term} - ${examArchive.folderName(a)}`);
    await examArchive.addExamToZip(zip, a, root, { preparedBy: (req.user && req.user.username) || '' });
    const buf = zip.toBuffer();
    const fname = `${root.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}.zip`;
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${fname}"`,
      'Content-Length': buf.length,
    });
    res.end(buf);
  } catch (e) {
    console.error('archive.downloadExam:', e.message);
    try { res.status(500).json({ error: 'Could not build the ZIP.' }); } catch { /* noop */ }
  }
};
