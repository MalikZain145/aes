/**
 * Resolves a "Program Batch" string (e.g. "BSCS-Spring 24") into a
 * readable program name, and a subject code into a department key.
 * Mirrors the Python scheduler so backend and scheduler agree.
 */

const PB_PREFIX_MAP = [
  ['BSCS', 'BS Computer Science'],
  ['BSSE', 'BS Software Engineering'],
  ['BSAI', 'BS Artificial Intelligence'],
  ['BECE', 'BE Civil Engineering'],
  ['BSCE', 'BE Civil Engineering'],
  ['BSc CET', 'BSc Civil Engineering Technology'],
  ['BSEE', 'BS Electrical Engineering'],
  ['BSc EET', 'BSc Electrical Engineering Technology'],
  ['BBA', 'Bachelor of Business Administration'],
  ['BSAF', 'BS Accounting and Finance'],
  ['BSENG', 'BS English (Language and Literature)'],
  ['BSPSY', 'BS Psychology'],
  ['PHARM-D', 'Doctor of Pharmacy'],
  ['DPT', 'Doctor of Physical Therapy'],
  ['BSMLT', 'BS Medical Lab Technology'],
  ['BSVS', 'BS Vision Sciences'],
  ['BSOT', 'BS Operation Theatre Technology'],
  ['BSRT', 'BS Radiology Technology'],
  ['BSHND', 'BS Human Nutrition & Dietetics'],
  ['General Courses', 'General Courses'],
];

function pbToProgram(pb) {
  const s = String(pb || '').trim();
  const sorted = [...PB_PREFIX_MAP].sort((a, b) => b[0].length - a[0].length);
  for (const [prefix, name] of sorted) {
    if (s.toUpperCase().startsWith(prefix.toUpperCase())) return name;
  }
  return 'Graduate Program';
}

const CODE_DEPT = {
  CS: 'cs', SE: 'cs', AI: 'ai', MT: 'math', NS: 'math', NSC: 'math',
  EE: 'ee', ET: 'ee', ELT: 'ee', ELC: 'ee', ELM: 'ee', ELQ: 'ee',
  CE: 'civil', CT: 'civil', CET: 'civil', MD: 'civil',
  MG: 'bba', HM: 'bba', AF: 'af', AC: 'af',
  SS: 'common', HUM: 'common', MS: 'common', GC: 'common',
  PD: 'pharmd', PH: 'pharmd',
  LT: 'mlt', BC: 'mlt', MB: 'mlt', VS: 'vs', OT: 'ot', RT: 'rt', HN: 'hnd',
  DP: 'dpt', PT: 'dpt', SU: 'dpt',
  ENG: 'eng', LIN: 'eng', PSY: 'psy',
};

const COMMON_KW = [
  'islamic studies', 'pakistan studies', 'quran', 'fahm-ul-quran',
  'communication skills', 'professional practices', 'professional ethics',
  'introduction to management', 'economics', 'technical report writing',
];

function getDeptKey(code, name) {
  const n = String(name || '').toLowerCase();
  if (COMMON_KW.some((kw) => n.includes(kw))) return 'common';
  const c = String(code || '').toUpperCase();
  const prefixes = Object.keys(CODE_DEPT).sort((a, b) => b.length - a.length);
  for (const p of prefixes) {
    if (c.startsWith(p)) return CODE_DEPT[p];
  }
  return 'common';
}

// Extract teacher display name from "email - ID - Mr. Name" format
function extractTeacher(raw) {
  if (raw === null || raw === undefined) return 'TBA';
  const s = String(raw).trim();
  if (s === '' || s.toLowerCase() === 'nan') return 'TBA';
  if (s.includes('@')) {
    const parts = s.split(' - ').map((p) => p.trim());
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (p && !p.includes('@') && !/^[A-Z&]+-\d+$/.test(p) && p.length > 2) return p;
    }
    return parts[parts.length - 1] || 'TBA';
  }
  if (['Mr.', 'Ms.', 'Dr.', 'Engr.', 'Prof.'].some((t) => s.includes(t))) return s;
  if (s.length > 3 && !/^[\d. ]+$/.test(s)) return s;
  return 'TBA';
}

