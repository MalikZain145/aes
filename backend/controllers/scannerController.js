/**
 * Offline exam scanner support.
 *
 * Exam halls often have weak or no internet. The scanner app therefore keeps an
 * OFFLINE PACK of the issued admit cards and checks a card on the phone itself;
 * attendance scanned offline is queued on the phone and sent here when the
 * network is back.
 *
 * The pack is public but reveals nothing: every card's details are encrypted with
 * a key derived from that card's own QR token, and indexed by a hash of the token.
 * Only someone holding the printed card (its QR) can open its entry — the same
 * information the online check already shows to whoever scans that card.
 *
 *   index  = sha256("abasyn-pack|h|" + token)  (hex, first 32 chars)
 *   key    = sha256("abasyn-pack|k|" + token)
 *   block i of the key stream = sha256(key ‖ uint32be(i)); data = JSON xor stream
 *
 * GET  /api/scanner/pack        → { v, generatedAt, serverTime, batches, entries:[[index, base64]] }
 * POST /api/scanner/attendance  → { marks:[{ token, code, date, slot, at }] } → per-mark result
 */
const crypto = require('crypto');
const GeneratedFile = require('../models/GeneratedFile');
const AdmitVerification = require('../models/AdmitVerification');
const Attendance = require('../models/Attendance');
const examClock = require('../utils/examClock');
const { _internal: V } = require('./verifyController');

const sha = (b) => crypto.createHash('sha256').update(b).digest();
const indexOf = (token) => sha(Buffer.from(`abasyn-pack|h|${token}`, 'utf8')).toString('hex').slice(0, 32);
function encrypt(token, obj) {
  const key = sha(Buffer.from(`abasyn-pack|k|${token}`, 'utf8'));
  const data = Buffer.from(JSON.stringify(obj), 'utf8');
  const out = Buffer.alloc(data.length);
  for (let i = 0, blk = 0; i < data.length; blk++) {
    const ctr = Buffer.alloc(4); ctr.writeUInt32BE(blk, 0);
    const ks = sha(Buffer.concat([key, ctr]));
    for (let j = 0; j < 32 && i < data.length; j++, i++) out[i] = data[i] ^ ks[j];
  }
  return out.toString('base64');
}

let cache = { at: 0, day: '', body: null };
const CACHE_MS = 5 * 60 * 1000;

async function buildPack() {
  const today = examClock.now().date;
  const batches = await GeneratedFile.find({ kind: 'admit_cards', archived: { $ne: true } }).select('_id').lean();
  const ids = batches.map((b) => b._id);
  const recs = ids.length ? await AdmitVerification.find({ batchId: { $in: ids }, 'exams.date': { $gte: today } }).lean() : [];
  const ends = {};
  const entries = [];
  for (const rec of recs) {
    const bid = rec.batchId ? String(rec.batchId) : '';
    if (bid && !ends[bid]) ends[bid] = (await V.examEndOf(rec)) || null;
    const exams = (rec.exams || []).filter((e) => e.date >= today).map((e) => ({
      c: e.code, nm: e.name || '', t: e.teacher || '', d: e.date, dd: e.dateDisp || '', dy: e.day || '',
      s: e.slot || '', st: e.start || '', fi: e.finish || '', rm: e.room || '', se: e.seat || '', sec: e.section || '',
    }));
    entries.push([indexOf(rec.token), encrypt(rec.token, {
      n: rec.name || '', r: rec.studentId || '', p: rec.program || '', b: rec.batch || '',
      f: rec.feeStatus || 'Paid', hd: rec.heading || '', l: V.cardLabel(rec), bid, e: exams,
    })]);
  }
  return {
    v: 1, generatedAt: new Date().toISOString(), serverTime: Date.now(), today, tz: examClock.TZ,
    batches: Object.fromEntries(Object.entries(ends).map(([k, v]) => [k, v ? { date: v.date, slot: v.slot } : null])),
    count: entries.length, entries,
  };
}

exports.pack = async (_req, res) => {
  try {
    const day = examClock.now().date;
    if (!cache.body || cache.day !== day || Date.now() - cache.at > CACHE_MS) {
      cache = { at: Date.now(), day, body: await buildPack() };
    }
    res.set('Cache-Control', 'no-store');
    res.json({ ...cache.body, serverTime: Date.now() });
  } catch (e) {
    console.error('scanner pack:', e.message);
    res.status(500).json({ error: 'Could not prepare the offline data.' });
  }
};

// PKT date + minutes of a moment
function pkt(ms) { return examClock.now(new Date(ms)); }

exports.attendance = async (req, res) => {
  const marks = Array.isArray(req.body && req.body.marks) ? req.body.marks.slice(0, 500) : [];
  const results = [];
  const now = Date.now();
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i] || {};
    try {
      const v = await V.resolveVerified(m.token);
      if (!v) { results.push({ i, ok: false, reason: 'invalid' }); continue; }
      const rec = v.rec;
      const e = (rec.exams || []).find((x) => x.code === String(m.code || '') && x.date === String(m.date || '') && x.slot === String(m.slot || ''));
      if (!e) { results.push({ i, ok: false, reason: 'no_paper' }); continue; }
      // the scan must have happened during the paper (±30 min), and not in the future
      let at = Number(m.at) || now;
      if (at > now + 5 * 60 * 1000) at = now;
      const p = pkt(at);
      const st = V.toMinutes(e.start); const fi = V.toMinutes(e.finish);
      if (p.date !== e.date || (st != null && p.minutes < st - 30) || (fi != null && p.minutes > fi + 30)) {
        results.push({ i, ok: false, reason: 'outside_paper_time' }); continue;
      }
      await Attendance.updateOne(
        { studentId: rec.studentId, code: e.code, date: e.date, slot: e.slot },
        { $setOnInsert: {
          name: rec.name, program: rec.program, courseName: e.name, room: e.room, seat: e.seat,
          status: 'present', scannedAt: new Date(at), source: 'scan-offline',
          batchId: rec.batchId || null, examType: rec.examType || '',
        } },
        { upsert: true },
      );
      results.push({ i, ok: true });
    } catch (err) {
      results.push({ i, ok: false, reason: 'error', retry: true });
    }
  }
  res.json({ ok: true, accepted: results.filter((r) => r.ok).length, results });
};

exports._internal = { indexOf, encrypt, buildPack };
