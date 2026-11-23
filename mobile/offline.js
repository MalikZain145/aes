/**
 * Offline scanning — the exam hall may have weak or no internet.
 *
 *  • An OFFLINE PACK of every issued admit card is downloaded whenever the phone
 *    is online (on open, every few minutes, when the app comes back to the screen).
 *    Each card's details are encrypted with its own QR token, so the pack reveals
 *    nothing to anyone who does not hold the printed card.
 *  • A scanned card is checked ON THE PHONE first — instantly, no network needed.
 *    Only a card that is not in the pack (e.g. issued a minute ago) goes online.
 *  • Attendance for a paper being written is QUEUED on the phone and uploaded in
 *    the background (and retried) — the server accepts a mark only if it was
 *    scanned during that paper's time.
 *
 * Pure JavaScript (no new native module): works on the installed APK through an
 * over-the-air update. If @react-native-async-storage/async-storage is present
 * (newer APK) the pack and the queue also survive an app restart.
 */
import { API_BASE } from './config';

const SERVER = String(API_BASE || '').trim().replace(/\/+$/, '');
const PACK_KEY = 'abasyn.scanner.pack.v1';
const QUEUE_KEY = 'abasyn.scanner.queue.v1';
const PKT_OFFSET_MIN = 5 * 60;   // Asia/Karachi, UTC+5, no daylight saving

// ── storage (persistent when available, else memory) ───────────────────────
let Store = null;
try { Store = require('@react-native-async-storage/async-storage').default; } catch { Store = null; }
const mem = {};
const storage = {
  persistent: !!Store,
  async get(k) { try { return Store ? await Store.getItem(k) : (mem[k] ?? null); } catch { return mem[k] ?? null; } },
  async set(k, v) { mem[k] = v; try { if (Store) await Store.setItem(k, v); } catch { /* memory copy kept */ } },
};

// ── SHA-256 (pure JS) ───────────────────────────────────────────────────────
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
export function sha256(bytes) {
  const l = bytes.length;
  const withPad = ((l + 9 + 63) >> 6) << 6;
  const m = new Uint8Array(withPad);
  m.set(bytes); m[l] = 0x80;
  const bits = l * 8;
  m[withPad - 4] = (bits >>> 24) & 255; m[withPad - 3] = (bits >>> 16) & 255; m[withPad - 2] = (bits >>> 8) & 255; m[withPad - 1] = bits & 255;
  m[withPad - 8] = Math.floor(bits / 2 ** 32) & 255;
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const r = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < withPad; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = (m[o + i * 4] << 24) | (m[o + i * 4 + 1] << 16) | (m[o + i * 4 + 2] << 8) | m[o + i * 4 + 3];
    for (let i = 16; i < 64; i++) {
      const s0 = r(W[i - 15], 7) ^ r(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = r(W[i - 2], 17) ^ r(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = r(e, 6) ^ r(e, 11) ^ r(e, 25);
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const S0 = r(a, 2) ^ r(a, 13) ^ r(a, 22);
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) { out[i * 4] = H[i] >>> 24; out[i * 4 + 1] = (H[i] >>> 16) & 255; out[i * 4 + 2] = (H[i] >>> 8) & 255; out[i * 4 + 3] = H[i] & 255; }
  return out;
}
export function utf8(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) { c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00); }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}
function fromUtf8(b) {
  let s = ''; let i = 0;
  while (i < b.length) {
    const c = b[i++];
    if (c < 0x80) s += String.fromCharCode(c);
    else if (c < 0xe0) s += String.fromCharCode(((c & 31) << 6) | (b[i++] & 63));
    else if (c < 0xf0) s += String.fromCharCode(((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63));
    else {
      const cp = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
      const u = cp - 0x10000; s += String.fromCharCode(0xd800 + (u >> 10), 0xdc00 + (u & 1023));
    }
  }
  return s;
}
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function fromBase64(s) {
  const clean = String(s).replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0; let buf = 0; let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    buf = (buf << 6) | B64.indexOf(clean[i]); bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 255; }
  }
  return out.slice(0, o);
}
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export const indexOf = (token) => hex(sha256(utf8(`abasyn-pack|h|${token}`))).slice(0, 32);
export function decrypt(token, b64) {
  const key = sha256(utf8(`abasyn-pack|k|${token}`));
  const data = fromBase64(b64);
  const out = new Uint8Array(data.length);
  for (let i = 0, blk = 0; i < data.length; blk++) {
    const kb = new Uint8Array(36); kb.set(key);
    kb[32] = (blk >>> 24) & 255; kb[33] = (blk >>> 16) & 255; kb[34] = (blk >>> 8) & 255; kb[35] = blk & 255;
    const ks = sha256(kb);
    for (let j = 0; j < 32 && i < data.length; j++, i++) out[i] = data[i] ^ ks[j];
  }
  return JSON.parse(fromUtf8(out));
}

