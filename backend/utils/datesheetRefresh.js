/**
 * datesheetRefresh.js — bring an EXISTING datesheet up to date with new registration
 * data WITHOUT regenerating it:
 *
 *   • every paper keeps its date + slot, every merge stays exactly as it is
 *   • students are recomputed from the current registrations (new students included,
 *     removed batches left out)
 *   • a code nobody is registered in any more is taken off the sheet
 *   • a THEORY course that students are registered in but has no paper anywhere in
 *     this cohort (not on this sheet, not on a sibling sheet, not removed / no-exam)
 *     is ADDED in a clash-free cell (B.Tech / MS column rules, MS reserve column and
 *     light days respected, per-day limit kept, least-loaded cell preferred)
 *   • if the new students create a clash between two existing papers, the smaller
 *     paper (its whole merge group) is moved to a clash-free cell
 *   • anything that cannot be placed clash-free is reported, never forced in
 *
 * planRefresh() is pure (no DB) so it can be tested on its own; refreshDatesheet()
 * loads the record, plans, re-renders through datesheet.py --render and replaces the
 * datesheet's files (same as a save from the datesheet editor).
 */
const fs = require('fs');
const path = require('path');

const up = (x) => String(x || '').trim().toUpperCase();

// "01:00-02:30" → [780, 870] minutes (exam clock hours 1-7 are afternoon)
function span(label) {
  const m = String(label || '').match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const t = (h, mm) => { h = Number(h); if (h < 8) h += 12; return h * 60 + Number(mm); };
  return [t(m[1], m[2]), t(m[3], m[4])];
}
const overlaps = (a, b) => !!(a && b && a[0] < b[1] && b[0] < a[1]);

/**
 * @param o.courses     [{code,name,group,d,s}]  current sheet (editor form)
 * @param o.dates       ['YYYY-MM-DD', …]
 * @param o.slots       ['09:00-10:30', …]
 * @param o.allowed     per day: slot indexes that day may use
 * @param o.reserve     per day: slot indexes used only as a last resort
 * @param o.lightDays   Set of weekday numbers (0=Mon … 6=Sun) to keep light (MS)
 * @param o.byCode      Map code → [sid]   (this cohort, removed batches left out)
 * @param o.external    [{code,date,slot}] same-cohort papers on sibling sheets
 * @param o.excluded    Set of codes removed from this sheet / no paper (snapshot)
 * @param o.noExam      Set of codes that never get a paper (labs, FYP, thesis, DB no-exam)
 * @param o.maxPerDay   preferred max papers per student per day (fallback: 2)
 * @param o.names       { code: title }
 * @param o.occupancy   Map 'date|slot' → students already seated by OTHER sheets (all cohorts)
 * @param o.capacity    seats per sitting (0/undefined = unknown → only balance)
 */
