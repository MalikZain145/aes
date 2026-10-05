/**
 * End-to-end EXAM PIPELINE (one click):
 *
 *   upload reports (any of: student-wise registration, class-wise enrolment,
 *   timetable dataset, rooms list — .xls/.xlsx/.csv, auto-detected)
 *     → saved into MongoDB (ADDITIVE: new students/courses/teachers are inserted;
 *       existing records are NOT overwritten unless updateExisting=true)
 *     → scheduler/exam_engine/pipeline.py:
 *          BS + B.Tech + MS datesheets on their fixed slots (CP-SAT, 0 student clashes)
 *          → ONE global seating → admit cards + identification sheets + invigilation
 *          → independent audit (fails the run on any hard violation)
 *          → optional weekly timetable (CP-SAT engine)
 *     → GeneratedFile records (Reports page) + QR verification records.
 *
 * Long-running: POST returns a jobId at once; poll GET /jobs/:id for live progress.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const GeneratedFile = require('../models/GeneratedFile');
const Course = require('../models/Course');
const Teacher = require('../models/Teacher');
const StudentRegistration = require('../models/StudentRegistration');
const AdmitVerification = require('../models/AdmitVerification');
const admitCrypto = require('../utils/admitCrypto');
const { logActivity } = require('../utils/logger');
const { OUTPUT_DIR, SCHEDULER_DIR, exportDatabaseToJson, fileSize, ensureOutputDir } = require('../utils/pythonRunner');

const JOBS = new Map();          // jobId -> job (in memory; results are persisted as GeneratedFile)
const MAX_JOBS = 20;
const isWindows = process.platform === 'win32';

function cleanup(p) { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ } }
function parseJSON(v, dflt) { if (v == null || v === '') return dflt; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return dflt; } }
function bool(v, dflt) { if (v === undefined || v === null || v === '') return dflt; return v === true || String(v).toLowerCase() === 'true'; }

function detectBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const port = process.env.PORT || 5000;
  const addrs = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal && !/^169\.254\./.test(i.address)) addrs.push(i.address);
  }
  const pick = addrs.find((a) => a.startsWith('192.168.')) || addrs.find((a) => a.startsWith('10.')) || addrs[0];
  return pick ? `http://${pick}:${port}` : `${req.protocol}://${req.get('host')}`;
}

/** Spawn `python -m <module> ...args` in scheduler/, trying PYTHON_BIN, py, python, python3. */
function runPyModule(moduleName, args, { timeoutMs, onStderr } = {}) {
  const cands = [...new Set([(process.env.PYTHON_BIN || '').trim(), ...(isWindows ? ['py', 'python', 'python3'] : ['python3', 'python'])].filter(Boolean))];
  return new Promise((resolve, reject) => {
    const attempt = (i) => {
      if (i >= cands.length) return reject(new Error(`Python not found (tried ${cands.join(', ')}). Set PYTHON_BIN in backend/.env.`));
      let child;
      try { child = spawn(cands[i], ['-m', moduleName, ...args], { cwd: SCHEDULER_DIR }); } catch { return attempt(i + 1); }
      let stdout = ''; let stderr = ''; let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; child.kill('SIGKILL'); reject(new Error('Pipeline timed out.')); } }, timeoutMs || 2 * 60 * 60 * 1000);
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { const s = d.toString(); stderr += s; if (onStderr) onStderr(s); });
      child.on('error', (err) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (err.code === 'ENOENT') return attempt(i + 1);
        reject(err);
      });
      child.on('close', (code) => { clearTimeout(timer); if (settled) return; settled = true; resolve({ code, stdout, stderr }); });
    };
    attempt(0);
  });
}

function lastJsonLine(stdout) {
  const lines = String(stdout || '').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]); } catch { /* keep looking */ } }
  return {};
}

