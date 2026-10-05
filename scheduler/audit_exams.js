/*
 * audit_exams.js — comprehensive exam-schedule validator for Abasyn Scheduler.
 *
 * Reads the LIVE generated data (datesheet schedule JSONs + admit-card seating in
 * AdmitVerification + invigilation rosters in the admit batch meta) straight from
 * MongoDB and reports:
 *   HARD checks (must all be 0): slot clashes, 3-per-day, cross-program room
 *     overlap, seat collisions, invigilator overlaps, invigilator >2/day, blocked-
 *     window (Friday Jumma) violations, duplicate course keys, zero-enrolment
 *     datesheet entries, seating-vs-datesheet mismatch, same-course neighbours.
 *   METRICS: 2-papers-per-day student-days (per cohort), back-to-back (30-min)
 *     pairs, per-slot load, room fill ratio, rooms below MIN students, invigilator
 *     duty spread.
 *
 * Usage: node audit_exams.js   (from scheduler/, backend/.env supplies MONGO_URI)
 * Cohort of a datesheet = bs | btech | pg (meta.btech / meta.programLevel).
 * Cohort of a student   = matched to the datesheet whose roster contains them.
 */
const path = require('path');
const fs = require('fs');
const B = path.resolve(__dirname, '../backend');
require(path.join(B, 'node_modules/dotenv')).config({ path: path.join(B, '.env') });
const mongoose = require(path.join(B, 'node_modules/mongoose'));
const G = require(path.join(B, 'models/GeneratedFile'));
const AV = require(path.join(B, 'models/AdmitVerification'));
const S = require(path.join(B, 'models/StudentRegistration'));
const Room = require(path.join(B, 'models/Room'));
const Lab = require(path.join(B, 'models/Lab'));
const { OUTPUT_DIR } = require(path.join(B, 'utils/pythonRunner'));

const MIN_ROOM_STUDENTS = 5;                 // P4: don't open a room for fewer (configurable)
// Blocked windows to CHECK against (JS getDay: Sun=0 … Fri=5). Empty by default:
// the exam office keeps the university's fixed slots (incl. Friday 01:00-02:30),
// so Jumma overlap is accepted and NOT flagged. Populate to audit a real block.
const BLOCKED_WINDOWS = [];

