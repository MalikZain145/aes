const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * The URL a phone should hit to verify a QR. Prefers PUBLIC_BASE_URL (set it to a
 * real domain in production); otherwise auto-detects this machine's LAN IPv4 so
 * the QR works on whatever network the server is on — no manual config needed.
 */
function detectBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const port = process.env.PORT || 5000;
  const addrs = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family === 'IPv4' && !i.internal && !/^169\.254\./.test(i.address)) addrs.push(i.address);
    }
  }
  // prefer a real home/office LAN range
  const pick = addrs.find((a) => a.startsWith('192.168.'))
    || addrs.find((a) => a.startsWith('10.'))
    || addrs.find((a) => /^172\.(1[6-9]|2\d|3[01])\./.test(a))
    || addrs[0];
  if (pick) return `http://${pick}:${port}`;
  return `${req.protocol}://${req.get('host')}`;   // last resort
}

const GeneratedFile = require('../models/GeneratedFile');
const Course = require('../models/Course');
const AdmitVerification = require('../models/AdmitVerification');
const StudentRegistration = require('../models/StudentRegistration');
const admitCrypto = require('../utils/admitCrypto');
const { isPostgradCode } = require('../utils/programMap');
const { logActivity } = require('../utils/logger');
const {
  OUTPUT_DIR,
  SCHEDULER_DIR,
  exportDatabaseToJson,
  runPython,
  fileSize,
} = require('../utils/pythonRunner');

// Course codes flagged noExam in the DB. Passed to datesheet.py SEPARATELY from the
// admin's own removals so the generator can apply the shared eligibility rules:
// FYP/thesis/internship/labs/clinical are dropped automatically (they stay in every
// student's course list — only the exam schedule skips them), and the old importer's
// false positive ("Software Project Management" etc. flagged as no-exam) is restored.
async function dbNoExamCodes() {
  try { return (await Course.distinct('code', { noExam: true })).map((x) => String(x).toUpperCase()); } catch { return []; }
}