// ── DB save (additive) ───────────────────────────────────────────────────────
async function saveIngestToDb(exportJson, { updateExisting }) {
  const out = { studentsInserted: 0, studentsUpdated: 0, studentsUnchanged: 0, studentsDiffering: 0,
    coursesInserted: 0, teachersInserted: 0 };
  // Students
  const existing = new Map((await StudentRegistration.find({}).select('studentId name program batch courses').lean())
    .map((r) => [String(r.studentId), r]));
  const inserts = [];
  for (const r of exportJson.student_registrations || []) {
    const sid = String(r.student_id);
    const doc = { studentId: sid, name: r.name || '', program: r.program || '', batch: r.batch || '', courses: r.courses || [] };
    const cur = existing.get(sid);
    if (!cur) { inserts.push(doc); continue; }
    const same = (cur.name || '') === doc.name && (cur.program || '') === doc.program && (cur.batch || '') === doc.batch
      && JSON.stringify([...(cur.courses || [])].sort()) === JSON.stringify([...doc.courses].sort());
    if (same) { out.studentsUnchanged++; continue; }
    if (updateExisting) {
      await StudentRegistration.updateOne({ _id: cur._id }, { $set: doc });
      out.studentsUpdated++;
    } else {
      out.studentsDiffering++;
    }
  }
  if (inserts.length) { await StudentRegistration.insertMany(inserts, { ordered: false }); out.studentsInserted = inserts.length; }

  // Courses — insert codes the DB does not have yet; never touch existing course rows.
  const haveCodes = new Set((await Course.distinct('code')).map((c) => String(c).toUpperCase()));
  const haveFull = new Set(await Course.distinct('fullCode'));
  const cDocs = [];
  for (const c of exportJson.courses || []) {
    const code = String(c.code || '').toUpperCase();
    if (!code || haveCodes.has(code) || haveFull.has(c.fullCode)) continue;
    cDocs.push({
      fullCode: c.fullCode, code, name: c.name || code, component: c.component === 'Lab' ? 'Lab' : 'Lecture',
      section: c.section || '', programBatch: c.programBatch || '', program: c.program || '',
      level: c.level === 'PG' ? 'PG' : 'UG', department: c.department || '', teacher: c.teacher || 'TBA',
      enrolled: Number(c.enrolled) || 0, creditHours: Number(c.creditHours) || 3, noExam: !!c.noExam,
    });
    haveFull.add(c.fullCode);
  }
  if (cDocs.length) { await Course.insertMany(cDocs, { ordered: false }).catch(() => null); out.coursesInserted = cDocs.length; }

  // Teachers — insert missing names only.
  const haveT = new Set((await Teacher.distinct('name')).map((n) => String(n).trim().toLowerCase()));
  const tDocs = [];
  for (const c of exportJson.courses || []) {
    const t = String(c.teacher || '').trim();
    if (!t || /^tba$/i.test(t) || haveT.has(t.toLowerCase())) continue;
    haveT.add(t.toLowerCase());
    tDocs.push({ name: t });
  }
  if (tDocs.length) { await Teacher.insertMany(tDocs, { ordered: false }).catch(() => null); out.teachersInserted = tDocs.length; }
  return out;
}

// ── record outputs ───────────────────────────────────────────────────────────
const COHORT_LABEL = { bs: 'BS', btech: 'B.Tech', pg: 'MS' };

function fileEntry(label, absPath) {
  if (!absPath || !fs.existsSync(absPath)) return null;
  return { label, filename: path.basename(absPath), format: path.extname(absPath).slice(1), sizeBytes: fileSize(absPath) };
}