function planRefresh(o) {
  const { dates, slots } = o;
  const allowed = o.allowed || dates.map(() => slots.map((_, i) => i));
  const reserve = o.reserve || dates.map(() => []);
  const light = o.lightDays || new Set();
  const byCode = o.byCode;
  const maxPerDay = Math.max(1, Number(o.maxPerDay) || 1);
  const names = o.names || {};
  const capacity = Number(o.capacity) || 0;
  const occ = o.occupancy || new Map();
  const spans = slots.map(span);
  const weekdayOf = dates.map((iso) => (new Date(`${iso}T00:00:00`).getDay() + 6) % 7);   // 0=Mon
  const dIndex = new Map(dates.map((iso, i) => [iso, i]));

  const report = { kept: 0, dropped: [], added: [], moved: [], unplaced: [], clashesBefore: 0, clashesAfter: 0, studentsBefore: 0, studentsAfter: 0, newStudents: 0 };

  // ── units (merge groups) ──
  const units = new Map();      // key → {key, codes:[], d, s, sids:Set}
  for (const c of o.courses) {
    const code = up(c.code);
    const n = (byCode.get(code) || []).length;
    if (!n) { report.dropped.push({ code, name: c.name || names[code] || '', group: c.group, date: dates[c.d], slot: slots[c.s] }); continue; }
    const key = String(c.group || code);
    if (!units.has(key)) units.set(key, { key, codes: [], names: {}, d: c.d, s: c.s, sids: new Set() });
    const u = units.get(key);
    u.codes.push(code);
    u.names[code] = c.name || names[code] || '';
    for (const sid of byCode.get(code)) u.sids.add(sid);
    report.kept++;
  }

  // ── every student's sittings ──
  const sit = new Map();        // sid → [{d, s, key}]   (s = -1 for external with own span)
  const add = (sid, it) => { if (!sit.has(sid)) sit.set(sid, []); sit.get(sid).push(it); };
  for (const u of units.values()) for (const sid of u.sids) add(sid, { d: u.d, sp: spans[u.s], key: u.key });
  for (const e of o.external || []) {
    const d = dIndex.has(e.date) ? dIndex.get(e.date) : null;
    for (const sid of byCode.get(up(e.code)) || []) add(sid, { d, date: e.date, sp: span(e.slot), key: `ext|${up(e.code)}`, ext: true });
  }
  const removeUnit = (u) => { for (const sid of u.sids) { const l = sit.get(sid); if (l) sit.set(sid, l.filter((x) => x.key !== u.key)); } };
  const putUnit = (u) => { for (const sid of u.sids) add(sid, { d: u.d, sp: spans[u.s], key: u.key }); };

  // cell load (students of THIS sheet in a cell) + other sheets' occupancy
  const cellLoad = new Map();
  const ck = (d, s) => `${d}|${s}`;
  const bump = (u, k) => cellLoad.set(ck(u.d, u.s), (cellLoad.get(ck(u.d, u.s)) || 0) + k * u.sids.size);
  for (const u of units.values()) bump(u, 1);
  const seated = (d, s) => (cellLoad.get(ck(d, s)) || 0) + (occ.get(`${dates[d]}|${slots[s]}`) || 0);

  /** students of `sids` that would clash / exceed `limit` papers that day at (d, s) */
  function cost(sids, d, s, limit, ignoreKey) {
    let clash = 0; let over = 0; let sameDay = 0;
    const sp = spans[s];
    for (const sid of sids) {
      const l = sit.get(sid) || [];
      let today = 0;
      for (const x of l) {
        if (x.key === ignoreKey) continue;
        const xd = x.d;
        if (xd !== d) continue;
        today++;
        if (overlaps(x.sp, sp)) clash++;
      }
      if (today) sameDay++;
      if (today + 1 > limit) over++;
    }
    return { clash, over, sameDay };
  }

  /** best clash-free cell for a set of students, or null */
  function bestCell(sids, ignoreKey) {
    const n = sids.size;
    for (const limit of [maxPerDay, 2]) {
      for (const pass of ['normal', 'light', 'reserve']) {
        let best = null;
        for (let d = 0; d < dates.length; d++) {
          const isLight = light.has(weekdayOf[d]);
          for (const s of allowed[d] || []) {
            const isRes = (reserve[d] || []).includes(s);
            if (pass === 'normal' && (isRes || isLight)) continue;
            if (pass === 'light' && (isRes || !isLight)) continue;
            if (pass === 'reserve' && !isRes) continue;
            if (capacity && seated(d, s) + n > capacity) continue;
            const c = cost(sids, d, s, limit, ignoreKey);
            if (c.clash || c.over) continue;
            // fewest students already sitting a paper that day, then the emptiest cell
            const score = c.sameDay * 1000 + seated(d, s);
            if (!best || score < best.score) best = { d, s, score, sameDay: c.sameDay };
          }
        }
        if (best) return { ...best, limit, pass };
      }
    }
    return null;
  }

  /** units (of this sheet) whose students clash with `sids` at (d, s) */
  function blockers(sids, d, s, limit, ignoreKey) {
    const keys = new Set();
    let externalBlock = false;
    const sp = spans[s];
    for (const sid of sids) {
      const l = (sit.get(sid) || []).filter((x) => x.key !== ignoreKey && x.d === d);
      const hits = l.filter((x) => overlaps(x.sp, sp));
      for (const x of hits) { if (x.ext) externalBlock = true; else keys.add(x.key); }
      if (l.length + 1 > limit) for (const x of l) { if (x.ext) externalBlock = true; else keys.add(x.key); }
    }
    return externalBlock ? null : [...keys];
  }

  /**
   * Ejection move: put unit `u` at a cell where it clashes only with a few small
   * units, and move each of those to its own clash-free cell. All-or-nothing.
   */
  function ejectMove(u) {
    const tries = [];
    for (const limit of [maxPerDay, 2]) {
      for (let d = 0; d < dates.length; d++) for (const s of allowed[d] || []) {
        if (d === u.d && s === u.s) continue;
        if ((reserve[d] || []).includes(s) && limit === maxPerDay) continue;
        const b = blockers(u.sids, d, s, limit, u.key);
        if (!b || !b.length || b.length > 2) continue;
        const moved = b.reduce((n, k) => n + units.get(k).sids.size, 0);
        if (moved >= u.sids.size * 3 && moved > 40) continue;   // never shove big papers around
        tries.push({ d, s, b, limit, moved });
      }
      if (tries.length) break;
    }
    tries.sort((x, y) => x.b.length - y.b.length || x.moved - y.moved);
    for (const t of tries.slice(0, 40)) {
      // tentatively place u, then re-home every blocker
      const save = [u, ...t.b.map((k) => units.get(k))].map((x) => ({ x, d: x.d, s: x.s }));
      removeUnit(u); bump(u, -1);
      u.d = t.d; u.s = t.s; putUnit(u); bump(u, 1);
      const done = [];
      let ok = true;
      for (const k of t.b) {
        const v = units.get(k);
        removeUnit(v); bump(v, -1);
        const cell = bestCell(v.sids, v.key);
        if (!cell) { putUnit(v); bump(v, 1); ok = false; break; }
        const from = { date: dates[v.d], slot: slots[v.s] };
        v.d = cell.d; v.s = cell.s; putUnit(v); bump(v, 1);
        done.push({ v, from });
      }
      if (ok && !cost(u.sids, u.d, u.s, t.limit, u.key).clash) {
        for (const { v, from } of done) report.moved.push({ codes: v.codes, students: v.sids.size, from, to: { date: dates[v.d], slot: slots[v.s] }, reason: `made room for ${u.codes.join('/')}` });
        return true;
      }
      // roll back
      for (const { x, d, s } of save) { removeUnit(x); bump(x, -1); x.d = d; x.s = s; putUnit(x); bump(x, 1); }
    }
    return false;
  }

  function clashList() {
    const out = [];
    const seen = new Set();
    for (const [sid, l] of sit) {
      for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) {
        const a = l[i], b = l[j];
        if (a.key === b.key || (a.ext && b.ext)) continue;
        const sameDay = a.d != null && b.d != null ? a.d === b.d : (a.date || dates[a.d]) === (b.date || dates[b.d]);
        if (sameDay && overlaps(a.sp, b.sp)) {
          out.push({ sid, a: a.key, b: b.key });
          seen.add(sid);
        }
      }
    }
    return out;
  }

  report.studentsBefore = new Set([].concat(...o.courses.map((c) => (o.prevByCode && o.prevByCode.get(up(c.code))) || []))).size;
  const before = clashList();
  report.clashesBefore = before.length;

  // ── papers sitting in a column their day may not use any more (e.g. BS Friday
  //    01:00-02:30 → 03:00-04:30): same day, nearest allowed time, clash-free ──
  for (const u of [...units.values()]) {
    if ((allowed[u.d] || []).includes(u.s)) continue;
    const from = { date: dates[u.d], slot: slots[u.s] };
    const fromSp = spans[u.s] || [0, 0];
    // nearest allowed time that day; on a tie the LATER one (BS Friday 01:00 → 03:00, not 11:00)
    const st = (i) => (spans[i] || [0])[0];
    const sameDay = [...(allowed[u.d] || [])].sort((a, b) => Math.abs(st(a) - fromSp[0]) - Math.abs(st(b) - fromSp[0]) || st(b) - st(a));
    bump(u, -1);
    let target = null;
    for (const s2 of sameDay) {
      const c = cost(u.sids, u.d, s2, 99, u.key);
      if (!c.clash && !(capacity && seated(u.d, s2) + u.sids.size > capacity)) { target = { d: u.d, s: s2 }; break; }
    }
    if (!target) { const c2 = bestCell(u.sids, u.key); if (c2) target = { d: c2.d, s: c2.s }; }
    if (!target) { bump(u, 1); report.unplaced.push({ code: u.codes.join('/'), name: '', students: u.sids.size, reason: `${from.date} ${from.slot} is not allowed and no clash-free slot was found` }); continue; }
    removeUnit(u);
    u.d = target.d; u.s = target.s;
    putUnit(u);
    bump(u, 1);
    report.moved.push({ codes: u.codes, students: u.sids.size, from, to: { date: dates[u.d], slot: slots[u.s] }, reason: o.ruleNote || 'slot rule for that day' });
  }

  // ── repair clashes caused by the new data: move the smaller unit ──
  for (let round = 0; round < 50; round++) {
    const cl = clashList();
    if (!cl.length) break;
    // the unit involved in most clashes (never an external paper), smallest first on ties
    const hits = new Map();
    for (const c of cl) for (const k of [c.a, c.b]) if (!k.startsWith('ext|')) hits.set(k, (hits.get(k) || 0) + 1);
    const order = [...hits.keys()].sort((x, y) => hits.get(y) - hits.get(x) || units.get(x).sids.size - units.get(y).sids.size);
    let movedOne = false;
    for (const k of order) {
      const u = units.get(k);
      const from = { date: dates[u.d], slot: slots[u.s] };
      bump(u, -1);
      const cell = bestCell(u.sids, u.key);
      if (!cell) {
        bump(u, 1);
        if (ejectMove(u)) {
          report.moved.push({ codes: u.codes, students: u.sids.size, from, to: { date: dates[u.d], slot: slots[u.s] }, reason: 'new registrations created a clash' });
          movedOne = true;
          break;
        }
        continue;
      }
      removeUnit(u);
      u.d = cell.d; u.s = cell.s;
      putUnit(u);
      bump(u, 1);
      report.moved.push({ codes: u.codes, students: u.sids.size, from, to: { date: dates[u.d], slot: slots[u.s] }, reason: 'new registrations created a clash' });
      movedOne = true;
      break;
    }
    if (!movedOne) break;
  }

  // ── add the missing theory courses ──
  const onSheet = new Set([...units.values()].flatMap((u) => u.codes));
  const elsewhere = new Set((o.external || []).map((e) => up(e.code)));
  const cands = [...byCode.keys()].map(up)
    .filter((c) => !onSheet.has(c) && !elsewhere.has(c) && !(o.excluded || new Set()).has(c) && !(o.noExam || new Set()).has(c))
    .sort((a, b) => (byCode.get(b) || []).length - (byCode.get(a) || []).length || a.localeCompare(b));
  for (const code of cands) {
    const sids = new Set(byCode.get(code) || []);
    if (!sids.size) continue;
    let cell = bestCell(sids, null);
    if (!cell) {
      const u0 = { key: code, codes: [code], names: { [code]: names[code] || '' }, d: -1, s: -1, sids };
      units.set(code, u0);
      // park it nowhere, then try an ejection move into the grid
      if (ejectMove(u0)) { report.added.push({ code, name: names[code] || '', students: sids.size, date: dates[u0.d], slot: slots[u0.s], note: 'other papers moved to make room' }); continue; }
      removeUnit(u0);
      units.delete(code);
      report.unplaced.push({ code, name: names[code] || '', students: sids.size, reason: 'no clash-free slot left in the exam window' });
      continue;
    }
    const u = { key: code, codes: [code], names: { [code]: names[code] || '' }, d: cell.d, s: cell.s, sids };
    units.set(code, u);
    putUnit(u);
    bump(u, 1);
    report.added.push({ code, name: names[code] || '', students: sids.size, date: dates[u.d], slot: slots[u.s], note: cell.limit > maxPerDay ? `${cell.limit} papers that day for some students` : (cell.pass !== 'normal' ? `${cell.pass} slot` : '') });
  }

  const after = clashList();
  report.clashesAfter = after.length;
  report.clashSamples = after.slice(0, 20);
  report.studentsAfter = new Set([...units.values()].flatMap((u) => [...u.sids])).size;

  const courses = [];
  for (const u of units.values()) for (const code of u.codes) {
    courses.push({ code, name: u.names[code] || names[code] || code, group: u.key, d: u.d, s: u.s });
  }
  return { courses, report };
}

