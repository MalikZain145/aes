/**
 * New CP-SAT timetable engine (scheduler/timetable_engine) — DB-driven.
 *
 * The admin clicks "Generate Timetable": we build the engine's inputs straight from
 * MongoDB (no Excel upload) — `config.json` (rooms seeded from the Room collection +
 * the editable rules) and `data.json` (courses + per-student registrations in the
 * exact shape parse.py produces) — then spawn the Python engine in a per-run temp
 * folder, stream its stdout into the run log, verify, and import timetable.json.
 *
 * BS vs MS is decided INSIDE the engine (course code level >= ms_level_from → MS
 * weekend timetable), so one run produces both; the portal just switches which
 * level it reads. The old CSP timetable (generateController → main.py) is untouched.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const Course = require('../models/Course');
const StudentRegistration = require('../models/StudentRegistration');
const Room = require('../models/Room');
const User = require('../models/User');
const Setting = require('../models/Setting');
const TimetableRun = require('../models/TimetableRun');
const TimetableEntry = require('../models/TimetableEntry');
const StudentSection = require('../models/StudentSection');
const { logActivity } = require('../utils/logger');

const ENGINE_DIR = path.join(__dirname, '..', '..', 'scheduler', 'timetable_engine');
const OUTPUT_DIR = path.join(__dirname, '..', '..', 'scheduler', 'output');
const WORKROOT = process.env.TIMETABLE_WORKDIR || path.join(os.tmpdir(), 'auic_tt_runs');
const PYTHON = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
const TIMEOUT_MS = Math.max(60000, parseInt(process.env.TIMETABLE_TIMEOUT_MS, 10) || 20 * 60 * 1000);
const ENGINE_FILES = ['engine.py', 'parse.py', 'export.py', 'verify_json.py', 'render_style.py'];
const LOGO_SRC = path.join(__dirname, '..', '..', 'frontend', 'public', 'favicon.png');
const CONFIG_KEY = 'timetable_config';
const norm = (s) => String(s == null ? '' : s).trim();

// ── config (rooms from DB + editable rules) ───────────────────────────────────
function defaultConfig() {
  return JSON.parse(fs.readFileSync(path.join(ENGINE_DIR, 'config.json'), 'utf-8'));
}
async function roomsFromDb() {
  const rooms = await Room.find({ active: true }).lean();
  return rooms.map((r) => ({
    name: r.name,
    block: r.building || '',
    cap: Number(r.capacity) || 0,
    type: r.type === 'lab' ? 'lab' : 'classroom',
  }));
}
// Merge the stored rules with live DB rooms. Rooms always come from the DB (single
// source of truth); if the DB has none we fall back to the engine's bundled list.
async function effectiveConfig() {
  const base = defaultConfig();
  let stored = null;
  try { const s = await Setting.findOne({ key: CONFIG_KEY }).lean(); stored = s && s.value; } catch { /* ignore */ }
  const cfg = stored && typeof stored === 'object' ? { ...base, ...stored } : base;
  const dbRooms = await roomsFromDb();
  cfg.rooms = dbRooms.length ? dbRooms : base.rooms;
  return cfg;
}

// GET /api/timetable/config
exports.getConfig = async (_req, res) => {
  const cfg = await effectiveConfig();
  res.json({ config: cfg, roomsFromDb: (await roomsFromDb()).length });
};
// PUT /api/timetable/config  — save editable RULES (rooms stay DB-sourced)
exports.putConfig = async (req, res) => {
  const incoming = (req.body && req.body.config) || {};
  // never persist rooms here — they live in the Room collection
  const toStore = { ...incoming }; delete toStore.rooms;
  await Setting.findOneAndUpdate({ key: CONFIG_KEY }, { key: CONFIG_KEY, value: toStore }, { upsert: true });
  res.json({ ok: true, config: await effectiveConfig() });
};