async function recordOutputs(result, examType, baseUrl, jobId) {
  const records = [];
  for (const [coh, d] of Object.entries(result.datesheets || {})) {
    const files = [fileEntry('Datesheet PDF', d.file), fileEntry('Analysis Report', d.report_file)].filter(Boolean);
    if (!files.length) continue;
    records.push(await GeneratedFile.create({
      kind: 'datesheet', examType,
      title: `${d.heading || (examType === 'mids' ? 'Mid-Term Datesheet' : 'Final-Term Datesheet')}  ·  ${COHORT_LABEL[coh] || coh}`,
      files,
      summary: { courses: d.total_units, days: d.total_days, papers: d.total_units, studentClashes: d.student_clashes },
      meta: {
        startDate: d.start_date, endDate: d.end_date, heading: d.heading,
        scheduleFile: d.schedule_file ? path.basename(d.schedule_file) : null,
        programLevel: coh === 'pg' ? 'Postgraduate' : 'Undergraduate',
        btech: coh === 'btech' || undefined, cohort: coh, pipelineJob: jobId,
        studentsTwoSameDay: d.students_two_same_day,
      },
      status: 'ready',
    }));
  }
  const a = result.admit;
  if (a && a.file && fs.existsSync(a.file)) {
    const files = [fileEntry('Admit Cards PDF', a.file), fileEntry('Seating Plan PDF', a.seating_file),
      fileEntry('Identification Sheets PDF', a.idsheets_file), fileEntry('Invigilation Roster PDF', a.invig_file)].filter(Boolean);
    const rec = await GeneratedFile.create({
      kind: 'admit_cards', examType,
      title: `Admit Cards — All Programs · ${a.heading || ''}`.trim(),
      files,
      summary: { students: a.total_students, admitCards: a.admit_cards, studentsNoPaper: a.students_no_paper,
        sessions: a.sessions, soloBenches: a.solo_benches, unseatedCount: a.unseated_count || 0 },
      meta: { cohort: 'all', heading: a.heading, venues: a.venues, verifyFile: a.verify_file ? path.basename(a.verify_file) : null,
        baseUrl, pipelineJob: jobId, auditClean: !!(result.audit && result.audit.clean) },
      status: 'ready',
    });
    records.push(rec);
    // QR verification records (same shape as generateAdmitCards)
    try {
      if (a.verify_file && fs.existsSync(a.verify_file)) {
        const v = JSON.parse(fs.readFileSync(a.verify_file, 'utf-8'));
        const docs = (v.students || []).map((s) => ({
          token: s.token, batchId: rec._id, studentId: s.sid, name: s.name, program: s.program, batch: s.batch,
          cardPage: s.page || 0, feeStatus: 'Unpaid',
          heading: v.heading, examType: v.exam_type, semester: v.semester, year: v.year,
          exams: (s.exams || []).map((e) => ({
            code: e.code, name: e.name, teacher: e.teacher, date: e.date, dateDisp: e.date_disp, day: e.day,
            slot: e.slot, start: e.start, finish: e.finish, room: e.room, seat: e.seat,
            key: admitCrypto.paperKey(s.token, e.code, e.date, e.slot),
          })),
        }));
        if (docs.length) await AdmitVerification.insertMany(docs, { ordered: false });
      }
    } catch (e) { console.error('pipeline verify store:', e.message); }
  }
  const audit = result.audit || {};
  const rep = fileEntry('Pipeline Audit Report', result.report_file);
  if (rep) {
    records.push(await GeneratedFile.create({
      kind: 'clash_report', examType,
      title: `Exam Pipeline Audit — ${audit.clean ? 'CLEAN' : 'FAILED'} · ${result.start_date || ''}`,
      files: [rep],
      summary: { clean: !!audit.clean, hard: audit.hard_counts || {}, soft: audit.soft_counts || {} },
      meta: { pipelineJob: jobId, stats: audit.stats || {} },
      status: audit.clean ? 'ready' : 'failed',
    }));
  }
  return records;
}