/* ───────────────────────── DB wrapper ───────────────────────── */

const intakeOf = (b) => { const m = String(b || '').match(/\b(spring|summer|fall|winter)\s*[-']?\s*(\d{4})\b/i); return m ? `${m[1].toLowerCase()} ${m[2]}` : ''; };
const bkey = (b) => String(b || '').trim().replace(/\s+/g, ' ').toLowerCase();

async function newBatchesOfExcludedIntakes(cohort, excludeBatches, prevByCode, cohortOfProgram) {
  // BS and B.Tech are one undergraduate intake (the 1st-semester "Fall 2026" removal covers both)
  const level = (c) => (c === 'pg' ? 'pg' : 'ug');
  const intakes = new Set(excludeBatches.filter((b) => level(cohortOfProgram(b)) === level(cohort)).map(intakeOf).filter(Boolean));
  if (!intakes.size) return [];
  const StudentRegistration = require('../models/StudentRegistration');
  const regs = await StudentRegistration.find({ studentId: { $ne: '' } }).select('studentId program batch').lean();
  const prev = new Set([].concat(...[...prevByCode.values()]));
  const have = new Set(excludeBatches.map(bkey));
  const seenBefore = new Set();
  const candidates = new Map();
  for (const r of regs) {
    const b = r.batch || r.program;
    if (cohortOfProgram(r.program || r.batch) !== cohort || have.has(bkey(b)) || !intakes.has(intakeOf(b))) continue;
    if (prev.has(String(r.studentId))) seenBefore.add(bkey(b));
    candidates.set(bkey(b), b);
  }
  return [...candidates.entries()].filter(([k]) => !seenBefore.has(k)).map(([, b]) => b).sort();
}

async function noExamSet(cohortExportPath) {
  const { runPython, OUTPUT_DIR } = require('./pythonRunner');
  const Course = require('../models/Course');
  const codesPath = path.join(OUTPUT_DIR, `noexam_codes_${Date.now()}.json`);
  fs.writeFileSync(codesPath, JSON.stringify((await Course.distinct('code', { noExam: true })).map(up)));
  try {
    const { code, stdout } = await runPython('-m', ['exam_engine.no_exam', 'auto', '--data', cohortExportPath, '--db-no-exam', codesPath], { timeoutMs: 120000 });
    const r = JSON.parse(String(stdout || '').trim().split('\n').filter(Boolean).pop() || '{}');
    if (code !== 0 || r.status !== 'ok') throw new Error(r.error || 'no-exam check failed');
    return new Set((r.items || []).map((x) => up(x.code)));
  } finally {
    try { fs.unlinkSync(codesPath); } catch { /* ignore */ }
  }
}

/** students seated per 'date|slot' by every OTHER active datesheet (all cohorts) */
function occupancyFromOthers(others, OUTPUT_DIR) {
  const occ = new Map();
  for (const o of others) {
    const sf = o.meta && o.meta.scheduleFile; const p = sf ? path.join(OUTPUT_DIR, path.basename(sf)) : null;
    if (!p || !fs.existsSync(p)) continue;
    try {
      const sn = JSON.parse(fs.readFileSync(p, 'utf-8'));
      const cell = new Map();
      for (const c of sn.courses || []) {
        const k = `${c.date}|${c.slot}`;
        if (!cell.has(k)) cell.set(k, new Set());
        for (const s of c.students || []) cell.get(k).add(String(s));
      }
      for (const [k, set] of cell) occ.set(k, (occ.get(k) || 0) + set.size);
    } catch { /* skip */ }
  }
  return occ;
}

async function examSeatCapacity() {
  try {
    const Room = require('../models/Room');
    const Lab = require('../models/Lab');
    const [rooms, labs] = await Promise.all([Room.find({ active: true, examVenue: true }).lean(), Lab.find({ active: true, examVenue: true }).lean()]);
    return [...rooms, ...labs].reduce((n, r) => n + (Number(r.examCapacity) || Number(r.capacity) || 0), 0);
  } catch { return 0; }
}

/**
 * Refresh one datesheet record in place. Returns { record, report }.
 * `opts.dryRun` → plan only, nothing written.
 */
async function refreshDatesheet(id, opts = {}) {
  const GeneratedFile = require('../models/GeneratedFile');
  const ed = require('../controllers/datesheetEditorController')._internals;
  const { OUTPUT_DIR, SCHEDULER_DIR, runPython, fileSize, exportDatabaseToJson } = require('./pythonRunner');
  const { rec, snap } = await ed.loadRecord(id);
  const cohort = ed.datesheetCohort(rec);
  const dates = snap.dates || [];
  const { slots, allowed, reserve } = ed.gridFor(cohort, snap.slots || [], dates);
  const courses = ed.snapToCourses(snap, slots);
  const prevByCode = new Map((snap.courses || []).map((c) => [up(c.code), (c.students || []).map(String)]));
  const excludeBatches = [...((rec.meta && (rec.meta.excludeBatches || (rec.meta.config && rec.meta.config.excludeBatches))) || [])];
  // A removed intake (e.g. "Fall 2026") stays removed: a batch of that intake that
  // did not exist when the sheet was made (new program name in the new report, e.g.
  // "BS Vision Sciences Fall 2026") is removed too, so its courses aren't added.
  const autoExcluded = await newBatchesOfExcludedIntakes(cohort, excludeBatches, prevByCode, ed.cohortOfProgram);
  excludeBatches.push(...autoExcluded);
  const { byCode } = await ed.studentsFor(cohort, excludeBatches);
  const external = await ed.externalPapers(rec, cohort);

  // no-exam rules run on the whole export (titles of every course → lab twins etc.)
  const { exportPath } = await exportDatabaseToJson();
  let noExam;
  try { noExam = await noExamSet(exportPath); } finally { try { fs.unlinkSync(exportPath); } catch { /* ignore */ } }

  const names = {};
  try {
    const Course = require('../models/Course');
    for (const c of await Course.find({ code: { $in: [...byCode.keys()] } }).select('code name').lean()) { const k = up(c.code); if (!names[k] && c.name) names[k] = c.name; }
  } catch { /* cosmetic */ }
  for (const c of snap.courses || []) names[up(c.code)] = c.name || names[up(c.code)] || '';

  const others = await GeneratedFile.find({ kind: 'datesheet', archived: { $ne: true }, _id: { $ne: rec._id } }).lean();
  const cfg = (rec.meta && rec.meta.config) || {};
  const plan = planRefresh({
    courses, dates, slots, allowed, reserve,
    lightDays: cohort === 'pg' ? new Set([0, 1, 2, 3]) : new Set(),
    byCode, prevByCode, external,
    excluded: new Set((snap.excluded_codes || []).map(up)),
    noExam,
    maxPerDay: cfg.maxPerDay || (rec.meta && rec.meta.maxPerDay) || 1,
    names,
    ruleNote: cohort === 'bs' ? 'BS Friday rule: 01:00-02:30 → 03:00-04:30' : undefined,
    occupancy: occupancyFromOthers(others, OUTPUT_DIR),
    capacity: opts.capacity != null ? opts.capacity : await examSeatCapacity(),
  });
  const { report } = plan;
  // previous students vs now
  const prevAll = new Set([].concat(...[...prevByCode.values()]));
  const nowAll = new Set([].concat(...plan.courses.map((c) => byCode.get(c.code) || [])));
  report.studentsBefore = prevAll.size;
  report.studentsAfter = nowAll.size;
  report.newStudents = [...nowAll].filter((s) => !prevAll.has(s)).length;
  report.goneStudents = [...prevAll].filter((s) => !nowAll.has(s)).length;
  report.title = rec.title;
  report.cohort = cohort;
  report.autoExcludedBatches = autoExcluded;
  if (opts.dryRun) return { record: rec, report };
  if (report.clashesAfter) {
    // never save a sheet with a clash — the Exam Cell fixes the rest in the editor
    report.saved = false;
    report.error = `${report.clashesAfter} clash(es) could not be fixed automatically — open the datesheet editor.`;
    return { record: rec, report };
  }

  // write the refreshed snapshot → render (no re-scheduling) → replace the old files
  const edited = {
    ...snap,
    slots,
    courses: plan.courses.map((c) => ({
      code: c.code, name: c.name, date: dates[c.d], day_index: c.d, slot_index: c.s, slot: slots[c.s], group: c.group,
      students: byCode.get(c.code) || [],
    })),
    // + no-paper courses (labs / FYP / thesis …) the students now take, so the
    //   auditor and the admit cards know they are intentionally not on the sheet
    excluded_codes: [...new Set([...(snap.excluded_codes || []).map(up), ...report.dropped.map((x) => x.code),
      ...[...byCode.keys()].map(up).filter((c) => noExam.has(c))])].filter((x) => !plan.courses.some((c) => c.code === x)).sort(),
  };
  const stamp = Date.now();
  const label = rec.examType === 'mids' ? 'Mids' : 'Finals';
  const tmpSnap = path.join(OUTPUT_DIR, `dsrefresh_${stamp}.json`);
  fs.writeFileSync(tmpSnap, JSON.stringify(edited));
  const pdfName = `Datesheet_${label}_${stamp}_updated.pdf`;
  const newPdf = path.join(OUTPUT_DIR, pdfName);
  const cfgPath = path.join(OUTPUT_DIR, `dsrefreshcfg_${stamp}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify({ schedule_json: tmpSnap, out: newPdf, drop_empty_slots: cohort === 'pg' }));
  try {
    const { code, stdout, stderr } = await runPython(path.join(SCHEDULER_DIR, 'datesheet.py'), ['--render', cfgPath], { timeoutMs: 5 * 60 * 1000 });
    let result = {};
    try { result = JSON.parse(String(stdout || '').trim().split('\n').filter(Boolean).pop() || '{}'); } catch { result = {}; }
    if (code !== 0 || result.status !== 'ok' || !fs.existsSync(newPdf)) throw new Error(result.error || `Could not render the updated datesheet. ${String(stderr || '').slice(-300)}`);
    const oldFiles = [...(rec.files || []).map((f) => f.filename), rec.meta && rec.meta.scheduleFile].filter(Boolean);
    rec.files = [{ label: 'Datesheet PDF', filename: pdfName, format: 'pdf', sizeBytes: fileSize(newPdf) }];
    rec.summary = { ...(rec.summary || {}), courses: result.total_courses, papers: result.total_papers, days: result.total_days, studentClashes: result.student_clashes || 0 };
    const log = Array.isArray(rec.meta && rec.meta.editLog) ? rec.meta.editLog : [];
    log.push({ at: new Date().toISOString(), papers: result.total_papers, removed: report.dropped.map((x) => x.code),
      added: report.added.map((x) => x.code), moved: report.moved.map((x) => x.codes.join('/')), note: opts.note || 'Updated with new registration data' });
    rec.meta = { ...(rec.meta || {}), ...(autoExcluded.length ? { excludeBatches } : {}), scheduleFile: path.basename(result.schedule_file), editedAt: new Date().toISOString(), refreshedAt: new Date().toISOString(), lastRefresh: report, editLog: log.slice(-50) };
    rec.markModified('meta'); rec.markModified('files');
    await rec.save();
    for (const f of oldFiles) {
      const p = path.join(OUTPUT_DIR, path.basename(f));
      if (p !== newPdf && fs.existsSync(p)) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
    }
    report.saved = true;
    report.studentClashes = result.student_clashes || 0;
  } finally {
    try { fs.unlinkSync(cfgPath); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpSnap); } catch { /* ignore */ }
  }
  try {
    const { logActivity } = require('./logger');
    await logActivity('generate.datesheet.refresh', `Datesheet updated with new data: ${rec.title} — +${report.added.length} added, ${report.moved.length} moved, ${report.dropped.length} removed${report.unplaced.length ? `, ${report.unplaced.length} could not be placed` : ''}`, report.unplaced.length ? 'warning' : 'success');
  } catch { /* optional */ }
  return { record: rec, report };
}

/** Refresh every active datesheet (one cohort at a time, so siblings see each other's additions). */
async function refreshAllDatesheets(opts = {}) {
  const GeneratedFile = require('../models/GeneratedFile');
  const recs = await GeneratedFile.find({ kind: 'datesheet', archived: { $ne: true } }).sort({ createdAt: 1 }).select('_id title').lean();
  const out = [];
  for (const r of recs) {
    try { out.push((await refreshDatesheet(r._id, opts)).report); } catch (e) { out.push({ title: r.title, error: e.message, saved: false }); }
  }
  return out;
}

/**
 * Re-render EVERY datesheet PDF (active and archived) from its saved schedule, with
 * no change to any paper — used to switch the existing sheets to landscape pages.
 * The PDF is replaced under the SAME filename, so links/downloads keep working.
 */
async function rerenderAllDatesheets() {
  const GeneratedFile = require('../models/GeneratedFile');
  const { OUTPUT_DIR, SCHEDULER_DIR, runPython, fileSize } = require('./pythonRunner');
  const ed = require('../controllers/datesheetEditorController')._internals;
  const recs = await GeneratedFile.find({ kind: 'datesheet' });
  const out = { done: 0, skipped: [], failed: [] };
  for (const rec of recs) {
    const sf = rec.meta && rec.meta.scheduleFile;
    const snap = sf ? path.join(OUTPUT_DIR, path.basename(sf)) : null;
    const f = (rec.files || []).find((x) => /datesheet/i.test(x.label || '') && /\.pdf$/i.test(x.filename || '')) || (rec.files || []).find((x) => /\.pdf$/i.test(x.filename || ''));
    if (!snap || !fs.existsSync(snap) || !f) { out.skipped.push(rec.title); continue; }
    const pdf = path.join(OUTPUT_DIR, path.basename(f.filename));
    const tmp = path.join(OUTPUT_DIR, `landscape_${Date.now()}_${rec._id}.pdf`);
    const cfgPath = path.join(OUTPUT_DIR, `landscapecfg_${Date.now()}_${rec._id}.json`);
    fs.writeFileSync(cfgPath, JSON.stringify({ schedule_json: snap, out: tmp, drop_empty_slots: ed.datesheetCohort(rec) === 'pg' }));
    try {
      const { code, stdout } = await runPython(path.join(SCHEDULER_DIR, 'datesheet.py'), ['--render', cfgPath], { timeoutMs: 5 * 60 * 1000 });
      let r = {};
      try { r = JSON.parse(String(stdout || '').trim().split('\n').filter(Boolean).pop() || '{}'); } catch { r = {}; }
      if (code !== 0 || r.status !== 'ok' || !fs.existsSync(tmp)) throw new Error(r.error || 'render failed');
      fs.copyFileSync(tmp, pdf);                       // same filename → old links still work
      // render also wrote a fresh <tmp>_schedule.json — keep the record's own snapshot
      try { fs.unlinkSync(r.schedule_file); } catch { /* ignore */ }
      f.sizeBytes = fileSize(pdf);
      rec.meta = { ...(rec.meta || {}), landscapeAt: new Date().toISOString() };
      rec.markModified('files'); rec.markModified('meta');
      await rec.save();
      out.done++;
    } catch (e) {
      out.failed.push(`${rec.title}: ${e.message}`);
    } finally {
      for (const x of [tmp, cfgPath]) { try { fs.unlinkSync(x); } catch { /* ignore */ } }
    }
  }
  return out;
}

module.exports = { rerenderAllDatesheets, planRefresh, refreshDatesheet, refreshAllDatesheets, span };