// ── build data.json from the DB (parse.py's shape) ────────────────────────────
// courses: [{row, code, title, credits, nsec, enrolled, sections:[{label,teacher}]}]
// students: [{name, id, program, batch, courses:[[code,title,credit],...]}]
async function buildDataJson() {
  const [courses, regs] = await Promise.all([
    Course.find({ active: true }).lean(),
    StudentRegistration.find({}).lean(),
  ]);

  // group course docs by CODE → title (first non-empty) + per-section teachers
  const byCode = new Map();
  for (const c of courses) {
    if (c.noTimetable) continue;                       // FYP/thesis/internship: never in the timetable
    if (String(c.component) === 'Lab') continue;        // labs come later (theory only for now)
    const code = String(c.code || '').toUpperCase(); if (!code) continue;
    let g = byCode.get(code);
    if (!g) { g = { code, title: c.name || code, credits: Number(c.creditHours) || 3, enrolled: 0, sections: [], secseen: new Set() }; byCode.set(code, g); }
    if ((!g.title || g.title === code) && c.name) g.title = c.name;
    const label = (norm(c.section) || 'A').toUpperCase();
    if (!g.secseen.has(label)) { g.secseen.add(label); g.sections.push({ label, teacher: norm(c.teacher) && norm(c.teacher) !== 'TBA' ? c.teacher : null }); }
    g.enrolled += Number(c.enrolled) || 0;
  }

  // course title + credit lookup for students' course list
  const titleOf = {}; const creditOf = {};
  for (const [code, g] of byCode) { titleOf[code] = g.title; creditOf[code] = g.credits; }

  const outCourses = [];
  let row = 1;
  for (const [code, g] of byCode) {
    outCourses.push({
      row: row++, code, title: g.title, credits: g.credits,
      nsec: g.sections.length || 1, enrolled: g.enrolled,
      sections: g.sections.length ? g.sections : [{ label: 'A', teacher: null }],
    });
  }

  const outStudents = [];
  for (const r of regs) {
    const sid = String(r.studentId || '').trim(); if (!sid) continue;
    const list = [];
    for (const raw of (r.courses || [])) {
      const code = String(raw || '').toUpperCase();
      if (!titleOf[code]) continue;                    // not a scheduled theory course (lab/FYP/unknown) → skip
      list.push([code, titleOf[code], creditOf[code]]);
    }
    if (!list.length) continue;
    outStudents.push({ name: r.name || '', id: sid, program: r.program || '', batch: r.batch || '', courses: list });
  }

  return { data: { courses: outCourses, students: outStudents },
    summary: { courses: outCourses.length, students: outStudents.length,
      sections: outCourses.reduce((a, c) => a + c.sections.length, 0) } };
}

// ── the run ───────────────────────────────────────────────────────────────────
// POST /api/timetable/runs  — generate BS + MS from the DB (one at a time)
exports.createRun = async (req, res) => {
  const active = await TimetableRun.findOne({ status: { $in: ['queued', 'running'] } }).lean();
  if (active) return res.status(409).json({ error: 'A timetable run is already in progress.', runId: active._id });

  const cfg = await effectiveConfig();
  if (!cfg.rooms || !cfg.rooms.length) return res.status(400).json({ error: 'No rooms found. Add rooms first.' });

  let built;
  try { built = await buildDataJson(); } catch (e) { return res.status(500).json({ error: 'Could not build timetable inputs: ' + e.message }); }
  if (!built.data.courses.length) return res.status(400).json({ error: 'No schedulable theory courses found in the database.' });
  if (!built.data.students.length) return res.status(400).json({ error: 'No student registrations found in the database.' });

  const term = norm((req.body && req.body.term)) || cfg.term || 'Fall 2026';
  const run = await TimetableRun.create({
    term, status: 'queued', config: cfg, summary: built.summary,
    createdBy: (req.user && req.user.id) ? String(req.user.id) : '',
  });

  // respond immediately; the engine runs in the background
  res.status(202).json({ ok: true, runId: run._id, status: 'queued', summary: built.summary });
  runEngine(run._id, cfg, built.data).catch((e) => console.error('[timetable] run error:', e));
};