function cleanup(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

/**
 * POST /api/generate/timetable
 * Exports DB → runs main.py → records the generated files.
 */
exports.generateTimetable = async (req, res) => {
  let exportPath;
  try {
    const { exportPath: ep, counts } = await exportDatabaseToJson();
    exportPath = ep;

    if (counts.courses === 0) {
      cleanup(exportPath);
      return res.status(400).json({ error: 'No courses in the database. Add courses first.' });
    }

    // UG (default) vs PG (MS): PG builds a separate MS timetable (code>=500) with
    // Saturday/Sunday-only classes; UG excludes MS courses.
    const level = String((req.body || {}).level || 'ug').toLowerCase() === 'pg' ? 'pg' : 'ug';
    const stamp = Date.now();
    const prefix = `Timetable_${level === 'pg' ? 'MS_' : ''}${stamp}`;

    const { code, stdout, stderr } = await runPython(
      path.join(SCHEDULER_DIR, 'main.py'),
      ['--data', exportPath, '--outdir', OUTPUT_DIR, '--prefix', prefix, '--level', level]
    );

    // The scheduler writes <prefix>_summary.json regardless of success/failure
    const summaryPath = path.join(OUTPUT_DIR, `${prefix}_summary.json`);
    let summary = {};
    if (fs.existsSync(summaryPath)) {
      summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
    }

    if (code !== 0 || summary.status === 'failed') {
      cleanup(exportPath);
      const msg = summary.error || stderr.slice(-400) || 'Timetable generation failed.';
      return res.status(500).json({ error: msg, log: stdout.slice(-1200) });
    }

    // Collect output files
    const excelName = `${prefix}.xlsx`;
    const pdfName = `${prefix}.pdf`;
    const reportName = `Clash_Report.txt`;

    // Rename the shared report to a unique name so it isn't overwritten next run
    const uniqueReport = `${prefix}_Clash_Report.txt`;
    const reportSrc = path.join(OUTPUT_DIR, reportName);
    const reportDst = path.join(OUTPUT_DIR, uniqueReport);
    if (fs.existsSync(reportSrc)) fs.renameSync(reportSrc, reportDst);

    const files = [];
    const excelPath = path.join(OUTPUT_DIR, excelName);
    if (fs.existsSync(excelPath)) {
      files.push({ label: 'Excel', filename: excelName, format: 'xlsx', sizeBytes: fileSize(excelPath) });
    }
    const pdfPath = path.join(OUTPUT_DIR, pdfName);
    if (fs.existsSync(pdfPath)) {
      files.push({ label: 'PDF', filename: pdfName, format: 'pdf', sizeBytes: fileSize(pdfPath) });
    }
    if (fs.existsSync(reportDst)) {
      files.push({ label: 'Report', filename: uniqueReport, format: 'txt', sizeBytes: fileSize(reportDst) });
    }

    // Academic term (e.g. "Summer 2025") from the courses, for search filters.
    let term = '';
    try {
      const terms = await Course.distinct('academicTerm', { active: true });
      term = (terms || []).filter(Boolean)[0] || '';
    } catch { /* ignore */ }

    const record = await GeneratedFile.create({
      kind: 'timetable',
      title: `Weekly Timetable — ${term || new Date().toLocaleString()}`,
      files,
      summary: summary.clashes || {},
      meta: {
        ...summary.stats, accuracy: summary.accuracy, fullyClashFree: summary.fullyClashFree,
        level, // 'ug' (BS) or 'pg' (MS) — both timetables coexist; view toggles by this
        seed: summary.seed, term,
        scheduleFile: summary.scheduleFile || null,
        capacityAdvisor: summary.capacityAdvisor || null,
      },
      status: 'ready',
    });

    // Also store a separate clash_report record so it shows in Reports cleanly
    if (fs.existsSync(reportDst)) {
      await GeneratedFile.create({
        kind: 'clash_report',
        title: `Clash Report — ${new Date().toLocaleString()}`,
        files: [{ label: 'Report', filename: uniqueReport, format: 'txt', sizeBytes: fileSize(reportDst) }],
        summary: summary.clashes || {},
        meta: { fullyClashFree: summary.fullyClashFree },
        status: 'ready',
      });
    }

    cleanup(exportPath);
    await logActivity(
      'generate.timetable',
      `Timetable generated (${summary.fullyClashFree ? 'clash-free' : summary.clashes.total + ' issues'})`,
      summary.fullyClashFree ? 'success' : 'warning'
    );

    res.json({ ok: true, record, summary });
  } catch (err) {
    cleanup(exportPath);
    console.error('Timetable generation error:', err);
    res.status(500).json({ error: err.message || 'Timetable generation failed.' });
  }
};

/**
 * POST /api/generate/datesheet
 *   Body: {
 *     examType: 'mids'|'finals',
 *     startDate: 'YYYY-MM-DD',
 *     windowMode: 'by_papers'|'by_days',
 *     papersPerSlot?: number,     // when by_papers
 *     numDays?: number,           // when by_days
 *     programLevel: 'Undergraduate'|'Postgraduate',
 *     semester?: 'Spring'|'Summer'|'Fall',
 *     year?: number,
 *     mergeGroups?: string[][]    // [[code, code, ...], ...]
 *   }
 */
// Readable label for each department key (used in per-department datesheet titles).
const DEPT_LABELS = {
  cs: 'Computer Science', ai: 'Artificial Intelligence', ee: 'Electrical Engineering',
  civil: 'Civil Engineering', btech: 'B.Tech', bba: 'Business Administration',
  af: 'Accounting & Finance', eng: 'English', psy: 'Psychology', math: 'Mathematics',
  pharmd: 'Pharmacy', dpt: 'Physical Therapy', mlt: 'Medical Lab Technology', vs: 'Vision Sciences',
  ot: 'Operation Theatre', rt: 'Radiology', hnd: 'Human Nutrition & Dietetics', common: 'General / Common',
};
const deptLabel = (k) => DEPT_LABELS[k] || String(k || '').toUpperCase();

// Rewrite the DB export IN PLACE to keep only Undergraduate (wantPG=false, code
// < 500) OR only Postgraduate/MS (wantPG=true, 3-digit code >= 500) courses, and
// trim the student registrations to match. So the UG datesheet never contains MS
// courses, and the "Postgraduate" button builds a separate MS-only datesheet.
function filterExportByLevel(srcPath, wantPG) {
  const raw = JSON.parse(fs.readFileSync(srcPath, 'utf-8'));
  const courses = (raw.courses || []).filter((c) => isPostgradCode(c.code) === !!wantPG);
  const codes = new Set(courses.map((c) => String(c.code || '').toUpperCase()));
  const regs = (raw.student_registrations || [])
    .map((r) => ({ ...r, courses: (r.courses || []).filter((cc) => codes.has(String(cc).toUpperCase())) }))
    .filter((r) => r.courses.length);
  fs.writeFileSync(srcPath, JSON.stringify({ ...raw, courses, student_registrations: regs }));
  return courses.length;
}

// Write a copy of the DB export keeping only courses in `deptSet` (and the
// student registrations trimmed to those courses). Returns { path, courseCount }.
// A datesheet record's program cohort: btech | pg (MS) | bs.
function datesheetCohort(d) {
  if (d && d.meta && d.meta.btech) return 'btech';
  if (/post/i.test((d && d.meta && d.meta.programLevel) || '')) return 'pg';
  return 'bs';
}

// Keep only the LATEST datesheet per (program cohort, examType): when a new one is
// generated for a program, its previous non-archived datesheet(s) + files are
// removed — so the system always holds exactly one datesheet per program (BS /
// B.Tech / MS) per exam, and the admit page shows a clean 3-slot picture.
async function pruneOldDatesheets(keepIds, cohort, examType) {
  const keep = new Set((keepIds || []).map(String));
  const all = await GeneratedFile.find({ kind: 'datesheet', examType, archived: { $ne: true } }).lean();
  const stale = all.filter((d) => datesheetCohort(d) === cohort && !keep.has(String(d._id)));
  for (const d of stale) {
    for (const f of (d.files || [])) cleanup(path.join(OUTPUT_DIR, path.basename(f.filename)));
    if (d.meta && d.meta.scheduleFile) cleanup(path.join(OUTPUT_DIR, path.basename(d.meta.scheduleFile)));
    await GeneratedFile.deleteOne({ _id: d._id });
  }
  return stale.length;
}

function writeFilteredExport(srcPath, deptSet) {
  const raw = JSON.parse(fs.readFileSync(srcPath, 'utf-8'));
  const courses = (raw.courses || []).filter((c) => deptSet.has(c.department || ''));
  const codes = new Set(courses.map((c) => String(c.code || '').toUpperCase()));
  const regs = (raw.student_registrations || [])
    .map((r) => ({ ...r, courses: (r.courses || []).filter((cc) => codes.has(String(cc).toUpperCase())) }))
    .filter((r) => r.courses.length);
  const out = { ...raw, courses, student_registrations: regs };
  // short random suffix — never the joined department names (they can be long
  // program names now, which would blow past the OS path-length limit).
  const p = path.join(OUTPUT_DIR, `dsfilt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(p, JSON.stringify(out));
  return { path: p, courseCount: courses.length };
}

// Write a copy of the DB export keeping only the courses that a COHORT's students
// (cohortTest(program/batch) === true) are actually registered in — regardless of
// which "department" the course belongs to. This is what makes a cohort datesheet
// COMPLETE and INDEPENDENT: e.g. the B.Tech (evening) datesheet then carries its
// students' shared gen-ed papers (SS121/SS122/SS108) as B.TECH's own papers in
// B.Tech slots, so nothing is missing from their admit cards and nothing has to be
// merged in from the BS datesheet (which caused duplicate seats before). Returns
// { path, courseCount }.
// Like filterExportByLevel but by COHORT ENROLLMENT: mutate srcPath in place to
// keep only this cohort's students and the courses they actually take (any level).
// Used for the MS (Postgraduate) datesheet so it carries its students' ≥500 core
// PLUS the gen-ed they sit (e.g. SS121/SS122 Fahm-ul-Quran, ENG449) as MS's OWN
// papers — independent of the BS/BTech copies. Returns the kept course count.
function filterExportByCohort(srcPath, cohortTest) {
  const raw = JSON.parse(fs.readFileSync(srcPath, 'utf-8'));
  const regs = (raw.student_registrations || []).filter((r) => cohortTest(r.program || r.batch));
  const taken = new Set();
  for (const r of regs) for (const cc of (r.courses || [])) taken.add(String(cc).toUpperCase());
  const courses = (raw.courses || []).filter((c) => taken.has(String(c.code || '').toUpperCase()));
  fs.writeFileSync(srcPath, JSON.stringify({ ...raw, courses, student_registrations: regs }));
  return courses.length;
}

function writeCohortExport(srcPath, cohortTest, tag) {
  const raw = JSON.parse(fs.readFileSync(srcPath, 'utf-8'));
  const regs = (raw.student_registrations || []).filter((r) => cohortTest(r.program || r.batch));
  const taken = new Set();
  for (const r of regs) for (const cc of (r.courses || [])) taken.add(String(cc).toUpperCase());
  const courses = (raw.courses || []).filter((c) => taken.has(String(c.code || '').toUpperCase()));
  const out = { ...raw, courses, student_registrations: regs };
  const p = path.join(OUTPUT_DIR, `dsfilt_${Date.now()}_${String(tag || 'cohort').replace(/[^a-z0-9]/gi, '').slice(0, 12) || 'cohort'}.json`);
  fs.writeFileSync(p, JSON.stringify(out));
  return { path: p, courseCount: courses.length };
}

// Cohort test on a student's program/batch string.
const _isPGprog = (p) => /( ms | mphil |mphil| master| mba | msc |postgrad| pgd | phd )/.test(' ' + String(p || '').toLowerCase().replace(/[.\-]/g, ' ') + ' ');
const _isBTprog = (p) => { const s = ' ' + String(p || '').toLowerCase().replace(/[.\-]/g, ' ') + ' '; return s.includes('btech') || s.includes(' b tech') || s.includes('engineering technology'); };

/**
 * Shared gen-ed papers (e.g. SS121/SS122) that THIS cohort's students also sit,
 * with the date/slot the BS datesheet already fixed → so they can be pinned onto
 * the cohort's own datesheet (one paper, one time, no leak).
 *   bsSchedulePaths : BS/other datesheet schedule JSONs (absolute paths)
 *   cohortTest      : fn(program/batch) → belongs to this cohort?
 */
async function buildFixedGenEd(bsSchedulePaths, cohortTest) {
  const bsMap = {};   // CODE -> { date, slot, name }
  for (const p of (bsSchedulePaths || [])) {
    try {
      const s = JSON.parse(fs.readFileSync(p, 'utf-8'));
      for (const c of (s.courses || [])) {
        const code = String(c.code || '').toUpperCase();
        if (code && c.date && c.slot && !bsMap[code]) bsMap[code] = { date: c.date, slot: c.slot, name: c.name || code };
      }
    } catch { /* ignore unreadable schedule */ }
  }
  if (!Object.keys(bsMap).length) return [];
  const regs = await StudentRegistration.find({}).select('studentId program batch courses').lean();
  const fixed = {};   // CODE -> { code, name, date, slot, students:Set }
  for (const r of regs) {
    if (!cohortTest(r.program || r.batch)) continue;
    for (const c of (r.courses || [])) {
      const code = String(c).toUpperCase();
      const bs = bsMap[code];
      if (!bs) continue;
      if (!fixed[code]) fixed[code] = { code, name: bs.name, date: bs.date, slot: bs.slot, students: new Set() };
      if (r.studentId) fixed[code].students.add(r.studentId);
    }
  }
  return Object.values(fixed).map((f) => ({ ...f, students: [...f.students] }));
}

// Build + run ONE datesheet (for a given data_json + department set) and create
// its GeneratedFile record. BTech-only jobs get the 3:00-4:30 single daily slot.
async function runDatesheetJob(base, dataJson, deptKeys, labelOverride, avoidSchedules, fixedCourses, splits) {
  const isBtech = deptKeys.length === 1 && deptKeys[0] === 'btech';
  // Shared gen-ed courses (also in the BS/other datesheets) live ONLY in BS — the
  // B.Tech datesheet schedules its EXCLUSIVE courses, and B.Tech students get the
  // shared papers via the admit-card merge. So a shared course (e.g. SS118) is
  // never double-scheduled at two different times.
  let exCodes = Array.isArray(base.exCourses) ? [...base.exCourses] : [];
  if (isBtech && Array.isArray(avoidSchedules) && avoidSchedules.length) {
    const shared = new Set();
    for (const sp of avoidSchedules) {
      try {
        const s = JSON.parse(fs.readFileSync(sp, 'utf-8'));
        for (const c of (s.courses || [])) if (c.code) shared.add(String(c.code).toUpperCase());
      } catch { /* ignore */ }
    }
    exCodes = [...new Set([...exCodes.map((x) => String(x).toUpperCase()), ...shared])];
  }
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const word = base.examType === 'mids' ? 'Mids' : 'Finals';
  // keep the on-disk filename SHORT (program names can be long now) — sanitize and
  // cap, so a many-department job never exceeds the OS path-length limit. The
  // human-friendly download name is built separately in friendlyName().
  const tag = deptKeys.length ? '_' + deptKeys.map((k) => String(k).replace(/[^a-z0-9]/gi, '')).join('-').slice(0, 40) : '';
  const pdfName = `Datesheet_${word}${tag}_${stamp}.pdf`;
  const pdfPath = path.join(OUTPUT_DIR, pdfName);
  // Auto-exclude courses marked no-exam (yellow-highlighted at import, or project/
  // thesis/internship) — they never get an exam slot on any cohort's datesheet.
  exCodes = [...new Set(exCodes.map((x) => String(x).toUpperCase()))];
  const _dbNoExam = await dbNoExamCodes();
  const config = {
    exam_type: base.examType, start_date: base.startDate, window_mode: base.mode,
    // BTech is FLEXIBLE — its daily slot may hold as many clash-free papers as the
    // rooms allow, so it isn't stretched thin. (It keeps its OWN timing; seat
    // collisions with the main sheet are prevented at SEATING time, not by moving
    // BTech's slots — overlapping sessions are co-seated in one allocation.)
    papers_per_slot: isBtech ? undefined : (base.mode === 'by_papers' ? Number(base.papersPerSlot) : undefined),
    max_papers_per_day: base.maxPerDay || 1,
    num_days: base.mode === 'by_days' ? Number(base.numDays) : undefined,
    program_level: base.programLevel, semester: base.semester || undefined,
    year: base.year ? Number(base.year) : undefined,
    merge_groups: base.mergeGroups, exclude_dates: base.excludeDates, exclude_courses: exCodes,
    db_no_exam_codes: _dbNoExam,
    include_courses: base.includeCourses || [],
    blocked_windows: base.blockedWindows,   // Friday Jumma etc. — enforced for every cohort
    same_day_groups: base.sameDayGroups,     // English-I/II/III etc. — one day, 3 slots
    ...(base.fsProvided ? { first_slot_departments: base.fsDepts } : {}),
    force_merges: base.forceMerges,
    // BTech: a COLUMN layout like the main sheet, with 3 fixed time columns and a
    // per-day mask so each day only fills the columns it's allowed to (the rest
    // stay blank):
    //   • columns:  0 = 09:00-10:30, 1 = 01:00-02:30, 2 = 03:00-04:30
    //   • weekdays (Mon-Fri) → column 2 only (03:00-04:30)
    //   • Saturday/Sunday    → columns 0 & 1 (09:00-10:30 and 01:00-02:30)
    // Sundays are used. Overlaps with the main Sat 09:00/01:00 slots are fine —
    // seat collisions are prevented at SEATING time by co-seating same-time
    // main+BTech papers into ONE allocation (anti-cheating kept, no seat shared).
    ...(isBtech ? {
      // ONE combined sheet for B.Tech Civil + B.Tech Electrical Engineering Technology,
      // titled simply "B.Tech" on the PDF.
      program_title: 'B.Tech',
      slots_override: ['09:00-10:30', '01:00-02:30', '03:00-04:30'],
      slot_day_mask: { weekday: [2], weekend: [0, 1] },
      include_sundays: true,
    } : {}),
    // Cross-cohort clash resolution: BTech avoids slots where its students
    // already sit a shared gen-ed (BS) paper — CET311-style clashes auto-shift.
    ...(Array.isArray(avoidSchedules) && avoidSchedules.length ? { avoid_clash_schedules: avoidSchedules } : {}),
    // Shared gen-ed papers pinned onto this cohort's sheet at their BS date/time.
    ...(Array.isArray(fixedCourses) && fixedCourses.length ? { fixed_courses: fixedCourses } : {}),
    data_json: dataJson, out: pdfPath,
  };
  // Department-wise PDFs from ONE joint solve (never separate solves).
  const splitOut = (Array.isArray(splits) ? splits : []).map((sp, i) => ({
    key: i, codes: [...sp.codes],
    out: path.join(OUTPUT_DIR, `Datesheet_${word}_${sp.depts.map((k) => String(k).replace(/[^a-z0-9]/gi, '')).join('-').slice(0, 30) || 'dept'}_${stamp}_${i}.pdf`),
  }));
  if (splitOut.length) config.split_outputs = splitOut;
  const configPath = path.join(OUTPUT_DIR, `dsconfig_${stamp}.json`);
  fs.writeFileSync(configPath, JSON.stringify(config));
  // Large combined datesheets (hundreds of courses, student clash-free) can run
  // well past the 5-min default — give plenty of headroom so they don't time out.
  const { code, stdout, stderr } = await runPython(path.join(SCHEDULER_DIR, 'datesheet.py'), ['--config', configPath], { timeoutMs: 30 * 60 * 1000 });
  let result = {};
  const lastLine = stdout.trim().split('\n').filter(Boolean).pop() || '{}';
  try { result = JSON.parse(lastLine); } catch { result = {}; }
  cleanup(configPath);
  if (code !== 0 || result.error || !fs.existsSync(pdfPath)) {
    const tail = ((stderr || '') + '\n' + (stdout || '')).trim().split('\n').filter(Boolean).slice(-4).join(' | ').slice(-700);
    throw new Error((result.error || `Datesheet generation failed for ${deptKeys.join(', ') || 'all'}.`) + (tail ? ` [python: ${tail}]` : ''));
  }
  const dsFiles = [{ label: 'Datesheet PDF', filename: pdfName, format: 'pdf', sizeBytes: fileSize(pdfPath) }];
  const reportName = `${pdfName.replace(/\.pdf$/, '')}_Report.pdf`;
  const reportPath = path.join(OUTPUT_DIR, reportName);
  if (fs.existsSync(reportPath)) dsFiles.push({ label: 'Analysis Report', filename: reportName, format: 'pdf', sizeBytes: fileSize(reportPath) });
  const deptName = labelOverride !== undefined ? labelOverride
    : deptKeys.length === 0 ? ''
    : deptKeys.length > 4 ? `Other Departments (${deptKeys.length})`
    : deptKeys.map(deptLabel).join(', ');
  const title = (result.heading ? result.heading : `${base.examType === 'mids' ? 'Mid-Term' : 'Final-Term'} Datesheet — ${result.start_date} to ${result.end_date}`)
    + (deptName ? `  ·  ${deptName}` : '');
  const record = await GeneratedFile.create({
    kind: 'datesheet', examType: base.examType, title, files: dsFiles,
    summary: { courses: result.total_courses, days: result.total_days, papers: result.total_papers, studentClashes: result.student_clashes },
    meta: {
      startDate: result.start_date, endDate: result.end_date, heading: result.heading,
      slotsPerDay: result.slots_per_day, papersPerSlot: result.papers_per_slot,
      scheduleFile: result.schedule_file ? path.basename(result.schedule_file) : null,
      programLevel: result.program_level, semester: result.semester, year: result.year,
      departments: deptKeys, departmentLabel: deptName || undefined, btech: isBtech || undefined,
      noExamAuto: result.auto_excluded || {}, restoredNoExam: result.restored_no_exam || [], reviewNoExam: result.review_no_exam || [],
    },
    status: 'ready',
  });
  return { record, result };
}

// Records for the department PDFs of a joint solve: one per department set, each with
// its own schedule snapshot (same dates/times as the joint schedule). The joint PDF
// itself is not recorded — its papers are exactly the union of the department PDFs.
async function recordSplits(base, result, splits) {
  const out = [];
  for (const sr of (result.split_results || [])) {
    const sp = splits[sr.key];
    if (!sp || !fs.existsSync(sr.file)) continue;
    const deptName = sp.label !== undefined ? sp.label
      : sp.depts.length > 4 ? `Other Departments (${sp.depts.length})` : sp.depts.map(deptLabel).join(', ');
    const files = [{ label: 'Datesheet PDF', filename: path.basename(sr.file), format: 'pdf', sizeBytes: fileSize(sr.file) }];
    if (!out.length && result.report_file && fs.existsSync(result.report_file)) {
      files.push({ label: 'Analysis Report', filename: path.basename(result.report_file), format: 'pdf', sizeBytes: fileSize(result.report_file) });
    }
    out.push(await GeneratedFile.create({
      kind: 'datesheet', examType: base.examType,
      title: `${result.heading || 'Datesheet'}${deptName ? `  ·  ${deptName}` : ''}`,
      files,
      summary: { courses: sr.papers, days: result.total_days, papers: sr.papers, studentClashes: result.student_clashes },
      meta: {
        startDate: result.start_date, endDate: result.end_date, heading: result.heading,
        slotsPerDay: result.slots_per_day, papersPerSlot: result.papers_per_slot,
        scheduleFile: sr.schedule_file ? path.basename(sr.schedule_file) : null,
        programLevel: result.program_level, semester: result.semester, year: result.year,
        departments: sp.depts, departmentLabel: deptName || undefined, jointSolve: true,
        noExamAuto: result.auto_excluded || {}, restoredNoExam: result.restored_no_exam || [], reviewNoExam: result.review_no_exam || [],
      },
      status: 'ready',
    }));
  }
  return out;
}

// Student → exam cohort, by ACADEMIC PROGRAM: 'pg' | 'btech' | 'bs'.
const cohortOfProgram = (p) => (_isPGprog(p) ? 'pg' : (_isBTprog(p) ? 'btech' : 'bs'));

// Export for ONE cohort built from its STUDENTS: their registrations (optionally
// limited to `codes`) and exactly the course rows they take. Returns {path, courseCount}.
function writeStudentCohortExport(raw, cohort, codes, tag) {
  const up = (x) => String(x || '').trim().toUpperCase();
  let regs = (raw.student_registrations || [])
    .filter((r) => cohortOfProgram(r.program || r.batch) === cohort)
    .map((r) => ({ ...r, courses: [...new Set((r.courses || []).map(up))] }));
  if (codes) regs = regs.map((r) => ({ ...r, courses: r.courses.filter((c) => codes.has(c)) }));
  regs = regs.filter((r) => r.courses.length);
  const taken = new Set(regs.flatMap((r) => r.courses));
  const courses = (raw.courses || []).filter((c) => taken.has(up(c.code)));
  const p = path.join(OUTPUT_DIR, `dsfilt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${tag}.json`);
  fs.writeFileSync(p, JSON.stringify({ ...raw, courses, student_registrations: regs }));
  return { path: p, courseCount: courses.length };
}

// An uploaded registration report (.xls/.xlsx/.csv, any recognised shape) → a DB-export
// shaped JSON (rooms/labs/teachers from the DB). Nothing is written to the database.
async function exportFromUpload(file) {
  const ext = (path.extname(file.originalname || '') || '.xlsx').toLowerCase();
  if (!file.path.toLowerCase().endsWith(ext)) {
    const renamed = file.path + ext;
    fs.renameSync(file.path, renamed);
    file.path = renamed;
  }
  const { exportPath: dbExp } = await exportDatabaseToJson();
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const out = path.join(OUTPUT_DIR, `upexport_${stamp}.json`);
  const canon = path.join(OUTPUT_DIR, `upcanon_${stamp}.json`);
  const { code, stderr } = await runPython('-m',
    ['exam_engine.ingest', file.path, '--out', canon, '--export-out', out, '--base-export', dbExp],
    { timeoutMs: 10 * 60 * 1000 });
  cleanup(canon); cleanup(dbExp);
  if (code !== 0 || !fs.existsSync(out)) {
    throw new Error(`Could not read the uploaded file. ${String(stderr || '').trim().split('\n').slice(-2).join(' ')}`);
  }
  const ex = JSON.parse(fs.readFileSync(out, 'utf-8'));
  if (!(ex.student_registrations || []).length) {
    cleanup(out);
    throw new Error('The uploaded file has no student registrations — upload the student-wise report (with the "Courses with Names" column).');
  }
  return out;
}

exports.generateDatesheet = async (req, res) => {
  let exportPath;
  let configPath;
  try {
    let {
      examType, startDate, windowMode, papersPerSlot, numDays,
      programLevel, semester, year, mergeGroups, excludeDates, forceMerges,
      excludeCourses,
    } = req.body || {};
    // Multipart uploads (datesheet from a file) send arrays as JSON strings.
    const _J = (v, d) => { if (v == null || v === '') return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
    mergeGroups = _J(mergeGroups, []);
    excludeDates = _J(excludeDates, []);
    let includeCourses = _J((req.body || {}).includeCourses, []);
    includeCourses = Array.isArray(includeCourses) ? includeCourses.map((x) => String(x).toUpperCase()).filter(Boolean) : [];

    // excludeCourses may arrive as an array (JSON body) or a JSON string
    // (multipart upload). Normalise to an array of course codes.
    let exCourses = excludeCourses;
    if (typeof exCourses === 'string') { try { exCourses = JSON.parse(exCourses); } catch { exCourses = []; } }
    exCourses = Array.isArray(exCourses) ? exCourses.filter(Boolean) : [];
    // always drop no-exam (yellow / project / thesis / internship) courses too
    // DB no-exam flags go to the generator separately (db_no_exam_codes) — see dbNoExamCodes().
    const dbNoExam = await dbNoExamCodes();

    // Blocked windows — time ranges no exam slot may overlap. This is an OPTIONAL,
    // configurable feature (admin passes req.body.blockedWindows = [{day,start,end}]
    // in minutes; day = Python weekday(), Mon=0 … Fri=4 … Sun=6). It defaults to
    // NONE: the university's fixed slots (incl. Friday 01:00-02:30) are kept as-is
    // and Jumma overlap is accepted per the exam office.
    let blockedWindows = (req.body || {}).blockedWindows;
    if (typeof blockedWindows === 'string') { try { blockedWindows = JSON.parse(blockedWindows); } catch { blockedWindows = null; } }
    if (!Array.isArray(blockedWindows)) blockedWindows = [];

    // Same-day groups: courses that must sit on ONE day (in different slots), e.g.
    // English-I/II/III (SS104/SS203/SS211). Admin can override via req.body.sameDayGroups.
    let sameDayGroups = (req.body || {}).sameDayGroups;
    if (typeof sameDayGroups === 'string') { try { sameDayGroups = JSON.parse(sameDayGroups); } catch { sameDayGroups = null; } }
    if (!Array.isArray(sameDayGroups)) sameDayGroups = [['SS104', 'SS203', 'SS211']];

    // firstSlotDepartments: code prefixes (e.g. ["CS","CE"]) the admin chose to
    // pin to the first slot. Absent → generator keeps its default; [] → none.
    let fsDepts = (req.body || {}).firstSlotDepartments;
    const fsProvided = fsDepts !== undefined;
    if (typeof fsDepts === 'string') { try { fsDepts = JSON.parse(fsDepts); } catch { fsDepts = []; } }
    fsDepts = Array.isArray(fsDepts) ? fsDepts.filter(Boolean) : [];

    if (!['mids', 'finals'].includes(examType)) {
      return res.status(400).json({ error: 'Choose either Mid-Term or Final-Term.' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '')) {
      return res.status(400).json({ error: 'Pick a valid start date.' });
    }
    const mode = windowMode === 'by_days' ? 'by_days' : 'by_papers';
    if (mode === 'by_papers' && !(Number(papersPerSlot) > 0)) {
      return res.status(400).json({ error: 'Enter how many papers per slot (a positive number).' });
    }
    if (mode === 'by_days' && !(Number(numDays) > 0)) {
      return res.status(400).json({ error: 'Enter how many exam days (a positive number).' });
    }

    // ── DATA: the live DB, or an uploaded registration file (read, never stored) ──
    if (req.file) {
      exportPath = await exportFromUpload(req.file);
    } else {
      const { exportPath: ep, counts } = await exportDatabaseToJson();
      exportPath = ep;
      if (counts.courses === 0) {
        cleanup(exportPath);
        return res.status(400).json({ error: 'No courses in the database. Add courses first.' });
      }
    }

    // ── COHORT ROUTING (by the STUDENT's program, never by a course's department) ──
    //   MS / MPhil / PhD students      → the Postgraduate datesheet
    //   B.Tech / BSc Eng. Technology   → the B.Tech datesheet (its own evening/weekend slots)
    //   everyone else (BS, BBA, DPT …) → the BS datesheet(s)
    // A course's `department` is only used to SPLIT the BS sheet when the admin picks
    // departments. (Routing by department put B.Tech Electrical papers on the BS sheet
    // whenever departments were selected, and could drop a BS student's paper whose
    // course row happened to carry a B.Tech department.)
    const wantPG = String(programLevel).toLowerCase().startsWith('post');
    if (wantPG) {
      const keptPG = filterExportByCohort(exportPath, _isPGprog);
      if (keptPG === 0) {
        cleanup(exportPath);
        return res.status(400).json({ error: 'No postgraduate (MS) students/courses found to build a datesheet.' });
      }
      // → falls through to the single (MS) datesheet below
    } else {
      let departments = _J((req.body || {}).departments, []);
      departments = Array.isArray(departments) ? departments.filter(Boolean) : [];
      const separate = String((req.body || {}).separate) === 'true' || (req.body || {}).separate === true;

      const raw = JSON.parse(fs.readFileSync(exportPath, 'utf-8'));
      const up = (x) => String(x || '').trim().toUpperCase();
      const isBtechDept = (d) => d === 'btech' || _isBTprog(d);
      const deptOfCode = {};
      for (const c of (raw.courses || [])) {
        const k = up(c.code);
        if (k && c.department && !deptOfCode[k]) deptOfCode[k] = c.department;
      }
      const bsRegs = (raw.student_registrations || []).filter((r) => cohortOfProgram(r.program || r.batch) === 'bs');
      const btRegs = (raw.student_registrations || []).filter((r) => cohortOfProgram(r.program || r.batch) === 'btech');
      const bsCodes = new Set(bsRegs.flatMap((r) => (r.courses || []).map(up)));

      const base = {
        examType, startDate, mode, papersPerSlot, numDays,
        programLevel: programLevel || 'Undergraduate', semester, year,
        mergeGroups: Array.isArray(mergeGroups) ? mergeGroups : [],
        excludeDates: Array.isArray(excludeDates) ? excludeDates : [],
        exCourses, includeCourses, fsDepts, fsProvided, forceMerges: String(forceMerges) === 'true' || forceMerges === true,
        blockedWindows, sameDayGroups,
        maxPerDay: Math.min(2, Math.max(1, Number((req.body || {}).maxPapersPerDay) || 1)),
      };

      // BS jobs: one sheet for all BS students, or split by the selected departments
      // (+ "the rest"). Merge groups and same-day groups are kept inside ONE job — a
      // merge can only happen within one sheet.
      const bsJobs = [];
      const selBs = departments.filter((d) => !isBtechDept(d));
      if (selBs.length) {
        const groups = separate ? selBs.map((d) => [d]) : [selBs];
        const jobOf = new Map();
        groups.forEach((g, i) => { const gs = new Set(g); for (const c of bsCodes) if (gs.has(deptOfCode[c] || '')) jobOf.set(c, i); });
        const restIdx = groups.length;
        for (const c of bsCodes) if (!jobOf.has(c)) jobOf.set(c, restIdx);
        for (const grp of [...base.mergeGroups, ...(base.sameDayGroups || []), ['SS104', 'SS211']]) {
          const cs = (grp || []).map(up).filter((c) => jobOf.has(c));
          if (cs.length > 1) { const tgt = Math.min(...cs.map((c) => jobOf.get(c))); cs.forEach((c) => jobOf.set(c, tgt)); }
        }
        const restDepts = [...new Set([...bsCodes].filter((c) => jobOf.get(c) === restIdx).map((c) => deptOfCode[c] || '').filter(Boolean))];
        [...groups, restDepts].forEach((g, i) => {
          const codes = new Set([...jobOf].filter(([, j]) => j === i).map(([c]) => c));
          if (codes.size) bsJobs.push({ depts: g.length ? g : ['other'], codes, label: undefined });
        });
      } else if (bsCodes.size) {
        bsJobs.push({ depts: [...new Set([...bsCodes].map((c) => deptOfCode[c] || '').filter(Boolean))], codes: null, label: '' });
      }

      const records = [];
      const errors = [];
      const tmp = [];
      try {
        // ALL BS papers are solved in ONE model (one student never double-booked across
        // department PDFs); department selection only splits the OUTPUT into PDFs.
        if (bsJobs.length) {
          const { path: fp, courseCount } = writeStudentCohortExport(raw, 'bs', null, 'bs');
          tmp.push(fp);
          if (courseCount) {
            try {
              if (bsJobs.length === 1 && bsJobs[0].codes === null) {
                const { record } = await runDatesheetJob(base, fp, bsJobs[0].depts, bsJobs[0].label);
                records.push(record);
              } else {
                const splits = bsJobs.map((j) => ({ depts: j.depts, codes: j.codes, label: j.label }));
                const { record, result } = await runDatesheetJob(base, fp, ['bs'], '', undefined, undefined, splits);
                const recs = await recordSplits(base, result, splits);
                if (recs.length) {
                  records.push(...recs);
                  await GeneratedFile.deleteOne({ _id: record._id });   // joint sheet = union of the department PDFs
                  cleanup(path.join(OUTPUT_DIR, record.files[0].filename));
                  if (record.meta && record.meta.scheduleFile) cleanup(path.join(OUTPUT_DIR, record.meta.scheduleFile));
                } else {
                  records.push(record);
                }
              }
            } catch (jobErr) {
              errors.push(`BS: ${jobErr.message}`);
              console.error('BS datesheet job failed:', jobErr.message);
            }
          }
        }
        // B.Tech is ALWAYS its own sheet (evening/weekend slots), built from ITS
        // students' registrations — selected or not, its papers never sit on a BS sheet.
        if (btRegs.length) {
          const { path: fp, courseCount } = writeStudentCohortExport(raw, 'btech', null, 'btech');
          tmp.push(fp);
          if (courseCount) {
            try {
              const { record } = await runDatesheetJob(base, fp, ['btech'], undefined);
              records.push(record);
            } catch (jobErr) {
              errors.push(`B.Tech: ${jobErr.message}`);
              console.error('B.Tech datesheet job failed:', jobErr.message);
            }
          }
        }
      } finally {
        tmp.forEach(cleanup);
        cleanup(exportPath);
      }
      if (!records.length) {
        return res.status(500).json({ error: errors[0] || 'No examinable courses to schedule.' });
      }
      try {
        for (const coh of new Set(records.map(datesheetCohort))) {
          await pruneOldDatesheets(records.filter((r) => datesheetCohort(r) === coh).map((r) => r._id), coh, examType);
        }
      } catch (e) { console.error('prune datesheets:', e.message); }
      await logActivity('generate.datesheet',
        `${records.length} datesheet(s) generated${errors.length ? `; FAILED: ${errors.join(' | ').slice(0, 1500)}` : ''}`, errors.length ? 'warning' : 'success');
      return res.json({ ok: true, records, multi: true, errors });
    }

    const stamp = Date.now();
    const label = examType === 'mids' ? 'Mids' : 'Finals';
    const pdfName = `Datesheet_${label}_${stamp}.pdf`;
    const pdfPath = path.join(OUTPUT_DIR, pdfName);

    // The MS (Postgraduate) datesheet is INDEPENDENT and ENROLLMENT-based: it holds
    // every examinable course MS students take — the ≥500 core PLUS the gen-ed they
    // sit (SS121/SS122 Fahm-ul-Quran, ENG449) as MS's OWN papers in MS slots, so
    // they appear on the MS sheet just like they do on BS/BTech (different paper).

    // Build a config file with every user input
    const config = {
      exam_type: examType,
      start_date: startDate,
      window_mode: mode,
      papers_per_slot: mode === 'by_papers' ? Number(papersPerSlot) : undefined,
      num_days: mode === 'by_days' ? Number(numDays) : undefined,
      max_papers_per_day: Math.min(2, Math.max(1, Number((req.body || {}).maxPapersPerDay) || 1)),
      program_level: programLevel || 'Undergraduate',
      semester: semester || undefined,
      year: year ? Number(year) : undefined,
      merge_groups: Array.isArray(mergeGroups) ? mergeGroups : [],
      exclude_dates: Array.isArray(excludeDates) ? excludeDates : [],
      exclude_courses: exCourses,   // course codes the user chose to remove
      db_no_exam_codes: dbNoExam,   // DB flags; FYP/thesis/labs also auto-excluded by the generator
      include_courses: includeCourses,   // auto no-exam courses the admin chose to KEEP
      blocked_windows: blockedWindows,   // Friday Jumma etc. — no slot may overlap
      same_day_groups: sameDayGroups,     // English-I/II/III etc. — one day, 3 slots
      ...(fsProvided ? { first_slot_departments: fsDepts } : {}),
      force_merges: String(forceMerges) === 'true' || forceMerges === true,
      data_json: exportPath,
      out: pdfPath,
    };
    configPath = path.join(OUTPUT_DIR, `dsconfig_${stamp}.json`);
    fs.writeFileSync(configPath, JSON.stringify(config));

    const { code, stdout } = await runPython(path.join(SCHEDULER_DIR, 'datesheet.py'), ['--config', configPath], { timeoutMs: 30 * 60 * 1000 });

    // datesheet.py prints a JSON result line
    let result = {};
    const lastLine = stdout.trim().split('\n').filter(Boolean).pop() || '{}';
    try {
      result = JSON.parse(lastLine);
    } catch {
      result = {};
    }

    if (code !== 0 || result.error || !fs.existsSync(pdfPath)) {
      cleanup(exportPath); cleanup(configPath);
      return res.status(500).json({ error: result.error || 'Datesheet generation failed.', log: stdout.slice(-800) });
    }

    // collect output files (datesheet + its companion analysis report)
    const dsFiles = [{ label: 'Datesheet PDF', filename: pdfName, format: 'pdf', sizeBytes: fileSize(pdfPath) }];
    const reportName = `Datesheet_${label}_${stamp}_Report.pdf`;
    const reportPath = path.join(OUTPUT_DIR, reportName);
    if (fs.existsSync(reportPath)) {
      dsFiles.push({ label: 'Analysis Report', filename: reportName, format: 'pdf', sizeBytes: fileSize(reportPath) });
    }

    const record = await GeneratedFile.create({
      kind: 'datesheet',
      examType,
      title: result.heading || `${examType === 'mids' ? 'Mid-Term' : 'Final-Term'} Datesheet — ${result.start_date} to ${result.end_date}`,
      files: dsFiles,
      summary: { courses: result.total_courses, days: result.total_days, papers: result.total_papers, studentClashes: result.student_clashes, minDaysClashfree: result.min_days_clashfree },
      meta: {
        startDate: result.start_date, endDate: result.end_date,
        heading: result.heading, filename: result.filename,
        slotsPerDay: result.slots_per_day, papersPerSlot: result.papers_per_slot,
        scheduleFile: result.schedule_file ? require('path').basename(result.schedule_file) : null,
        windowMode: result.window_mode, clashFixes: result.clash_fixes,
        programLevel: result.program_level, semester: result.semester, year: result.year,
        studentClashes: result.student_clashes, batchOverlaps: result.batch_overlaps,
        noExamAuto: result.auto_excluded || {}, restoredNoExam: result.restored_no_exam || [], reviewNoExam: result.review_no_exam || [],
        // store the exact inputs so the datesheet can be re-generated / edited
        config: {
          examType, startDate, windowMode: mode,
          papersPerSlot: mode === 'by_papers' ? Number(papersPerSlot) : undefined,
          numDays: mode === 'by_days' ? Number(numDays) : undefined,
          programLevel: programLevel || 'Undergraduate', semester, year,
          mergeGroups: Array.isArray(mergeGroups) ? mergeGroups : [],
          excludeDates: Array.isArray(excludeDates) ? excludeDates : [],
        },
      },
      status: 'ready',
    });

    cleanup(exportPath); cleanup(configPath);
    // MS keeps only its LATEST datesheet — replace the previous MS datesheet of this exam.
    try { await pruneOldDatesheets([record._id], datesheetCohort(record), examType); }
    catch (e) { console.error('prune datesheets:', e.message); }
    await logActivity(
      'generate.datesheet',
      `${examType === 'mids' ? 'Mid-Term' : 'Final-Term'} datesheet generated (${result.total_courses} courses, ${result.total_days} days)`,
      'success'
    );

    res.json({ ok: true, record, result });
  } catch (err) {
    cleanup(exportPath); cleanup(configPath);
    console.error('Datesheet generation error:', err);
    res.status(500).json({ error: err.message || 'Datesheet generation failed.' });
  }
};

/**
 * POST /api/generate/datesheet-from-file   (multipart, field "dataset")
 *
 * Generate a datesheet DIRECTLY from an uploaded .xls/.xlsx registration file.
 * The database is never touched — this is the intended flow for datesheets,
 * which are produced a couple of times a semester from a fresh export. The
 * uploaded file is deleted as soon as the PDF is built.
 */
// Datesheet from an uploaded registration file: SAME cohort routing as the DB flow
// (BS · B.Tech · MS sheets on their own slots). The file is read, never stored.
exports.generateDatesheetFromFile = (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach an .xls, .xlsx or .csv registration file.' });
  res.on('finish', () => cleanup(req.file && req.file.path));
  return exports.generateDatesheet(req, res);
};

/**
 * POST /api/generate/admit-cards   (multipart, field "dataset")
 *
 * Generate per-student ADMIT CARDS + an anti-cheating SEATING PLAN from an
 * uploaded student registration file. Rooms/labs (with exam capacities) and the
 * per-course teachers come from the live database; the datesheet is scheduled
 * internally by the SAME clash-free engine so the mapping is always consistent.
 *
 * Body: examType, startDate, windowMode, papersPerSlot|numDays, programLevel,
 *       semester, year, campusLine, includeLabs, excludeDates, mergeGroups
 */
exports.generateAdmitCards = async (req, res) => {
  let exportPath;
  let configPath;
  let progressPath = null;
  let mergedSchedulePath = null;
  const mergedSchedulePaths = [];
  const uploadPath = req.file ? req.file.path : null;
  try {
    // The student registration file is OPTIONAL now — if none is uploaded, cards
    // are built straight from the database (StudentRegistration, imported under
    // Import Data). We verify the DB has registrations before running.
    let { datesheetId, datesheetIds, campusLine, includeLabs, progressToken, cohort } = req.body || {};
    cohort = String(cohort || '').toLowerCase();
    // SEATING IS ALWAYS GLOBAL: the generator seats ALL programs together (from
    // every cohort's datesheet) so shared rooms/benches are conflict-free and anti-
    // cheating holds across cohorts, and — because that seating is deterministic —
    // generating cohorts SEPARATELY at different times still yields identical,
    // clash-free seats. `outputCohort` decides which cohort's ADMIT CARDS this run
    // ISSUES: bs|btech|pg → a separate per-cohort batch; 'all'/'' → one batch for
    // everyone. Either way the seating considers everyone.
    const outputCohort = ['bs', 'btech', 'pg'].includes(cohort) ? cohort : '';
    const safeToken = String(progressToken || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
    progressPath = safeToken ? path.join(OUTPUT_DIR, `acprogress_${safeToken}.json`) : null;

    // Accept ONE datesheet (datesheetId) or MANY (datesheetIds). Cards built from
    // several datesheets merge every student's papers into ONE card — so BTech
    // students (in their own datesheet) aren't dropped. Every student gets a card.
    if (typeof datesheetIds === 'string') { try { datesheetIds = JSON.parse(datesheetIds); } catch { datesheetIds = []; } }
    let idList = Array.isArray(datesheetIds) ? datesheetIds.filter(Boolean) : [];
    if (!idList.length && datesheetId) idList = [datesheetId];
    if (!idList.length) {
      return res.status(400).json({ error: 'Choose the datesheet(s) these admit cards are for.' });
    }

    // No file uploaded → the DB must already hold student registrations (with
    // names). Guide the user to Import Data if it doesn't.
    if (!uploadPath) {
      const regCount = await StudentRegistration.countDocuments({});
      if (regCount === 0) {
        return res.status(400).json({ error: 'No student registrations in the database. Import the registration report under Import Data (or attach the file here).' });
      }
      const withName = await StudentRegistration.countDocuments({ name: { $exists: true, $ne: '' } });
      if (withName === 0) {
        return res.status(400).json({ error: 'Student registrations have no names yet. Re-import the registration report under Import Data (with the "Student Name" column), then generate — no upload needed.' });
      }
    }

    const datesheets = [];
    for (const id of idList) {
      const d = await GeneratedFile.findById(id).lean().catch(() => null);
      if (d && d.kind === 'datesheet') datesheets.push(d);
    }
    if (!datesheets.length) {
      return res.status(404).json({ error: 'No valid datesheet found. Generate a datesheet first.' });
    }
    const datesheet = datesheets[0];   // primary → heading / exam type / term

    // Each datesheet's frozen schedule JSON (exact dates/times).
    const schedulePaths = datesheets
      .map((d) => d.meta && d.meta.scheduleFile)
      .filter(Boolean)
      .map((n) => path.join(OUTPUT_DIR, path.basename(n)))
      .filter((p) => fs.existsSync(p));

    // Merge multiple schedules into one so a card lists ALL of a student's papers.
    let schedulePath = schedulePaths[0] || null;
    if (schedulePaths.length > 1) {
      const merged = { dates: [], slots: [], courses: [] };
      const seenCode = new Set();
      let firstMeta = null;
      for (const p of schedulePaths) {
        const s = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (!firstMeta) firstMeta = s;
        for (const d of (s.dates || [])) if (!merged.dates.includes(d)) merged.dates.push(d);
        for (const sl of (s.slots || [])) if (!merged.slots.includes(sl)) merged.slots.push(sl);
        for (const c of (s.courses || [])) {
          const key = String(c.code || '').toUpperCase();
          if (key && !seenCode.has(key)) { seenCode.add(key); merged.courses.push(c); }
        }
      }
      merged.dates.sort();
      Object.assign(merged, {
        exam_type: firstMeta.exam_type, semester: firstMeta.semester, year: firstMeta.year,
        program_level: firstMeta.program_level, heading: firstMeta.heading,
      });
      mergedSchedulePath = path.join(OUTPUT_DIR, `acmerged_${Date.now()}.json`);
      fs.writeFileSync(mergedSchedulePath, JSON.stringify(merged));
      schedulePath = mergedSchedulePath;
    }
    const haveSchedule = schedulePath && fs.existsSync(schedulePath);
    const dsConfig = (datesheet.meta && datesheet.meta.config) || {};

    // Export the DB → gives rooms/labs (with examCapacity) + course teachers.
    const { exportPath: ep, counts } = await exportDatabaseToJson();
    exportPath = ep;
    if (counts.rooms === 0 && counts.labs === 0) {
      cleanup(exportPath);
      return res.status(400).json({ error: 'No rooms or labs in the database. Add exam venues first.' });
    }

    const examType = datesheet.examType || dsConfig.examType || 'finals';
    const stamp = Date.now();
    const label = examType === 'mids' ? 'Mids' : 'Finals';
    const pdfName = `AdmitCards_${label}_${stamp}.pdf`;
    const seatName = `AdmitCards_${label}_${stamp}_SeatingPlan.pdf`;
    const idsheetName = `AdmitCards_${label}_${stamp}_IdentificationSheets.pdf`;
    const invigName = `AdmitCards_${label}_${stamp}_Invigilation.pdf`;
    const verifyName = `AdmitCards_${label}_${stamp}_verify.json`;
    const pdfPath = path.join(OUTPUT_DIR, pdfName);
    const seatPath = path.join(OUTPUT_DIR, seatName);
    const idsheetPath = path.join(OUTPUT_DIR, idsheetName);
    const invigPath = path.join(OUTPUT_DIR, invigName);
    const verifyPath = path.join(OUTPUT_DIR, verifyName);

    // Auto-detected LAN base URL for the QR (PUBLIC_BASE_URL overrides).
    const baseUrl = detectBaseUrl(req);

    const config = {
      campus_line: campusLine || 'Abasyn University Islamabad Campus',
      include_labs: String(includeLabs) !== 'false',
      dataset_xlsx: uploadPath,   // students (names + registered courses)
      data_json: exportPath,      // rooms/labs + teachers
      out: pdfPath,
      out_seating: seatPath,
      out_idsheets: idsheetPath,
      out_invig: invigPath,
      out_verify: verifyPath,
      base_url: baseUrl,
      // Server secret used ONLY to sign the QR token so a hand-made QR is
      // rejected. Passed to the generator over a local temp file; never leaves
      // the machine and never appears in a client response.
      verify_secret: admitCrypto.SECRET,
      // Freshly generated cards are UNPAID by default — held from the student
      // portal / email / print until Finance clears the fee (list upload or the
      // manual Paid toggle). Nothing shows to a student until then.
      fee_default: 'Unpaid',
      progress_file: progressPath || undefined,
      // Cohort filter: 'bs' | 'btech' | 'pg' → this batch seats only that cohort,
      // so B.Tech gets its own separate seating plan / admit cards.
      output_cohort: outputCohort || undefined,   // which cohort's cards to ISSUE
    };
    // Map each cohort → its own frozen schedule so a student's paper time comes from
    // THEIR program's datesheet, while the SEATING considers all cohorts together.
    // Built from every datesheet passed in (the frontend sends all cohorts' sheets),
    // so the global seating is the same no matter which cohort we're issuing.
    // A cohort may have SEVERAL sheets (BS split by department) — merge them into one
    // per-cohort schedule so NO sheet's papers are dropped from the admit cards
    // (previously only the first BS sheet was used).
    let dsByCohort = {};
    const _sheetsByCohort = {};
    for (const d of datesheets) {
      const tag = datesheetCohort(d);
      const sf = d.meta && d.meta.scheduleFile;
      const p = sf && path.join(OUTPUT_DIR, path.basename(sf));
      if (p && fs.existsSync(p)) (_sheetsByCohort[tag] = _sheetsByCohort[tag] || []).push(p);
    }
    for (const [tag, list] of Object.entries(_sheetsByCohort)) {
      if (list.length === 1) { dsByCohort[tag] = list[0]; continue; }
      const merged = { dates: [], slots: [], courses: [], sessions: [], excluded_codes: [] };
      const seen = new Set();
      let first = null;
      for (const p of list) {
        const sch = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (!first) first = sch;
        for (const dd of (sch.dates || [])) if (!merged.dates.includes(dd)) merged.dates.push(dd);
        for (const sl of (sch.slots || [])) if (!merged.slots.includes(sl)) merged.slots.push(sl);
        for (const c of (sch.courses || [])) {
          const k = String(c.code || '').toUpperCase();
          if (k && !seen.has(k)) { seen.add(k); merged.courses.push(c); }
        }
        merged.excluded_codes.push(...(sch.excluded_codes || []));
      }
      merged.dates.sort();
      merged.excluded_codes = [...new Set(merged.excluded_codes)].filter((c) => !seen.has(String(c).toUpperCase()));
      Object.assign(merged, { exam_type: first.exam_type, semester: first.semester, year: first.year,
        program_level: first.program_level, heading: first.heading });
      const mp = path.join(OUTPUT_DIR, `acmerged_${tag}_${Date.now()}.json`);
      fs.writeFileSync(mp, JSON.stringify(merged));
      dsByCohort[tag] = mp;
      mergedSchedulePaths.push(mp);
    }
    let issueAll = false;
    if (Object.keys(dsByCohort).length) {
      config.datesheets_by_cohort = dsByCohort;   // global seating over all programs
      // COMPULSION: admit cards are issued for ALL programs together, so they cannot
      // be generated until BS, B.Tech AND MS datesheets all exist. (No more separate
      // per-cohort admit runs — one click makes every student's card.)
      const REQUIRED = ['bs', 'btech', 'pg'];
      const LABEL = { bs: 'BS (Undergraduate)', btech: 'B.Tech', pg: 'MS (Postgraduate)' };
      const missing = REQUIRED.filter((c) => !dsByCohort[c]);
      if (missing.length) {
        cleanup(exportPath);
        return res.status(400).json({
          error: `Datesheets for ${missing.map((c) => LABEL[c]).join(', ')} not found. `
            + 'Admit cards are generated for ALL programs together in one run, so the BS, B.Tech and MS '
            + 'datesheets must all be generated first — then one click issues every student\'s admit card.',
          missingDatesheets: missing,
        });
      }
      config.output_cohort = undefined;   // one-click ALL — never a single-cohort batch
      issueAll = true;
    } else if (haveSchedule) {
      // Exact: read the datesheet's frozen schedule (no re-scheduling).
      config.datesheet_json = schedulePath;
    } else {
      // Fallback: reproduce the datesheet from its saved settings.
      config.exam_type = examType;
      config.start_date = dsConfig.startDate;
      config.window_mode = dsConfig.windowMode || 'by_papers';
      config.papers_per_slot = dsConfig.papersPerSlot;
      config.num_days = dsConfig.numDays;
      config.program_level = dsConfig.programLevel || 'Undergraduate';
      config.semester = dsConfig.semester;
      config.year = dsConfig.year;
      config.merge_groups = Array.isArray(dsConfig.mergeGroups) ? dsConfig.mergeGroups : [];
      config.exclude_dates = Array.isArray(dsConfig.excludeDates) ? dsConfig.excludeDates : [];
      if (!config.start_date) {
        cleanup(exportPath);
        return res.status(400).json({
          error: 'This datesheet has no saved schedule to build cards from. Re-generate the datesheet, then try again.',
        });
      }
    }

    // This batch's cohort tag (bs | btech | pg → separate per-cohort batch; 'all'
    // → one batch for everyone). Drives the BS/B.Tech/MS view toggles + fee release.
    const thisCohort = issueAll ? 'all' : (outputCohort || 'all');

    // Cross-cohort room/invigilator EXCLUSION is ONLY for the legacy fallback where
    // this run seats just one datesheet in isolation. With global seating
    // (datesheets_by_cohort) every program is placed together in ONE deterministic
    // pass, so there is nothing to exclude — sharing a room is correct by design.
    if (!config.datesheets_by_cohort) try {
      const cohortOf = (b) => (b.meta && b.meta.cohort)
        || (/post/i.test((b.meta && b.meta.programLevel) || (/postgrad/i.test(b.title || '') ? 'Postgraduate' : '')) ? 'pg' : 'bs');
      const others = await GeneratedFile.find({ kind: 'admit_cards' }).sort({ createdAt: -1 })
        .select('title meta.cohort meta.programLevel meta.invigilatorsBySession meta.invigilatorDayLoad').lean();
      const seen = new Set([thisCohort]);
      const otherBatchIds = [];
      const invExclude = {};   // 'DD-Mon-YYYY|slot' → [teacher names on duty elsewhere]
      const invDayExclude = {}; // teacher → { 'DD-Mon-YYYY' → duties } across other cohorts
      for (const b of others) {
        const c = cohortOf(b);
        if (seen.has(c)) continue;
        seen.add(c);
        otherBatchIds.push(b._id);   // newest batch of each OTHER cohort
        // teachers that cohort already put on duty, per (date, slot)
        const inv = (b.meta && b.meta.invigilatorsBySession) || {};
        for (const [k, names] of Object.entries(inv)) {
          invExclude[k] = (invExclude[k] || []).concat(names || []);
        }
        // teachers' per-DAY duty counts in that cohort → carried into the ≤2/day cap
        const dl = (b.meta && b.meta.invigilatorDayLoad) || {};
        for (const [name, days] of Object.entries(dl)) {
          invDayExclude[name] = invDayExclude[name] || {};
          for (const [d, n] of Object.entries(days || {})) invDayExclude[name][d] = (invDayExclude[name][d] || 0) + (Number(n) || 0);
        }
      }
      if (otherBatchIds.length) {
        const rows = await AdmitVerification.aggregate([
          { $match: { batchId: { $in: otherBatchIds } } },
          { $unwind: '$exams' },
          { $group: { _id: { date: '$exams.date', slot: '$exams.slot' }, rooms: { $addToSet: '$exams.room' } } },
        ]);
        const map = {};
        for (const r of rows) { const k = `${r._id.date}|${r._id.slot}`; map[k] = (map[k] || []).concat((r.rooms || []).filter(Boolean)); }
        if (Object.keys(map).length) config.exclude_rooms_by_session = map;
      }
      // No teacher invigilates two rooms at once across cohorts (BS ↔ B.Tech ↔ MS).
      if (Object.keys(invExclude).length) config.exclude_invigilators_by_session = invExclude;
      // No teacher exceeds 2 duties on one day across ALL cohorts combined.
      if (Object.keys(invDayExclude).length) config.exclude_invigilator_day_load = invDayExclude;
    } catch { /* best-effort — small-room-first for MS still separates them */ }

    configPath = path.join(OUTPUT_DIR, `acconfig_${stamp}.json`);
    fs.writeFileSync(configPath, JSON.stringify(config));

    // Admit-card jobs for thousands of students render slowly (reportlab + a QR
    // per card). Give the generator plenty of headroom so it COMPLETES instead
    // of being killed mid-run; the frontend tracks live progress by polling.
    const { code, stdout } = await runPython(path.join(SCHEDULER_DIR, 'admit_cards.py'), [
      '--config', configPath,
    ], { timeoutMs: 90 * 60 * 1000 });   // 90 min — handles 5,000–10,000 cards

    let result = {};
    const lastLine = stdout.trim().split('\n').filter(Boolean).pop() || '{}';
    try { result = JSON.parse(lastLine); } catch { result = {}; }

    if (code !== 0 || result.status === 'failed' || result.error || !fs.existsSync(pdfPath)) {
      cleanup(exportPath); cleanup(configPath);
      return res.status(500).json({ error: result.error || 'Admit-card generation failed.', log: stdout.slice(-800) });
    }

    const files = [{ label: 'Admit Cards PDF', filename: pdfName, format: 'pdf', sizeBytes: fileSize(pdfPath) }];
    if (fs.existsSync(seatPath)) {
      files.push({ label: 'Seating Plan PDF', filename: seatName, format: 'pdf', sizeBytes: fileSize(seatPath) });
    }
    if (fs.existsSync(idsheetPath)) {
      files.push({ label: 'Identification Sheets PDF', filename: idsheetName, format: 'pdf', sizeBytes: fileSize(idsheetPath) });
    }
    if (fs.existsSync(invigPath)) {
      files.push({ label: 'Invigilation Roster PDF', filename: invigName, format: 'pdf', sizeBytes: fileSize(invigPath) });
    }

    const cohortLabel = thisCohort === 'all' ? 'All Programs' : thisCohort === 'btech' ? 'B.Tech' : thisCohort === 'pg' ? 'MS' : 'BS';
    const record = await GeneratedFile.create({
      kind: 'admit_cards',
      examType,
      title: `Admit Cards — ${cohortLabel} · ${result.heading || (examType === 'mids' ? 'Mid-Term' : 'Final-Term')}`,
      files,
      summary: {
        students: result.total_students, admitCards: result.admit_cards,
        studentsNoPaper: result.students_no_paper, sessions: result.sessions,
        soloBenches: result.solo_benches, overflowBenches: result.overflow_benches,
        seatsShort: result.seats_short,
        unseatedCount: result.unseated_count || 0,   // scheduled papers with no seat (venue capacity) — must be 0
        // Independent audit (exam_engine.audit): null when it could not run (legacy single-sheet mode)
        auditClean: result.audit ? !!result.audit.clean : null,
        auditHard: result.audit ? (result.audit.hard_counts || {}) : null,
      },
      meta: {
        cohort: thisCohort,   // bs | btech | pg — drives the BS/B.Tech/MS toggles
        invigilatorsBySession: result.invigilators_by_session || {},   // for cross-cohort invig de-clash
        invigilatorDayLoad: result.invigilator_day_load || {},         // for cross-cohort ≤2/day cap
        clashCount: result.clash_count || 0,
        clashes: Array.isArray(result.clashes) ? result.clashes.slice(0, 500) : [],
        heading: result.heading, campusLine: result.campus_line,
        startDate: result.start_date, endDate: result.end_date,
        totalDays: result.total_days, venues: result.venues,
        venueBenchCapacity: result.venue_bench_capacity,
        venueSeatCapacity: result.venue_seat_capacity,
        peakSessionStudents: result.peak_session_students,
        programLevel: result.program_level, semester: result.semester, year: result.year,
        seatingReport: result.seating_report,
        verifyFile: verifyName, baseUrl,
        audit: result.audit || null,
      },
      status: 'ready',
    });

    // Persist per-student verification records (QR → /verify/:token).
    let verifyCount = 0;
    try {
      if (fs.existsSync(verifyPath)) {
        const v = JSON.parse(fs.readFileSync(verifyPath, 'utf-8'));
        const docs = (v.students || []).map((s) => ({
          token: s.token, batchId: record._id,
          studentId: s.sid, name: s.name, program: s.program, batch: s.batch,
          cardPage: s.page || 0,
          // Fee gate: a freshly generated card is ALWAYS UNPAID → hidden on the
          // student portal, not emailable and not printable until Finance clears
          // the fee (by reg no. manually, or in bulk via the fee-paid list upload).
          feeStatus: 'Unpaid',
          heading: v.heading, examType: v.exam_type, semester: v.semester, year: v.year,
          exams: (s.exams || []).map((e) => ({
            code: e.code, name: e.name, teacher: e.teacher,
            date: e.date, dateDisp: e.date_disp, day: e.day, slot: e.slot,
            start: e.start, finish: e.finish, room: e.room, seat: e.seat,
            // Per-(student, paper) 64-bit key — derived from the signed token +
            // this paper. One-way; stored only server-side, never exposed.
            key: admitCrypto.paperKey(s.token, e.code, e.date, e.slot),
          })),
        }));
        if (docs.length) { await AdmitVerification.insertMany(docs, { ordered: false }); verifyCount = docs.length; }
      }
    } catch (e) { console.error('verify store error:', e.message); }
    cleanup(verifyPath);
    result.verify_records = verifyCount;

    cleanup(exportPath); cleanup(configPath);
    await logActivity(
      'generate.admit_cards',
      `Admit cards generated (${result.admit_cards} cards, ${result.sessions} sessions, ${result.solo_benches} solo benches)`,
      (result.seats_short > 0 || (result.audit && !result.audit.clean)) ? 'warning' : 'success'
    );
    if (result.audit && !result.audit.clean) {
      await logActivity('audit.admit_cards', `Admit-card audit found violations: ${JSON.stringify(result.audit.hard_counts)}`, 'warning');
    }

    res.json({ ok: true, record, result });
  } catch (err) {
    cleanup(exportPath); cleanup(configPath);
    console.error('Admit-card generation error:', err);
    res.status(500).json({ error: err.message || 'Admit-card generation failed.' });
  } finally {
    try { if (uploadPath && fs.existsSync(uploadPath)) fs.unlinkSync(uploadPath); } catch { /* ignore */ }
    cleanup(progressPath);
    cleanup(mergedSchedulePath);
    mergedSchedulePaths.forEach(cleanup);
  }
};

// Fee gate: 'Unpaid' contains the substring "paid", so UNPAID must be checked
// first. Blank / unknown → treated as NOT paid (card stays locked).
function isFeePaid(s) {
  const v = String(s == null ? '' : s).toLowerCase();
  if (v.includes('unpaid') || v.includes('not paid')) return false;
  return v.includes('paid');
}

// Locate a student's most recent admit-card record + its batch PDF filename.
async function locateStudentCard(reg) {
  const av = await AdmitVerification.findOne({ studentId: reg }).sort({ createdAt: -1 }).lean();
  if (!av) return { found: false };
  let filename = null;
  if (av.batchId) {
    const batch = await GeneratedFile.findById(av.batchId).lean().catch(() => null);
    const f = batch && (batch.files || []).find((x) => /admit/i.test(x.label) && x.format === 'pdf');
    filename = f ? f.filename : null;
  }
  return { found: true, av, filename };
}

/**
 * GET /api/generate/admit-card/find?reg=  → { found, reg, name, program, batch, papers, canPrint }
 * Look up a single student's admit card by registration number.
 */
exports.findStudentCard = async (req, res) => {
  const reg = String(req.query.reg || '').trim();
  if (!reg) return res.status(400).json({ error: 'Enter a registration number.' });
  const r = await locateStudentCard(reg);
  if (!r.found) return res.json({ found: false });
  const { av, filename } = r;
  const feePaid = isFeePaid(av.feeStatus);
  res.json({
    found: true, reg: av.studentId, name: av.name, program: av.program, batch: av.batch,
    papers: (av.exams || []).length, cardPage: av.cardPage,
    feeStatus: feePaid ? 'Paid' : 'Unpaid', feePaid,
    // Card can only be printed when the page exists AND the fee is cleared.
    canPrint: !!(filename && av.cardPage && feePaid),
  });
};

/**
 * GET /api/generate/admit-card/pdf?reg=  → streams ONLY that student's 1-page admit card.
 * Extracts the single page (cardPage) from the batch admit-card PDF with pdf-lib.
 */
exports.studentCardPdf = async (req, res) => {
  const reg = String(req.query.reg || '').trim();
  if (!reg) return res.status(400).json({ error: 'Enter a registration number.' });
  const r = await locateStudentCard(reg);
  if (!r.found || !r.filename || !r.av.cardPage) {
    return res.status(404).json({ error: 'No printable admit card found for that registration number.' });
  }
  // Fee gate — an unpaid student's card is not issued (portal / email / print).
  if (!isFeePaid(r.av.feeStatus)) {
    return res.status(403).json({ error: 'Fee is unpaid — mark this student as Paid to issue the admit card.' });
  }

  // If this student's course was edited/deleted after the batch was generated, an
  // up-to-date 1-page card was re-rendered (studentCourseController). Serve THAT
  // when it is newer than the batch file, so the printed/emailed card is current
  // even before the whole-batch PDF has been spliced in the background.
  try {
    const upd = await GeneratedFile.findOne({ kind: 'admit_update', 'meta.reg': reg }).lean();
    const updName = upd && upd.files && upd.files[0] && upd.files[0].filename;
    if (updName) {
      const updPath = path.join(OUTPUT_DIR, path.basename(updName));
      const batchPath = path.join(OUTPUT_DIR, path.basename(r.filename));
      const fresher = fs.existsSync(updPath)
        && (!fs.existsSync(batchPath) || fs.statSync(updPath).mtimeMs >= fs.statSync(batchPath).mtimeMs);
      if (fresher) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="AdmitCard_${reg}.pdf"`);
        return res.end(fs.readFileSync(updPath));
      }
    }
  } catch (e) { /* fall back to the batch extract below */ }

  const pdfPath = path.join(OUTPUT_DIR, path.basename(r.filename));
  if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: 'Admit-card PDF file is missing — re-generate the admit cards.' });
  try {
    const { PDFDocument } = require('pdf-lib');
    const src = await PDFDocument.load(fs.readFileSync(pdfPath));
    const idx = r.av.cardPage - 1;
    if (idx < 0 || idx >= src.getPageCount()) return res.status(404).json({ error: 'This card page is out of range — re-generate the admit cards.' });
    const out = await PDFDocument.create();
    const [pg] = await out.copyPages(src, [idx]);
    out.addPage(pg);
    const bytes = await out.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="AdmitCard_${reg}.pdf"`);
    return res.end(Buffer.from(bytes));
  } catch (e) {
    console.error('studentCardPdf error:', e.message);
    return res.status(500).json({ error: 'Could not extract the admit card.' });
  }
};

/**
 * GET /api/generate/tags[?batchId=]  → a printable PDF of Question-Paper-Envelope
 * tags, one per (course, room, session), built from the admit-card seating data.
 * Each tag shows Teacher, Room, Exam Date, Time, Course (code+name), Section,
 * No. of Students and Type (Mid/Final Term) — like the physical envelope label.
 */
const TAGS_LOGO = path.join(__dirname, '..', '..', 'frontend', 'public', 'favicon.png');
exports.generateTags = async (req, res) => {
  try {
    let batch = null;
    if (req.query.batchId) batch = await GeneratedFile.findById(req.query.batchId).lean().catch(() => null);
    if (!batch) batch = await GeneratedFile.findOne({ kind: 'admit_cards' }).sort({ createdAt: -1 }).lean();
    if (!batch) return res.status(404).json({ error: 'No admit cards found. Generate admit cards first, then print tags.' });

    const avs = await AdmitVerification.find({ batchId: batch._id }).select('examType exams program').lean();
    if (!avs.length) return res.status(404).json({ error: 'No exam records for this admit-card batch. Re-generate the admit cards.' });

    // course code → its section(s), to show a section on the tag when meaningful
    // Placeholder faculty values ("no teacher" from the class-wise report, TBA…) are
    // NOT names — never print them on an envelope.
    const NO_T = /^\s*(tba|tbd|tbc|nan|none|null|n\/?a|-+|—|–|no\s*teacher|not\s*assigned|unassigned|to\s*be\s*(announced|assigned|decided))\s*\.?\s*$/i;
    const cleanT = (t) => {
      let x = String(t || '').trim();
      if (x.includes(' - ')) x = x.split(' - ').map((p) => p.trim()).filter((p) => p && !p.includes('@') && !/^[A-Za-z&]+-\d+$/.test(p)).pop() || '';
      return NO_T.test(x) ? '' : x;
    };
    const joinTeachers = (list) => {
      const seen = new Set(); const out = [];
      for (const part of list.flatMap((t) => String(t || '').split(/\s*\/\s*/))) {
        const n = cleanT(part); const k = n.toLowerCase().replace(/^(mr|ms|mrs|dr|prof|engr)\.?\s*/, '');
        if (n && !seen.has(k)) { seen.add(k); out.push(n); }
      }
      return out.join(' / ');
    };
    const secByCode = {};
    const teachersByCode = {};   // code → [teacher, enrolled] of EVERY section (DB)
    try {
      const courses = await Course.find({ active: true }).select('code section teacher enrolled').lean();
      for (const c of courses) {
        const cd = String(c.code || '').toUpperCase(); if (!cd) continue;
        (secByCode[cd] = secByCode[cd] || new Set()).add(String(c.section || '').toUpperCase());
        const tn = cleanT(c.teacher);
        if (tn) (teachersByCode[cd] = teachersByCode[cd] || []).push([tn, Number(c.enrolled) || 0]);
      }
    } catch { /* ignore */ }
    // Envelope teacher = every section teacher of the course from the DB (most-enrolled
    // first); falls back to the name stored on the admit card.
    const teacherOf = (code, stored) => {
      const db = (teachersByCode[String(code || '').toUpperCase()] || []).slice().sort((x, y) => y[1] - x[1]).map((x) => x[0]);
      return joinTeachers(db.length ? db : [stored]);
    };
    const sectionOf = (code) => {
      const s = secByCode[String(code || '').toUpperCase()];
      if (!s) return '';
      const vals = [...s].filter(Boolean);
      return vals.length === 1 ? vals[0] : (vals.length ? vals.join('/') : '');
    };

    // group by (code | room | date | slot) → one envelope per paper-room-session
    const map = new Map();
    for (const av of avs) {
      for (const e of (av.exams || [])) {
        const key = `${e.code}|${e.room}|${e.date}|${e.slot}`;
        let t = map.get(key);
        if (!t) {
          t = { code: e.code, name: e.name, teacher: teacherOf(e.code, e.teacher), room: e.room || '',
            dateDisp: e.dateDisp || e.date || '', day: e.day || '', start: e.start || '',
            finish: e.finish || '', slot: e.slot || '', examType: av.examType || batch.examType || '', count: 0 };
          map.set(key, t);
        }
        t.count += 1;
      }
    }
    // TEACHER-WISE order: every tag for one teacher (all their courses, in all
    // their rooms) prints together, then the next teacher — instead of a random /
    // date-wise mix. Within a teacher: course → date → slot → room. Unnamed / TBA
    // teachers sort to the very end.
    const tkey = (x) => {
      const t = String(x.teacher || '').trim();
      return t ? t.toLowerCase() : '~~~~';   // empty/TBA last
    };
    const tags = [...map.values()].sort((a, b) =>
      tkey(a).localeCompare(tkey(b))
      || String(a.code).localeCompare(String(b.code))
      || String(a.dateDisp).localeCompare(String(b.dateDisp))
      || String(a.slot).localeCompare(String(b.slot))
      || String(a.room).localeCompare(String(b.room)));
    if (!tags.length) return res.status(404).json({ error: 'No papers to tag.' });

    const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

    const A4 = [595.28, 841.89];
    const M = 32, TAGW = A4[0] - 2 * M, TAGH = 176, GAP = 14;
    const green = rgb(0.098, 0.239, 0.18), line = rgb(0.75, 0.78, 0.76), dark = rgb(0.12, 0.15, 0.13);
    const perPage = Math.floor((A4[1] - 2 * M + GAP) / (TAGH + GAP));
    const examLabel = (t) => (String(t.examType).toLowerCase().includes('mid') ? 'Mid Term' : 'Final Term');

    let page = null, slotIdx = 0;
    const newPage = () => { page = pdf.addPage(A4); slotIdx = 0; };
    newPage();
    for (const t of tags) {
      if (slotIdx >= perPage) newPage();
      const top = A4[1] - M - slotIdx * (TAGH + GAP);
      const x = M, yTop = top;
      // box
      page.drawRectangle({ x, y: yTop - TAGH, width: TAGW, height: TAGH, borderColor: line, borderWidth: 1 });
      // header — title (left) + single ABASYN UNIVERSITY wordmark (right)
      page.drawText('Question Paper Envelope Detail', { x: x + 14, y: yTop - 26, size: 13, font: bold, color: dark });
      const brandR = x + TAGW - 16;
      const w1 = bold.widthOfTextAtSize('ABASYN', 15);
      page.drawText('ABASYN', { x: brandR - w1, y: yTop - 22, size: 15, font: bold, color: green });
      const w2 = font.widthOfTextAtSize('UNIVERSITY', 8.5);
      page.drawText('UNIVERSITY', { x: brandR - w2, y: yTop - 32, size: 8.5, font, color: green });
      page.drawLine({ start: { x: x + 14, y: yTop - 38 }, end: { x: x + TAGW - 14, y: yTop - 38 }, thickness: 0.7, color: line });
      // fields
      const field = (label, val, yy) => {
        page.drawText(label, { x: x + 16, y: yy, size: 10, font: bold, color: dark });
        page.drawText(String(val || '—'), { x: x + 150, y: yy, size: 10, font, color: dark });
      };
      {
        const tv = String(t.teacher || '—'); let ts = 10;
        while (ts > 7 && font.widthOfTextAtSize(tv, ts) > TAGW - 166) ts -= 0.25;
        page.drawText('Teacher Name:', { x: x + 16, y: yTop - 54, size: 10, font: bold, color: dark });
        page.drawText(tv, { x: x + 150, y: yTop - 54, size: ts, font, color: dark });
      }
      field('Examination Room:', t.room, yTop - 72);
      field('Exam Date:', [t.day, t.dateDisp].filter(Boolean).join(', '), yTop - 90);
      field('Time:', t.start || t.slot, yTop - 108);
      // table (Course | Section | No of Students | Type) — widened so Type fits
      const tblY = yTop - 130, rowH = 20;
      const cols = [x + 16, x + 291, x + 361, x + 456, x + TAGW - 16];   // Type col ≈ 59pt
      const hdr = ['Course', 'Section', 'No of Students', 'Type'];
      page.drawRectangle({ x: cols[0], y: tblY - rowH, width: cols[4] - cols[0], height: rowH, color: rgb(0.93, 0.96, 0.94) });
      for (let i = 0; i < 4; i++) page.drawText(hdr[i], { x: cols[i] + 4, y: tblY - 14, size: 8, font: bold, color: dark });
      // data row
      const dy = tblY - rowH;
      page.drawRectangle({ x: cols[0], y: dy - rowH, width: cols[4] - cols[0], height: rowH, borderColor: line, borderWidth: 0.6 });
      for (let i = 1; i < 4; i++) page.drawLine({ start: { x: cols[i], y: tblY }, end: { x: cols[i], y: dy - rowH }, thickness: 0.6, color: line });
      page.drawLine({ start: { x: cols[0], y: tblY }, end: { x: cols[4], y: tblY }, thickness: 0.6, color: line });
      // full course title — shrink the font to fit the column instead of cutting it
      const courseTxt = `${t.code}  ${t.name || ''}`;
      const cw = cols[1] - cols[0] - 8;
      let cs = 8.5;
      while (cs > 5.5 && font.widthOfTextAtSize(courseTxt, cs) > cw) cs -= 0.25;
      let shown = courseTxt;
      while (shown.length > 4 && font.widthOfTextAtSize(shown, cs) > cw) shown = shown.slice(0, -2);
      if (shown !== courseTxt) shown = shown.slice(0, -1) + '…';
      page.drawText(shown, { x: cols[0] + 4, y: dy - 14, size: cs, font, color: dark });
      page.drawText(sectionOf(t.code) || '—', { x: cols[1] + 4, y: dy - 14, size: 8.5, font, color: dark });
      page.drawText(String(t.count), { x: cols[2] + 30, y: dy - 14, size: 9, font: bold, color: dark });
      page.drawText(examLabel(t), { x: cols[3] + 5, y: dy - 14, size: 8, font, color: dark });
      slotIdx += 1;
    }

    const bytes = await pdf.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="QuestionPaperTags_${tags.length}.pdf"`);
    return res.end(Buffer.from(bytes));
  } catch (err) {
    console.error('generateTags error:', err.message);
    return res.status(500).json({ error: 'Could not generate the tags PDF.' });
  }
};

