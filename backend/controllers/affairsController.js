/**
 * Office of Student Affairs — digital student ID cards (merged from the standalone
 * "Abasyn Student Affairs" Node backend; same rules, same QR format).
 *
 * Data lives in its OWN collections in the scheduler database — nothing in the
 * exam / timetable / admit-card data is read or changed:
 *   affairs_students  one record per student: details, photo thumbnail, expiry,
 *                     QR token + SHA-256 of the hidden card key, blocked flag
 *   affairs_scans     every gate scan (fake attempts too)
 *
 * Endpoints (mounted at /api/affairs):
 *   POST /scan                 public  — scanner app: { qr } → decision
 *   GET  /status               affairs — server + database check
 *   POST /cards/issue          affairs — issue / re-use the hidden key per student
 *   GET  /students/:regNo      affairs — look up one card
 *   POST /cards/block          affairs — block / unblock a lost card
 *   GET  /stats                affairs — totals for the dashboard
 */
const mongoose = require('mongoose');
const { seal, open, newKey, hash, sameHash, PREFIX } = require('../utils/affairsSecure');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const regKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const human = (iso) => { const [y, m, d] = String(iso || '').split('-').map(Number); return y ? `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}` : ''; };
// valid through the END of the expiry day, Pakistan time (UTC+5) — whatever the server's time zone
const isExpired = (iso, now = Date.now()) => {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  if (!y) return false;
  return now > Date.UTC(y, m - 1, d, 23, 59, 59) - 5 * 3600e3;
};
const pub = (d) => ({ regNo: d.regNo, name: d.name, batch: d.batch || '', expiry: d.expiry, expiryText: human(d.expiry), fields: d.fields || [], photo: d.photo || '' });

const MSG = {
  granted: 'Entry Granted',
  fake: 'This card seems fake. Do not allow entry',
  expired: 'Card Expired. Do not allow entry',
  blocked: 'Card Blocked. Do not allow entry',
};

let _indexed = false;
function cols() {
  const db = mongoose.connection.db;
  if (!db) throw Object.assign(new Error('Database is not connected yet. Try again in a moment.'), { status: 503 });
  const students = db.collection('affairs_students');
  const scans = db.collection('affairs_scans');
  if (!_indexed) {
    _indexed = true;
    students.createIndex({ regKey: 1 }, { unique: true }).catch(() => { _indexed = false; });
    scans.createIndex({ at: -1 }).catch(() => {});
  }
  return { students, scans };
}

// Express 4 does not catch async errors — every handler goes through this.
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  if (!e || !e.status) console.error('student affairs:', e);
  res.status((e && e.status) || 500).json({ error: (e && e.status && e.message) || 'Student Affairs server error.' });
});

exports.status = wrap(async (_req, res) => {
  let db = false;
  try { await mongoose.connection.db.command({ ping: 1 }); db = true; } catch { /* offline */ }
  res.json({ ok: true, db, time: new Date().toISOString() });
});

