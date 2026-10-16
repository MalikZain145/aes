/**
 * sectionPlan.js — which section (A/B/C…) each student of a multi-section course sits in.
 *
 * The ERP class list (odoocms.class) names every section's PROGRAM BATCH
 * ("CS313 … Section-A" → BSCS-Fall 24, "Section-B" → BSSE-Fall 24). So:
 *   1. a student whose program + intake matches exactly one section → that section;
 *   2. a batch shared by several sections (CS432 A and B are both BSCS-Fall 24) →
 *      filled in reg-no order: A up to its ERP enrollment, then B, …;
 *   3. anyone left (batch not on the class list) → whole batch together into the
 *      section with the most room left.
 * Only sections the class list actually writes are used — none are invented — and a
 * course with one written section is never split.
 *
 *   planSections(courses, students) → Map "sid|CODE" → letter   (pure, tested)
 *   studentSectionMap()             → the same from the DB, as a plain object
 */

const TERM_RX = /^(fall|spring|summer|fa|sp|su|f|s)\s*'?\s*(\d{2}|\d{4})$/i;

/** "Fall 24" / "SP25" / "F24" / "Spring 2025" → "F24" / "S25". '' when not a term. */
function termKey(s) {
  const m = String(s || '').trim().match(TERM_RX);
  if (!m) return '';
  const w = m[1].toLowerCase();
  const season = w.startsWith('su') ? 'U' : w.startsWith('f') ? 'F' : 'S';
  return `${season}${m[2].slice(-2)}`;
}

/** "BSCS-Fall 24" → { abbr: 'BSCS', term: 'F24' }; "CC- Social Sciences-Fall 26" → abbr "CC- SOCIAL SCIENCES". */
function splitProgramBatch(pb) {
  const s = String(pb || '').replace(/\s+/g, ' ').trim();
  const i = s.lastIndexOf('-');
  if (i < 0) return { abbr: s.toUpperCase(), term: '' };
  const term = termKey(s.slice(i + 1));
  return term ? { abbr: s.slice(0, i).trim().toUpperCase(), term } : { abbr: s.toUpperCase(), term: '' };
}

/** Student's intake term from the registration batch ("BS Computer Science Fall 2024" → F24). */
function studentTerm(st) {
  const b = String(st.batch || '').replace(/\s+/g, ' ').trim();
  const m = b.match(/(fall|spring|summer)\s*(\d{4}|\d{2})\s*$/i);
  return m ? termKey(`${m[1]} ${m[2]}`) : '';
}

const sidKey = (sid) => { const s = String(sid); return /^\d+$/.test(s) ? [0, Number(s), ''] : [1, 0, s]; };
const bySid = (a, b) => { const x = sidKey(a), y = sidKey(b); return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0); };
const up = (s) => String(s || '').trim().toUpperCase();
const progKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * courses: lecture rows [{ code, section, programBatches:[…], erpEnrolled|enrolled }]
 * students: [{ studentId, program, batch, courses:[CODE…] }]
 */
