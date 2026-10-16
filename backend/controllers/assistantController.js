/**
 * assistantController.js — "Ask Abasyn" voice / text assistant (Exam Cell).
 *
 * POST /api/assistant/ask  { text, alternatives?: [..], lang?: 'en'|'ur' }
 *   → { ok, intent, heard, answer, answerUr, speak, speakUr, result, suggestions }
 *
 * Answers from the LIVE exam data — the newest admit-card batch (seating, sections,
 * invigilation), the datesheets, faculty and courses — in English and Urdu:
 *   • "Aqsa Ashfaq ki duty kab hai"         → her invigilation duties
 *   • "9841 ki seat" / "Osama Ud Din ka card"→ the student's papers, rooms, seats, fee
 *   • "CS313 ka paper kab hai"               → date, time, rooms, sections, teacher
 *   • "J-214 mein 3 November ko kaun hai"    → papers, students, invigilators
 *   • "3 November ke papers"                 → every paper that day
 *   • "kitne students / admit cards"         → counts
 */
const fs = require('fs');
const path = require('path');
const NLU = require('../utils/assistantNlu');
const GeneratedFile = require('../models/GeneratedFile');
const { OUTPUT_DIR } = require('../utils/pythonRunner');

const up = (s) => String(s || '').trim().toUpperCase();
const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const toIso = (d) => {   // "03-Nov-2026" | "2026-11-03" → "2026-11-03"
  const s = String(d || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  return m ? `${m[3]}-${String(MON[m[2]] + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}` : s;
};
const DAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_UR = ['اتوار', 'پیر', 'منگل', 'بدھ', 'جمعرات', 'جمعہ', 'ہفتہ'];
const MON_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MON_UR = ['جنوری', 'فروری', 'مارچ', 'اپریل', 'مئی', 'جون', 'جولائی', 'اگست', 'ستمبر', 'اکتوبر', 'نومبر', 'دسمبر'];
const dEn = (iso) => { const d = new Date(`${iso}T00:00:00`); return `${DAY_EN[d.getDay()]} ${d.getDate()} ${MON_EN[d.getMonth()]}`; };
const dUr = (iso) => { const d = new Date(`${iso}T00:00:00`); return `${DAY_UR[d.getDay()]} ${d.getDate()} ${MON_UR[d.getMonth()]}`; };
const tEn = (slot) => { const [a, b] = String(slot).split('-'); return `${a} to ${b}`; };
const tUr = (slot) => { const [a, b] = String(slot).split('-'); return `${a} سے ${b} تک`; };
const cohortName = { bs: 'BS', btech: 'B.Tech', pg: 'MS' };

// ── knowledge base (cached; rebuilt when the batch / layout / datesheets change) ──
let KB = null; let KB_KEY = '';

async function datesheetCourses() {
  const out = new Map();
  const recs = await GeneratedFile.find({ kind: 'datesheet', archived: { $ne: true } }).sort({ createdAt: -1 }).lean();
  const seen = new Set();
  for (const r of recs) {
    const cohort = r.meta && r.meta.btech ? 'btech' : (/post/i.test((r.meta && r.meta.programLevel) || '') ? 'pg' : 'bs');
    if (seen.has(cohort)) continue; seen.add(cohort);
    const sf = r.meta && r.meta.scheduleFile; const p = sf ? path.join(OUTPUT_DIR, path.basename(sf)) : null;
    if (!p || !fs.existsSync(p)) continue;
    try {
      const snap = JSON.parse(fs.readFileSync(p, 'utf-8'));
      for (const c of snap.courses || []) {
        const code = up(c.code);
        if (!out.has(code)) out.set(code, []);
        out.get(code).push({ code, name: c.name || code, date: toIso(c.date), slot: c.slot, cohort, group: c.group || code, students: (c.students || []).length });
      }
    } catch { /* unreadable sheet */ }
  }
  return out;
}

async function loadKB() {
  const batch = await GeneratedFile.findOne({ kind: 'admit_cards' }).sort({ createdAt: -1 }).lean();
  const cards = batch && (batch.files || []).find((f) => /admit cards/i.test(f.label || ''));
  const layoutPath = cards ? path.join(OUTPUT_DIR, path.basename(cards.filename).replace(/\.pdf$/i, '_layout.json')) : null;
  const dsRecs = await GeneratedFile.find({ kind: 'datesheet', archived: { $ne: true } }).select('_id updatedAt').lean();
  let mtime = 0; try { mtime = layoutPath ? fs.statSync(layoutPath).mtimeMs : 0; } catch { mtime = 0; }
  const key = `${batch ? batch._id : ''}|${mtime}|${dsRecs.map((d) => `${d._id}:${+new Date(d.updatedAt)}`).join(',')}`;
  if (KB && KB_KEY === key && Date.now() - KB.at < 10 * 60 * 1000) return KB;

  const Teacher = require('../models/Teacher');
  const Course = require('../models/Course');
  const [teachersDb, coursesDb, dsc] = await Promise.all([
    Teacher.find({}).select('name aliases designation facultyId allowInvigilation isVisiting listYellow active').lean(),
    Course.find({ active: true }).select('code name section teacher component erpEnrolled').lean(),
    datesheetCourses(),
  ]);

  // seating + invigilation from the batch layout
  const students = new Map(); const duties = new Map(); const byCourse = new Map(); const byRoom = new Map(); const sessions = [];
  let layout = null;
  try { layout = layoutPath && fs.existsSync(layoutPath) ? JSON.parse(fs.readFileSync(layoutPath, 'utf-8')) : null; } catch { layout = null; }
  for (const s of (layout && layout.sessions) || []) {
    const date = toIso(s.date);
    for (const room of s.rooms || []) {
      const papers = {};
      for (const r of room.rows || []) {
        const sid = String(r.sid); const code = up(r.course);
        if (!students.has(sid)) students.set(sid, { sid, name: r.name || '', program: r.program || '', batch: r.batch || '', papers: [] });
        const slot = r.time || s.slot;
        students.get(sid).papers.push({ code, date, slot, room: room.name, seat: r.seat, section: r.section || '' });
        const k = `${code}|${r.section || ''}`; papers[k] = (papers[k] || 0) + 1;
        if (!byCourse.has(code)) byCourse.set(code, []);
        byCourse.get(code).push({ date, slot, room: room.name, section: r.section || '', sid });
      }
      const entry = { date, slot: s.slot, room: room.name, invigilators: room.invigilators || [], papers, students: (room.rows || []).length };
      sessions.push(entry);
      if (!byRoom.has(room.name)) byRoom.set(room.name, []);
      byRoom.get(room.name).push(entry);
      for (const n of room.invigilators || []) { if (!duties.has(n)) duties.set(n, []); duties.get(n).push(entry); }
    }
  }
  for (const st of students.values()) st.papers.sort((a, b) => (a.date + a.slot).localeCompare(b.date + b.slot));

  // teachers: DB faculty + any roster spelling not in the DB
  const lecturersOf = new Map(); const sectionTeacher = new Map(); const courseName = new Map();
  const hasLec = new Set(coursesDb.filter((c) => c.component !== 'Lab').map((c) => up(c.code)));
  for (const c of coursesDb) {
    const code = up(c.code);
    if (c.name && !courseName.has(code)) courseName.set(code, c.name);
    if (c.component === 'Lab' && hasLec.has(code)) continue;
    const t = String(c.teacher || '').trim();
    if (!t || /^(tba|no teacher)$/i.test(t)) continue;
    if (!lecturersOf.has(code)) lecturersOf.set(code, new Set());
    lecturersOf.get(code).add(t);
    if (/^[A-Z]$/.test(up(c.section))) sectionTeacher.set(`${code}|${up(c.section)}`, t);
  }
  const personKey = (n) => NLU.skel(String(n || '').replace(/\b(mr|mrs|ms|miss|dr|engr|prof|syed|hafiz)\b\.?/gi, ' ')).replace(/ /g, '');
  const teachers = []; const byKey = new Map();
  for (const t of teachersDb) {
    if (t.active === false) continue;
    const rec = { name: t.name, keys: [t.name, ...(t.aliases || [])], designation: t.designation || '', facultyId: t.facultyId || '',
      allow: t.allowInvigilation !== false && !t.isVisiting, yellow: !!t.listYellow, visiting: !!t.isVisiting, dutyNames: [] };
    teachers.push(rec);
    for (const k of rec.keys) byKey.set(personKey(k), rec);
  }
  for (const n of duties.keys()) {
    const rec = byKey.get(personKey(n));
    if (rec) rec.dutyNames.push(n);
    else { const r2 = { name: n, keys: [n], designation: '', facultyId: '', allow: true, dutyNames: [n] }; teachers.push(r2); byKey.set(personKey(n), r2); }
  }
  // courses each teacher teaches (lecture rows)
  const teaches = new Map();
  for (const [code, set] of lecturersOf) for (const t of set) {
    const rec = byKey.get(personKey(t)); if (!rec) continue;
    if (!teaches.has(rec.name)) teaches.set(rec.name, new Set());
    teaches.get(rec.name).add(code);
  }

  const allCodes = new Set([...dsc.keys(), ...byCourse.keys()]);
  const courses = [...allCodes].map((code) => ({ code, name: courseName.get(code) || ((dsc.get(code) || [])[0] || {}).name || code }));
  const rooms = [...new Set([...byRoom.keys(), ...((layout && layout.venues) || []).map((v) => v.name)])];
  const examDates = [...new Set([...sessions.map((s) => s.date), ...[...dsc.values()].flat().map((c) => c.date)])].filter(Boolean).sort();
  const slots = [...new Set([...sessions.map((s) => s.slot), ...[...dsc.values()].flat().map((c) => c.slot)])].filter(Boolean).sort();
  const studentList = [...students.values()].map((s) => ({ ...s, keys: [s.name] }));

  KB = {
    at: Date.now(), batch, layout: !!layout, students, studentList, studentIds: new Set(students.keys()), duties, byCourse, byRoom, sessions,
    teachers, teaches, lecturersOf, sectionTeacher, dsc, courses, rooms, examDates, slots,
    nlu: { teachers, students: studentList, courses, rooms, examDates, slots, studentIds: new Set(students.keys()), studentById: new Map(studentList.map((s) => [s.sid, s])) },
  };
  KB_KEY = key;
  return KB;
}

// ── answers ──────────────────────────────────────────────────────────────────
function teacherDuties(kb, t) {
  const list = (t.dutyNames.length ? t.dutyNames : [t.name]).flatMap((n) => kb.duties.get(n) || []);
  const uniq = [...new Map(list.map((d) => [`${d.date}|${d.slot}|${d.room}`, d])).values()].sort((a, b) => (a.date + a.slot).localeCompare(b.date + b.slot));
  return uniq;
}

function answerTeacherDuty(kb, p) {
  const t = p.teacher; let d = teacherDuties(kb, t);
  if (p.dates) d = d.filter((x) => p.dates.includes(x.date));
  const who = t.name;
  const rows = d.map((x) => ({ date: x.date, day: dEn(x.date), slot: x.slot, room: x.room, students: x.students, with: x.invigilators.filter((n) => !t.dutyNames.includes(n) && n !== t.name) }));
  if (!d.length) {
    const why = !t.allow ? (t.visiting ? ' (visiting faculty — no invigilation)' : ' (invigilation is switched off for this teacher)') : '';
    const whyUr = !t.allow ? (t.visiting ? ' (وزیٹنگ فیکلٹی ہیں — ڈیوٹی نہیں لگتی)' : ' (ان کی انویجیلیشن بند ہے)') : '';
    return { answer: `${who} has no invigilation duty${p.dates ? ' on ' + p.dates.map(dEn).join(', ') : ''}${why}.`,
      answerUr: `${who} کی ${p.dates ? p.dates.map(dUr).join('، ') + ' کو ' : ''}کوئی ڈیوٹی نہیں ہے${whyUr}۔`,
      result: { type: 'duties', title: who, subtitle: t.designation, rows: [] } };
  }
  const first = d.slice(0, 6);
  const en = `${who} has ${d.length} ${d.length === 1 ? 'duty' : 'duties'}: ` + first.map((x) => `${dEn(x.date)}, ${tEn(x.slot)}, room ${x.room}`).join('; ') + (d.length > 6 ? '; and more.' : '.');
  const ur = `${who} کی ${d.length} ${d.length === 1 ? 'ڈیوٹی ہے' : 'ڈیوٹیاں ہیں'}: ` + first.map((x) => `${dUr(x.date)}، ${tUr(x.slot)}، کمرہ ${x.room}`).join('؛ ') + '۔';
  return { answer: en, answerUr: ur, result: { type: 'duties', title: who, subtitle: [t.designation, t.facultyId && `ID ${t.facultyId}`].filter(Boolean).join(' · '), rows } };
}

function answerTeacherCourses(kb, p) {
  const t = p.teacher; const codes = [...(kb.teaches.get(t.name) || [])].sort();
  const rows = [];
  for (const code of codes) {
    const ex = (kb.dsc.get(code) || [])[0];
    rows.push({ code, name: (kb.courses.find((c) => c.code === code) || {}).name || code, date: ex && ex.date, day: ex && dEn(ex.date), slot: ex && ex.slot });
  }
  if (!rows.length) return { answer: `I could not find courses taught by ${t.name}.`, answerUr: `${t.name} کے کورس نہیں ملے۔`, result: null };
  const withPaper = rows.filter((r) => r.date);
  const en = `${t.name} teaches ${rows.length} course${rows.length === 1 ? '' : 's'}. ` + withPaper.slice(0, 5).map((r) => `${r.code} paper: ${dEn(r.date)}, ${tEn(r.slot)}`).join('; ') + '.';
  const ur = `${t.name} ${rows.length} کورس پڑھاتے ہیں۔ ` + withPaper.slice(0, 5).map((r) => `${r.code} کا پرچہ ${dUr(r.date)}، ${tUr(r.slot)}`).join('؛ ') + '۔';
  return { answer: en, answerUr: ur, result: { type: 'teacher_courses', title: t.name, subtitle: t.designation, rows } };
}

async function answerStudent(kb, p) {
  const s = p.student;
  let papers = s.papers;
  if (p.course) papers = papers.filter((x) => x.code === p.course.code);
  if (p.dates) papers = papers.filter((x) => p.dates.includes(x.date));
  let fee = '';
  try {
    const AV = require('../models/AdmitVerification');
    const av = await AV.findOne({ batchId: kb.batch && kb.batch._id, studentId: s.sid }).select('feeStatus').lean();
    fee = av ? (/unpaid|not\s*paid/i.test(av.feeStatus || '') || !av.feeStatus ? 'Unpaid' : 'Paid') : '';
  } catch { fee = ''; }
  const rows = papers.map((x) => ({ code: x.code + (x.section ? `-${x.section}` : ''), name: (kb.courses.find((c) => c.code === x.code) || {}).name || '', date: x.date, day: dEn(x.date), slot: x.slot, room: x.room, seat: x.seat }));
  if (p.intent === 'student_fee') {
    return { answer: `${s.name} (${s.sid}): fee ${fee || 'unknown'}. ${fee === 'Paid' ? 'The admit card is released.' : 'The admit card stays locked until Finance clears the fee.'}`,
      answerUr: `${s.name} (${s.sid}): فیس ${fee === 'Paid' ? 'جمع ہے، ایڈمٹ کارڈ جاری ہے' : 'جمع نہیں، ایڈمٹ کارڈ فنانس کی منظوری تک بند ہے'}۔`,
      result: { type: 'student', title: `${s.sid} · ${s.name}`, subtitle: `${s.batch}${fee ? ' · Fee ' + fee : ''}`, rows } };
  }
  if (!rows.length) return { answer: `${s.name} (${s.sid}) has no matching paper.`, answerUr: `${s.name} (${s.sid}) کا ایسا کوئی پرچہ نہیں۔`, result: { type: 'student', title: `${s.sid} · ${s.name}`, subtitle: s.batch, rows: [] } };
  const en = `${s.name}, ${s.sid}: ${rows.length} paper${rows.length === 1 ? '' : 's'}. ` + rows.slice(0, 6).map((r) => `${r.code} on ${r.day}, ${tEn(r.slot)}, room ${r.room}, seat ${r.seat}`).join('; ') + '.';
  const ur = `${s.name}، ${s.sid}: ${rows.length} پرچے۔ ` + rows.slice(0, 6).map((r) => `${r.code} ${dUr(r.date)}، ${tUr(r.slot)}، کمرہ ${r.room}، سیٹ ${r.seat}`).join('؛ ') + '۔';
  return { answer: en, answerUr: ur, result: { type: 'student', title: `${s.sid} · ${s.name}`, subtitle: `${s.batch}${fee ? ' · Fee ' + fee : ''}`, rows } };
}

function answerCourse(kb, p) {
  const c = p.course; const ex = kb.dsc.get(c.code) || [];
  const seats = kb.byCourse.get(c.code) || [];
  const teachers = [...(kb.lecturersOf.get(c.code) || [])];
  const groups = new Map();
  for (const x of seats) { const k = `${x.date}|${x.slot}|${x.room}|${x.section}`; groups.set(k, (groups.get(k) || 0) + 1); }
  let rows = [...groups].map(([k, n]) => { const [date, slot, room, section] = k.split('|'); return { date, day: dEn(date), slot, room, section, students: n, teacher: section ? (kb.sectionTeacher.get(`${c.code}|${section}`) || '') : teachers.join(' / ') }; })
    .sort((a, b) => (a.date + a.slot + a.section + a.room).localeCompare(b.date + b.slot + b.section + b.room));
  if (p.section) rows = rows.filter((r) => r.section === p.section);
  if (p.intent === 'course_teacher') {
    let secs = [...new Set(rows.map((r) => r.section).filter(Boolean))];
    const tset = new Set(secs.map((x) => kb.sectionTeacher.get(`${c.code}|${x}`) || ''));
    if (secs.length > 1 && tset.size === 1 && [...tset][0]) {
      const t = [...tset][0];
      return { answer: `${c.code} ${c.name}: all sections (${secs.join(', ')}) are taught by ${t}.`, answerUr: `${c.code} کے تمام سیکشن (${secs.join('، ')}) ${t} پڑھاتے ہیں۔`, result: { type: 'course', title: `${c.code} · ${c.name}`, subtitle: t, rows } };
    }
    if (p.section) secs = secs.filter((x) => x === p.section);
    const en = secs.length ? `${c.code} ${c.name}: ` + secs.map((s) => `section ${s} — ${kb.sectionTeacher.get(`${c.code}|${s}`) || 'not assigned'}`).join('; ') + '.' : `${c.code} ${c.name} is taught by ${teachers.join(' and ') || 'no teacher on record'}.`;
    const ur = secs.length ? `${c.code}: ` + secs.map((s) => `سیکشن ${s} — ${kb.sectionTeacher.get(`${c.code}|${s}`) || 'ٹیچر درج نہیں'}`).join('؛ ') + '۔' : `${c.code} ${teachers.join(' اور ') || 'کوئی ٹیچر درج نہیں'} پڑھاتے ہیں۔`;
    return { answer: en, answerUr: ur, result: { type: 'course', title: `${c.code} · ${c.name}`, subtitle: teachers.join(' / '), rows } };
  }
  if (!ex.length && !rows.length) return { answer: `${c.code} ${c.name} has no paper in this exam.`, answerUr: `${c.code} ${c.name} کا اس امتحان میں کوئی پرچہ نہیں۔`, result: null };
  const when = ex.length ? ex : [{ date: rows[0].date, slot: rows[0].slot, cohort: '' }];
  const w = when[0];
  const total = rows.reduce((a, r) => a + r.students, 0);
  const secs = [...new Set(rows.map((r) => r.section).filter(Boolean))];
  const roomsTxt = [...new Set(rows.map((r) => r.room))];
  const en = `${c.code} ${c.name}: paper on ${dEn(w.date)}, ${tEn(w.slot)}${when.length > 1 ? ` (${when.map((x) => `${cohortName[x.cohort] || x.cohort}: ${dEn(x.date)} ${x.slot}`).join(', ')})` : ''}. `
    + (total ? `${total} students in ${roomsTxt.length} room${roomsTxt.length === 1 ? '' : 's'}: ${roomsTxt.join(', ')}.` : '')
    + (secs.length ? ` Sections ${secs.join(', ')}.` : '');
  const ur = `${c.code} ${c.name} کا پرچہ ${dUr(w.date)}، ${tUr(w.slot)} ہے۔ ` + (total ? `${total} طلبہ، ${roomsTxt.length} کمروں میں: ${roomsTxt.join('، ')}۔` : '') + (secs.length ? ` سیکشن ${secs.join('، ')}۔` : '');
  return { answer: en, answerUr: ur, result: { type: 'course', title: `${c.code} · ${c.name}`, subtitle: [`${dEn(w.date)} · ${w.slot}`, teachers.join(' / ')].filter(Boolean).join(' · '), rows } };
}

function answerRoom(kb, p) {
  let list = kb.byRoom.get(p.room) || [];
  if (p.dates) list = list.filter((x) => p.dates.includes(x.date));
  if (p.slot) list = list.filter((x) => x.slot === p.slot);
  list = [...list].sort((a, b) => (a.date + a.slot).localeCompare(b.date + b.slot));
  const rows = list.map((x) => ({ date: x.date, day: dEn(x.date), slot: x.slot, students: x.students, papers: Object.entries(x.papers).map(([k, n]) => `${k.replace(/\|$/, '').replace('|', '-')} (${n})`).join(', '), invigilators: x.invigilators.join(', ') }));
  if (!rows.length) return { answer: `Room ${p.room} has no paper${p.dates ? ' on ' + p.dates.map(dEn).join(', ') : ''}${p.slot ? ' at ' + p.slot : ''}.`, answerUr: `کمرہ ${p.room} میں ${p.dates ? p.dates.map(dUr).join('، ') + ' کو ' : ''}کوئی پرچہ نہیں۔`, result: { type: 'room', title: p.room, rows: [] } };
  const one = rows.length <= 3;
  const en = `Room ${p.room}: ${rows.length} sitting${rows.length === 1 ? '' : 's'}. ` + (one ? rows.map((r) => `${r.day}, ${tEn(r.slot)}: ${r.students} students — ${r.papers}; invigilators ${r.invigilators}`).join('. ') : `First: ${rows[0].day}, ${tEn(rows[0].slot)}, ${rows[0].students} students`) + '.';
  const ur = `کمرہ ${p.room}: ${rows.length} نشستیں۔ ` + (one ? rows.map((r) => `${dUr(r.date)}، ${tUr(r.slot)}: ${r.students} طلبہ — ${r.papers}؛ نگران ${r.invigilators}`).join('۔ ') : `پہلی: ${dUr(rows[0].date)}، ${tUr(rows[0].slot)}، ${rows[0].students} طلبہ`) + '۔';
  return { answer: en, answerUr: ur, result: { type: 'room', title: `Room ${p.room}`, rows } };
}

function answerDate(kb, p) {
  const rows = [];
  for (const [code, list] of kb.dsc) for (const x of list) {
    if (!p.dates.includes(x.date) || (p.slot && x.slot !== p.slot)) continue;
    const n = (kb.byCourse.get(code) || []).filter((s) => s.date === x.date).length;
    rows.push({ code, name: x.name, date: x.date, day: dEn(x.date), slot: x.slot, cohort: cohortName[x.cohort] || x.cohort, students: n });
  }
  rows.sort((a, b) => (a.date + a.slot + a.code).localeCompare(b.date + b.slot + b.code));
  const days = p.dates.map(dEn).join(', '); const daysUr = p.dates.map(dUr).join('، ');
  if (!rows.length) return { answer: `No paper on ${days}${p.slot ? ' at ' + p.slot : ''}.`, answerUr: `${daysUr} کو کوئی پرچہ نہیں۔`, result: { type: 'date', title: days, rows: [] } };
  const slots = [...new Set(rows.map((r) => r.slot))];
  const en = `${days}: ${rows.length} paper${rows.length === 1 ? '' : 's'} in ${slots.length} slot${slots.length === 1 ? '' : 's'} (${slots.join(', ')}), ${rows.reduce((a, r) => a + r.students, 0)} students.`;
  const ur = `${daysUr}: ${rows.length} پرچے، ${slots.length} اوقات میں (${slots.join('، ')})، کل ${rows.reduce((a, r) => a + r.students, 0)} طلبہ۔`;
  return { answer: en, answerUr: ur, result: { type: 'date', title: days, rows } };
}

function answerCount(kb, text) {
  const n = { students: kb.students.size, teachers: kb.teachers.filter((t) => t.facultyId).length, duty: kb.duties.size, courses: kb.dsc.size, rooms: kb.rooms.length, sittings: kb.sessions.length };
  if (/teacher|faculty|ustad|invigilat|duty/.test(text)) return { answer: `${n.teachers} faculty members; ${n.duty} of them have invigilation duties.`, answerUr: `${n.teachers} اساتذہ ہیں؛ ان میں سے ${n.duty} کی ڈیوٹیاں ہیں۔` };
  if (/course|paper|subject|exam/.test(text)) return { answer: `${n.courses} papers are on the datesheets.`, answerUr: `ڈیٹ شیٹس پر ${n.courses} پرچے ہیں۔` };
  if (/room|kamra|hall|venue/.test(text)) return { answer: `${n.rooms} exam rooms are in use.`, answerUr: `${n.rooms} امتحانی کمرے استعمال ہو رہے ہیں۔` };
  return { answer: `${n.students} students have admit cards in this exam, across ${n.courses} papers and ${n.rooms} rooms.`, answerUr: `اس امتحان میں ${n.students} طلبہ کے ایڈمٹ کارڈ ہیں، ${n.courses} پرچے اور ${n.rooms} کمرے۔` };
}

const HELP = {
  answer: 'Ask me about duties, papers, seats or rooms. For example: "Aqsa Ashfaq ki duty", "CS313 ka paper kab hai", "9841 ki seat", "room J-214 on 3 November", "3 November ke papers".',
  answerUr: 'مجھ سے ڈیوٹی، پرچوں، سیٹ یا کمروں کے بارے میں پوچھیں۔ مثلاً: عقصہ اشفاق کی ڈیوٹی، سی ایس تین سو تیرہ کا پرچہ کب ہے، نو آٹھ چار ایک کی سیٹ، تین نومبر کے پرچے۔',
};

exports.ask = async (req, res) => {
  try {
    const body = req.body || {};
    const alts = [body.text, ...(Array.isArray(body.alternatives) ? body.alternatives : [])].filter(Boolean).map(String).slice(0, 8);
    if (!alts.length) return res.status(400).json({ error: 'Say or type a question.' });
    const kb = await loadKB();
    const p = NLU.best(alts, kb.nlu);
    let out;
    switch (p.intent) {
      case 'greet': out = { answer: 'Yes, I am listening. Ask me anything about the exams.', answerUr: 'جی، میں سن رہی ہوں۔ امتحانات کے بارے میں کچھ بھی پوچھیں۔' }; break;
      case 'help': out = HELP; break;
      case 'count': out = answerCount(kb, p.text); break;
      case 'student': case 'student_fee': out = await answerStudent(kb, p); break;
      case 'teacher_duty': out = answerTeacherDuty(kb, p); break;
      case 'teacher_courses': out = answerTeacherCourses(kb, p); break;
      case 'course': case 'course_teacher': out = answerCourse(kb, p); break;
      case 'room': out = answerRoom(kb, p); break;
      case 'date': out = answerDate(kb, p); break;
      case 'duty_overview': out = { answer: `${kb.duties.size} teachers have ${kb.sessions.reduce((a, s) => a + s.invigilators.length, 0)} invigilation duties. Say a teacher's name to hear theirs.`, answerUr: `${kb.duties.size} اساتذہ کی ڈیوٹیاں لگی ہیں۔ کسی ٹیچر کا نام بولیں، میں ان کی ڈیوٹی بتا دوں گی۔` }; break;
      case 'datesheet_overview': out = { answer: `Exams run from ${dEn(kb.examDates[0])} to ${dEn(kb.examDates[kb.examDates.length - 1])}, ${kb.dsc.size} papers. Say a course code or a date.`, answerUr: `امتحانات ${dUr(kb.examDates[0])} سے ${dUr(kb.examDates[kb.examDates.length - 1])} تک ہیں، ${kb.dsc.size} پرچے۔ کورس کوڈ یا تاریخ بولیں۔` }; break;
      default: out = null;
    }
    const suggestions = [...(p.teacherAlts || []).slice(1), ...(p.studentAlts || []).slice(1)].slice(0, 3);
    if (!out) {
      return res.json({ ok: true, intent: null, heard: p.raw, normalized: p.text,
        answer: 'Sorry, I did not catch a teacher, student, course, room or date in that. Please say it again.',
        answerUr: 'معاف کیجیے، اس میں کوئی ٹیچر، طالب علم، کورس، کمرہ یا تاریخ سمجھ نہیں آئی۔ دوبارہ بولیں۔', result: null, suggestions });
    }
    res.json({ ok: true, intent: p.intent, heard: p.raw, normalized: p.text, confidence: Math.round((p.confidence || 0) * 100) / 100, ...out, suggestions });
  } catch (err) {
    console.error('assistant:', err);
    res.status(500).json({ error: 'The assistant could not answer that.' });
  }
};

exports._internals = { loadKB, toIso };