/**
 * GET /api/generate/admit-cards/progress/:token
 * Lightweight live progress for the admit-card counter: { done, total }.
 * The frontend polls this while the (long) generate request is in flight.
 */
exports.getAdmitCardsProgress = async (req, res) => {
  const safe = String(req.params.token || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
  if (!safe) return res.json({ done: 0, total: 0 });
  const p = path.join(OUTPUT_DIR, `acprogress_${safe}.json`);
  try {
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return res.json({ done: Number(data.done) || 0, total: Number(data.total) || 0 });
    }
  } catch { /* ignore */ }
  res.json({ done: 0, total: 0 });
};

/**
 * GET /api/generate/files?kind=timetable|datesheet|clash_report|admit_cards
 */
exports.listFiles = async (req, res) => {
  const { kind } = req.query;
  const q = { archived: { $ne: true } };   // current term only; archived go to Previous Semesters
  if (kind) q.kind = kind;
  const items = await GeneratedFile.find(q).sort({ createdAt: -1 }).limit(100).lean();
  res.json({ items });
};

/**
 * Build a clean, human-readable download filename from a record + file, e.g.
 *   "Undergraduate Program Date Sheet - Final Term - Summer 2025 - Generated 20-Aug-2026 8-32PM.pdf"
 *   "Undergraduate Admit Cards - Final Term - Summer 2025 - Generated ... .pdf"
 *   "Weekly Timetable - Summer 2025 - Generated ... .xlsx"
 */
