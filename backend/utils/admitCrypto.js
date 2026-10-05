/**
 * Admit-card QR security.
 *
 * Every admit card carries a QR whose token is UNFORGEABLE and every (student,
 * paper) pair gets its own 64-bit verification key. Both are keyed on a single
 * server secret that lives ONLY on the backend (env var or an auto-generated,
 * git-ignored file) — it is never sent to the browser and never baked into the
 * QR in a recoverable form.
 *
 *   token   = <qid:16hex> + <sig:16hex>   where sig = HMAC(secret, "tok|"+qid)
 *             → a QR made up by hand cannot produce a valid sig, so it is
 *               rejected before any database lookup.
 *   key     = HMAC(secret, "key|token|code|date|slot")  (first 64 bits)
 *             → one per paper, all different, one-way (never decryptable),
 *               only re-computable by the server that holds the secret.
 *
 * Verification is pass/fail only; the key itself is never returned to a client.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET_FILE = path.join(__dirname, '..', '.admit_secret');

function loadSecret() {
  const env = process.env.ADMIT_VERIFY_SECRET;
  if (env && env.length >= 16) return env;
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const s = fs.readFileSync(SECRET_FILE, 'utf-8').trim();
      if (s.length >= 16) return s;
    }
  } catch { /* fall through to generate */ }
  const gen = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(SECRET_FILE, gen, { mode: 0o600 });
    console.warn('[admitCrypto] Generated a new admit-verification secret at '
      + `${SECRET_FILE}. Keep it stable — regenerating it invalidates every `
      + 'previously issued admit-card QR. Set ADMIT_VERIFY_SECRET to override.');
  } catch (e) {
    console.error('[admitCrypto] Could not persist the admit secret:', e.message);
  }
  return gen;
}

const SECRET = loadSecret();

const h16 = (msg) =>
  crypto.createHmac('sha256', SECRET).update(String(msg)).digest('hex').slice(0, 16);

/** Signature bound to a random id — the second half of a token. */
const tokenSig = (qid) => h16(`tok|${qid}`);

/**
 * Validate a scanned token's shape + signature (constant-time). Returns the
 * random id when genuine, or null for anything hand-made / tampered / wrong
 * length. This runs BEFORE any DB lookup so forgeries never touch the database.
 */
function verifyToken(token) {
  const t = String(token || '');
  if (!/^[0-9a-f]{32}$/i.test(t)) return null;
  const qid = t.slice(0, 16);
  const sig = t.slice(16).toLowerCase();
  const good = tokenSig(qid);
  const a = Buffer.from(sig); const b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return qid;
}

/** The 64-bit key for one (student-token, paper). Deterministic + one-way. */
const paperKey = (token, code, date, slot) => h16(`key|${token}|${code}|${date}|${slot}`);

/** Constant-time string compare that never throws on length mismatch. */
function safeEqual(x, y) {
  const a = Buffer.from(String(x == null ? '' : x));
  const b = Buffer.from(String(y == null ? '' : y));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { SECRET, tokenSig, verifyToken, paperKey, safeEqual };