function planSections(courses, students) {
  // ── sections per code (only letters the class list writes, with students) ──
  const secs = new Map();   // CODE → Map(letter → { batches:Set('ABBR|TERM'), target })
  for (const c of courses || []) {
    const code = up(c.code); const L = up(c.section);
    if (!code || !/^[A-Z]$/.test(L)) continue;
    const n = Number(c.erpEnrolled != null ? c.erpEnrolled : c.enrolled) || 0;
    if (!secs.has(code)) secs.set(code, new Map());
    const m = secs.get(code);
    if (!m.has(L)) m.set(L, { pbs: [], target: 0 });
    const e = m.get(L);
    e.target += n;
    for (const pb of c.programBatches || (c.programBatch ? [c.programBatch] : [])) if (pb) e.pbs.push(pb);
  }
  for (const [code, m] of [...secs]) {
    for (const [L, e] of [...m]) if (e.target <= 0 && !e.pbs.length) m.delete(L);
    if (m.size < 2) secs.delete(code);
  }
  const out = new Map();
  if (!secs.size) return out;

  // ── who is registered where ──
  const regBy = new Map();   // CODE → [student]
  for (const st of students || []) {
    st._term = studentTerm(st);
    for (const code of new Set((st.courses || []).map(up))) {
      if (!regBy.has(code)) regBy.set(code, []);
      regBy.get(code).push(st);
    }
  }

  // ── "BSCS" → BS Computer Science: the known prefixes (programMap) first; an
  // abbreviation it does not know ("CC-Computing", "MSPM") is learned from who
  // actually sits that class ──
  const { pbToProgram } = require('./programMap');
  const known = (pb) => { const p = pbToProgram(pb); return p && p !== 'Graduate Program' && p !== 'General Courses' ? progKey(p) : ''; };
  const votes = new Map();   // ABBR → Map(program → n)
  for (const [code, m] of secs) {
    for (const e of m.values()) {
      for (const pb of e.pbs) {
        const { abbr, term } = splitProgramBatch(pb);
        if (!abbr || !term || known(pb)) continue;
        for (const st of regBy.get(code) || []) {
          if (st._term !== term) continue;
          if (!votes.has(abbr)) votes.set(abbr, new Map());
          const v = votes.get(abbr); const pk = progKey(st.program); v.set(pk, (v.get(pk) || 0) + 1);
        }
      }
    }
  }
  const progsOf = new Map();   // ABBR → Set(program)
  for (const [abbr, v] of votes) {
    const tot = [...v.values()].reduce((a, b) => a + b, 0);
    const top = Math.max(...v.values());
    progsOf.set(abbr, new Set([...v].filter(([, n]) => n === top || n >= tot * 0.2).map(([p]) => p)));
  }

  for (const [code, m] of secs) {
    const letters = [...m.keys()].sort();
    const keys = new Map(letters.map((L) => [L, new Set()]));
    for (const L of letters) {
      for (const pb of m.get(L).pbs) {
        const { abbr, term } = splitProgramBatch(pb);
        const k = known(pb);
        for (const p of k ? [k] : (progsOf.get(abbr) || [])) keys.get(L).add(`${p}|${term}`);
      }
    }
    const left = new Map(letters.map((L) => [L, m.get(L).target]));
    const studs = [...(regBy.get(code) || [])].sort((a, b) => bySid(a.studentId, b.studentId));
    const most = (cands) => cands.reduce((best, L) => (left.get(L) > left.get(best) ? L : best), cands[0]);
    const unmatched = [];
    for (const st of studs) {
      const k = `${progKey(st.program)}|${st._term}`;
      const cands = letters.filter((L) => keys.get(L).has(k));
      if (!cands.length) { unmatched.push(st); continue; }
      const L = cands.find((x) => left.get(x) > 0) || most(cands);
      out.set(`${st.studentId}|${code}`, L);
      left.set(L, left.get(L) - 1);
    }
    // batches the class list does not name: whole batch together, most room first
    const groups = new Map();
    for (const st of unmatched) {
      const g = `${progKey(st.program)}|${st._term}`;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(st);
    }
    const order = [...groups.values()].sort((a, b) => b.length - a.length || bySid(a[0].studentId, b[0].studentId));
    for (const g of order) {
      const L = most(letters);
      for (const st of g) out.set(`${st.studentId}|${code}`, L);
      left.set(L, left.get(L) - g.length);
    }
  }
  for (const st of students || []) delete st._term;
  return out;
}

/** From the DB: active lecture rows + every registration. Plain object for JSON. */
async function studentSectionMap() {
  const Course = require('../models/Course');
  const StudentRegistration = require('../models/StudentRegistration');
  const courses = await Course.find({ active: true, component: { $ne: 'Lab' } })
    .select('code section programBatch programBatches erpEnrolled enrolled').lean();
  const students = await StudentRegistration.find({}).select('studentId program batch courses').lean();
  const map = Object.fromEntries(planSections(courses, students));
  // exam-office corrections ("9841 is in MG403-B"): Setting 'section-overrides'
  // { "SID|CODE": "B" } — applied when the student is registered and the section exists
  try {
    const ov = await require('../models/Setting').findOne({ key: 'section-overrides' }).lean();
    const have = new Set(courses.map((c) => `${up(c.code)}|${up(c.section)}`));
    const reg = new Set(students.flatMap((st) => (st.courses || []).map((c) => `${st.studentId}|${up(c)}`)));
    for (const [k, L] of Object.entries((ov && ov.value) || {})) {
      const [sid, code] = k.split('|'); const key = `${sid}|${up(code)}`;
      if (reg.has(key) && have.has(`${up(code)}|${up(L)}`)) map[key] = up(L);
    }
  } catch { /* no overrides */ }
  return map;
}

/** Record a manual section for students: setSectionOverrides({ '9841|MG403': 'B' }). */
async function setSectionOverrides(entries) {
  const Setting = require('../models/Setting');
  const cur = (await Setting.findOne({ key: 'section-overrides' }).lean()) || {};
  const value = { ...((cur && cur.value) || {}), ...entries };
  await Setting.updateOne({ key: 'section-overrides' }, { $set: { value } }, { upsert: true });
  return value;
}

module.exports = { planSections, studentSectionMap, setSectionOverrides, termKey, splitProgramBatch };