function friendlyName(record, file) {
  const m = record.meta || {};
  const ext = (file.filename.split('.').pop() || 'pdf').toLowerCase();
  const examLabel = record.examType === 'mids' ? 'Mid Term'
    : record.examType === 'finals' ? 'Final Term' : '';
  const level = m.programLevel || '';
  const term = (m.term || [m.semester, m.year].filter(Boolean).join(' ')).trim();
  const d = new Date(record.createdAt || Date.now());
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let hh = d.getHours(); const ampm = hh >= 12 ? 'PM' : 'AM'; hh = hh % 12 || 12;
  const stamp = `${String(d.getDate()).padStart(2, '0')}-${MON[d.getMonth()]}-${d.getFullYear()} `
    + `${hh}-${String(d.getMinutes()).padStart(2, '0')}${ampm}`;

  let base;
  const label = file.label || '';
  if (record.kind === 'timetable') {
    base = ['Weekly Timetable', term].filter(Boolean).join(' - ');
  } else if (record.kind === 'datesheet') {
    const main = [level, 'Program Date Sheet'].filter(Boolean).join(' ');
    base = [main, examLabel, term].filter(Boolean).join(' - ');
    if (/report/i.test(label)) base += ' - Analysis Report';
  } else if (record.kind === 'admit_cards') {
    const main = [level, 'Admit Cards'].filter(Boolean).join(' ');
    base = [main, examLabel, term].filter(Boolean).join(' - ');
    if (/seating/i.test(label)) base += ' - Seating Plan';
    else if (/identif/i.test(label)) base += ' - Identification Sheets';
    else if (/invigil/i.test(label)) base += ' - Invigilation Roster';
  } else if (record.kind === 'clash_report') {
    base = 'Clash Report';
  } else {
    base = label || 'Download';
  }
  base = `${base} - Generated ${stamp}`;
  // strip characters Windows/macOS dislike in filenames
  base = base.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `${base}.${ext}`;
}

