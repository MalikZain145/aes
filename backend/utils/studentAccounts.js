/**
 * studentAccounts.js — every registered student automatically gets a Student
 * Portal login.
 *
 *   username = registration number (lower-cased, letters/digits only, e.g. "10237")
 *   password = student123   (student is asked to change it on first sign-in)
 *
 * ensureStudentAccounts()  — idempotent: creates the missing logins for every
 *   StudentRegistration, and fills a blank name / batch / program on existing
 *   student logins. It NEVER changes a password, role or an account's active flag.
 *
 * startStudentAccountSync() — runs ensureStudentAccounts() once when the server
 *   starts, then watches for new registration records (cheap check every 2 minutes:
 *   record count + last update time) and creates logins for any new reg numbers.
 *
 * kickStudentAccountSync() — called right after an import so new students can
 *   sign in immediately instead of waiting for the next check.
 */
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const StudentRegistration = require('../models/StudentRegistration');

const DEFAULT_PASSWORD = 'student123';
const CHECK_EVERY_MS = 2 * 60 * 1000;

// same username rule as the roster upload / "Create logins" button
const usernameOf = (reg) => String(reg == null ? '' : reg).replace(/[^a-z0-9]/gi, '').toLowerCase();

let _defaultHash = null;
async function defaultHash() {
  if (!_defaultHash) _defaultHash = await bcrypt.hash(DEFAULT_PASSWORD, await bcrypt.genSalt(10));
  return _defaultHash;
}

let _running = null;

/** Create missing student logins from StudentRegistration. Returns { created, updated, total }. */
async function ensureStudentAccounts() {
  if (_running) return _running;          // never run two syncs at once
  _running = (async () => {
    const regs = await StudentRegistration.find({ studentId: { $nin: ['', null] } })
      .select('studentId name program batch').lean();
    if (!regs.length) return { created: 0, updated: 0, total: await User.countDocuments({ role: 'student' }) };

    const users = await User.find({ username: { $in: regs.map((r) => usernameOf(r.studentId)).filter(Boolean) } })
      .select('username role name batch degree regNo').lean();
    const byUsername = new Map(users.map((u) => [u.username, u]));

    const toCreate = [];
    const toFill = [];
    const seen = new Set();
    for (const r of regs) {
      const username = usernameOf(r.studentId);
      if (!username || seen.has(username)) continue;
      seen.add(username);
      const u = byUsername.get(username);
      if (!u) {
        toCreate.push({
          username, role: 'student', regNo: String(r.studentId).trim(),
          name: r.name || '', batch: r.batch || '', degree: r.program || '',
          mustChangePassword: true, active: true,
        });
        continue;
      }
      if (u.role !== 'student') continue;   // a staff account with the same username is never touched
      const set = {};
      if (!u.name && r.name) set.name = r.name;
      if (!u.batch && r.batch) set.batch = r.batch;
      if (!u.degree && r.program) set.degree = r.program;
      if (!u.regNo) set.regNo = String(r.studentId).trim();
      if (Object.keys(set).length) toFill.push({ updateOne: { filter: { _id: u._id }, update: { $set: set } } });
    }

    let created = 0;
    if (toCreate.length) {
      const passwordHash = await defaultHash();
      try {
        const res = await User.insertMany(toCreate.map((d) => ({ ...d, passwordHash })), { ordered: false });
        created = res.length;
      } catch (e) {
        // duplicate usernames created in parallel — keep the ones that went in
        if (e && (e.code === 11000 || (e.writeErrors || []).every((w) => (w.code || (w.err && w.err.code)) === 11000))) {
          created = (e.insertedDocs || []).length || (e.result && e.result.insertedCount) || 0;
        } else throw e;
      }
    }
    if (toFill.length) await User.bulkWrite(toFill, { ordered: false });

    if (created) {
      try {
        const { logActivity } = require('./logger');
        await logActivity('students.provision', `Auto-created ${created} student portal login(s) (password: ${DEFAULT_PASSWORD}).`, 'success');
      } catch { /* logging is optional */ }
    }
    return { created, updated: toFill.length, total: await User.countDocuments({ role: 'student' }) };
  })();
  try { return await _running; } finally { _running = null; }
}

// ── automatic sync ───────────────────────────────────────────────────────────
let _timer = null;
let _lastSig = '';
async function _signature() {
  const [count, last] = await Promise.all([
    StudentRegistration.estimatedDocumentCount(),
    StudentRegistration.findOne({}).sort({ updatedAt: -1 }).select('updatedAt').lean(),
  ]);
  return `${count}|${last && last.updatedAt ? new Date(last.updatedAt).getTime() : 0}`;
}
async function _tick(force = false) {
  try {
    const sig = await _signature();
    if (!force && sig === _lastSig) return null;
    const r = await ensureStudentAccounts();
    _lastSig = sig;
    if (r.created) console.log(`✓ Student logins: ${r.created} new account(s) created (password "${DEFAULT_PASSWORD}") — ${r.total} total`);
    return r;
  } catch (e) {
    console.warn('Student login sync:', e.message);
    return null;
  }
}

/** Start the background sync (server start). */
function startStudentAccountSync() {
  if (_timer) return;
  _tick(true);
  _timer = setInterval(() => _tick(false), CHECK_EVERY_MS);
  if (_timer.unref) _timer.unref();
}

/** Run a sync now (after an import). Fire-and-forget safe. */
function kickStudentAccountSync() {
  return _tick(true);
}

module.exports = { ensureStudentAccounts, startStudentAccountSync, kickStudentAccountSync, usernameOf, DEFAULT_PASSWORD };
