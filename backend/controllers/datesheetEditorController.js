/**
 * Datesheet editor — open a generated datesheet, then delete / move / merge /
 * unmerge papers and save. Every change is clash-checked against the REAL student
 * registrations (and the cohort's other datesheets, e.g. department PDFs of the same
 * run); a datesheet with a clash can never be saved. Saving re-renders the PDF and
 * schedule snapshot from the edited layout (datesheet.py --render, no re-scheduling)
 * and REPLACES the previous files of that datesheet.
 *
 *   GET  /api/generate/datesheet/:id/editor  → grid + students per course
 *   POST /api/generate/datesheet/:id/editor  → { courses:[{code,group,d,s}], removed:[codes] }
 */
const fs = require('fs');
const path = require('path');
const GeneratedFile = require('../models/GeneratedFile');
const StudentRegistration = require('../models/StudentRegistration');
const { OUTPUT_DIR, SCHEDULER_DIR, runPython, fileSize } = require('../utils/pythonRunner');
const { logActivity } = require('../utils/logger');

const up = (x) => String(x || '').trim().toUpperCase();
const _isPGprog = (p) => /( ms | mphil |mphil| master| mba | msc |postgrad| pgd | phd )/.test(' ' + String(p || '').toLowerCase().replace(/[.\-]/g, ' ') + ' ');
const _isBTprog = (p) => { const s = ' ' + String(p || '').toLowerCase().replace(/[.\-]/g, ' ') + ' '; return s.includes('btech') || s.includes(' b tech') || s.includes('engineering technology'); };
const cohortOfProgram = (p) => (_isPGprog(p) ? 'pg' : (_isBTprog(p) ? 'btech' : 'bs'));
function datesheetCohort(d) {
  if (d && d.meta && d.meta.btech) return 'btech';
  if (/post/i.test((d && d.meta && d.meta.programLevel) || '')) return 'pg';
  return 'bs';
}
const batchKey = (b) => String(b || '').trim().replace(/\s+/g, ' ').toLowerCase();

// "01:00-02:30" → [780, 870] minutes (exam clock hours 1-7 are afternoon)
function span(label) {
  const m = String(label || '').match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const t = (h, mm) => { h = Number(h); if (h < 8) h += 12; return h * 60 + Number(mm); };
  return [t(m[1], m[2]), t(m[3], m[4])];
}
const overlaps = (a, b) => !!(a && b && a[0] < b[1] && b[0] < a[1]);
const isWeekend = (iso) => { const d = new Date(iso + 'T00:00:00'); const w = d.getDay(); return w === 0 || w === 6; };
const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Columns + which column each day may use, per cohort (same rules as generation).
const MASKED = {
  slots: ['09:00-10:30', '01:00-02:30', '03:00-04:30'],
  weekday: ['03:00-04:30'],
  weekend: ['09:00-10:30', '01:00-02:30'],
};
// BS Friday rule (Jumma): the 01:00-02:30 paper sits at 03:00-04:30 on Fridays.
const BS_FRIDAY = { from: '01:00-02:30', to: '03:00-04:30' };
const isFriday = (iso) => new Date(iso + 'T00:00:00').getDay() === 5;

function gridFor(cohort, sheetSlots, dates) {
  let slots = [...sheetSlots];
  if (cohort === 'btech' || cohort === 'pg') {
    for (const s of MASKED.slots) if (!slots.includes(s)) slots.push(s);
  }
  const bsFriday = cohort === 'bs' && slots.includes(BS_FRIDAY.from) && dates.some(isFriday);
  if (bsFriday && !slots.includes(BS_FRIDAY.to)) slots.push(BS_FRIDAY.to);
  slots.sort((a, b) => ((span(a) || [0])[0] - (span(b) || [0])[0]));
  const allowed = dates.map((iso) => {
    if (bsFriday) {
      const skip = isFriday(iso) ? BS_FRIDAY.from : BS_FRIDAY.to;
      return slots.map((s, i) => (s === skip ? -1 : i)).filter((i) => i >= 0);
    }
    if (cohort !== 'btech' && cohort !== 'pg') return slots.map((_, i) => i);
    const ok = isWeekend(iso) ? MASKED.weekend : MASKED.weekday;
    return slots.map((s, i) => (ok.includes(s) ? i : -1)).filter((i) => i >= 0);
  });
  const reserve = cohort === 'pg'
    ? dates.map((iso) => (isWeekend(iso) ? slots.map((s, i) => (s === '09:00-10:30' ? i : -1)).filter((i) => i >= 0) : []))
    : dates.map(() => []);
  return { slots, allowed, reserve };
}

