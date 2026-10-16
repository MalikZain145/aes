/**
 * sections.js — multi-section courses on exam documents.
 *
 * A course the class-wise report lists with 2+ sections (A, B, C) keeps its sections
 * apart on the admit cards, seating plan, identification sheets and paper tags — all
 * sections still sit the same paper at the same time, but section A is seated first,
 * then B, then C, and every section gets its own ID sheet and envelope tag.
 *
 * The registration report has no per-student section, so admit_cards.py splits the
 * students: same batch (program + intake) together, sections filled evenly, reg-no order.
 *
 *   courseSections()         → { CODE: ['A','B',…] } for every multi-section course
 *   resectionBatch(batchId)  → apply the rule to an ALREADY issued batch (no re-seating
 *                              of other papers, invigilators unchanged), re-print it
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

async function courseSections() {
  const Course = require('../models/Course');
  const rows = await Course.find({ active: true, component: { $ne: 'Lab' } }).select('code section erpEnrolled programBatches').lean();
  const m = new Map();
  for (const c of rows) {
    const code = String(c.code || '').trim().toUpperCase();
    const sec = String(c.section || '').trim().toUpperCase();
    if (!code || !/^[A-Z]$/.test(sec)) continue;
    // a section the ERP class list shows with nobody in it is not a section
    if (c.erpEnrolled === 0 && !(c.programBatches || []).length) continue;
    if (!m.has(code)) m.set(code, new Set());
    m.get(code).add(sec);
  }
  const out = {};
  for (const [code, set] of m) if (set.size > 1) out[code] = [...set].sort();
  return out;
}

function baseUrl() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const port = process.env.PORT || 5000;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal && !/^169\.254\./.test(i.address)) return `http://${i.address}:${port}`;
  }
  return '';
}

async function resectionBatch(batchId) {
  const GeneratedFile = require('../models/GeneratedFile');
  const AdmitVerification = require('../models/AdmitVerification');
  const { OUTPUT_DIR, SCHEDULER_DIR, runPython, fileSize } = require('./pythonRunner');
  const batch = await GeneratedFile.findById(batchId);
  if (!batch || batch.kind !== 'admit_cards') throw new Error('Admit-card batch not found.');
  const files = batch.files || [];
  const pick = (rx) => files.find((f) => rx.test(f.label || ''));
  const cards = pick(/admit cards/i);
  if (!cards) throw new Error('This batch has no admit-card PDF.');
  const layout = path.join(OUTPUT_DIR, path.basename(cards.filename).replace(/\.pdf$/i, '_layout.json'));
  if (!fs.existsSync(layout)) throw new Error('This batch has no seating data (_layout.json) — regenerate the admit cards.');
  const avs = await AdmitVerification.find({ batchId: batch._id }).lean();
  if (!avs.length) throw new Error('No admit-card records for this batch.');
  const course_sections = await courseSections();
  const stamp = Date.now();
  const studentsJson = path.join(OUTPUT_DIR, `resection_students_${stamp}.json`);
  const outJson = path.join(OUTPUT_DIR, `resection_out_${stamp}.json`);
  const cfgPath = path.join(OUTPUT_DIR, `resection_cfg_${stamp}.json`);
  fs.writeFileSync(studentsJson, JSON.stringify(avs.map((a) => ({
    sid: a.studentId, name: a.name, program: a.program, batch: a.batch, token: a.token, page: a.cardPage || 0,
    exams: (a.exams || []).map((e) => ({ code: e.code, name: e.name, teacher: e.teacher, date: e.date, date_disp: e.dateDisp, day: e.day,
      slot: e.slot, start: e.start, finish: e.finish, room: e.room, seat: e.seat, section: e.section || '' })),
  }))));
  const out = (f) => (f ? path.join(OUTPUT_DIR, path.basename(f.filename)) : undefined);
  const sample = avs.find((a) => a.heading) || avs[0];
  const t = String(sample.examType || '').toLowerCase();
  fs.writeFileSync(cfgPath, JSON.stringify({
    mode: 'resection', layout_json: layout, students_json: studentsJson, course_sections,
    student_sections: await require('./sectionPlan').studentSectionMap().catch(() => ({})),
    meta: { heading: sample.heading || '', exam_label: t ? (t.startsWith('mid') ? 'Mid Term Examination' : 'Final Term Examination') : '' },
    base_url: baseUrl(), out_json: outJson,
    out_cards: out(cards), out_seating: out(pick(/seating/i)), out_idsheets: out(pick(/identif/i)), out_invig: out(pick(/invigil/i)),
  }));
  let result;
  try {
    const { code, stdout, stderr } = await runPython(path.join(SCHEDULER_DIR, 'admit_cards.py'), ['--config', cfgPath], { timeoutMs: 45 * 60 * 1000 });
    try { result = JSON.parse(String(stdout || '').trim().split('\n').filter(Boolean).pop() || '{}'); } catch { result = {}; }
    if (code !== 0 || result.status !== 'ok') throw new Error(result.error || `section re-print failed. ${String(stderr || '').slice(-300)}`);
    const upd = JSON.parse(fs.readFileSync(outJson, 'utf-8'));
    const ops = [];
    for (const a of avs) {
      const list = upd[String(a.studentId)];
      if (!list) continue;
      const byKey = new Map(list.map((e) => [`${String(e.code).toUpperCase()}|${e.date}|${e.slot}`, e]));
      let changed = false;
      const exams = (a.exams || []).map((e) => {
        const n = byKey.get(`${String(e.code).toUpperCase()}|${e.date}|${e.slot}`);
        if (!n) return e;
        if (n.room !== e.room || n.seat !== e.seat || (n.section || '') !== (e.section || '')) changed = true;
        return { ...e, room: n.room, seat: n.seat, section: n.section || '' };
      });
      if (changed) ops.push({ updateOne: { filter: { _id: a._id }, update: { $set: { exams } } } });
    }
    for (let i = 0; i < ops.length; i += 500) await AdmitVerification.bulkWrite(ops.slice(i, i + 500), { ordered: false });
    for (const f of files) { const p = path.join(OUTPUT_DIR, path.basename(f.filename)); if (fs.existsSync(p)) f.sizeBytes = fileSize(p); }
    batch.meta = { ...(batch.meta || {}), sectionsAppliedAt: new Date().toISOString(), sectionCounts: result.section_counts };
    batch.markModified('files'); batch.markModified('meta');
    await batch.save();
    return { ...result, studentsUpdated: ops.length, title: batch.title };
  } finally {
    for (const p of [studentsJson, outJson, cfgPath]) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
  }
}

/** Every active batch that has seating data. */
async function resectionAll() {
  const GeneratedFile = require('../models/GeneratedFile');
  const { OUTPUT_DIR } = require('./pythonRunner');
  const recs = await GeneratedFile.find({ kind: 'admit_cards', archived: { $ne: true } }).sort({ createdAt: -1 }).lean();
  const out = [];
  for (const r of recs) {
    const f = (r.files || []).find((x) => /admit cards/i.test(x.label || ''));
    if (!f || !fs.existsSync(path.join(OUTPUT_DIR, path.basename(f.filename).replace(/\.pdf$/i, '_layout.json')))) continue;
    out.push(await resectionBatch(r._id));
  }
  return out;
}