/* Issue (or re-use) the hidden key for each student and return the QR token to print. */
exports.issue = wrap(async (req, res) => {
  const list = Array.isArray(req.body && req.body.students) ? req.body.students : [];
  const reissue = !!(req.body && req.body.reissue);
  if (!list.length || list.length > 50) return res.status(400).json({ error: 'Send 1-50 students per request.' });
  const { students } = cols();
  const keys = list.map((s) => regKey(s && s.regNo));
  const existing = new Map((await students.find({ regKey: { $in: keys } }, { projection: { regKey: 1, token: 1, keyHash: 1 } }).toArray()).map((d) => [d.regKey, d]));
  const ops = []; const cards = []; const rejected = [];
  for (const s of list) {
    const rk = regKey(s && s.regNo);
    if (!rk || !s.name || !ISO.test(s.expiry || '')) { rejected.push((s && s.regNo) || '?'); continue; }
    const fields = Array.isArray(s.fields)
      ? s.fields.filter((f) => Array.isArray(f) && f.length === 2).slice(0, 40).map(([k, v]) => [String(k).slice(0, 60), String(v == null ? '' : v).slice(0, 300)])
      : [];
    const set = { regNo: String(s.regNo).trim(), regKey: rk, name: String(s.name).trim().slice(0, 120), batch: String(s.batch || '').trim().slice(0, 120), expiry: s.expiry, fields, updatedAt: new Date() };
    if (typeof s.photo === 'string' && s.photo.startsWith('data:image/') && s.photo.length < 250000) set.photo = s.photo;
    const ex = existing.get(rk);
    let token = ex && ex.token;
    if (!token || !ex.keyHash || reissue) {
      const k = newKey();
      token = await seal(set.regNo, k);
      Object.assign(set, { token, keyHash: hash(k), issuedAt: new Date(), blocked: false });
    }
    ops.push({ updateOne: { filter: { regKey: rk }, update: { $set: set, $setOnInsert: { createdAt: new Date(), scans: 0 } }, upsert: true } });
    cards.push({ regNo: set.regNo, token });
  }
  if (ops.length) await students.bulkWrite(ops, { ordered: false });
  res.json({ ok: true, cards, rejected });
});

/* Scanner app (public): send the raw QR text, get a decision. */
exports.scan = wrap(async (req, res) => {
  const qr = String((req.body && req.body.qr) || '').trim();
  const p = await open(qr);
  const { students, scans } = cols();
  let result = 'fake'; let doc = null;
  if (p) {
    doc = await students.findOne({ regKey: regKey(p.regNo) });
    if (doc && sameHash(hash(p.cardKey), doc.keyHash)) result = doc.blocked ? 'blocked' : (isExpired(doc.expiry) ? 'expired' : 'granted');
    else doc = null;   // key mismatch → never reveal any data
  }
  const log = scans.insertOne({ regNo: (doc && doc.regNo) || (p && p.regNo) || null, result, at: new Date(), device: String((req.body && req.body.device) || '').slice(0, 60) });
  const inc = doc ? students.updateOne({ _id: doc._id }, { $inc: { scans: 1 }, $set: { lastScanAt: new Date() } }) : null;
  await Promise.all([log, inc]).catch(() => {});
  res.json({ kind: 'id_card', result, allow: result === 'granted', message: MSG[result], student: doc ? pub(doc) : null, checkedAt: new Date().toISOString() });
});

/* Look up / block / unblock a student. */
exports.lookup = wrap(async (req, res) => {
  const { students } = cols();
  const d = await students.findOne({ regKey: regKey(req.params.regNo) }, { projection: { token: 0, keyHash: 0 } });
  if (!d) return res.json({ found: false });
  res.json({ found: true, status: d.blocked ? 'Blocked' : (isExpired(d.expiry) ? 'Expired' : 'Valid'), scans: d.scans || 0, lastScanAt: d.lastScanAt || null, issuedAt: d.issuedAt, student: pub(d) });
});

exports.block = wrap(async (req, res) => {
  const rk = regKey(req.body && req.body.regNo);
  if (!rk) return res.status(400).json({ error: 'Enter a registration number.' });
  const { students } = cols();
  const r = await students.updateOne({ regKey: rk }, { $set: { blocked: !(req.body && req.body.blocked === false), updatedAt: new Date() } });
  res.json({ ok: true, matched: r.matchedCount });
});

exports.stats = wrap(async (_req, res) => {
  const { students, scans } = cols();
  const since = new Date(Date.now() - 864e5);
  const [total, scans24h, fake24h] = await Promise.all([
    students.countDocuments({}),
    scans.countDocuments({ at: { $gte: since } }),
    scans.countDocuments({ at: { $gte: since }, result: 'fake' }),
  ]);
  res.json({ total, scans24h, fake24h });
});

exports.PREFIX = PREFIX;
exports._internals = { regKey, isExpired, human };