async function loadRecord(id) {
  const rec = await GeneratedFile.findById(id);
  if (!rec || rec.kind !== 'datesheet') throw Object.assign(new Error('Datesheet not found.'), { status: 404 });
  const sf = rec.meta && rec.meta.scheduleFile;
  const p = sf ? path.join(OUTPUT_DIR, path.basename(sf)) : null;
  if (!p || !fs.existsSync(p)) throw Object.assign(new Error('This datesheet has no saved schedule to edit — generate it again.'), { status: 400 });
  return { rec, schedPath: p, snap: JSON.parse(fs.readFileSync(p, 'utf-8')) };
}

/** students per course code for this cohort (removed batches left out) */
async function studentsFor(cohort, excludeBatches) {
  const ex = new Set((excludeBatches || []).map(batchKey).filter(Boolean));
  const regs = await StudentRegistration.find({ studentId: { $ne: '' } }).select('studentId name program batch courses').lean();
  const byCode = new Map(); const info = {};
  for (const r of regs) {
    if (cohortOfProgram(r.program || r.batch) !== cohort) continue;
    if (ex.has(batchKey(r.batch || r.program))) continue;
    const sid = String(r.studentId);
    info[sid] = [r.name || '', r.batch || r.program || ''];
    for (const c of new Set((r.courses || []).map(up))) {
      if (!byCode.has(c)) byCode.set(c, []);
      byCode.get(c).push(sid);
    }
  }
  return { byCode, info };
}

/** the snapshot → editor units; merged papers share a group id */
function snapToCourses(snap, slots) {
  const dates = snap.dates || [];
  const out = [];
  const cellGroups = new Map();
  for (const c of snap.courses || []) {
    const d = dates.indexOf(c.date) >= 0 ? dates.indexOf(c.date) : Number(c.day_index);
    let s = slots.indexOf(c.slot);
    if (s < 0) s = slots.indexOf((snap.slots || [])[Number(c.slot_index)]);
    let group = c.group;
    if (!group) {
      // older snapshots: papers of one merge share an identical student list in one cell
      const k = `${d}|${s}|${(c.students || []).join(',')}`;
      if ((c.students || []).length && cellGroups.has(k)) group = cellGroups.get(k);
      else { group = c.code; if ((c.students || []).length) cellGroups.set(k, group); }
    }
    out.push({ code: up(c.code), name: c.name || '', group, d, s });
  }
  return out;
}

/** other datesheets of the same cohort & exam (e.g. department PDFs of one run) */
async function externalPapers(rec, cohort) {
  const others = await GeneratedFile.find({ kind: 'datesheet', examType: rec.examType, archived: { $ne: true }, _id: { $ne: rec._id } }).lean();
  const out = [];
  for (const o of others) {
    if (datesheetCohort(o) !== cohort) continue;
    const sf = o.meta && o.meta.scheduleFile; const p = sf ? path.join(OUTPUT_DIR, path.basename(sf)) : null;
    if (!p || !fs.existsSync(p)) continue;
    try {
      const sn = JSON.parse(fs.readFileSync(p, 'utf-8'));
      for (const c of sn.courses || []) out.push({ code: up(c.code), name: c.name || '', date: c.date, slot: c.slot, sheet: o.title });
    } catch { /* skip unreadable */ }
  }
  return out;
}

