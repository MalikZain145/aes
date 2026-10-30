/**
 * Student Affairs — digital ID-card QR security (ported from the standalone
 * "Abasyn Student Affairs" backend, same token format so nothing changes for a card).
 *
 *   QR = "AUSA1." + base64url( AES-256-GCM( regNo \n cardKey ) )
 *
 * A normal camera only sees random characters. Only this server can open it, and
 * the opened key must match the SHA-256 hash stored for that student — so an
 * edited, copied-from-another-system or hand-made QR is reported as FAKE.
 *
 * Secret (never sent to any client, never printed):
 *   1. env AFFAIRS_QR_SECRET (or QR_SECRET, the name the old backend used), else
 *   2. one random secret kept in the database (Setting "affairs-qr-secret"),
 *      created once — so the office PC and the hosted server, which share the
 *      database, always verify the same cards, and a restart / redeploy never
 *      turns issued cards into "fake".
 * Changing the secret makes every issued ID card fake, so it is never rotated here.
 */
const crypto = require('crypto');

const PREFIX = 'AUSA1.';
const SETTING_KEY = 'affairs-qr-secret';
let _key = null;
let _loading = null;

async function loadKey() {
  const env = process.env.AFFAIRS_QR_SECRET || process.env.QR_SECRET || '';
  if (env) {
    if (env.length < 16) throw new Error('AFFAIRS_QR_SECRET is too short (min 16 characters).');
    return crypto.createHash('sha256').update(env).digest();
  }
  const Setting = require('../models/Setting');
  let row = await Setting.findOne({ key: SETTING_KEY }).lean();
  if (!row || !row.value || String(row.value.secret || '').length < 32) {
    const secret = crypto.randomBytes(32).toString('hex');
    // insert only if still missing (two servers starting together keep ONE secret)
    await Setting.updateOne({ key: SETTING_KEY },
      { $setOnInsert: { value: { secret, createdAt: new Date() } } }, { upsert: true })
      .catch((e) => { if (e && e.code !== 11000) throw e; });
    row = await Setting.findOne({ key: SETTING_KEY }).lean();
    if (!row || !row.value || String(row.value.secret || '').length < 32) throw new Error('Student Affairs QR secret is not available.');
  }
  return crypto.createHash('sha256').update(String(row.value.secret)).digest();
}
async function key() {
  if (_key) return _key;
  if (!_loading) _loading = loadKey().then((k) => { _key = k; return k; }).finally(() => { _loading = null; });
  return _loading;
}

async function seal(regNo, cardKey) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', await key(), iv);
  const ct = Buffer.concat([c.update(`${regNo}\n${cardKey}`, 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}
async function open(token) {
  if (typeof token !== 'string' || !token.startsWith(PREFIX) || token.length > 400) return null;
  const k = await key();
  try {
    const raw = Buffer.from(token.slice(PREFIX.length), 'base64url');
    if (raw.length < 30) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', k, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const [regNo, cardKey] = Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8').split('\n');
    return regNo && cardKey ? { regNo, cardKey } : null;
  } catch { return null; }   // tampered / forged / made with another secret
}
const newKey = () => crypto.randomBytes(18).toString('base64url');
const hash = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');
function sameHash(a, b) {
  const x = Buffer.from(a || '', 'hex'); const y = Buffer.from(b || '', 'hex');
  return x.length === 32 && y.length === 32 && crypto.timingSafeEqual(x, y);
}

module.exports = { PREFIX, seal, open, newKey, hash, sameHash, _reset: () => { _key = null; } };