// ── clock: server-corrected, Pakistan time ─────────────────────────────────
let clockSkew = 0;   // serverTime - phone time (ms), learnt at each pack download
export function examNow() {
  const t = new Date(Date.now() + clockSkew + PKT_OFFSET_MIN * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return { ms: Date.now() + clockSkew, date: `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`, minutes: t.getUTCHours() * 60 + t.getUTCMinutes() };
}
function toMinutes(hhmm) {   // '01:00' on the exam clock = 1 PM (hours 1–7 are afternoon)
  const m = String(hhmm || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  let h = Number(m[1]); if (h >= 1 && h <= 7) h += 12;
  return h * 60 + Number(m[2]);
}

// ── pack ────────────────────────────────────────────────────────────────────
let pack = null;            // { generatedAt, fetchedAt, batches, map: Map(index → data) }
let loaded = false;
async function loadPack() {
  if (loaded) return pack;
  loaded = true;
  try {
    const raw = await storage.get(PACK_KEY);
    if (raw) { const p = JSON.parse(raw); pack = { ...p, map: new Map(p.entries) }; clockSkew = p.clockSkew || 0; }
  } catch { pack = null; }
  return pack;
}
export async function refreshPack(timeoutMs = 20000) {
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs);
    const r = await fetch(`${SERVER}/api/scanner/pack`, { signal: c.signal });
    clearTimeout(t);
    if (!r.ok) return false;
    const p = await r.json();
    if (!p || !Array.isArray(p.entries)) return false;
    clockSkew = Number(p.serverTime) ? Number(p.serverTime) - Date.now() : 0;
    const keep = { generatedAt: p.generatedAt, fetchedAt: Date.now(), batches: p.batches || {}, count: p.entries.length, clockSkew, entries: p.entries };
    pack = { ...keep, map: new Map(p.entries) };
    storage.set(PACK_KEY, JSON.stringify(keep));   // best-effort
    return true;
  } catch { return false; }
}
export async function packInfo() {
  await loadPack();
  const q = await loadQueue();
  return { cards: pack ? pack.count || pack.map.size : 0, fetchedAt: pack ? pack.fetchedAt : 0, waiting: q.length, persistent: storage.persistent };
}

// ── attendance queue ────────────────────────────────────────────────────────
let queue = null;
async function loadQueue() {
  if (queue) return queue;
  try { queue = JSON.parse((await storage.get(QUEUE_KEY)) || '[]'); } catch { queue = []; }
  if (!Array.isArray(queue)) queue = [];
  return queue;
}
async function saveQueue() { await storage.set(QUEUE_KEY, JSON.stringify(queue || [])); }
async function enqueue(marks) {
  await loadQueue();
  const have = new Set(queue.map((m) => `${m.token}|${m.code}|${m.date}|${m.slot}`));
  for (const m of marks) if (!have.has(`${m.token}|${m.code}|${m.date}|${m.slot}`)) queue.push(m);
  await saveQueue();
}
let flushing = false;
export async function flushQueue(timeoutMs = 20000) {
  if (flushing) return { sent: 0 };
  flushing = true;
  try {
    await loadQueue();
    if (!queue.length) return { sent: 0 };
    const batch = queue.slice(0, 200);
    const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs);
    const r = await fetch(`${SERVER}/api/scanner/attendance`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ marks: batch }), signal: c.signal,
    });
    clearTimeout(t);
    if (!r.ok) return { sent: 0 };
    const j = await r.json();
    // keep only marks the server asked to retry (a passing DB hiccup); drop the rest
    const retry = new Set((j.results || []).filter((x) => !x.ok && x.retry).map((x) => x.i));
    const sent = batch.filter((_, i) => !retry.has(i));
    const sentKeys = new Set(sent.map((m) => `${m.token}|${m.code}|${m.date}|${m.slot}`));
    queue = queue.filter((m) => !sentKeys.has(`${m.token}|${m.code}|${m.date}|${m.slot}`));
    await saveQueue();
    return { sent: j.accepted || 0 };
  } catch { return { sent: 0 }; } finally { flushing = false; }
}

// ── offline check of one card ──────────────────────────────────────────────
/** Returns the same shape as GET /api/verify/:token, with offline:true — or null if not in the pack. */
export async function verifyOffline(token) {
  await loadPack();
  if (!pack || !pack.map) return null;
  const enc = pack.map.get(indexOf(token));
  if (!enc) return null;
  let d;
  try { d = decrypt(token, enc); } catch { return null; }
  const now = examNow();
  const student = { name: d.n, registrationNo: d.r, degree: d.p, batch: d.b };
  const end = d.bid && pack.batches ? pack.batches[d.bid] : null;
  if (end && (now.date > end.date || (now.date === end.date && now.minutes > (toMinutes(String(end.slot).split('-')[1]) ?? 1e9)))) {
    return { ok: true, offline: true, revoked: true, revokedLabel: d.l, message: 'Admit Card Revoked. Do not allow entry.', student, feeStatus: d.f, status: 'over', today: [] };
  }
  const exams = (d.e || []).slice().sort((a, b) => (a.d + a.st).localeCompare(b.d + b.st));
  const todays = exams.filter((e) => e.d === now.date);
  let status = 'no_today';
  if (!exams.length) status = 'no_exams';
  else if (todays.length) status = 'today';
  else if (now.date > exams[exams.length - 1].d) status = 'over';
  const today = todays.map((e) => {
    const st = toMinutes(e.st); const fi = toMinutes(e.fi);
    let state = 'upcoming';
    if (st != null && fi != null) { if (now.minutes >= st && now.minutes <= fi) state = 'active'; else if (now.minutes > fi) state = 'completed'; }
    return { code: e.c, name: e.nm, teacher: e.t, date: e.d, dateDisp: e.dd, day: e.dy, slot: e.s, start: e.st, finish: e.fi, room: e.rm, seat: e.se, section: e.sec, state };
  });
  const active = today.filter((e) => e.state === 'active');
  if (active.length) {
    await enqueue(active.map((e) => ({ token, code: e.code, date: e.date, slot: e.slot, at: now.ms })));
    flushQueue().catch(() => {});   // upload now if the network allows; else later
  }
  return {
    ok: true, offline: true, student, feeStatus: d.f || 'Paid', heading: d.hd, status, today,
    attendanceMarked: active.length > 0, attendanceCourses: active.map((e) => e.code), attendanceQueued: active.length > 0,
  };
}
