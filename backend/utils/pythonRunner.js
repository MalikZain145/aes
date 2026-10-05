const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const Room = require('../models/Room');
const Lab = require('../models/Lab');
const Course = require('../models/Course');
const StudentRegistration = require('../models/StudentRegistration');

// Where the Python scripts live and where outputs go
const SCHEDULER_DIR = path.join(__dirname, '..', '..', 'scheduler');
const OUTPUT_DIR = path.join(SCHEDULER_DIR, 'output');

const isWindows = process.platform === 'win32';

/**
 * Build an ordered list of Python commands to try.
 * 1. Whatever is set in .env (PYTHON_BIN) — highest priority
 * 2. Common Windows launchers ("py", "python")
 * 3. Common Unix names ("python3", "python")
 * The first one that actually launches wins, and is then cached.
 */
function pythonCandidates() {
  const fromEnv = (process.env.PYTHON_BIN || '').trim();
  const list = [];
  if (fromEnv) list.push(fromEnv);
  if (isWindows) {
    list.push('py', 'python', 'python3');
  } else {
    list.push('python3', 'python');
  }
  // de-duplicate while preserving order
  return [...new Set(list)];
}

// Cache the working command after the first successful launch
let RESOLVED_PYTHON = null;

// Exposed for logging / messages
const PYTHON = process.env.PYTHON_BIN || (isWindows ? 'py' : 'python3');

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

/**
 * Export the live database into the JSON shape the Python scripts expect.
 * Writes to a temp file and returns its path.
 */
async function exportDatabaseToJson() {
  ensureOutputDir();

  const [rooms, labs, courses, regs] = await Promise.all([
    Room.find({ active: true }).lean(),
    Lab.find({ active: true }).lean(),
    Course.find({ active: true }).lean(),
    StudentRegistration.find({}).lean(),
  ]);

  const payload = {
    rooms: rooms.map((r) => ({
      name: r.name,
      capacity: r.capacity,
      examCapacity: r.examCapacity || null,
      examVenue: r.examVenue === true,
    })),
    labs: labs.map((l) => ({
      name: l.name,
      capacity: l.capacity,
      examCapacity: l.examCapacity || null,
      departments: l.departments || [],
      examVenue: l.examVenue === true,
    })),
    // Courses flagged no-timetable (FYP / thesis / internship / dissertation) are
    // not taught in a class slot, so they are left out of the generated schedule
    // (they still exist in the Courses tab). No-exam courses stay here — they are
    // dropped from the DATESHEET at generation time, not from the export.
    courses: courses.filter((c) => !c.noTimetable).map((c) => ({
      fullCode: c.fullCode,
      code: c.code,
      name: c.name,
      component: c.component,
      section: c.section || '',
      programBatch: c.programBatch || '',
      program: c.program || '',
      level: c.level || 'UG',
      department: c.department || '',
      teacher: c.teacher || 'TBA',
      enrolled: c.enrolled || 0,
      creditHours: c.creditHours != null ? c.creditHours : 3,
    })),
    // Real per-student course lists → lets the scheduler be STUDENT clash-free
    // (no student ever double-booked), not just batch-label clash-free.
    student_registrations: regs.map((r) => ({
      student_id: r.studentId,
      name: r.name || '',
      program: r.program || '',
      batch: r.batch || '',
      courses: r.courses || [],
    })),
  };

  const exportPath = path.join(OUTPUT_DIR, `db_export_${Date.now()}.json`);
  fs.writeFileSync(exportPath, JSON.stringify(payload), 'utf-8');
  return { exportPath, counts: { rooms: rooms.length, labs: labs.length, courses: courses.length } };
}

/**
 * Try to spawn `script` with a single python command.
 * Resolves with { code, stdout, stderr } on completion, or rejects with
 * { notFound: true } if the command itself doesn't exist (ENOENT).
 */
function trySpawn(cmd, script, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, [script, ...args], { cwd: SCHEDULER_DIR });
    } catch (e) {
      return reject({ notFound: true, err: e });
    }

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('The generator timed out. Try again or reduce the dataset size.'));
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        return reject({ notFound: true, err }); // command doesn't exist — try next
      }
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Run a Python script, automatically finding a working interpreter.
 * Tries PYTHON_BIN first, then platform-appropriate fallbacks
 * ("py", "python", "python3" on Windows). The first command that
 * launches is cached for subsequent runs.
 * Resolves with { code, stdout, stderr }.
 */
async function runPython(script, args, { timeoutMs = 300000 } = {}) {
  const candidates = RESOLVED_PYTHON ? [RESOLVED_PYTHON] : pythonCandidates();
  const tried = [];

  for (const cmd of candidates) {
    tried.push(cmd);
    try {
      const result = await trySpawn(cmd, script, args, timeoutMs);
      if (RESOLVED_PYTHON !== cmd) {
        RESOLVED_PYTHON = cmd; // cache the winner
        console.log(`✓ Using Python command: "${cmd}"`);
      }
      return result;
    } catch (e) {
      if (e && e.notFound) {
        continue; // not installed — try the next candidate
      }
      throw e; // real error (timeout / runtime crash) — stop and report
    }
  }

  const hint = isWindows
    ? `Tried: ${tried.join(', ')}. Open backend/.env and set the full path, e.g. PYTHON_BIN=C:\\Program Files\\Python312\\python.exe — then restart the backend.`
    : `Tried: ${tried.join(', ')}. Set PYTHON_BIN in backend/.env to your python path, then restart the backend.`;
  throw new Error(`Python not found. ${hint}`);
}

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

module.exports = {
  SCHEDULER_DIR,
  OUTPUT_DIR,
  PYTHON,
  exportDatabaseToJson,
  runPython,
  fileSize,
  ensureOutputDir,
};
