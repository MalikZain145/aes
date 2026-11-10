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
  // ERP class list (odoocms.class): Code "CS313-Fall 26-01-Section-A-lecture" + Primary
  // Faculty + Program Batch, one row per class (section × component), no Component column.
  if (keys.includes('code') && has('primary faculty') && has('program batch') && !keys.includes('component')) return 'classlist';
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

// ── ERP class-list parser (odoocms.class export) ────────────────────────────
// One row per class: "CS313-Fall 26-01-Section-A-lecture" | name | term | faculty |
// enrolled | "BSCS-Fall 24". Sections are taken EXACTLY as written (never invented):
// every class with the same code + letter + component is one Course row; its program
// batches are kept (programBatches) so students sit with the section of their batch.
function parseClassList(rows) {
  const col = {};
  Object.keys(rows[0]).forEach((k) => { col[k.toLowerCase().trim()] = k; });
  const cEn = col['enrolled students'] || col['enrolled'];
  const groups = new Map();   // fullCode → merged row
  const teacherMap = new Map();
  // A class written WITHOUT a section letter next to lettered classes of the same course
  // (MG403 "…-01-CE-lecture" beside "…-02-Section-A-lecture") is its own section: it gets
  // the next free letter (→ B), so its students are never merged into section A.
  const tokOf = (raw) => { const t = raw.match(/-([^-]+)-(?:lecture|lab)$/i); return t ? t[1].toUpperCase() : ''; };
  const letterOf = (raw) => { const sm = raw.match(/-(?:Section-)?([A-Za-z])-(?:lecture|lab)$/i); return sm ? sm[1].toUpperCase() : ''; };
  const extraLetter = new Map();   // CODE|TOKEN → letter
  {
    const used = new Map(); const loose = new Map();
    for (const row of rows) {
      const raw = norm(row[col.code]);
      if (!/-(lecture|lab)$/i.test(raw)) continue;
      const code = extractCode(raw); const L = letterOf(raw);
      if (L) { if (!used.has(code)) used.set(code, new Set()); used.get(code).add(L); }
      else { if (!loose.has(code)) loose.set(code, new Set()); loose.get(code).add(tokOf(raw)); }
    }
    for (const [code, toks] of loose) {
      const u = used.get(code); if (!u || !u.size) continue;   // no lettered class → stays one section
      const taken = new Set(u);
      for (const tok of [...toks].sort()) {
        const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').find((x) => !taken.has(x));
        taken.add(L); extraLetter.set(`${code}|${tok}`, L);
      }
    }
  }
  for (const row of rows) {
    const raw = norm(row[col.code]);
    const m = raw.match(/-(lecture|lab)$/i);
    if (!m) continue;   // the "Fall 2026 (1066)" group header etc.
    const component = /lab/i.test(m[1]) ? 'Lab' : 'Lecture';
    const code = extractCode(raw);
    const section = letterOf(raw) || extraLetter.get(`${code}|${tokOf(raw)}`) || '';
    const name = norm(row[col.name]).replace(/\s*\(\d+(?:\.\d+)?\)\s*$/, '').replace(/\s*\(\d\+\d\)\s*$/, '').trim() || code;
    const enrolled = parseInt(row[cEn], 10) || 0;
    const pb = norm(row[col['program batch']]);
    const fac = parseFaculty(row[col['primary faculty']]);
    if (fac.name && fac.name !== 'TBA' && !teacherMap.has(fac.name)) teacherMap.set(fac.name, { name: fac.name, email: fac.email || '', facultyId: fac.facultyId || '' });
    const fullCode = `${code}-${section || 'X'}-${component}`;
    let g = groups.get(fullCode);
    if (!g) {
      g = { fullCode, code, name, component, section, programBatch: '', programBatches: [], program: '', academicTerm: norm(row[col['academic term']]) || '',
        teacher: 'TBA', enrolled: 0, creditHours: null, _best: -1, _bestT: -1 };
      groups.set(fullCode, g);
    }
    g.enrolled += enrolled;
    if (pb && enrolled > 0 && !g.programBatches.includes(pb)) g.programBatches.push(pb);
    if (enrolled > g._best) { g._best = enrolled; g.name = name; if (pb) { g.programBatch = pb; g.program = pbToProgram(pb); } }
    if (fac.name && fac.name !== 'TBA' && enrolled > g._bestT) { g._bestT = enrolled; g.teacher = fac.name; }
  }
  const all = [...groups.values()];
  const lectureCodes = new Set(all.filter((c) => c.component === 'Lecture').map((c) => c.code));
  const lectureNoExam = new Set(all.filter((c) => c.component === 'Lecture' && NON_EXAM_RE.test(c.name)).map((c) => c.code));
  const courses = all.map((c) => {
    const { _best, _bestT, ...rest } = c;
    let department = ''; try { department = resolveDepartment(c.code, c.name, c.program) || ''; } catch { department = ''; }
    let level = 'UG'; try { level = isPostgradCode(c.code) ? 'PG' : 'UG'; } catch { level = 'UG'; }
    return {
      ...rest, department, level,
      // a Lab row never removes its course's written paper; a LAB-ONLY course has none
      noExam: c.component === 'Lab' ? (!lectureCodes.has(c.code) || lectureNoExam.has(c.code)) : NON_EXAM_RE.test(c.name),
      noTimetable: NON_CLASS_RE.test(c.name),
    };
  });
  return { courses, teachers: Array.from(teacherMap.values()), studentRegistrations: [], classList: true };
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

// ── column aliases, header-row / sheet detection and the import report ────
// Each report shape lists the columns its parser uses. A header is matched to a
// column by its name, ignoring case, spaces, "_", ".", ":" and "#" — and by a few
// common alternative names (e.g. "Reg No" for Student ID). Matched columns are
// renamed to the standard name before parsing, so the parsers stay unchanged.
const canonH = (s) => String(s == null ? '' : s).replace(/^﻿/, '').toLowerCase()
  .replace(/[_.:#*]+/g, ' ').replace(/\s+/g, ' ').trim();

const SCHEMAS = {
  student: {
    label: 'Student-wise registration report',
    fields: [
      { key: 'Student ID', required: true,
        aliases: ['student id', 'studentid', 'student reg no', 'reg no', 'registration no', 'registration number', 'reg number', 'roll no', 'roll number', 'enrollment no', 'enrolment no', 'student no', 'student number', 'reg id'],
        impact: 'Students cannot be saved: per-student clash checks, admit cards, seating and the student portal will not work for this file. Courses are still imported.' },
      { key: 'Student Name', aliases: ['student name', 'name', 'full name', 'student full name'],
        impact: 'Students are saved without names — admit cards, seating plans and lists will show blank names.' },
      { key: 'Academic Program', aliases: ['academic program', 'academic programme', 'program', 'programme', 'degree', 'degree program', 'program name'],
        impact: "Each student's program is unknown — BS/MS split, department lists and the degree on admit cards will be blank or less accurate." },
      { key: 'Batch Intake', aliases: ['batch intake', 'batch', 'intake', 'session', 'admission batch'],
        impact: 'Batch is unknown — seating cannot keep same-batch students apart and sections cannot be matched by batch.' },
      { key: 'Courses with Names', required: true,
        aliases: ['courses with names', 'courses', 'registered courses', 'course list', 'courses registered', 'enrolled courses', 'subjects', 'course names'],
        impact: 'No courses can be read.' },
    ],
    known: ['s no', 'sr no', 'serial no', 'number of courses', 'no of courses', 'credit hours', 'total credit hours'],
  },
  classlist: {
    label: 'ERP class list (one row per class)',
    fields: [
      { key: 'Code', required: true, aliases: ['code', 'class code'], impact: 'No classes can be read.' },
      { key: 'Name', aliases: ['name', 'course name', 'course title', 'title'], impact: 'Course names are taken from the course code.' },
      { key: 'Academic Term', aliases: ['academic term', 'term'], impact: 'Academic term is left blank.' },
      { key: 'Primary Faculty', required: true, aliases: ['primary faculty', 'faculty', 'teacher', 'instructor'], impact: 'Teachers are unknown (TBA) — no teacher clash checks and no invigilation conflict-of-interest checks.' },
      { key: 'Enrolled Students', aliases: ['enrolled students', 'enrolled', 'strength', 'students'], impact: 'Section sizes are 0 and the batches sitting in each section are unknown.' },
      { key: 'Program Batch', required: true, aliases: ['program batch', 'programme batch', 'batch'], impact: 'Programs and batches of each section are unknown.' },
    ],
    known: ['s no', 'sr no'],
  },
  coursewise: {
    label: 'Course-wise enrolment report',
    fields: [
      { key: 'Course Code', required: true, aliases: ['course code', 'code'], impact: 'No courses can be read.' },
      { key: 'Course Title', required: true, aliases: ['course title', 'title', 'course name', 'name'], impact: 'No courses can be read.' },
      { key: 'Credit Hours', aliases: ['credit hours', 'credit', 'credits', 'cr', 'credit hrs'], impact: 'Every course is taken as 3 credit hours.' },
      { key: 'Enrolled Students', aliases: ['enrolled students', 'enrolled', 'students', 'strength'], impact: 'Course sizes are 0.' },
      { key: 'Meta Details', aliases: ['meta details', 'meta', 'sections details', 'section details'], impact: 'Sections and teachers are unknown — each course becomes one section with teacher TBA.' },
    ],
    known: ['s no', 'sr no', 'sections'],
  },
  timetable: {
    label: 'Timetable dataset (one row per class component)',
    fields: [
      { key: 'Code', required: true, aliases: ['code', 'course code'], impact: 'No courses can be read.' },
      { key: 'Name', required: true, aliases: ['name', 'course name', 'course title', 'title'], impact: 'No courses can be read.' },
      { key: 'Component', required: true, aliases: ['component', 'class type'], impact: 'Rows cannot be told apart as Lecture or Lab — none are imported.' },
      { key: 'Class Section', aliases: ['class section', 'section'], impact: 'Sections are taken from the class code, or left blank.' },
      { key: 'Academic Term', aliases: ['academic term', 'term'], impact: 'Academic term is set to a default.' },
      { key: 'Primary Faculty', aliases: ['primary faculty', 'faculty', 'teacher', 'instructor'], impact: 'Teachers are unknown (TBA) — no teacher clash checks.' },
      { key: 'Enrolled Students', required: true, aliases: ['enrolled students', 'enrolled', 'strength', 'students'], impact: 'Rows without a student count are skipped — nothing is imported.' },
      { key: 'Program Batch', aliases: ['program batch', 'programme batch', 'batch'], impact: 'Programs and batches are unknown.' },
      { key: 'Credit Hours', aliases: ['credit hours', 'credit', 'credits', 'cr', 'credit hrs'], impact: 'Every course is taken as 3 credit hours.' },
    ],
    known: ['s no', 'sr no'],
  },
};
const ALL_ALIASES = [...new Set(Object.values(SCHEMAS).flatMap((s) => s.fields.flatMap((f) => f.aliases)))];

// does header `h` (canonical) match alias `a`? exact, or a multi-word alias inside it
const aliasHit = (h, a) => h === a || (a.includes(' ') && h.includes(a));

function mapColumns(schema, headers) {
  const map = {};            // field key → original header
  const used = new Set();
  for (const f of schema.fields) {
    // exact matches first, then "contains" matches; aliases in priority order
    let hit = null;
    for (const a of f.aliases) { hit = headers.find((h) => !used.has(h) && canonH(h) === a); if (hit) break; }
    if (!hit) for (const a of f.aliases) { hit = headers.find((h) => !used.has(h) && a.includes(' ') && canonH(h).includes(a)); if (hit) break; }
    if (hit) { map[f.key] = hit; used.add(hit); }
  }
  return { map, used };
}

// which report is this? (same order and rules as before, now alias-aware)
function detectShapeMapped(headers) {
  const ch = headers.map(canonH);
  const m = {};
  for (const [k, s] of Object.entries(SCHEMAS)) m[k] = mapColumns(s, headers).map;
  if (m.student['Courses with Names']) return 'student';
  if (m.classlist.Code && m.classlist['Primary Faculty'] && m.classlist['Program Batch'] && !m.timetable.Component) return 'classlist';
  const literalCourse = ch.some((h) => h.includes('course code') || h.includes('course title'));
  if (literalCourse && (m.coursewise['Meta Details'] || m.coursewise['Enrolled Students'])) return 'coursewise';
  if (m.timetable.Component || (m.timetable.Code && m.timetable.Name && ch.includes('code') && ch.includes('name'))) return 'timetable';
  if (m.coursewise['Meta Details'] && (m.coursewise['Course Code'] || m.coursewise['Course Title'])) return 'coursewise';
  return 'unknown';
}

// the header row: the row (among the first 25) with the most recognised column names
function findHeaderRow(sheet) {
  const aoa = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
  let best = -1, bestScore = 0;
  const n = Math.min(aoa.length, 25);
  for (let i = 0; i < n; i++) {
    const score = (aoa[i] || []).filter((c) => { const h = canonH(c); return h && ALL_ALIASES.some((a) => aliasHit(h, a)); }).length;
    if (score > bestScore) { best = i; bestScore = score; }
  }
  return bestScore >= 2 ? best : 0;
}

// rows of one sheet, read from its header row (absolute sheet row index)
function readRows(sheet) {
  const rel = findHeaderRow(sheet);
  const aoa = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false, raw: true });
  if (!aoa.length) return { rows: [], headerRow: 0 };
  // translate "nth non-blank row" into the absolute sheet row of that header
  const range = xlsx.utils.decode_range(sheet['!ref'] || 'A1');
  let absRow = range.s.r;
  if (rel > 0) {
    let seen = -1;
    for (let r = range.s.r; r <= range.e.r; r++) {
      let blank = true;
      for (let c = range.s.c; c <= range.e.c; c++) { const cell = sheet[xlsx.utils.encode_cell({ r, c })]; if (cell && cell.v !== '' && cell.v != null) { blank = false; break; } }
      if (!blank) seen++;
      if (seen === rel) { absRow = r; break; }
    }
  }
  const opts = { defval: '' };
  if (absRow > range.s.r) opts.range = absRow;
  return { rows: xlsx.utils.sheet_to_json(sheet, opts), headerRow: absRow };
}

const filled = (v) => !(v == null || String(v).trim() === '');
const rowNo = (r) => (r && typeof r.__rowNum__ === 'number' ? r.__rowNum__ + 1 : null);

// rename matched columns to the standard names (keeps the Excel row number)
function canonicalRows(rows, map) {
  const back = Object.fromEntries(Object.entries(map).map(([k, h]) => [h, k]));
  const stdLower = new Set(Object.keys(map).map((k) => k.toLowerCase()));
  return rows.map((r) => {
    const o = {};
    for (const [k, v] of Object.entries(r)) {
      if (back[k]) o[back[k]] = v;
      else if (!stdLower.has(String(k).toLowerCase().trim()) && !o[k]) o[k] = v;
    }
    Object.defineProperty(o, '__rowNum__', { value: r.__rowNum__, enumerable: false });
    return o;
  });
}

function addSkip(list, reason, r) {
  let s = list.find((x) => x.reason === reason);
  if (!s) { s = { reason, count: 0, rows: [] }; list.push(s); }
  s.count++;
  const n = rowNo(r);
  if (n && s.rows.length < 8) s.rows.push(n);
}

// row-level checks, mirroring what each parser keeps or drops
function checkRows(shape, rows) {
  const skipped = []; const notes = [];
  let used = 0;
  if (shape === 'student') {
    const seen = new Map(); let badEntries = 0; const badEx = [];
    for (const r of rows) {
      const entries = splitCourses(r['Courses with Names']);
      if (!entries.length) { addSkip(skipped, 'No courses listed in the row', r); continue; }
      used++;
      for (const e of entries) {
        const p = parseCourseEntry(e);
        if (!p || !/^[A-Z]{2,6}-?\d{3,4}/.test(p.code)) { badEntries++; if (badEx.length < 3) badEx.push(String(e).slice(0, 40)); }
      }
      const sid = norm(r['Student ID']);
      if (!sid) addSkip(notes, 'Courses read, but the student was not saved (no Student ID)', r);
      else seen.set(sid, (seen.get(sid) || 0) + 1);
      if (r['Student Name'] !== undefined && !filled(r['Student Name']) && sid) addSkip(notes, 'Student Name is empty', r);
      if (r['Academic Program'] !== undefined && !filled(r['Academic Program']) && sid) addSkip(notes, 'Academic Program is empty', r);
      if (r['Batch Intake'] !== undefined && !filled(r['Batch Intake']) && sid) addSkip(notes, 'Batch Intake is empty', r);
    }
    if (badEntries) notes.push({ reason: `Course entries that could not be read as "CODE - Name - Credit" (e.g. ${badEx.map((x) => `"${x}"`).join(', ')})`, count: badEntries, rows: [] });
    const dup = [...seen.values()].filter((c) => c > 1).length;
    if (dup) notes.push({ reason: 'Students listed in more than one row (their courses were merged)', count: dup, rows: [] });
  } else if (shape === 'classlist') {
    for (const r of rows) {
      const raw = norm(r.Code);
      if (!/-(lecture|lab)$/i.test(raw)) { addSkip(skipped, 'Not a class row (heading / group total)', r); continue; }
      used++;
      const fac = norm(r['Primary Faculty']);
      if (!fac || /^tba$/i.test(fac)) addSkip(notes, 'Class without a teacher (TBA)', r);
      if (r['Enrolled Students'] !== undefined && !(parseInt(r['Enrolled Students'], 10) > 0)) addSkip(notes, 'Class with 0 students', r);
    }
  } else if (shape === 'coursewise') {
    for (const r of rows) {
      const code = norm(r['Course Code']); const name = norm(r['Course Title']);
      if (!code || !name || /course\s*code/i.test(code)) { addSkip(skipped, 'Course Code or Course Title is empty', r); continue; }
      used++;
      if (r['Meta Details'] !== undefined && !filled(r['Meta Details'])) addSkip(notes, 'No section / teacher details (one section, teacher TBA)', r);
    }
  } else if (shape === 'timetable') {
    for (const r of rows) {
      const comp = norm(r.Component);
      if (!['Lecture', 'Lab'].includes(comp)) { addSkip(skipped, 'Component is not "Lecture" or "Lab"', r); continue; }
      if (!norm(r.Code) || !norm(r.Name)) { addSkip(skipped, 'Code or Name is empty', r); continue; }
      if (!(parseInt(r['Enrolled Students'], 10) > 0)) { addSkip(skipped, 'Enrolled Students is 0 or empty', r); continue; }
      used++;
      if (r['Primary Faculty'] !== undefined && !filled(r['Primary Faculty'])) addSkip(notes, 'No teacher (TBA)', r);
    }
  }
  return { used, skipped, notes };
}

function buildReport({ sheetName, sheetNames, headerRow, shape, headers, map, rows, result }) {
  const schema = SCHEMAS[shape];
  const found = []; const missing = [];
  for (const f of schema.fields) {
    const col = map[f.key];
    if (col) {
      const n = rows.filter((r) => filled(r[f.key])).length;
      found.push({ field: f.key, column: col, renamed: canonH(col) !== canonH(f.key), required: !!f.required, filledRows: n, emptyRows: rows.length - n });
    } else {
      missing.push({ field: f.key, required: !!f.required, impact: f.impact });
    }
  }
  const usedHeaders = new Set(Object.values(map));
  const known = new Set(schema.known || []);
  const ignored = headers.filter((h) => !usedHeaders.has(h) && filled(h) && !/^__empty/i.test(h) && !known.has(canonH(h)));
  const chk = checkRows(shape, rows);
  const c = result.courses || []; const regs = result.studentRegistrations || [];
  const uniq = (a) => new Set(a.filter(Boolean)).size;
  const data = {
    courses: uniq(c.map((x) => x.code)),
    courseRecords: c.length,
    sections: c.filter((x) => x.section).length,
    teachers: (result.teachers || []).length,
    students: regs.length,
    programs: uniq(regs.length ? regs.map((r) => r.program) : c.map((x) => x.program)),
    batches: uniq(regs.length ? regs.map((r) => r.batch) : c.flatMap((x) => x.programBatches || [x.programBatch])),
    labs: c.filter((x) => x.component === 'Lab').length,
    noExam: c.filter((x) => x.noExam).length,
    noTimetable: c.filter((x) => x.noTimetable).length,
  };
  const warnings = [];
  for (const m of missing) if (m.required) warnings.push(`Required column "${m.field}" is missing: ${m.impact}`);
  for (const f of found) if (f.required && f.filledRows === 0) warnings.push(`Column "${f.column}" is present but empty in every row.`);
  return {
    sheet: sheetName, sheets: sheetNames, headerRow: headerRow + 1, shape, shapeLabel: schema.label,
    columns: { found, missing, ignored },
    rows: { total: rows.length, used: chk.used, skipped: chk.skipped, notes: chk.notes },
    data, warnings,
  };
}

// ── entry point ─────────────────────────────────────────────────────────────
function parseDataset(xlsxPath) {
  if (!fs.existsSync(xlsxPath)) {
    throw new Error(`Dataset not found at ${xlsxPath}`);
  }
  // cellStyles:true so we can read the YELLOW highlight (courses to drop from the
  // datesheet). Works for .xlsx, .xls and .csv.
  const wb = xlsx.readFile(xlsxPath, { cellStyles: true });
  // Use the first sheet whose columns are recognised (title rows above the header
  // are allowed); fall back to the first sheet that has data.
  const tried = [];
  let pick = null;
  for (const nm of wb.SheetNames) {
    const sh = wb.Sheets[nm];
    if (!sh || !sh['!ref']) continue;
    const { rows, headerRow } = readRows(sh);
    if (!rows.length) continue;
    const headers = Object.keys(rows[0]);
    const shape = detectShapeMapped(headers);
    tried.push({ sheet: nm, headerRow: headerRow + 1, columns: headers.filter((h) => !/^__empty/i.test(h)) });
    if (shape !== 'unknown') { pick = { nm, sheet: sh, rows, headerRow, headers, shape }; break; }
  }
  if (!pick) {
    if (!tried.length) throw new Error('The dataset is empty.');
    const err = new Error(
      'Unrecognised columns. Expected a "Courses with Names" column (student ' +
      'registration export), Code/Name/Component columns (timetable format), ' +
      'Code/Primary Faculty/Program Batch (ERP class list), or ' +
      'Course Code / Course Title / Meta Details columns (course-wise enrolment report).'
    );
    err.report = { shape: 'unknown', sheets: wb.SheetNames, tried };
    throw err;
  }

  const { nm, sheet, headerRow, headers, shape } = pick;
  const { map } = mapColumns(SCHEMAS[shape], headers);
  const rows = canonicalRows(pick.rows, map);

  let result;
  if (shape === 'student') result = parseStudentWise(rows);
  else if (shape === 'classlist') result = parseClassList(rows);
  else if (shape === 'timetable') result = parseTimetable(rows);
  else {
    // coursewise: collect codes whose cell fill is yellow (→ removed from the datesheet)
    const yellow = new Set();
    try {
      const range = xlsx.utils.decode_range(sheet['!ref']);
      const codeHeader = canonH(map['Course Code'] || 'course code');
      let codeCol = -1;
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = sheet[xlsx.utils.encode_cell({ r: headerRow, c })];
        if (cell && canonH(cell.v) === codeHeader) { codeCol = c; break; }
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
    result = parseCourseWise(rows, yellow);
  }
  // what was read, what is missing — shown to the Exam Cell after every import
  try {
    result.report = buildReport({ sheetName: nm, sheetNames: wb.SheetNames, headerRow, shape, headers, map, rows, result });
  } catch (e) { result.report = { shape, error: e.message }; }
  return result;
}

module.exports = { parseDataset, parseStudentWise, parseTimetable, parseClassList, SECTION_LIMIT, SCHEMAS };
