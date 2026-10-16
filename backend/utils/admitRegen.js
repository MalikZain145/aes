/**
 * admitRegen.js — re-issue the admit cards for ALL programs from the server itself
 * (same code path as the "Generate admit cards" button), e.g. after new registration
 * data is imported. Uses the newest BS + B.Tech + MS datesheets of the exam the last
 * admit-card batch was for, the same campus line, labs off (the page default).
 *
 * Fee status is carried over: a student Finance already cleared (Paid) on the
 * previous batch stays Paid on the new cards; everyone else stays Unpaid.
 */
// same rule as generateController.isFeePaid: "Unpaid" contains "paid" → check it first
const isFeePaidText = (s) => { const t = String(s || '').toLowerCase(); return !!t && !/unpaid|not\s*paid/.test(t) && /paid/.test(t); };

function cohortOf(d) {
  if (d && d.meta && d.meta.btech) return 'btech';
  if (/post/i.test((d && d.meta && d.meta.programLevel) || '')) return 'pg';
  return 'bs';
}

async function regenerateAdmitCards({ log = console.log, replaceAll = false } = {}) {
  const GeneratedFile = require('../models/GeneratedFile');
  const AdmitVerification = require('../models/AdmitVerification');
  const prev = await GeneratedFile.findOne({ kind: 'admit_cards' }).sort({ createdAt: -1 }).lean();
  const examType = (prev && prev.examType) || null;
  const sheets = await GeneratedFile.find({ kind: 'datesheet', archived: { $ne: true }, ...(examType ? { examType } : {}) })
    .sort({ createdAt: -1 }).lean();
  const pick = {};
  for (const d of sheets) { const c = cohortOf(d); if (!pick[c]) pick[c] = d; }
  const missing = ['bs', 'btech', 'pg'].filter((c) => !pick[c]);
  if (missing.length) throw new Error(`no ${missing.join(', ')} datesheet${examType ? ` (${examType})` : ''} — generate the admit cards from the Admit Cards page`);

  const req = {
    body: {
      datesheetIds: JSON.stringify(['bs', 'btech', 'pg'].map((c) => String(pick[c]._id))),
      cohort: 'all',
      campusLine: (prev && prev.meta && prev.meta.campusLine) || 'Abasyn University Islamabad Campus',
      includeLabs: 'false',
    },
    file: null, protocol: 'http', get: () => `localhost:${process.env.PORT || 5000}`,
  };
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
  log(`   generating admit cards from: ${['bs', 'btech', 'pg'].map((c) => pick[c].title).join(' + ')}`);
  await require('../controllers/generateController').generateAdmitCards(req, res);
  if (res.code !== 200 || !res.body || !res.body.ok) throw new Error((res.body && res.body.error) || `admit-card generation failed (${res.code})`);
  const rec = res.body.record; const r = res.body.result || {};

  // fee status carried over: Paid on the previous batch (or, when every old batch is
  // being replaced, Paid on ANY earlier batch) stays Paid on the new cards
  let carried = 0;
  const olds = replaceAll
    ? (await GeneratedFile.find({ kind: 'admit_cards' }).select('_id title files').lean()).filter((b) => String(b._id) !== String(rec._id))
    : (prev ? [prev] : []);
  if (olds.length) {
    const paid = (await AdmitVerification.find({ batchId: { $in: olds.map((b) => b._id) } }).select('studentId feeStatus').lean())
      .filter((a) => isFeePaidText(a.feeStatus)).map((a) => String(a.studentId));
    if (paid.length) {
      const u = await AdmitVerification.updateMany({ batchId: rec._id, studentId: { $in: [...new Set(paid)] } }, { $set: { feeStatus: 'Paid' } });
      carried = (u && (u.modifiedCount != null ? u.modifiedCount : u.nModified)) || 0;
    }
  }
  // every earlier admit-card batch removed: records, QR/verify records, files on disk
  let removed = '';
  if (replaceAll && olds.length) {
    const fs = require('fs'); const path = require('path');
    const { OUTPUT_DIR } = require('./pythonRunner');
    try {
      const bk = path.join(OUTPUT_DIR, `backup_old_admit_batches_${Date.now()}.json`);
      const avs = await AdmitVerification.find({ batchId: { $in: olds.map((b) => b._id) } }).select('batchId studentId name feeStatus token').lean();
      fs.writeFileSync(bk, JSON.stringify({ batches: olds.map((b) => ({ id: b._id, title: b.title, files: (b.files || []).map((f) => f.filename) })), cards: avs }));
    } catch (e) { log(`   backup of old batches failed: ${e.message}`); }
    let files = 0;
    for (const b of olds) {
      for (const f of b.files || []) {
        const base = path.join(OUTPUT_DIR, path.basename(f.filename));
        for (const x of [base, base.replace(/\.pdf$/i, '_layout.json'), base.replace(/\.pdf$/i, '_audit.json')]) {
          try { if (fs.existsSync(x)) { fs.unlinkSync(x); files++; } } catch { /* ignore */ }
        }
      }
    }
    const qr = await AdmitVerification.deleteMany({ batchId: { $in: olds.map((b) => b._id) } });
    await GeneratedFile.deleteMany({ _id: { $in: olds.map((b) => b._id) } });
    removed = `; ${olds.length} old batch(es) removed (${qr.deletedCount || 0} old card records, ${files} files)`;
  }
  return `${r.admit_cards || 0} admit cards, ${r.sessions || 0} sessions, ${r.unseated_count || 0} unseated, `
    + `audit ${r.audit ? (r.audit.clean ? 'clean' : 'NOT clean ' + JSON.stringify(r.audit.hard_counts || {})) : 'n/a'}, fee Paid carried over for ${carried}${removed}`;
}

module.exports = { regenerateAdmitCards };