/**
 * GET /api/generate/files/:id/download/:filename
 * Streams a stored output file with a friendly, fully-formatted download name.
 */
exports.downloadFile = async (req, res) => {
  const { id, filename } = req.params;
  const record = await GeneratedFile.findById(id).lean();
  if (!record) return res.status(404).json({ error: 'File record not found.' });

  const match = record.files.find((f) => f.filename === filename);
  if (!match) return res.status(404).json({ error: 'Requested file is not part of this record.' });

  // Prevent path traversal
  const safe = path.basename(filename);
  const filePath = path.join(OUTPUT_DIR, safe);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File no longer exists on disk. Regenerate it.' });
  }

  res.download(filePath, friendlyName(record, match));
};

/**
 * GET /api/generate/files/:id/preview/:filename
 * Returns text content for clash reports (for inline viewing).
 */
exports.previewFile = async (req, res) => {
  const { id, filename } = req.params;
  const record = await GeneratedFile.findById(id).lean();
  if (!record) return res.status(404).json({ error: 'File record not found.' });

  const safe = path.basename(filename);
  if (!safe.endsWith('.txt')) {
    return res.status(400).json({ error: 'Only text reports can be previewed.' });
  }

  const filePath = path.join(OUTPUT_DIR, safe);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File no longer exists on disk.' });
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  res.json({ content });
};