async function runEngine(runId, cfg, data) {
  const run = await TimetableRun.findById(runId);
  if (!run) return;
  const dir = path.join(WORKROOT, String(runId));
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ENGINE_FILES) fs.copyFileSync(path.join(ENGINE_DIR, f), path.join(dir, f));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 1));
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(data));

    run.status = 'running'; run.startedAt = new Date(); await run.save();

    const code = await spawnPy(dir, ['engine.py'], run, TIMEOUT_MS);
    if (code !== 0) throw new Error(`engine exited with code ${code}`);

    // independent verification (non-fatal — captured into metrics)
    let verifyText = '';
    try { await spawnPy(dir, ['verify_json.py'], null, 120000, (t) => { verifyText += t; }); } catch { /* ignore */ }

    // styled PDF + Excel in the official house layout (non-fatal)
    try {
      if (fs.existsSync(LOGO_SRC)) fs.copyFileSync(LOGO_SRC, path.join(dir, 'logo.png'));
      await spawnPy(dir, ['render_style.py'], null, 120000, () => {});
    } catch (e) { console.error('[timetable] style render failed:', e.message); }

    const ttPath = path.join(dir, 'timetable.json');
    if (!fs.existsSync(ttPath)) throw new Error('engine produced no timetable.json');
    const tt = JSON.parse(fs.readFileSync(ttPath, 'utf-8'));

    await importTimetable(run, tt, dir, verifyText);
    run.status = 'done'; run.finishedAt = new Date(); await run.save();
    await logActivity('timetable.run', `Timetable generated (BS+MS) — run ${runId}`, 'success');
  } catch (e) {
    run.status = 'failed'; run.finishedAt = new Date(); run.error = String(e.message || e); await run.save();
    await logActivity('timetable.run', `Timetable run ${runId} failed: ${run.error}`, 'warning');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* keep on failure? cleaned anyway */ }
  }
}

// spawn python in `dir`, stream stdout/stderr into run.log (throttled), enforce timeout
function spawnPy(dir, args, run, timeoutMs, onData) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, args, { cwd: dir });
    let buf = ''; let lastSave = 0; let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); reject(new Error('timed out')); }, timeoutMs);
    const handle = (d) => {
      const t = d.toString(); buf += t;
      if (onData) onData(t);
      else if (run && run.save) {
        run.log = (run.log || '') + t;
        const now = Date.now();
        if (now - lastSave > 1500) { lastSave = now; run.save().catch(() => {}); }
      }
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (run && run.save && !onData) run.save().catch(() => {});
      if (killed) return;
      resolve(code);
    });
  });
}

