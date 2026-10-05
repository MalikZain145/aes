/**
 * Parses a course dataset into course + teacher records.
 *
 * Supports TWO dataset shapes automatically:
 *
 *  A) Timetable format — columns: Code, Name, Component, Program Batch,
 *     Primary Faculty, Enrolled Students, Credit Hours, Class Section.
 *     One row per course-component.
 *
 *  B) Student-wise registration format — columns: Student ID, Academic Program,
 *     Batch Intake, "Courses with Names", Credit Hours. One row per student,
 *     whose courses are listed like:
 *        "CS313 - Operating Systems Concepts - 3.0, CS242 - Computer Arch - 3.0"
 *     Enrolment counts and per-student sets are derived by tallying students.
 *
 * Both produce the same output: { courses, teachers }.
 * Large classes (>50) are auto-sectioned into A, B, C…  (timetable shape).
 */
const fs = require('fs');
const xlsx = require('xlsx');

const { pbToProgram, parseFaculty, resolveDepartment, isPostgradCode } = require('./programMap');

const SECTION_LIMIT = 50;
const SECTION_LETTERS = 'ABCDEFGHIJ'.split('');

// ── helpers ─────────────────────────────────────────────────────────────────
function norm(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function extractCode(raw) {
  const s = norm(raw);
  const m = s.match(/^([A-Za-z]{2,6}[-\s]?\d{3,4}(?:\[\d+\])?(?:-II|-I)?)/);
  if (m) return m[1].replace(/\s/g, '').toUpperCase();
  return s.split(/[\s-]/)[0].toUpperCase();
}

/** Turn "CS313 - Operating Systems Concepts - 3.0" into
 *  { code:'CS313', name:'Operating Systems Concepts', credit:3 } */
function parseCourseEntry(raw) {
  let s = norm(raw);
  if (!s) return null;
  // strip a trailing credit like "- 3.0" or "- 3"
  let credit = 3;
  const cm = s.match(/-\s*(\d+(?:\.\d+)?)\s*$/);
  if (cm) {
    credit = parseFloat(cm[1]);
    s = s.slice(0, cm.index).trim();
  }
  // strip a trailing bracketed credit like "(3.00)"
  s = s.replace(/\s*\(\d+(?:\.\d+)?\)\s*$/, '').trim();
  const code = extractCode(s);
  // remove the leading code (and separator) to get the name
  let name = s;
  const nm = s.match(/^[A-Za-z]{2,6}[-\s]?\d{3,4}(?:\[\d+\])?(?:-II|-I)?\s*[-–:]?\s*(.*)$/);
  if (nm && nm[1]) name = nm[1].trim();
  name = name.replace(/\s*\(\d+(?:\.\d+)?\)\s*$/, '').trim();
  return { code, name: norm(name), credit: Number.isNaN(credit) ? 3 : credit };
}

/** Split a "Courses with Names" cell into individual course entries. */
function splitCourses(raw) {
  const s = norm(raw);
  if (!s) return [];
  // Courses are separated by commas, but names themselves contain " - ".
  // Split on a comma that is followed by a course code pattern (or end).
  const parts = s.split(/,\s*(?=[A-Za-z]{2,6}[-\s]?\d{3,4}|$)/);
  return parts.map((p) => p.replace(/,+\s*$/, '').trim()).filter(Boolean);
}

// ── shape detection ─────────────────────────────────────────────────────────
function detectShape(rows) {
  if (!rows.length) return 'unknown';
  const keys = Object.keys(rows[0]).map((k) => k.toLowerCase().trim());
  const has = (needle) => keys.some((k) => k.includes(needle));
  if (has('courses with names')) return 'student';
  // Course-wise enrolment report: Course Code + Course Title + Meta Details
  // (per-section "Section-X - n - Teacher"). No per-student data.
  if ((has('course code') || has('course title')) && (has('meta details') || has('enrolled students')) && !has('courses with names')) return 'coursewise';
  if (keys.includes('component') || (keys.includes('code') && keys.includes('name'))) return 'timetable';
  // last-ditch: a bare Code/Title table with Meta Details still parses as coursewise
  if (has('meta details') && (has('code') || has('title'))) return 'coursewise';
  return 'unknown';
}

// Courses that carry NO formal exam (project/thesis/internship/etc.) — excluded
// from the DATESHEET. Also excluded from the TIMETABLE when they are not taught
// in a class slot (the same list — FYP/thesis/internship/dissertation/seminar).
const NON_CLASS_RE = /(final\s*year\s*project|\bfyp\b|\bthesis\b|internship|dissertation|capstone|comprehensive\s*exam|\bviva\b)/i;
// NOTE: a bare `\bproject\b` used to be here — it wrongly flagged real THEORY papers
// such as "Software Project Management" (SE424), "Project Scope, Time and Cost
// Management" (PM615/CE611), "AI and Computer Applications in Project Management"
// (PM616/CE614) as no-exam, so they silently vanished from every datesheet. Only a
// course that IS a project (named "Project", "Project-I/II", "Engineering Project",
// "Research Project", "Term/Semester Project", FYP …) is now treated as no-exam.
const NON_EXAM_RE = /(final\s*year\s*project|\bfyp\b|\bthesis\b|internship|dissertation|capstone|\bseminar\b|research\s*(project|thesis|work)|term\s*paper|(term|semester|mini|design|engineering)\s+project|\bproject\s*[-–]?\s*(i{1,3}|[1-3])\b(?!\s*[a-z])|^\s*project\s*$|supervised\s+(industrial|field)|field\s+training|industrial\s+training)/i;

// ── course-wise enrolment parser ────────────────────────────────────────────
// rows: sheet_to_json rows. `yellowCodes`: Set of Course Codes highlighted yellow
// in the sheet (→ removed from the datesheet). Produces courses + teachers only.
function parseCourseWise(rows, yellowCodes = new Set()) {
  const col = {};
  Object.keys(rows[0]).forEach((k) => { col[k.toLowerCase().trim()] = k; });
  const cCode = col['course code'] || col['code'];
  const cTitle = col['course title'] || col['title'] || col['name'];
  const cCredit = col['credit hours'] || col['credit'] || col['cr'];
  const cMeta = col['meta details'] || col['meta'] || col['sections details'];
  if (!cCode || !cTitle) throw new Error('Course-wise sheet needs Course Code and Course Title columns.');

  const teacherMap = new Map();
  const finalCourses = [];
  const seen = new Set();

  const isLab = (code, name) => /\blab\b|practical/i.test(name) || /[A-Z]{2,}L\d/i.test(code);

  for (const row of rows) {
    const rawCode = norm(row[cCode]);
    const name = norm(row[cTitle]);
    if (!rawCode || !name || /course\s*code/i.test(rawCode)) continue;
    const code = extractCode(rawCode);
    let credit = parseFloat(row[cCredit]); if (Number.isNaN(credit)) credit = 3;
    const totalEnrolled = parseInt(row[col['enrolled students']] || row[col['enrolled']] || 0, 10) || 0;

    // Meta Details → one entry per section: "Section-C - 0 - Mr. Asad Hanif,"
    const metaRaw = cMeta ? String(row[cMeta] || '') : '';
    const segments = metaRaw.split(/[\n\r]+/).map((s) => s.trim()).filter(Boolean);
    const sections = [];
    for (const seg of segments) {
      const parts = seg.split(/\s+-\s+/);   // ["Section-C","0","Mr. Asad Hanif,"]
      let section = norm(parts[0] || '').replace(/section\s*-?\s*/i, '').toUpperCase();
      if (!/^[A-Z]$/.test(section)) section = section.slice(0, 1);
      const teacher = norm((parts.slice(2).join(' - ') || '').replace(/,+\s*$/, ''));
      sections.push({ section: /^[A-Z]$/.test(section) ? section : '', teacher });
    }
    if (!sections.length) sections.push({ section: '', teacher: '' });

    const per = Math.max(1, Math.round(totalEnrolled / sections.length)) || totalEnrolled || 1;
    const component = isLab(code, name) ? 'Lab' : 'Lecture';
    // LAB-ONLY courses have no written exam → excluded from the DATESHEET (noExam),
    // but they MAY appear in the TIMETABLE for labs (noTimetable stays false).
    const noExam = yellowCodes.has(code) || yellowCodes.has(rawCode.toUpperCase()) || NON_EXAM_RE.test(name) || component === 'Lab';
    const noTimetable = NON_CLASS_RE.test(name);
    // No program column in this format → derive the DEPARTMENT and LEVEL from the
    // course code (CS→cs, CE→civil, DP→dpt, MG→bba, SS→common, code>=500 → PG),
    // so the datesheet builder's department-wise filter works.
    let department = ''; try { department = resolveDepartment(code, name, '') || ''; } catch { department = ''; }
    let level = 'UG'; try { level = isPostgradCode(code) ? 'PG' : 'UG'; } catch { level = 'UG'; }

    for (const s of sections) {
      const teacher = s.teacher || 'TBA';
      if (teacher && teacher !== 'TBA' && !teacherMap.has(teacher)) teacherMap.set(teacher, { name: teacher, email: '', facultyId: '' });
      const fullCode = `${code}-${s.section || 'X'}-${component}`.replace(/\s+/g, '_');
      if (seen.has(fullCode)) continue; seen.add(fullCode);
      finalCourses.push({
        fullCode,
        code, name, component, section: s.section || '',
        programBatch: '', program: '', academicTerm: '', department, level,
        teacher, enrolled: totalEnrolled ? per : 0, creditHours: credit,
        noExam, noTimetable,
      });
    }
  }
  return { courses: finalCourses, teachers: Array.from(teacherMap.values()), studentRegistrations: [] };
}

// ── student-wise parser ─────────────────────────────────────────────────────
function parseStudentWise(rows) {
  // course key -> { code, name, batches:Set, students:Set, credit }
  const courses = new Map();
  // raw per-student registrations (needed for clash-free scheduling)
  const studentRegs = new Map(); // studentId -> { batch, courses:Set }

  const col = {};
  Object.keys(rows[0]).forEach((k) => { col[k.toLowerCase().trim()] = k; });
  const cCourses = col['courses with names'];
  const cProg = col['academic program'];
  const cBatch = col['batch intake'];
  const cSid = col['student id'];
  const cName = col['student name'] || col['name'];

  for (const row of rows) {
    const sid = cSid ? norm(row[cSid]) : '';
    const prog = cProg ? norm(row[cProg]) : '';
    const batch = cBatch ? norm(row[cBatch]) : '';
    const name = cName ? norm(row[cName]) : '';
    const batchLabel = [prog, batch].filter(Boolean).join(' ') || prog || batch;

    for (const entry of splitCourses(row[cCourses])) {
      const parsed = parseCourseEntry(entry);
      if (!parsed || !parsed.code) continue;
      // NOTE: FYP / thesis / project / internship courses are NOT filtered at
      // import — they are real offered courses and must appear in the Courses
      // tab. They are skipped only at DATESHEET/TIMETABLE generation time.
      const key = `${parsed.code}||${parsed.name.toLowerCase()}`;
      let c = courses.get(key);
      if (!c) {
        c = { code: parsed.code, name: parsed.name, credit: parsed.credit,
              batches: new Set(), students: new Set() };
        courses.set(key, c);
      }
      if (batchLabel) c.batches.add(batchLabel);
      if (sid) c.students.add(sid);

      // record this course under the student (raw registration)
      if (sid) {
        let reg = studentRegs.get(sid);
        if (!reg) { reg = { name, program: prog, batch: batchLabel, courses: new Set() }; studentRegs.set(sid, reg); }
        if (name && !reg.name) reg.name = name;
        if (prog && !reg.program) reg.program = prog;
        reg.courses.add(parsed.code);
      }
    }
  }

  // Build course records. Enrollment = number of students taking it.
  // A single logical course may span several batches; we emit one Lecture
  // record per (course), and auto-section by enrolment.
  const finalCourses = [];
  for (const c of courses.values()) {
    const enrolled = c.students.size || c.batches.size || 1;
    const primaryBatch = [...c.batches][0] || '';
    const base = {
      code: c.code,
      name: c.name,
      component: 'Lecture',
      section: '',
      programBatch: primaryBatch,
      program: pbToProgram(primaryBatch) || (primaryBatch.split(/\s+/).slice(0, -2).join(' ') || primaryBatch),
      academicTerm: '',
      teacher: 'TBA',
      enrolled,
      creditHours: c.credit || 3,
      students: [...c.students],
      allBatches: [...c.batches],
    };
    // auto-section by enrolment
    if (enrolled > SECTION_LIMIT) {
      const n = Math.ceil(enrolled / SECTION_LIMIT);
      let rem = enrolled;
      for (let i = 0; i < n; i++) {
        const take = Math.min(SECTION_LIMIT, rem); rem -= take;
        const letter = SECTION_LETTERS[i] || `S${i + 1}`;
        finalCourses.push({
          ...base, section: letter, enrolled: take,
          fullCode: `${c.code}-${letter}`.replace(/\s+/g, '_'),
          autoSectioned: n > 1,
        });
      }
    } else {
      finalCourses.push({ ...base, fullCode: `${c.code}`.replace(/\s+/g, '_') });
    }
  }

  const studentRegistrations = [];
  for (const [sid, reg] of studentRegs.entries()) {
    studentRegistrations.push({
      studentId: sid, name: reg.name || '', program: reg.program || '',
      batch: reg.batch, courses: [...reg.courses],
    });
  }

  return { courses: finalCourses, teachers: [], studentRegistrations };
}

// ── timetable parser (original) ─────────────────────────────────────────────
function parseTimetable(rows) {
  const teacherMap = new Map();
  const baseCourses = [];

  for (const row of rows) {
    const component = norm(row['Component']);
    if (!['Lecture', 'Lab'].includes(component)) continue;

    const rawCode = norm(row['Code']);
    const name = norm(row['Name']);
    if (!rawCode || !name) continue;
    // Keep FYP/thesis/project/internship — real offered courses; they are only
    // dropped at datesheet/timetable generation, not at import.

    const code = extractCode(rawCode);
    let section = norm(row['Class Section']).toUpperCase();
    if (!/^[A-J]$/.test(section)) {
      const m = rawCode.match(/-(?:Section-)?([A-J])-(?:lecture|lab)$/i);
      section = m ? m[1].toUpperCase() : '';
    }
    const enrolled = parseInt(row['Enrolled Students'], 10) || 0;
    if (enrolled <= 0) continue;

    const programBatch = norm(row['Program Batch']);
    const fac = parseFaculty(row['Primary Faculty']);
    const teacher = fac.name;
    if (teacher && teacher !== 'TBA') {
      if (!teacherMap.has(teacher)) {
        teacherMap.set(teacher, { name: teacher, email: fac.email || '', facultyId: fac.facultyId || '' });
      } else {
        const ex = teacherMap.get(teacher);
        if (!ex.email && fac.email) ex.email = fac.email;
        if (!ex.facultyId && fac.facultyId) ex.facultyId = fac.facultyId;
      }
    }
    let creditHours = parseFloat(row['Credit Hours']);
    if (Number.isNaN(creditHours)) creditHours = 3;

    baseCourses.push({
      code, name, component, section, programBatch,
      program: pbToProgram(programBatch),
      academicTerm: norm(row['Academic Term']) || 'Spring 2026',
      teacher, enrolled, creditHours,
    });
  }

  const finalCourses = [];
  for (const c of baseCourses) {
    if (c.enrolled > SECTION_LIMIT) {
      const n = Math.ceil(c.enrolled / SECTION_LIMIT);
      let rem = c.enrolled;
      const startIdx = /^[A-J]$/.test(c.section) ? SECTION_LETTERS.indexOf(c.section) : 0;
      for (let i = 0; i < n; i++) {
        const take = Math.min(SECTION_LIMIT, rem); rem -= take;
        const letter = SECTION_LETTERS[startIdx + i] || `S${startIdx + i + 1}`;
        finalCourses.push({
          ...c, section: letter, enrolled: take,
          fullCode: `${c.code}-${c.programBatch}-${c.component}-${letter}`.replace(/\s+/g, '_'),
          autoSectioned: n > 1,
        });
      }
    } else {
      finalCourses.push({
        ...c,
        fullCode: `${c.code}-${c.programBatch}-${c.component}-${c.section || 'X'}`.replace(/\s+/g, '_'),
      });
    }
  }

  const seen = new Set();
  const unique = [];
  for (const r of finalCourses) {
    if (seen.has(r.fullCode)) continue;
    seen.add(r.fullCode);
    unique.push(r);
  }
  return { courses: unique, teachers: Array.from(teacherMap.values()), studentRegistrations: [] };
}

// ── entry point ─────────────────────────────────────────────────────────────
function parseDataset(xlsxPath) {
  if (!fs.existsSync(xlsxPath)) {
    throw new Error(`Dataset not found at ${xlsxPath}`);
  }
  // cellStyles:true so we can read the YELLOW highlight (courses to drop from the
  // datesheet). Pick the first sheet that actually has data rows.
  const wb = xlsx.readFile(xlsxPath, { cellStyles: true });
  let sheet = wb.Sheets[wb.SheetNames[0]];
  let rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });
  if (!rows.length) {
    for (const nm of wb.SheetNames) {
      const r = xlsx.utils.sheet_to_json(wb.Sheets[nm], { defval: '' });
      if (r.length) { sheet = wb.Sheets[nm]; rows = r; break; }
    }
  }
  if (!rows.length) {
    throw new Error('The dataset is empty.');
  }

  const shape = detectShape(rows);
  if (shape === 'student') return parseStudentWise(rows);
  if (shape === 'timetable') return parseTimetable(rows);
  if (shape === 'coursewise') {
    // find the Course Code column letter, then collect codes whose cell fill is yellow
    const yellow = new Set();
    try {
      const range = xlsx.utils.decode_range(sheet['!ref']);
      // locate header row + the "Course Code"/"Code" column
      let codeCol = -1, headerRow = range.s.r;
      outer: for (let r = range.s.r; r <= Math.min(range.s.r + 3, range.e.r); r++) {
        for (let c = range.s.c; c <= range.e.c; c++) {
          const cell = sheet[xlsx.utils.encode_cell({ r, c })];
          if (cell && /course\s*code|^code$/i.test(String(cell.v || '').trim())) { codeCol = c; headerRow = r; break outer; }
        }
      }
      if (codeCol >= 0) {
        for (let r = headerRow + 1; r <= range.e.r; r++) {
          const cell = sheet[xlsx.utils.encode_cell({ r, c: codeCol })];
          if (!cell || cell.v == null || cell.v === '') continue;
          const rgb = cell.s && cell.s.fgColor && cell.s.fgColor.rgb;
          if (rgb && /^F{2}F{2}0{2}$/i.test(String(rgb))) {   // FFFF00 yellow
            yellow.add(extractCode(String(cell.v)));
            yellow.add(String(cell.v).trim().toUpperCase());
          }
        }
      }
    } catch { /* styles unavailable → fall back to keyword-only exclusion */ }
    return parseCourseWise(rows, yellow);
  }

  throw new Error(
    'Unrecognised columns. Expected a "Courses with Names" column (student ' +
    'registration export), Code/Name/Component columns (timetable format), or ' +
    'Course Code / Course Title / Meta Details columns (course-wise enrolment report).'
  );
}

module.exports = { parseDataset, parseStudentWise, parseTimetable, SECTION_LIMIT };