/** EXACT JS twin of admit_cards.assign_sections — so tags printed before the batch
 *  was re-printed show the same section a student gets on the re-printed papers. */
const sidKey = (sid) => { const s = String(sid); return /^\d+$/.test(s) ? [0, Number(s), ''] : [1, 0, s]; };
const cmpKey = (a, b) => { const x = sidKey(a), y = sidKey(b); return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0); };
function assignSections(studentsByCode, courseSections, batchOf) {
  const out = new Map();   // `${sid}|${CODE}` → letter
  for (const [code0, lettersRaw] of Object.entries(courseSections || {})) {
    const code = String(code0).toUpperCase();
    const letters = [...new Set((lettersRaw || []).map((x) => String(x).trim().toUpperCase()).filter(Boolean))].sort();
    const sids = [...new Set(studentsByCode.get(code) || [])].map(String).sort(cmpKey);
    if (letters.length < 2 || !sids.length) continue;
    const k = letters.length, n = sids.length;
    const cap = Object.fromEntries(letters.map((L, i) => [L, Math.floor(n / k) + (i < n % k ? 1 : 0)]));
    const groups = new Map();
    for (const sid of sids) {
      const g = String(batchOf.get(sid) || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(sid);
    }
    const order = [...groups.values()].sort((a, b) => (b.length - a.length) || cmpKey(a[0], b[0]));
    for (const g of order) {
      const best = letters.slice().sort((a, b) => (cap[b] - cap[a]) || (a < b ? -1 : 1))[0];
      if (cap[best] >= g.length) { for (const sid of g) out.set(`${sid}|${code}`, best); cap[best] -= g.length; continue; }
      for (const sid of g) {
        const L = letters.find((x) => cap[x] > 0) || letters[letters.length - 1];
        out.set(`${sid}|${code}`, L); cap[L] -= 1;
      }
    }
  }
  return out;
}

module.exports = { courseSections, resectionBatch, resectionAll, assignSections };