// ── job runner ───────────────────────────────────────────────────────────────
async function runJob(job, opts) {
  const { uploads, body, baseUrl } = opts;
  const stamp = job.id;
  const logPath = path.join(OUTPUT_DIR, `${stamp}_pipeline.log`);
  const push = (m) => { job.log.push(`[${new Date().toLocaleTimeString()}] ${m}`); if (job.log.length > 400) job.log.shift(); };
  let exportPath; let configPath; let ingestExport;
  try {
    ensureOutputDir();
    const examType = body.examType === 'mids' ? 'mids' : 'finals';
    // 1) ingest + DB save
    if (uploads.length) {
      job.stage = 'ingest';
      push(`Reading ${uploads.length} uploaded file(s) …`);
      const canonPath = path.join(OUTPUT_DIR, `${stamp}_canonical.json`);
      ingestExport = path.join(OUTPUT_DIR, `${stamp}_ingest_export.json`);
      const r = await runPyModule('exam_engine.ingest', [...uploads.map((u) => u.path), '--out', canonPath, '--export-out', ingestExport], { timeoutMs: 10 * 60 * 1000 });
      const res = lastJsonLine(r.stdout);
      if (r.code !== 0 || res.status !== 'ok') throw new Error(`Could not read the uploaded files. ${String(r.stderr).slice(-400)}`);
      job.ingest = res;
      push(`Detected: ${(res.files || []).map((f) => `${f.file} → ${f.shape}`).join(', ')}`);
      cleanup(canonPath);
      if (bool(body.saveToDb, true)) {
        job.stage = 'database';
        const ex = JSON.parse(fs.readFileSync(ingestExport, 'utf-8'));
        job.db = await saveIngestToDb(ex, { updateExisting: bool(body.updateExisting, false) });
        push(`Database: +${job.db.studentsInserted} students, +${job.db.coursesInserted} courses, +${job.db.teachersInserted} teachers`
          + (job.db.studentsDiffering ? ` (${job.db.studentsDiffering} existing student records differ — left unchanged)` : ''));
      }
    }
    // 2) DB export (rooms/labs + teachers) and DB no-exam flags
    job.stage = 'export';
    const ex = await exportDatabaseToJson();
    exportPath = ex.exportPath;
    let noExam = [];
    try { noExam = await Course.distinct('code', { noExam: true }); } catch { /* ignore */ }

    // 3) pipeline
    job.stage = 'pipeline';
    const cfg = {
      prefix: `${stamp}_`, outdir: OUTPUT_DIR, log_file: logPath,
      exam_type: examType, start_date: body.startDate,
      window_mode: body.windowMode === 'by_papers' ? 'by_papers' : 'by_days',
      num_days: Number(body.numDays) || 7,
      papers_per_slot: body.papersPerSlot ? Number(body.papersPerSlot) : undefined,
      max_papers_per_day: Math.min(2, Math.max(1, Number(body.maxPapersPerDay) || 1)),
      semester: body.semester || undefined, year: body.year ? Number(body.year) : undefined,
      cohort_settings: parseJSON(body.cohortSettings, {}),
      cohorts_to_run: parseJSON(body.cohorts, ['bs', 'btech', 'pg']),
      merge_groups: parseJSON(body.mergeGroups, []),
      same_day_groups: parseJSON(body.sameDayGroups, [['SS104', 'SS203', 'SS211']]),
      exclude_dates: parseJSON(body.excludeDates, []),
      blocked_windows: parseJSON(body.blockedWindows, []),
      exclude_courses: parseJSON(body.excludeCourses, []),
      include_courses: parseJSON(body.includeCourses, []),
      no_exam_codes: noExam,
      shared_paper_policy: body.sharedPaperPolicy === 'same_time' ? 'same_time' : 'independent',
      room_turnover_min: body.roomTurnoverMin !== undefined ? Number(body.roomTurnoverMin) : 30,
      invigilator_max_per_day: Number(body.invigilatorMaxPerDay) || 2,
      strict: bool(body.strict, true),
      // uploaded files are the source of truth for THIS run; rooms come from the DB
      files: uploads.map((u) => u.path),
      data_json: exportPath,
      merge_with_db: bool(body.mergeWithDb, false),
      admit: { base_url: baseUrl, verify_secret: admitCrypto.SECRET, fee_default: 'Unpaid',
        campus_line: body.campusLine || 'Abasyn University Islamabad Campus' },
      timetable: { enabled: bool(body.timetable, false) },
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cfg.start_date || '')) throw new Error('Pick a valid start date (YYYY-MM-DD).');
    configPath = path.join(OUTPUT_DIR, `${stamp}_pipeline_config.json`);
    fs.writeFileSync(configPath, JSON.stringify(cfg));
    push('Generating datesheets (BS · B.Tech · MS) → seating → admit cards → audit …');
    const r = await runPyModule('exam_engine.pipeline', ['--config', configPath], {
      timeoutMs: 3 * 60 * 60 * 1000,
      onStderr: (s) => s.split('\n').filter((l) => l.startsWith('[pipeline')).forEach((l) => push(l.replace(/^\[pipeline [\d:]+\]\s*/, ''))),
    });
    const result = lastJsonLine(r.stdout);
    if (!result || result.status === 'failed' || !result.datesheets) {
      throw new Error(result.error || `Pipeline failed (exit ${r.code}). ${String(r.stderr).split('\n').filter(Boolean).slice(-3).join(' | ')}`);
    }
    job.result = result;
    // 4) record files
    job.stage = 'recording';
    const clean = !!(result.audit && result.audit.clean);
    const publish = clean || bool(body.publishOnFail, false);
    const recs = publish ? await recordOutputs(result, examType, baseUrl, stamp)
      : await recordOutputs({ ...result, datesheets: {}, admit: null }, examType, baseUrl, stamp);
    job.records = recs.map((x) => ({ id: x._id, kind: x.kind, title: x.title }));
    job.status = clean ? 'done' : 'audit_failed';
    push(clean ? 'Audit CLEAN — all files published to Reports.' : `Audit FAILED: ${JSON.stringify(result.audit.hard_counts)} — files NOT published (see the audit report).`);
    await logActivity('exam.pipeline', `Exam pipeline ${clean ? 'clean' : 'audit failed'} (${Object.keys(result.datesheets).join(', ')})`, clean ? 'success' : 'warning');
  } catch (e) {
    job.status = 'failed';
    job.error = e.message;
    push(`ERROR: ${e.message}`);
    console.error('exam pipeline:', e);
  } finally {
    job.finishedAt = new Date();
    job.stage = 'finished';
    cleanup(exportPath); cleanup(configPath); cleanup(ingestExport);
    for (const u of uploads) cleanup(u.path);
  }
}

