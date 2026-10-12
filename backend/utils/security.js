/**
 * security.js — shared hardening helpers (no extra npm packages needed).
 *
 *   securityHeaders()   strict browser security headers (CSP, HSTS, no-sniff, …)
 *   corsDelegate        CORS: only the configured origins (or same-origin)
 *   sanitizeInput       strips MongoDB operator keys ($gt, $where…) from input
 *   rateLimit(opts)     small in-memory rate limiter (per IP / per key)
 *   DEFAULT_PASSWORDS   the factory passwords every account starts with
 *   isDefaultPassword   true when a plain password is one of the defaults
 *   checkPasswordPolicy rules a NEW password must satisfy
 */
const crypto = require('crypto');

// ── Default / factory passwords ────────────────────────────────────────────────
// Any account that signs in with one of these is forced to set its own password
// before it can use the system.
const DEFAULT_PASSWORDS = ['student123', 'faculty123', 'finance123', 'admin123'];
const ROLE_DEFAULT = { student: 'student123', faculty: 'faculty123', finance: 'finance123', admin: 'admin123' };
const isDefaultPassword = (plain) => DEFAULT_PASSWORDS.includes(String(plain || '').trim().toLowerCase());

// Weak passwords that are refused as a NEW password.
const COMMON = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwerty123',
  'abc12345', 'iloveyou', 'admin1234', 'welcome1', 'welcome123', 'abasyn123', 'abasyn@123',
  'pakistan', 'pakistan123', '11111111', '00000000', 'letmein1', 'changeme', 'student1234',
]);

/**
 * Returns an error message when `plain` is not acceptable as a new password, else null.
 * Rules: 8–72 chars, at least one letter AND one number, not a default/common
 * password, not the username / registration number, no spaces at the ends.
 */
function checkPasswordPolicy(plain, user = {}) {
  const p = String(plain == null ? '' : plain);
  if (p.length < 8) return 'Password must be at least 8 characters long.';
  if (p.length > 72) return 'Password is too long (maximum 72 characters).';
  if (p !== p.trim()) return 'Password cannot start or end with a space.';
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return 'Password must contain at least one letter and one number.';
  const low = p.toLowerCase();
  if (isDefaultPassword(low)) return 'You cannot use a default password. Choose your own password.';
  if (COMMON.has(low)) return 'This password is too common. Choose a stronger one.';
  const ids = [user.username, user.regNo, user.email && String(user.email).split('@')[0]]
    .map((x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '')).filter((x) => x.length >= 4);
  const flat = low.replace(/[^a-z0-9]/g, '');
  if (ids.some((id) => flat === id || flat.includes(id))) return 'Password cannot contain your username or registration number.';
  if (/^(.)\1+$/.test(p)) return 'Password cannot be one repeated character.';
  return null;
}

// ── Security headers (helmet-style) ────────────────────────────────────────────
function securityHeaders() {
  const isProd = process.env.NODE_ENV === 'production';
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: data:",
    "connect-src 'self'",
    "frame-src 'self' blob: data:",
    "worker-src 'self' blob:",
  ].join('; ');
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('X-Download-Options', 'noopen');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), interest-cohort=()');
    // CSP only on the web pages we serve (not on JSON / file downloads)
    if (isProd && !req.path.startsWith('/api/')) res.setHeader('Content-Security-Policy', csp);
    if (isProd && (req.secure || req.headers['x-forwarded-proto'] === 'https')) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    // API responses (tokens, personal data) are never cached by browsers / proxies
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  };
}

// ── CORS ───────────────────────────────────────────────────────────────────────
// CLIENT_ORIGIN = comma-separated list of allowed web origins. When it is unset
// (or "*"), only same-origin pages are allowed — the built frontend is served by
// this same server. Requests with NO Origin header (the mobile scanner app,
// curl, server-to-server) are not affected by CORS and are allowed.
function corsDelegate(req, cb) {
  const origin = req.header('Origin');
  const list = String(process.env.CLIENT_ORIGIN || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  const allowAll = list.includes('*') && process.env.NODE_ENV !== 'production';
  let ok = !origin || allowAll || list.includes(origin);
  if (!ok && origin) {
    const host = req.get('host');
    try { ok = new URL(origin).host === host; } catch { ok = false; }
    // local dev (vite on :5173 proxying to :5000)
    if (!ok && process.env.NODE_ENV !== 'production') ok = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  }
  cb(null, {
    origin: ok ? (origin || true) : false,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  });
}

// ── NoSQL-injection guard ──────────────────────────────────────────────────────
// Removes keys that start with "$" (Mongo operators) or contain "." from body,
// query and params, so input like {"username":{"$ne":null}} can never reach a query.
function _clean(v, depth = 0) {
  if (depth > 12 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = _clean(v[i], depth + 1); return v; }
  for (const k of Object.keys(v)) {
    if (k.startsWith('$') || k.includes('.') || k === '__proto__' || k === 'constructor' || k === 'prototype') { delete v[k]; continue; }
    v[k] = _clean(v[k], depth + 1);
  }
  return v;
}
function sanitizeInput(req, _res, next) {
  try {
    if (req.body && typeof req.body === 'object') _clean(req.body);
    if (req.params && typeof req.params === 'object') _clean(req.params);
    if (req.query && typeof req.query === 'object') {
      // Express 4 query object is writable; clean in place
      for (const k of Object.keys(req.query)) {
        if (k.startsWith('$') || k.includes('.')) delete req.query[k];
        else if (req.query[k] && typeof req.query[k] === 'object') _clean(req.query[k]);
      }
    }
  } catch { /* never block a request because of the cleaner */ }
  next();
}

// ── Rate limiting (in-memory, per process) ─────────────────────────────────────
function clientIp(req) {
  return String(req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}
function rateLimit({ windowMs = 60_000, max = 100, keyFn = clientIp, message = 'Too many requests. Please slow down and try again shortly.' } = {}) {
  const hits = new Map();   // key -> { count, reset }
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, Math.min(windowMs, 60_000));
  if (timer.unref) timer.unref();
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset <= now) { h = { count: 0, reset: now + windowMs }; hits.set(key, h); }
    h.count += 1;
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - h.count)));
    if (h.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

// ── JWT secret ─────────────────────────────────────────────────────────────────
// A missing / weak secret would let anyone forge a login token. If none is set we
// generate a strong random one for this run (users must sign in again after a
// restart) and warn loudly.
function ensureJwtSecret() {
  const s = process.env.JWT_SECRET || '';
  const unsafe = !s || s.length < 16 || /change-me/i.test(s);
  const weak = unsafe || s.length < 32;
  if (weak) {
    if (unsafe) {
      process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
      console.warn('⚠ JWT_SECRET is missing or weak — using a random secret for this run (everyone must sign in again after a restart).');
      console.warn('  Set a long random JWT_SECRET (64+ characters) in backend/.env to keep sessions across restarts.');
    } else {
      console.warn('⚠ JWT_SECRET looks weak. Use a long random value (64+ characters) in backend/.env.');
    }
  }
}

module.exports = {
  DEFAULT_PASSWORDS, ROLE_DEFAULT, isDefaultPassword, checkPasswordPolicy,
  securityHeaders, corsDelegate, sanitizeInput, rateLimit, clientIp, ensureJwtSecret,
};