// bulk-import timetable.json → TimetableEntry + StudentSection + run.metrics
async function importTimetable(run, tt, dir, verifyText) {
  const entryDocs = []; const secDocs = []; const secSeen = new Set(); const metrics = {};
  for (const [level, t] of Object.entries(tt.timetables || {})) {
    metrics[level] = t.metrics || {};
    for (const e of (t.entries || [])) {
      entryDocs.push({
        runId: run._id, level,
        day: e.day, slotIndex: e.slot_index, time: e.time, room: e.room, block: e.block || '',
        roomCapacity: e.room_capacity || 0, courseCode: e.course_code, courseTitle: e.course_title,
        section: e.section, sectionUid: e.section_uid || `${e.course_code}-${e.section}`,
        teacher: e.teacher || 'TBA', tag: e.tag || '', type: e.type || 'theory',
        sessionNo: e.session_no || 1, durationSlots: e.duration_slots || 1,
        students: e.students || 0, studentIds: (e.student_ids || []).map(String),
        cohorts: e.cohorts || [], classes: e.classes || [],
      });
      for (const sid of (e.student_ids || [])) {
        const key = `${sid}|${e.course_code}`;
        if (secSeen.has(key)) continue; secSeen.add(key);
        secDocs.push({ runId: run._id, level, studentId: String(sid), courseCode: e.course_code, section: e.section });
      }
    }
  }
  if (verifyText) metrics.verify = verifyText.trim().split('\n').slice(-6).join('\n');
  run.metrics = metrics;

  // move the STYLED Excel + PDF into the shared output dir (downloadable). Fall back
  // to the engine's plain Excel if the styled render did not run.
  try {
    const sx = path.join(dir, 'Timetable_styled.xlsx');
    const plain = path.join(dir, 'AUIC_Theory_Timetable_Fall2026.xlsx');
    const src = fs.existsSync(sx) ? sx : (fs.existsSync(plain) ? plain : null);
    if (src) { const name = `Timetable_${run._id}.xlsx`; fs.copyFileSync(src, path.join(OUTPUT_DIR, name)); run.xlsxFile = name; }
    const sp = path.join(dir, 'Timetable_styled.pdf');
    if (fs.existsSync(sp)) { const name = `Timetable_${run._id}.pdf`; fs.copyFileSync(sp, path.join(OUTPUT_DIR, name)); run.pdfFile = name; }
  } catch { /* ignore */ }

  await TimetableEntry.deleteMany({ runId: run._id });
  await StudentSection.deleteMany({ runId: run._id });
  if (entryDocs.length) await TimetableEntry.insertMany(entryDocs, { ordered: false });
  if (secDocs.length) await StudentSection.insertMany(secDocs, { ordered: false });
  run.summary = { ...(run.summary || {}), entries: entryDocs.length,
    BS: (tt.timetables.BS && (tt.timetables.BS.entries || []).length) || 0,
    MS: (tt.timetables.MS && (tt.timetables.MS.entries || []).length) || 0 };
}

// GET /api/timetable/runs  — recent runs
exports.listRuns = async (_req, res) => {
  const items = await TimetableRun.find({}).sort({ createdAt: -1 }).limit(30)
    .select('term status startedAt finishedAt metrics summary published publishedAt error createdAt').lean();
  res.json({ items });
};
// GET /api/timetable/runs/:id  — status + log + metrics (polling)
exports.getRun = async (req, res) => {
  const r = await TimetableRun.findById(req.params.id).lean();
  if (!r) return res.status(404).json({ error: 'Run not found.' });
  res.json({ run: r });
};
// POST /api/timetable/runs/:id/publish — make this the live timetable (atomic per term)
exports.publishRun = async (req, res) => {
  const r = await TimetableRun.findById(req.params.id);
  if (!r) return res.status(404).json({ error: 'Run not found.' });
  if (r.status !== 'done') return res.status(400).json({ error: 'Only a completed run can be published.' });
  await TimetableRun.updateMany({ term: r.term, _id: { $ne: r._id } }, { $set: { published: false } });
  r.published = true; r.publishedAt = new Date(); await r.save();
  await logActivity('timetable.publish', `Published timetable run ${r._id} for ${r.term}`, 'success');
  res.json({ ok: true });
};

async function publishedRun(term) {
  const q = term ? { term, published: true } : { published: true };
  return (await TimetableRun.findOne(q).sort({ publishedAt: -1 }).lean())
    || (await TimetableRun.findOne({ status: 'done' }).sort({ finishedAt: -1 }).lean());
}

// GET /api/timetable?level=BS|MS&view=class|teacher|room|course&key=...
exports.read = async (req, res) => {
  const run = await publishedRun(req.query.term);
  if (!run) return res.json({ hasTimetable: false, entries: [] });
  const level = req.query.level === 'MS' ? 'MS' : 'BS';
  const q = { runId: run._id, level };
  const key = norm(req.query.key);
  if (key) {
    if (req.query.view === 'teacher') q.teacher = key;
    else if (req.query.view === 'room') q.room = key;
    else if (req.query.view === 'course') q.courseCode = key.toUpperCase();
    else if (req.query.view === 'class') q.classes = key;   // class-group membership
  }
  const entries = await TimetableEntry.find(q).lean();
  const spec = (run.config && run.config.timetables && run.config.timetables[level]) || {};
  res.json({
    hasTimetable: true, runId: run._id, level, published: run.published,
    days: spec.days || [], slots: spec.slots || [], breakAfterSlot: spec.break_after_slot,
    metrics: (run.metrics && run.metrics[level]) || {}, entries,
  });
};