/**
 * DELETE /api/generate/files/:id
 */
exports.deleteFile = async (req, res) => {
  const record = await GeneratedFile.findById(req.params.id);
  if (!record) return res.status(404).json({ error: 'File record not found.' });

  // Remove files from disk
  for (const f of record.files) {
    cleanup(path.join(OUTPUT_DIR, path.basename(f.filename)));
  }
  await record.deleteOne();
  await logActivity('generate.delete', `Deleted ${record.kind}: ${record.title}`, 'warning');
  res.json({ ok: true });
};

/**
 * DELETE /api/generate/files   — wipe ALL generated timetables, datesheets,
 * admit cards, clash reports (and their QR verification records + output files),
 * so a fresh set can be generated. Optional ?kind= to limit to one type.
 */
exports.clearAllFiles = async (req, res) => {
  const { kind } = req.query;
  const q = kind && ['timetable', 'datesheet', 'admit_cards', 'clash_report'].includes(kind) ? { kind } : {};
  const records = await GeneratedFile.find(q).lean();
  for (const rec of records) {
    for (const f of (rec.files || [])) cleanup(path.join(OUTPUT_DIR, path.basename(f.filename)));
    // remove companion schedule/verify sidecars too
    if (rec.meta && rec.meta.scheduleFile) cleanup(path.join(OUTPUT_DIR, path.basename(rec.meta.scheduleFile)));
  }
  const del = await GeneratedFile.deleteMany(q);
  let qr = { deletedCount: 0 };
  if (!kind || kind === 'admit_cards') qr = await AdmitVerification.deleteMany({});
  await logActivity('generate.clear_all',
    `Cleared ${del.deletedCount} generated file record(s)${qr.deletedCount ? ` + ${qr.deletedCount} QR record(s)` : ''}`,
    'warning');
  res.json({ ok: true, deleted: del.deletedCount, qrDeleted: qr.deletedCount });
};