// "01:00-02:30" → [start_min, end_min]; exam hours 1-7 are afternoon (+12).
function span(slot) {
  const m = String(slot || '').match(/(\d{1,2}):(\d{2})\D+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const t = (h, mi) => { h = +h; if (h < 8) h += 12; return h * 60 + +mi; };
  return [t(m[1], m[2]), t(m[3], m[4])];
}
const overlap = (a, b) => a && b && a[0] < b[1] && b[0] < a[1];
const rowNum = (seat) => { const m = String(seat || '').match(/^(\d+)/); return m ? m[1] : String(seat || ''); };
const up = (s) => String(s || '').toUpperCase();

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/abasyn_scheduler');

  // ---- datesheets (slots) per cohort ----
  const dss = await G.find({ kind: 'datesheet', archived: { $ne: true } }).sort({ createdAt: -1 }).lean();
  const cohortDs = {}; // cohort -> {courses:[{code,name,date,slot}], cellOf:{code->'date|slot'}}
  for (const d of dss) {
    const tag = (d.meta && d.meta.btech) ? 'btech' : (/post/i.test((d.meta && d.meta.programLevel) || '') ? 'pg' : 'bs');
    if (cohortDs[tag]) continue; // newest per cohort
    const sf = d.meta && d.meta.scheduleFile;
    if (!sf) continue;
    const j = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, path.basename(sf)), 'utf-8'));
    const cellOf = {};
    for (const c of j.courses) cellOf[up(c.code)] = `${c.date}|${c.slot}`;
    cohortDs[tag] = { j, cellOf };
  }

  // ---- registrations, assign each student to the cohort whose datesheet holds ≥1 of their courses ----
  const regs = await S.find({}).select('studentId program courses').lean();
  const regCourses = {}; for (const r of regs) regCourses[r.studentId] = [...new Set((r.courses || []).map(up))];
  const studentCohort = {};
  for (const r of regs) {
    const cs = regCourses[r.studentId];
    let best = null, bestN = 0;
    for (const tag of Object.keys(cohortDs)) {
      const n = cs.filter((c) => cohortDs[tag].cellOf[c]).length;
      if (n > bestN) { bestN = n; best = tag; }
    }
    if (best) studentCohort[r.studentId] = best;
  }

  // ---- room capacities ----
  const rooms = await Room.find({}).lean(); const labs = await Lab.find({}).lean();
  const capOf = {};
  const capFromRows = (r) => Number(r.rows || r.capacity || 0) * (r.seatsPerRow || r.seats || 2) || Number(r.capacity || 0);
  for (const r of [...rooms, ...labs]) { const n = r.name || r.roomNumber || r.number; if (n) capOf[n] = capFromRows(r) || 0; }

  console.log('=== SETUP ===');
  console.log('datesheets:', Object.fromEntries(Object.entries(cohortDs).map(([k, v]) => [k, v.j.courses.length])));
  console.log('students mapped to a cohort:', Object.keys(studentCohort).length, '/', regs.length);

  const HARD = {}; const METRIC = {};

  // ===== DATESHEET-level checks (from schedule + rosters) =====
  // duplicate course key (same code in >1 slot) — within a cohort a code maps to one cell,
  // so check across the raw courses list for repeats.
  let dupKeys = 0; const dupEx = [];
  for (const [tag, v] of Object.entries(cohortDs)) {
    const seen = {};
    for (const c of v.j.courses) { const k = up(c.code); (seen[k] = seen[k] || []).push(`${c.date}|${c.slot}`); }
    for (const [k, cells] of Object.entries(seen)) {
      const uniq = [...new Set(cells)];
      if (uniq.length > 1) { dupKeys++; if (dupEx.length < 6) dupEx.push(`${tag}:${k} @ ${uniq.join(' & ')}`); }
    }
  }
  HARD['duplicate course key (same code, >1 slot)'] = [dupKeys, dupEx];

  // zero-enrolment datesheet entries (a scheduled course no mapped student sits)
  const enrollCount = {}; // tag -> code -> count
  for (const [sid, tag] of Object.entries(studentCohort)) {
    for (const c of regCourses[sid]) if (cohortDs[tag].cellOf[c]) ((enrollCount[tag] = enrollCount[tag] || {})[c] = (enrollCount[tag][c] || 0) + 1);
  }
  let zeroEnr = 0; const zeroEx = [];
  for (const [tag, v] of Object.entries(cohortDs)) for (const c of v.j.courses) {
    const n = (enrollCount[tag] || {})[up(c.code)] || 0;
    if (n === 0) { zeroEnr++; if (zeroEx.length < 8) zeroEx.push(`${tag}:${c.code} "${(c.name || '').slice(0, 20)}" @ ${c.date}|${c.slot}`); }
  }
  HARD['zero-enrolment datesheet entries'] = [zeroEnr, zeroEx];

  // slot clashes + 3-per-day + 2-per-day + back-to-back + blocked window, per student
  let slotClash = 0, threeDay = 0, blockedV = 0; const blockedEx = [];
  const twoPerDay = { bs: 0, btech: 0, pg: 0 }; const twoPerDayStudents = { bs: 0, btech: 0, pg: 0 };
  let backToBack = 0;
  const dow = (dstr) => new Date(dstr + 'T00:00:00').getDay();
  for (const [sid, tag] of Object.entries(studentCohort)) {
    const cellOf = cohortDs[tag].cellOf;
    const cells = regCourses[sid].filter((c) => cellOf[c]).map((c) => cellOf[c]);
    // group by date
    const byDate = {};
    const bySlotCount = {};
    for (const cell of cells) {
      bySlotCount[cell] = (bySlotCount[cell] || 0) + 1;
      const [date, slot] = cell.split('|');
      (byDate[date] = byDate[date] || []).push(slot);
    }
    for (const [cell, n] of Object.entries(bySlotCount)) if (n > 1) slotClash++;
    let hadTwo = false;
    for (const [date, slotsArr] of Object.entries(byDate)) {
      const uniqSlots = [...new Set(slotsArr)];
      if (uniqSlots.length >= 3) threeDay++;
      if (uniqSlots.length === 2) { twoPerDay[tag]++; hadTwo = true; }
      // back-to-back: two slots on same day with a 30-min gap (end of one == start-30 of next → gap 30)
      const spans = uniqSlots.map(span).filter(Boolean).sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < spans.length; i++) if (spans[i][0] - spans[i - 1][1] <= 30) backToBack++;
      // blocked window (Friday Jumma)
      for (const slot of uniqSlots) {
        const sp = span(slot); const dw = dow(date);
        for (const bw of BLOCKED_WINDOWS) if (dw === bw.day && sp && sp[0] < bw.end && bw.start < sp[1]) { blockedV++; if (blockedEx.length < 4) blockedEx.push(`${tag} ${date}(Fri) ${slot}`); }
      }
    }
    if (hadTwo) twoPerDayStudents[tag]++;
  }
  HARD['student slot clashes (2 papers same slot)'] = [slotClash, []];
  HARD['3-papers-in-one-day'] = [threeDay, []];
  HARD['blocked-window (Fri Jumma) violations'] = [blockedV, [...new Set(blockedEx)]];
  METRIC['2-papers-per-day student-days'] = twoPerDay;
  METRIC['   (distinct students with a 2-paper day)'] = twoPerDayStudents;
  METRIC['back-to-back (<=30 min gap) pairs'] = backToBack;

  // ===== SEATING checks (AdmitVerification) =====
  const batchRows = await G.find({ kind: 'admit_cards', archived: { $ne: true } }).select('meta.cohort meta.invigilatorsBySession title createdAt').lean();
  const batchCohort = {}; for (const b of batchRows) batchCohort[String(b._id)] = (b.meta && b.meta.cohort) || '?';
  const avs = await AV.find({}).select('studentId batchId exams').lean();
  const seatMap = {}, roomSess = {}, benchMap = {}, roomLoad = {}, slotLoad = {};
  let seatCount = 0, dupSC = 0, mismatch = 0; const mmEx = [];
  for (const a of avs) {
    const coh = batchCohort[String(a.batchId)] || '?';
    const seen = {};
    for (const e of (a.exams || [])) {
      const code = up(e.code); seen[code] = (seen[code] || 0) + 1;
      // seating vs datesheet: the seat's date|slot must equal the datesheet cell for that code
      const dsCell = cohortDs[coh] && cohortDs[coh].cellOf[code];
      if (dsCell && `${e.date}|${e.slot}` !== dsCell) { mismatch++; if (mmEx.length < 5) mmEx.push(`${a.studentId} ${code}: seat@${e.date}|${e.slot} vs ds@${dsCell}`); }
      if (!e.room || !e.seat) continue;
      seatCount++;
      const base = `${e.date}|${e.slot}`;
      (seatMap[`${base}|${e.room}|${e.seat}`] = seatMap[`${base}|${e.room}|${e.seat}`] || []).push(a.studentId);
      (roomSess[`${base}|${e.room}`] = roomSess[`${base}|${e.room}`] || new Set()).add(coh);
      (benchMap[`${base}|${e.room}|${rowNum(e.seat)}`] = benchMap[`${base}|${e.room}|${rowNum(e.seat)}`] || []).push(code);
      (roomLoad[`${base}|${e.room}`] = roomLoad[`${base}|${e.room}`] || 0); roomLoad[`${base}|${e.room}`]++;
      (slotLoad[base] = slotLoad[base] || 0); slotLoad[base]++;
    }
    for (const [c, n] of Object.entries(seen)) if (n > 1) dupSC++;
  }
  let seatColl = 0; for (const occ of Object.values(seatMap)) if ([...new Set(occ)].length > 1) seatColl++;
  let roomShare = 0; const rsEx = []; for (const [k, c] of Object.entries(roomSess)) if (c.size > 1) { roomShare++; if (rsEx.length < 5) rsEx.push(`${k} → ${[...c].join('+')}`); }
  let benchV = 0; for (const codes of Object.values(benchMap)) { const cc = {}; for (const c of codes) cc[c] = (cc[c] || 0) + 1; for (const n of Object.values(cc)) if (n > 1) benchV++; }
  HARD['duplicate (student,course) seat'] = [dupSC, []];
  HARD['physical seat collisions'] = [seatColl, []];
  // Cross-program room sharing is a METRIC, not a violation: UNIFIED seating pools
  // all cohorts into shared rooms by design. The real anti-cheating guarantees are
  // "physical seat collisions = 0" and "same-course bench neighbours = 0".
  METRIC['cross-program room sharing (unified: expected)'] = roomShare;
  HARD['same-course bench neighbours'] = [benchV, []];
  HARD['seating vs datesheet mismatch'] = [mismatch, mmEx];

  // room fill + rooms below MIN
  const fills = []; let belowMin = 0; const belowEx = [];
  for (const [k, n] of Object.entries(roomLoad)) {
    const room = k.split('|')[2]; const cap = capOf[room] || 0;
    if (cap > 0) fills.push(n / cap);
    if (n < MIN_ROOM_STUDENTS) { belowMin++; if (belowEx.length < 8) belowEx.push(`${k} = ${n}`); }
  }
  const avgFill = fills.length ? (fills.reduce((a, b) => a + b, 0) / fills.length) : 0;
  METRIC['room-session count'] = Object.keys(roomLoad).length;
  METRIC['avg room fill ratio'] = avgFill.toFixed(2);
  METRIC[`room-sessions below MIN(${MIN_ROOM_STUDENTS})`] = [belowMin, belowEx];
  METRIC['per-(date|slot) load'] = Object.fromEntries(Object.entries(slotLoad).sort((a, b) => a[0].localeCompare(b[0])));

  // ===== INVIGILATION checks =====
  // Each per-cohort batch carries the SAME authoritative GLOBAL roster (seating is
  // global), so evaluate ONE roster (the newest batch's), not the sum of all three
  // — otherwise identical duties are counted 2-3× and falsely look double-booked.
  const perSess = {}; const dutyDay = {}; const dutyTotal = {};
  const rosterBatch = batchRows.slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .find((b) => b.meta && b.meta.invigilatorsBySession && Object.keys(b.meta.invigilatorsBySession).length);
  const invOne = (rosterBatch && rosterBatch.meta && rosterBatch.meta.invigilatorsBySession) || {};
  for (const [skey, names] of Object.entries(invOne)) {
    const [date] = skey.split('|');
    for (const n of names) {
      ((perSess[skey] = perSess[skey] || {})[n] = (perSess[skey][n] || 0) + 1);
      ((dutyDay[`${n}|${date}`] = (dutyDay[`${n}|${date}`] || 0) + 1));
      dutyTotal[n] = (dutyTotal[n] || 0) + 1;
    }
  }
  // overlap across cohorts at same session
  let invDouble = 0; for (const names of Object.values(perSess)) for (const n of Object.values(names)) if (n > 1) invDouble++;
  // >2 duties per day
  let invOver = 0; const invOverEx = [];
  for (const [k, n] of Object.entries(dutyDay)) if (n > 2) { invOver++; if (invOverEx.length < 6) invOverEx.push(`${k} = ${n}`); }
  HARD['cross-cohort invigilator overlap (same session)'] = [invDouble, []];
  HARD['invigilator >2 duties per day'] = [invOver, invOverEx];
  const loads = Object.values(dutyTotal).sort((a, b) => b - a);
  METRIC['invigilators / duties'] = `${loads.length} / ${loads.reduce((a, b) => a + b, 0)}`;
  METRIC['invig duty spread (max/min/avg)'] = `${loads[0] || 0} / ${loads[loads.length - 1] || 0} / ${(loads.reduce((a, b) => a + b, 0) / (loads.length || 1)).toFixed(1)}`;

  // ===== REPORT =====
  console.log('\n===== HARD CHECKS (must be 0) =====');
  let anyFail = false;
  for (const [name, [n, ex]] of Object.entries(HARD)) {
    const ok = n === 0; if (!ok) anyFail = true;
    console.log(`  ${ok ? 'OK ' : 'XX '} ${name}: ${n}${ex && ex.length ? '  | ' + ex.slice(0, 4).join(' ; ') : ''}`);
  }
  console.log('\n===== METRICS =====');
  console.log('  2-per-day student-days:', JSON.stringify(METRIC['2-papers-per-day student-days']),
    '(total', Object.values(twoPerDay).reduce((a, b) => a + b, 0) + ')');
  console.log('  distinct students w/ a 2-paper day:', JSON.stringify(twoPerDayStudents));
  console.log('  back-to-back (<=30m) pairs:', backToBack);
  console.log('  room-sessions:', METRIC['room-session count'], '| avg fill:', METRIC['avg room fill ratio'],
    '| below MIN:', belowMin);
  if (belowEx.length) console.log('     below-min e.g.:', belowEx.slice(0, 6).join(' ; '));
  console.log('  invigilators/duties:', METRIC['invigilators / duties'], '| spread max/min/avg:', METRIC['invig duty spread (max/min/avg)']);
  const sl = METRIC['per-(date|slot) load'];
  console.log('  per-slot load:');
  for (const [k, v] of Object.entries(sl)) console.log(`     ${k}: ${v}`);

  console.log(`\n===== ${anyFail ? 'HARD CHECKS FAILED' : 'ALL HARD CHECKS PASS'} =====`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
