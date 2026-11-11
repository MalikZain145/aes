/**
 * Import a ready-made datesheet (a special exam, e.g. the mid-terms of a new intake).
 *
 * The normal generator plans a whole semester. A special exam often comes with a
 * plan already agreed (fixed days, one time per day, papers merged by hand), so this
 * takes that plan as an Excel file plus the students' registration file and creates
 * an ordinary datesheet record from it — the PDF looks the same, and admit cards,
 * seating plans, identification sheets, invigilation and QR codes are then generated
 * from it exactly as for any other datesheet.
 *
 *   plan     : Excel with columns  Date | Time | Course code(s) [| Course name]
 *              one row per paper; "SS104 / SS113 / ENG101" in one row = ONE merged paper
 *   dataset  : the registration report of the students who sit this exam (only them)
 *
 * Nothing is scheduled or moved: the plan is checked (every code must have students,
 * no student may sit two papers at the same time, or — by default — on the same day)
 * and saved. Existing datesheets, admit cards and attendance are not touched.
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const GeneratedFile = require('../models/GeneratedFile');
const { parseDataset } = require('../utils/datasetImporter');
const { OUTPUT_DIR, SCHEDULER_DIR, runPython, fileSize, ensureOutputDir } = require('../utils/pythonRunner');

const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const MON_NAME = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const up = (x) => String(x == null ? '' : x).trim().toUpperCase();
const pad = (n) => String(n).padStart(2, '0');

function isoOf(v) {
  if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  const s = String(v == null ? '' : v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/(\d{1,2})[-\s/]([A-Za-z]{3})[A-Za-z]*[-\s/,]*(\d{4})/);
  if (m && MON[m[2].toLowerCase()] != null) return `${m[3]}-${pad(MON[m[2].toLowerCase()] + 1)}-${pad(m[1])}`;
  if (/^\d{5}$/.test(s)) { const d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000); return d.toISOString().slice(0, 10); }
  return '';
}
// "3:00 PM – 4:30 PM" | "03:00-04:30" | "15:00-16:30" → "03:00-04:30" (exam clock, 12-hour, no am/pm)
function slotOf(v) {
  const s = String(v == null ? '' : v);
  const t = [...s.matchAll(/(\d{1,2})[:.](\d{2})/g)].map((m) => {
    let h = Number(m[1]); if (h > 12) h -= 12; if (h === 0) h = 12;
    return `${pad(h)}:${m[2]}`;
  });
  return t.length >= 2 ? `${t[0]}-${t[1]}` : '';
}
const slotMinutes = (slot) => {   // order columns by real time of day (1–7 = afternoon)
  const m = String(slot).match(/(\d{1,2}):(\d{2})/); if (!m) return 9999;
  let h = Number(m[1]); if (h >= 1 && h <= 7) h += 12; return h * 60 + Number(m[2]);
};
const dispOf = (iso) => { const [y, mo, d] = iso.split('-').map(Number); return `${pad(d)}-${MON_NAME[mo - 1]}-${y}`; };
const dayOf = (iso) => { const [y, mo, d] = iso.split('-').map(Number); return DAY_NAME[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]; };

function readPlan(file) {
  const wb = XLSX.readFile(file, { cellDates: true });
  for (const nm of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[nm], { header: 1, defval: '', raw: true });
    const hi = grid.findIndex((r) => r.some((c) => /^date/i.test(String(c).trim())) && r.some((c) => /^(course|code|paper)/i.test(String(c).trim())));
    if (hi < 0) continue;
    const H = grid[hi].map((c) => String(c).trim().toLowerCase());
    const col = (re) => H.findIndex((h) => re.test(h));
    const C = { date: col(/^date/), time: col(/^(time|slot)/), code: col(/^(course\s*code|code|paper|course(?!\s*name))/), name: col(/^(course\s*name|name|title)/) };
    if (C.date < 0 || C.time < 0 || C.code < 0) continue;
    const rows = [];
    for (let i = hi + 1; i < grid.length; i++) {
      const g = grid[i];
      const codes = String(g[C.code] || '').split(/[\/,+&]/).map(up).map((x) => x.replace(/\s+/g, '')).filter((x) => /^[A-Z]{2,5}L?\d{2,4}[A-Z]?(-[A-Z0-9]+)?$/.test(x));
      if (!codes.length) continue;
      const names = C.name >= 0 ? String(g[C.name] || '').split(/\s+\/\s+/).map((x) => x.trim()) : [];
      rows.push({ excelRow: i + 1, date: isoOf(g[C.date]), slot: slotOf(g[C.time]), codes, names });
    }
    if (rows.length) return { sheet: nm, rows };
  }
  throw new Error('No sheet with the columns Date, Time and Course code was found in the datesheet file.');
}

class ImportError extends Error { constructor(status, body) { super(body.error); this.status = status; this.body = body; } }
const fail = (status, error, extra = {}) => { throw new ImportError(status, { error, ...extra }); };

/**
 * Core import (used by the upload endpoint and by a one-time server task).
 * planFile / dataFile: { path, originalname }. Returns the response body.
 */