/**
 * POST /api/generate/files/keep-latest   body: { keepMs?: true, dryRun?: false }
 * Keep ONLY the latest datesheet run per program (BS · B.Tech · MS when keepMs) and
 * remove every older datesheet + ALL admit-card batches (QR records + files on disk).
 * Runs inside the live server → always uses the same database the app shows.
 */
exports.keepLatestDatesheets = async (req, res) => {
  try {
    const keepMs = (req.body || {}).keepMs !== false;
    const dryRun = (req.body || {}).dryRun === true;
    const wipeAll = (req.body || {}).all === true;   // delete EVERY datesheet too (fresh start)
    const RUN_WINDOW_MS = 20 * 60 * 1000;
    const sheets = await GeneratedFile.find({ kind: 'datesheet', archived: { $ne: true } }).sort({ createdAt: -1 }).lean();
    const admits = await GeneratedFile.find({ kind: 'admit_cards', archived: { $ne: true } }).lean();
    const keep = new Set();
    const kept = {};
    for (const c of (wipeAll ? [] : (keepMs ? ['bs', 'btech', 'pg'] : ['bs', 'btech']))) {
      const list = sheets.filter((d) => datesheetCohort(d) === c);
      if (!list.length) { kept[c] = 0; continue; }
      const newest = new Date(list[0].createdAt).getTime();
      const run = list.filter((d) => d.examType === list[0].examType && newest - new Date(d.createdAt).getTime() <= RUN_WINDOW_MS);
      run.forEach((d) => keep.add(String(d._id)));
      kept[c] = run.length;
    }
    const drop = [...sheets.filter((d) => !keep.has(String(d._id))), ...admits];
    if (!dryRun) {
      for (const d of drop) {
        const names = (d.files || []).map((f) => f.filename);
        if (d.meta && d.meta.scheduleFile) names.push(d.meta.scheduleFile);
        if (d.meta && d.meta.verifyFile) names.push(d.meta.verifyFile);
        names.filter(Boolean).forEach((n) => cleanup(path.join(OUTPUT_DIR, path.basename(String(n)))));
      }
      await GeneratedFile.deleteMany({ _id: { $in: drop.map((d) => d._id) } });
      await AdmitVerification.deleteMany({ batchId: { $in: admits.map((a) => a._id) } });
      await logActivity('files.keep_latest', `${wipeAll ? 'Cleared ALL datesheets/admit cards. ' : ''}Kept latest datesheets ${JSON.stringify(kept)}; removed ${drop.length - admits.length} old datesheet(s) and ${admits.length} admit-card batch(es)`, 'info');
    }
    res.json({ ok: true, dryRun, all: wipeAll, kept, removedDatesheets: drop.length - admits.length, removedAdmitBatches: admits.length,
      keptTitles: sheets.filter((d) => keep.has(String(d._id))).map((d) => d.title) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Cleanup failed.' });
  }
};

/**
 * GET /api/generate/no-exam/auto
 * Courses that get NO paper automatically (FYP/thesis/internship/project-I/II, labs incl.
 * "L" lab codes, clinical rotations, seminars) + DB no-exam flags — pre-selected (red)
 * in the Date Sheets "remove courses" step. Read-only.
 */
exports.noExamAuto = async (_req, res) => {
  let exportPath; let codesPath;
  try {
    ({ exportPath } = await exportDatabaseToJson());
    codesPath = path.join(OUTPUT_DIR, `noexam_${Date.now()}.json`);
    fs.writeFileSync(codesPath, JSON.stringify(await dbNoExamCodes()));
    const { code, stdout } = await runPython('-m', ['exam_engine.no_exam', 'auto', '--data', exportPath, '--db-no-exam', codesPath], { timeoutMs: 120000 });
    const lastLine = String(stdout || '').trim().split('\n').filter(Boolean).pop() || '{}';
    const out = JSON.parse(lastLine);
    if (code !== 0 || out.status !== 'ok') return res.status(500).json({ error: out.error || 'Could not compute the no-exam list.' });
    res.json({ items: out.items });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not compute the no-exam list.' });
  } finally { cleanup(exportPath); cleanup(codesPath); }
};

/**
 * POST /api/generate/no-exam/from-file   (multipart "dataset": .xls/.xlsx)
 * Every course code on a YELLOW-highlighted row of the uploaded report → removed
 * from the datesheet. The file is read, never stored.
 */
exports.noExamFromFile = async (req, res) => {
  const f = req.file;
  if (!f) return res.status(400).json({ error: 'Attach the .xls or .xlsx report with yellow-highlighted courses.' });
  const ext = (path.extname(f.originalname || '') || '.xlsx').toLowerCase();
  const p = f.path + ext;
  try {
    fs.renameSync(f.path, p);
    const { code, stdout } = await runPython('-m', ['exam_engine.no_exam', 'highlights', p], { timeoutMs: 120000 });
    const lastLine = String(stdout || '').trim().split('\n').filter(Boolean).pop() || '{}';
    const out = JSON.parse(lastLine);
    if (code !== 0 || out.status !== 'ok') return res.status(400).json({ error: out.error || 'Could not read highlights from the file.' });
    res.json({ items: out.items });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not read the file.' });
  } finally { cleanup(p); cleanup(f.path); }
};