/**
 * Clash check (the same rules the browser shows live):
 *   • a student never sits two papers whose times overlap on the same date
 *     (merged papers = one sitting); includes the cohort's other datesheets
 *   • a paper only in a column that day may use (B.Tech / MS rules)
 */
function findClashes(courses, dates, slots, allowed, byCode, external) {
  const sittings = new Map();   // sid -> [{date, span, label, key}]
  const push = (sid, it) => { if (!sittings.has(sid)) sittings.set(sid, []); sittings.get(sid).push(it); };
  const groups = new Map();
  for (const c of courses) {
    const key = `${c.d}|${c.s}|${c.group}`;
    if (!groups.has(key)) groups.set(key, { d: c.d, s: c.s, codes: [] });
    groups.get(key).codes.push(c.code);
  }
  const bad = [];
  for (const [key, g] of groups) {
    if (!(allowed[g.d] || []).includes(g.s)) bad.push({ type: 'slot', codes: g.codes, date: dates[g.d], slot: slots[g.s] });
    const seen = new Set();
    for (const code of g.codes) for (const sid of byCode.get(code) || []) {
      if (seen.has(sid)) { bad.push({ type: 'merge', codes: g.codes, student: sid }); continue; }
      seen.add(sid);
      push(sid, { date: dates[g.d], span: span(slots[g.s]), label: `${g.codes.join('/')} (${dates[g.d]} ${slots[g.s]})`, key, code });
    }
  }
  for (const e of external) for (const sid of byCode.get(e.code) || []) {
    push(sid, { date: e.date, span: span(e.slot), label: `${e.code} (${e.date} ${e.slot}, ${e.sheet})`, key: `ext|${e.code}`, code: e.code, ext: true });
  }
  for (const [sid, list] of sittings) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.key === b.key || (a.ext && b.ext)) continue;
      if (a.date === b.date && overlaps(a.span, b.span)) bad.push({ type: 'student', student: sid, a: a.label, b: b.label });
    }
  }
  return bad;
}