// ── HTTP handlers ────────────────────────────────────────────────────────────
exports.run = async (req, res) => {
  const running = [...JOBS.values()].find((j) => j.status === 'running');
  if (running) return res.status(409).json({ error: 'A pipeline run is already in progress.', jobId: running.id });
  const body = req.body || {};
  if (!['mids', 'finals'].includes(body.examType)) return res.status(400).json({ error: 'examType must be mids or finals.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.startDate || '')) return res.status(400).json({ error: 'Pick a valid start date.' });
  const uploads = (req.files || []).map((f) => {
    // keep the original extension so the reader picks the right engine (.xls/.xlsx/.csv)
    const ext = path.extname(f.originalname || '').toLowerCase();
    const p = f.path + ext;
    try { fs.renameSync(f.path, p); } catch { return { path: f.path, name: f.originalname }; }
    return { path: p, name: f.originalname };
  });
  if (!uploads.length) {
    const n = await StudentRegistration.countDocuments({});
    if (!n) return res.status(400).json({ error: 'Upload the student-wise registration report (no registrations in the database yet).' });
  }
  const id = `EP${Date.now()}`;
  const job = { id, status: 'running', stage: 'queued', startedAt: new Date(), log: [], files: uploads.map((u) => u.name) };
  JOBS.set(id, job);
  if (JOBS.size > MAX_JOBS) JOBS.delete(JOBS.keys().next().value);
  runJob(job, { uploads, body, baseUrl: detectBaseUrl(req) });   // background
  res.status(202).json({ ok: true, jobId: id });
};

exports.status = (req, res) => {
  const job = JOBS.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown job (the server may have restarted).' });
  res.json(job);
};

exports.list = (_req, res) => {
  res.json([...JOBS.values()].map((j) => ({ id: j.id, status: j.status, stage: j.stage, startedAt: j.startedAt, finishedAt: j.finishedAt, files: j.files })).reverse());
};