/**
 * Fully parse a "Primary Faculty" cell into { name, email, facultyId }.
 * Handles formats like:
 *   "shahrukh.pasha@abasynisb.edu.pk - CE-075 - Mr. M. Shahrukh Pasha"
 *   "muhammad.salman@abasynisb.edu.pk - Mr. Muhammad Salman"
 *   "Mr. Muhammad Salman"
 *   "" / "nan" / "TBA"  -> name "TBA"
 */
function parseFaculty(raw) {
  const out = { name: 'TBA', email: '', facultyId: '' };
  if (raw === null || raw === undefined) return out;
  const s = String(raw).trim();
  if (s === '' || s.toLowerCase() === 'nan' || s.toLowerCase() === 'tba') return out;

  const parts = s.split(' - ').map((p) => p.trim()).filter(Boolean);
  for (const p of parts) {
    if (p.includes('@')) {
      out.email = p.toLowerCase();
    } else if (/^[A-Za-z&]+-\d+$/.test(p)) {
      out.facultyId = p.toUpperCase();
    } else if (p.length > 2) {
      // Likely the name (may include a title)
      out.name = p;
    }
  }
  // Fallback to the simpler extractor if no name part was found
  if (out.name === 'TBA') out.name = extractTeacher(raw);
  return out;
}

// Courses with NO written paper — projects, internships, thesis, etc. Keywords
// are stored NORMALISED (lowercase, punctuation → single space) and matched
// against a normalised course name, so "Project - II", "Project-II" and
// "Project  II" all catch the same rule (e.g. CT394 "Project - II").
const EXCL_KW = [
  'final year project', 'fyp',
  'research project', 'research work', 'research thesis',
  'term project', 'short term project', 'semester project', 'mini project', 'design project',
  'project i', 'project ii', 'project iii', 'project 1', 'project 2', 'project 3',
  'internship', 'industrial internship', 'internship project', 'industrial training',
  'supervised industrial', 'supervised field', 'field training', 'field work',
  'thesis', 'dissertation', 'term paper', 'capstone',
  'civil engineering project', 'engineering project',
];

const _normName = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function shouldExclude(name) {
  const n = _normName(name);
  return EXCL_KW.some((kw) => n.includes(kw));
}

// "BS Computer Science Fall 2025" → "BS Computer Science"
function stripBatch(pb) {
  return String(pb || '').replace(/\s+(Fall|Spring|Summer|Autumn|Winter)\s+\d{4}\s*$/i, '').trim();
}

// A course is POSTGRADUATE (MS/PhD) when its code has a 3-digit number 500–999
// (CS602, MG687, DS604…). 4-digit codes (CE1013, CE2023) are undergraduate.
function isPostgradCode(code) {
  const m = String(code || '').match(/(\d{3,4})/);
  if (!m) return false;
  return m[1].length === 3 && parseInt(m[1], 10) >= 500;
}

// UG vs PG — code >= 500 wins, else fall back to the program name.
function levelOf(program, code) {
  if (isPostgradCode(code)) return 'PG';
  return /^(m\.?s\b|msc\b|mphil\b|m\.?\s?phil|master of philosophy|master of|ph\.?d\b|doctor of philosophy)/i
    .test(String(program || '').trim()) ? 'PG' : 'UG';
}

// Department key — "Engineering Technology" programs → btech, else by course code.
function resolveDepartment(code, name, program) {
  if (/engineering technology/i.test(String(program || ''))) return 'btech';
  return getDeptKey(code, name) || '';
}

// Program name from a programBatch (real name if present, else code-prefix map).
function resolveProgram(programBatch) {
  const stripped = stripBatch(programBatch);
  if (stripped && !/^(bscs|bsse|bsai|bece|bsce|bsee|bba|bsaf|phaarm|dpt)\b/i.test(stripped)) return stripped;
  return pbToProgram(programBatch);
}

module.exports = {
  pbToProgram, getDeptKey, extractTeacher, parseFaculty, shouldExclude,
  stripBatch, isPostgradCode, levelOf, resolveDepartment, resolveProgram,
};