// GET /api/generate/datesheet/:id/editor
exports.openEditor = async (req, res) => {
  try {
    const { rec, snap } = await loadRecord(req.params.id);
    const cohort = datesheetCohort(rec);
    const dates = snap.dates || [];
    const { slots, allowed, reserve } = gridFor(cohort, snap.slots || [], dates);
    const courses = snapToCourses(snap, slots);
    const excludeBatches = (rec.meta && (rec.meta.excludeBatches || (rec.meta.config && rec.meta.config.excludeBatches))) || [];
    const { byCode, info } = await studentsFor(cohort, excludeBatches);
    const external = await externalPapers(rec, cohort);
    const need = new Set([...courses.map((c) => c.code), ...external.map((e) => e.code)]);
    const students = {}; const used = new Set();
    for (const c of need) { students[c] = byCode.get(c) || []; for (const s of students[c]) used.add(s); }
    const studentInfo = {}; for (const s of used) studentInfo[s] = info[s];
    // every course this cohort's students take that is NOT on the sheet (can be added back)
    const onSheet = new Set(courses.map((c) => c.code));
    const offSheet = [...byCode.keys()].filter((c) => !onSheet.has(c)).sort();
    const names = {};
    try {
      const Course = require('../models/Course');
      for (const c of await Course.find({ code: { $in: [...need, ...offSheet] } }).select('code name').lean()) {
        const k = up(c.code); if (!names[k] && c.name) names[k] = c.name;
      }
    } catch { /* names are cosmetic */ }
    for (const c of snap.courses || []) names[up(c.code)] = c.name || names[up(c.code)] || '';
    res.json({
      id: rec._id, title: rec.title, examType: rec.examType, cohort, heading: snap.heading || rec.title,
      dates: dates.map((iso) => ({ iso, day: DAY[new Date(iso + 'T00:00:00').getDay()], weekend: isWeekend(iso) })),
      slots, allowed, reserve, courses, external, students, studentInfo, offSheet, names,
      editedAt: rec.meta && rec.meta.editedAt, clashes: findClashes(courses, dates, slots, allowed, byCode, external).length,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not open the datesheet.' });
  }
};

// POST /api/generate/datesheet/:id/editor   { courses:[{code,name,group,d,s}], removed:[codes] }
exports.saveEditor = async (req, res) => {
  let tmpSnap; let newPdf;
  try {
    const { rec, snap } = await loadRecord(req.params.id);
    const cohort = datesheetCohort(rec);
    const dates = snap.dates || [];
    const { slots, allowed } = gridFor(cohort, snap.slots || [], dates);
    const body = req.body || {};
    const courses = (Array.isArray(body.courses) ? body.courses : []).map((c) => ({
      code: up(c.code), name: String(c.name || ''), group: String(c.group || up(c.code)), d: Number(c.d), s: Number(c.s),
    })).filter((c) => c.code);
    if (!courses.length) return res.status(400).json({ error: 'The datesheet would be empty.' });
    const dup = courses.map((c) => c.code).filter((c, i, a) => a.indexOf(c) !== i);
    if (dup.length) return res.status(400).json({ error: `Paper listed twice: ${[...new Set(dup)].join(', ')}` });
    for (const c of courses) {
      if (!(c.d >= 0 && c.d < dates.length && c.s >= 0 && c.s < slots.length)) return res.status(400).json({ error: `${c.code}: invalid date / slot.` });
    }
    // merged papers must share ONE cell
    const gcell = new Map();
    for (const c of courses) {
      const k = gcell.get(c.group);
      if (k && k !== `${c.d}|${c.s}`) return res.status(400).json({ error: `Merged papers ${c.group} must sit in the same slot.` });
      gcell.set(c.group, `${c.d}|${c.s}`);
    }
    const excludeBatches = (rec.meta && (rec.meta.excludeBatches || (rec.meta.config && rec.meta.config.excludeBatches))) || [];
    const { byCode } = await studentsFor(cohort, excludeBatches);
    const external = await externalPapers(rec, cohort);
    const clashes = findClashes(courses, dates, slots, allowed, byCode, external);
    if (clashes.length) {
      return res.status(409).json({ error: `Not saved — ${clashes.length} clash(es). Fix them first.`, clashes: clashes.slice(0, 50) });
    }

    // edited snapshot → re-render (no re-scheduling)
    const removed = [...new Set((Array.isArray(body.removed) ? body.removed : []).map(up).filter(Boolean))];
    const nameOf = {}; for (const c of snap.courses || []) nameOf[up(c.code)] = c.name || '';
    const edited = {
      ...snap,
      slots,
      courses: courses.map((c) => ({
        code: c.code, name: c.name || nameOf[c.code] || c.code, date: dates[c.d], day_index: c.d, slot_index: c.s,
        slot: slots[c.s], group: c.group, students: byCode.get(c.code) || [],
      })),
      excluded_codes: [...new Set([...(snap.excluded_codes || []), ...removed])].filter((x) => !courses.some((c) => c.code === up(x))),
    };
    const stamp = Date.now();
    const label = rec.examType === 'mids' ? 'Mids' : 'Finals';
    tmpSnap = path.join(OUTPUT_DIR, `dsedit_${stamp}.json`);
    fs.writeFileSync(tmpSnap, JSON.stringify(edited));
    const pdfName = `Datesheet_${label}_${stamp}_edited.pdf`;
    newPdf = path.join(OUTPUT_DIR, pdfName);
    const cfgPath = path.join(OUTPUT_DIR, `dseditcfg_${stamp}.json`);
    fs.writeFileSync(cfgPath, JSON.stringify({ schedule_json: tmpSnap, out: newPdf, drop_empty_slots: cohort === 'pg' }));
    const { code, stdout, stderr } = await runPython(path.join(SCHEDULER_DIR, 'datesheet.py'), ['--render', cfgPath], { timeoutMs: 5 * 60 * 1000 });
    try { fs.unlinkSync(cfgPath); } catch { /* ignore */ }
    let result = {};
    try { result = JSON.parse(String(stdout || '').trim().split('\n').filter(Boolean).pop() || '{}'); } catch { result = {}; }
    if (code !== 0 || result.status !== 'ok' || !fs.existsSync(newPdf)) {
      throw new Error(result.error || `Could not render the edited datesheet. ${String(stderr || '').slice(-300)}`);
    }

    // replace the previous files of this datesheet
    const oldFiles = [...(rec.files || []).map((f) => f.filename), rec.meta && rec.meta.scheduleFile].filter(Boolean);
    rec.files = [{ label: 'Datesheet PDF', filename: pdfName, format: 'pdf', sizeBytes: fileSize(newPdf) }];
    rec.summary = { ...(rec.summary || {}), courses: result.total_courses, papers: result.total_papers, days: result.total_days, studentClashes: 0 };
    const log = Array.isArray(rec.meta && rec.meta.editLog) ? rec.meta.editLog : [];
    log.push({ at: new Date().toISOString(), papers: result.total_papers, removed, note: String(body.note || '').slice(0, 300) });
    rec.meta = { ...(rec.meta || {}), scheduleFile: path.basename(result.schedule_file), editedAt: new Date().toISOString(), editLog: log.slice(-50) };
    rec.markModified('meta'); rec.markModified('files');
    await rec.save();
    for (const f of oldFiles) {
      const p = path.join(OUTPUT_DIR, path.basename(f));
      if (p !== newPdf && fs.existsSync(p)) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
    }
    try { fs.unlinkSync(tmpSnap); } catch { /* ignore */ }

    // admit cards made from the OLD layout are now out of date
    const staleCards = await GeneratedFile.countDocuments({ kind: 'admit_cards', archived: { $ne: true }, examType: rec.examType });
    await logActivity('generate.datesheet.edit', `Datesheet edited & saved: ${rec.title}${removed.length ? ` (removed ${removed.join(', ')})` : ''}`, 'success');
    res.json({ ok: true, record: rec, staleAdmitCards: staleCards > 0 });
  } catch (err) {
    if (tmpSnap) { try { fs.unlinkSync(tmpSnap); } catch { /* ignore */ } }
    if (newPdf && fs.existsSync(newPdf)) { try { fs.unlinkSync(newPdf); } catch { /* ignore */ } }
    console.error('datesheet editor save:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Could not save the datesheet.' });
  }
};

// POST /api/generate/datesheet/:id/refresh   { dryRun? }
exports.refresh = async (req, res) => {
  try {
    const { refreshDatesheet } = require('../utils/datesheetRefresh');
    const dryRun = !!(req.body && req.body.dryRun);
    const { record, report } = await refreshDatesheet(req.params.id, { dryRun });
    const staleCards = dryRun ? 0 : await GeneratedFile.countDocuments({ kind: 'admit_cards', archived: { $ne: true }, examType: record.examType });
    res.status(report.saved === false && !dryRun ? 409 : 200).json({ ok: report.saved !== false, dryRun, record, report, staleAdmitCards: staleCards > 0, error: report.error });
  } catch (err) {
    console.error('datesheet refresh:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Could not update the datesheet.' });
  }
};

// POST /api/generate/datesheets/refresh-all
exports.refreshAll = async (req, res) => {
  try {
    const { refreshAllDatesheets } = require('../utils/datesheetRefresh');
    const reports = await refreshAllDatesheets({ dryRun: !!(req.body && req.body.dryRun) });
    res.json({ ok: reports.every((r) => r.saved !== false), reports });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not update the datesheets.' });
  }
};

module.exports._test = { findClashes, gridFor, snapToCourses, span };
module.exports._internals = { cohortOfProgram, loadRecord, datesheetCohort, gridFor, snapToCourses, studentsFor, externalPapers, findClashes };