// GET /api/timetable/filters?level= — distinct teachers/rooms/courses/classes for the picker
exports.filters = async (req, res) => {
  const run = await publishedRun(req.query.term);
  if (!run) return res.json({ teachers: [], rooms: [], courses: [], classes: [] });
  const level = req.query.level === 'MS' ? 'MS' : 'BS';
  const base = { runId: run._id, level };
  const [teachers, rooms, courses, classesRaw] = await Promise.all([
    TimetableEntry.distinct('teacher', base),
    TimetableEntry.distinct('room', base),
    TimetableEntry.distinct('courseCode', base),
    TimetableEntry.distinct('classes', base),
  ]);
  res.json({
    teachers: teachers.filter(Boolean).sort(),
    rooms: rooms.filter(Boolean).sort(),
    courses: courses.filter(Boolean).sort(),
    classes: classesRaw.filter(Boolean).sort(),
  });
};

// GET /api/timetable/me — the signed-in student's or teacher's own weekly timetable
exports.me = async (req, res) => {
  const run = await publishedRun();
  if (!run) return res.json({ hasTimetable: false, entries: [] });
  const u = await User.findById(req.user.id).lean();
  if (!u) return res.status(404).json({ error: 'Profile not found.' });

  let q = { runId: run._id };
  let level = 'BS';
  if (u.role === 'student') {
    const reg = u.regNo || u.username || '';
    q.studentIds = String(reg);
    // a student is in exactly one level; detect it from their matches
  } else if (u.role === 'faculty' || u.role === 'admin') {
    const names = new Set([u.name].filter(Boolean).map((x) => x.toLowerCase().trim()));
    q.teacher = { $in: [...names].length ? [u.name] : ['\u0000'] };
  }
  let entries = await TimetableEntry.find(q).lean();
  if (u.role === 'student' && entries.length) level = entries[0].level;
  entries.sort((a, b) => String(a.day).localeCompare(String(b.day)) || a.slotIndex - b.slotIndex);
  const spec = (run.config && run.config.timetables && run.config.timetables[level]) || {};
  res.json({ hasTimetable: entries.length > 0, level, days: spec.days || [], slots: spec.slots || [], breakAfterSlot: spec.break_after_slot, entries });
};

// GET /api/timetable/runs/:id/export.xlsx — the engine's Excel workbook
exports.exportXlsx = async (req, res) => {
  const r = await TimetableRun.findById(req.params.id).lean();
  if (!r || !r.xlsxFile) return res.status(404).json({ error: 'No Excel file for this run.' });
  const p = path.join(OUTPUT_DIR, path.basename(r.xlsxFile));
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Excel file missing — re-generate.' });
  res.download(p, `AUIC_Timetable_${r.term.replace(/\s+/g, '_')}.xlsx`);
};

// GET /api/timetable/runs/:id/export.pdf — the styled house-layout PDF
exports.exportPdf = async (req, res) => {
  const r = await TimetableRun.findById(req.params.id).lean();
  if (!r || !r.pdfFile) return res.status(404).json({ error: 'No PDF for this run.' });
  const p = path.join(OUTPUT_DIR, path.basename(r.pdfFile));
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'PDF missing — re-generate.' });
  res.download(p, `AUIC_Timetable_${r.term.replace(/\s+/g, '_')}.pdf`);
};

// exposed for tests / tooling
exports._buildDataJson = buildDataJson;
exports._effectiveConfig = effectiveConfig;
exports._ENGINE_DIR = ENGINE_DIR;