async function importPlan({ planFile, dataFile, body = {} }) {
  let snapPath; let pdfPath;
  try {
    if (!planFile) fail(400, 'Choose the datesheet Excel file.');
    if (!dataFile) fail(400, 'Choose the registration file of the students who sit this exam.');
    const b = body || {};
    const examType = String(b.examType || 'mids').toLowerCase().startsWith('fin') ? 'finals' : 'mids';
    const label = String(b.label || '').trim().slice(0, 80);
    const allowSameDay = String(b.allowSameDay || '') === 'true';
    const footerNote = String(b.note || '').trim().slice(0, 1500);
    let examRooms = b.examRooms;
    if (typeof examRooms === 'string') { try { examRooms = JSON.parse(examRooms); } catch { examRooms = examRooms.split(','); } }
    examRooms = Array.isArray(examRooms) ? examRooms.map((x) => String(x).trim()).filter(Boolean) : [];

    const plan = readPlan(planFile.path);
    const bad = plan.rows.filter((r) => !r.date || !r.slot);
    if (bad.length) fail(400, `Row ${bad[0].excelRow}: date or time not understood.`);

    const ds = parseDataset(dataFile.path);
    const regs = ds.studentRegistrations || [];
    if (!regs.length) fail(400, 'The registration file has no students (student-wise report expected).');
    const byCode = new Map();
    for (const r of regs) for (const c of (r.courses || [])) {
      const k = up(c); if (!byCode.has(k)) byCode.set(k, new Set()); byCode.get(k).add(String(r.studentId));
    }
    const nameFromData = {};
    for (const c of (ds.courses || [])) if (c.code && c.name && !nameFromData[up(c.code)]) nameFromData[up(c.code)] = c.name;

    // every code once; empty codes are dropped from a merged paper (reported)
    const seen = new Map(); const dupes = []; const noStudents = [];
    for (const r of plan.rows) {
      for (const c of r.codes) {
        if (seen.has(c)) dupes.push(`${c} (rows ${seen.get(c)} and ${r.excelRow})`); else seen.set(c, r.excelRow);
        if (!byCode.has(c)) noStudents.push(c);
      }
    }
    if (dupes.length) fail(400, `Paper listed twice: ${dupes.slice(0, 5).join(', ')}`);

    const dates = [...new Set(plan.rows.map((r) => r.date))].sort();
    const slots = [...new Set(plan.rows.map((r) => r.slot))].sort((a, z) => slotMinutes(a) - slotMinutes(z));
    const courses = [];
    for (const r of plan.rows) {
      const live = r.codes.filter((c) => byCode.has(c));
      if (!live.length) continue;
      const group = live.join('/');
      r.codes.forEach((c, i) => {
        if (!byCode.has(c)) return;
        courses.push({
          code: c, name: r.names[i] || nameFromData[c] || c, group,
          date: r.date, date_disp: dispOf(r.date), day: dayOf(r.date),
          day_index: dates.indexOf(r.date), slot_index: slots.indexOf(r.slot), slot: r.slot,
          students: [...byCode.get(c)],
        });
      });
    }
    if (!courses.length) fail(400, 'None of the papers in the datesheet has students in the registration file.');

    // clash check — same time always; same day unless allowed
    const perStudent = new Map();   // sid → [{date, slot, group}]
    const groupsDone = new Set();
    for (const c of courses) {
      const gk = `${c.group}`;
      for (const sid of c.students) {
        if (!perStudent.has(sid)) perStudent.set(sid, []);
        const l = perStudent.get(sid);
        if (!l.some((x) => x.group === gk)) l.push({ date: c.date, slot: c.slot, group: gk });
      }
      groupsDone.add(gk);
    }
    const clashes = [];
    const nameOf = new Map(regs.map((r) => [String(r.studentId), r.name || '']));
    for (const [sid, l] of perStudent) {
      const bySlot = new Map(); const byDay = new Map();
      for (const x of l) {
        const k = `${x.date}|${x.slot}`; bySlot.set(k, (bySlot.get(k) || []).concat(x.group));
        byDay.set(x.date, (byDay.get(x.date) || []).concat(x.group));
      }
      for (const [k, g] of bySlot) if (g.length > 1) clashes.push({ sid, name: nameOf.get(sid), when: `${dispOf(k.split('|')[0])} ${k.split('|')[1]}`, papers: g, kind: 'same time' });
      if (!allowSameDay) {
        for (const [d, g] of byDay) {
          const sameTime = [...bySlot.entries()].some(([k, x]) => k.startsWith(`${d}|`) && x.length > 1);
          if (g.length > 1 && !sameTime) clashes.push({ sid, name: nameOf.get(sid), when: dispOf(d), papers: g, kind: 'same day' });
        }
      }
    }
    if (clashes.length) fail(409, `Not imported — ${clashes.length} student clash(es).`, { clashes: clashes.slice(0, 100) });

    // A conducted exam (e.g. the regular mid-terms) is archived first, as before any new datesheet.
    try { await require('../utils/examArchive').archiveConductedExams({ reason: 'special datesheet imported' }); }
    catch (e) { console.error('exam archive:', e.message); }

    // B.Tech (Engineering Technology) gets its OWN datesheet, as always; BS another.
    // A paper both sit (e.g. Pakistan Studies) is printed on both — same date/time.
    const progOf = new Map(regs.map((r) => [String(r.studentId), `${r.program || ''} ${r.batch || ''}`]));
    const isBT = (sid) => /engineering\s*technology|b\.?\s*tech\b/i.test(progOf.get(String(sid)) || '');
    const parts = [
      { key: 'bs', title: '', keep: (c) => c.students.some((x) => !isBT(x)) },
      { key: 'btech', title: 'B.Tech', keep: (c) => c.students.some((x) => isBT(x)) },
    ];
    const groupHas = new Map();   // merged paper → which parts sit it
    for (const c of courses) for (const pt of parts) if (pt.keep(c)) { const k = `${pt.key}|${c.group}`; groupHas.set(k, true); }
    const live = parts.filter((pt) => courses.some((c) => groupHas.get(`${pt.key}|${c.group}`)));
    const split = live.length > 1;

    ensureOutputDir();
    const stamp = Date.now();
    const word = examType === 'mids' ? 'Mids' : 'Finals';
    const sem = String(b.semester || '').trim() || 'Fall';
    const year = Number(b.year) || Number(dates[0].slice(0, 4));
    const baseHeading = `${label ? `${label} — ` : ''}${examType === 'mids' ? 'Mid Term' : 'Final Term'} Examination, ${sem} ${year}`;
    const dataName = `Datesheet_${word}_Imported_${stamp}_registrations${path.extname(dataFile.originalname || '.xlsx') || '.xlsx'}`;
    fs.copyFileSync(dataFile.path, path.join(OUTPUT_DIR, dataName));
    const records = [];
    for (const pt of live) {
      const mine = courses.filter((c) => groupHas.get(`${pt.key}|${c.group}`));
      const myDates = [...new Set(mine.map((c) => c.date))].sort();
      const mySlots = [...new Set(mine.map((c) => c.slot))].sort((a, z) => slotMinutes(a) - slotMinutes(z));
      const heading = split && pt.title ? `${baseHeading} — ${pt.title}` : baseHeading;
      const snap = {
        exam_type: examType, program_level: 'Undergraduate', semester: sem, year, heading,
        start_date: dispOf(myDates[0]), end_date: dispOf(myDates[myDates.length - 1]),
        dates: myDates, slots: mySlots,
        courses: mine.map((c) => ({ ...c, day_index: myDates.indexOf(c.date), slot_index: mySlots.indexOf(c.slot) })),
        // the note (BS papers held in class) is printed on the BS sheet only, never on B.Tech
        excluded_codes: [], footer_note: pt.key === 'btech' ? '' : footerNote,
      };
      snapPath = path.join(OUTPUT_DIR, `dsconfig_${stamp}_${pt.key}_snap.json`);
      fs.writeFileSync(snapPath, JSON.stringify(snap));
      const pdfName = `Datesheet_${word}_Imported_${stamp}${split ? `_${pt.key}` : ''}.pdf`;
      pdfPath = path.join(OUTPUT_DIR, pdfName);
      const cfgPath = path.join(OUTPUT_DIR, `dsconfig_${stamp}_${pt.key}.json`);
      fs.writeFileSync(cfgPath, JSON.stringify({ schedule_json: snapPath, out: pdfPath, drop_empty_slots: true }));
      const { code, stdout, stderr } = await runPython(path.join(SCHEDULER_DIR, 'datesheet.py'), ['--render', cfgPath], { timeoutMs: 5 * 60 * 1000 });
      try { fs.unlinkSync(cfgPath); } catch { /* ignore */ }
      try { fs.unlinkSync(snapPath); } catch { /* ignore */ }
      snapPath = null;
      let result = {};
      try { result = JSON.parse(String(stdout || '').trim().split('\n').filter(Boolean).pop() || '{}'); } catch { result = {}; }
      if (code !== 0 || result.status !== 'ok' || !fs.existsSync(pdfPath)) {
        throw new Error(result.error || `Could not render the datesheet. ${String(stderr || '').slice(-300)}`);
      }
      const papers = new Set(mine.map((c) => c.group)).size;
      const studs = new Set(mine.flatMap((c) => c.students.filter((x) => (pt.key === 'btech') === isBT(x))));
      records.push(await GeneratedFile.create({
        kind: 'datesheet', examType,
        title: `${heading} (${snap.start_date} – ${snap.end_date})`,
        files: [{ label: 'Datesheet PDF', filename: pdfName, format: 'pdf', sizeBytes: fileSize(pdfPath) }],
        summary: { courses: mine.length, days: myDates.length, papers, studentClashes: 0 },
        meta: {
          startDate: snap.start_date, endDate: snap.end_date, heading,
          scheduleFile: result.schedule_file ? path.basename(result.schedule_file) : null,
          programLevel: 'Undergraduate', semester: sem, year,
          imported: true, special: true, label: label || undefined,
          importGroup: String(stamp), part: split ? pt.key : undefined, partLabel: split ? (pt.title || 'BS') : undefined,
          datasetFile: dataName, students: split ? studs.size : perStudent.size, groupStudents: perStudent.size,
          footerNote: footerNote || undefined, examRooms: examRooms.length ? examRooms : undefined,
          config: { examType, startDate: dates[0], semester: sem, year },
        },
        status: 'ready',
      }));
    }
    const papers = new Set(courses.map((c) => c.group)).size;
    try { await require('../utils/logger').logActivity('datesheet.import', `Imported datesheet "${baseHeading}" — ${papers} papers, ${perStudent.size} students${split ? ' (BS + B.Tech sheets)' : ''}`, 'success'); } catch { /* optional */ }
    return {
      ok: true, record: records[0], records, sheets: records.length, papers, courses: courses.length, students: perStudent.size, days: dates.length, slots,
      skippedNoStudents: [...new Set(noStudents)],
      // registered (theory) courses that have no paper on this datesheet — check these
      coursesWithoutPaper: [...byCode.keys()].filter((c) => !seen.has(c) && !/^[A-Z]{2,4}L\d/.test(c)).sort(),
    };
  } finally {
    try { if (snapPath) fs.unlinkSync(snapPath); } catch { /* ignore */ }
  }
}

// POST /api/generate/datesheet-import   (multipart: plan, dataset; examType, semester, year, label, note, examRooms, allowSameDay)
exports.importDatesheet = async (req, res) => {
  const files = req.files || {};
  const planFile = files.plan && files.plan[0];
  const dataFile = files.dataset && files.dataset[0];
  try {
    res.json(await importPlan({ planFile, dataFile, body: req.body }));
  } catch (e) {
    if (e instanceof ImportError) return res.status(e.status).json(e.body);
    console.error('datesheet.import:', e.message);
    res.status(500).json({ error: e.message || 'Could not import the datesheet.' });
  } finally {
    for (const f of [planFile, dataFile]) { try { if (f) fs.unlinkSync(f.path); } catch { /* ignore */ } }
  }
};
exports.importPlan = importPlan;

module.exports._internal = { readPlan, slotOf, isoOf };
