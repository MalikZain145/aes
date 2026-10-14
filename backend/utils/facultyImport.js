/**
 * facultyImport.js — load the faculty rosters into Teacher records + faculty logins.
 *
 *   Faculty_List.xlsx   (#, Name, Designation). Rows highlighted YELLOW → no invigilation.
 *                        "Adjunct" / "Visiting" in the designation or name → Visiting/Adjunct.
 *   All_Faculity.xlsx   (Full Name, Email Address) → e-mails (+ any faculty not yet in the system)
 *
 * The Faculty List IS the faculty: every teacher record not on it is removed (JSON backup in
 * scheduler/output) together with its faculty login. A list name that matches an existing
 * record (titles, "M."/"Muhammad", dots, doubled letters ignored; close spellings allowed)
 * keeps that record — its Faculty ID, login and the course-report spelling (kept as an alias,
 * so the "never invigilate your own paper" check still recognises the person).
 * All_Faculity only supplies e-mails.
 *
 * Invigilation: yellow row or visiting/adjunct → OFF; everyone else ON.
 *
 * Every teacher gets a random, unique 4-digit Faculty ID and a Faculty Portal login:
 *   username = e-mail (or "fac<ID>" when there is no e-mail) · password faculty123 ·
 *   must change it on first sign-in. Existing passwords are never touched.
 */
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');
const Teacher = require('../models/Teacher');
const User = require('../models/User');
const Course = require('../models/Course');
const { makeMatcher, displayName } = require('./facultyNames');

const DEFAULT_PASSWORD = 'faculty123';
const VISITING_RX = /visiting|adjunct/i;
const isYellow = (cell) => {
  const fg = cell && cell.s && cell.s.fgColor;
  if (!fg) return false;
  const rgb = String(fg.rgb || '').toUpperCase().slice(-6);
  return rgb === 'FFFF00' || fg.indexed === 13;
};

/** Faculty_List.xlsx → [{ name, designation, yellow, visiting }] */
function readFacultyList(file) {
  const wb = XLSX.readFile(file, { cellStyles: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: true });
  const { s: { r: r0, c: c0 } } = XLSX.utils.decode_range(ws['!ref'] || 'A1');   // sheet may not start at A1
  // find the name column: the column with the most multi-word text cells
  const width = Math.max(...rows.map((r) => r.length), 0);
  let nameCol = 1, best = -1;
  for (let c = 0; c < width; c++) {
    const n = rows.filter((r) => typeof r[c] === 'string' && /[a-z]{2,}\s+[a-z]/i.test(r[c]) && !/designation|name/i.test(r[c])).length;
    if (n > best) { best = n; nameCol = c; }
  }
  const out = [];
  rows.forEach((r, i) => {
    const name = typeof r[nameCol] === 'string' ? r[nameCol].trim() : '';
    if (!name || /^(name|faculty name)$/i.test(name)) return;
    const designation = String(r[nameCol + 1] || '').replace(/\s+/g, ' ').trim();
    const addr = (c) => XLSX.utils.encode_cell({ r: i + r0, c: c + c0 });
    const yellow = isYellow(ws[addr(nameCol)]) || isYellow(ws[addr(nameCol + 1)]);
    out.push({ name, designation, yellow, visiting: VISITING_RX.test(`${name} ${designation}`) });
  });
  return out;
}

/** All_Faculity.xlsx → [{ name, email }] */
function readAllFaculty(file) {
  const wb = XLSX.readFile(file);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  const out = [];
  for (const r of rows) {
    const keys = Object.keys(r);
    const nk = keys.find((k) => /name/i.test(k));
    const ek = keys.find((k) => /mail/i.test(k));
    const name = String(r[nk] || '').trim();
    const email = String(r[ek] || '').trim().toLowerCase();
    if (name) out.push({ name, email: /@/.test(email) ? email : '' });
  }
  return out;
}

async function uniqueIds(count, taken) {
  const ids = [];
  const pool = [];
  for (let n = 1000; n <= 9999; n++) if (!taken.has(String(n))) pool.push(String(n));
  for (let i = 0; i < count && pool.length; i++) {
    const j = Math.floor(Math.random() * pool.length);
    ids.push(pool[j]);
    pool[j] = pool[pool.length - 1];
    pool.pop();
  }
  return ids;
}

async function importFaculty({ facultyList, allFaculty, log = console.log } = {}) {
  const FL = facultyList ? readFacultyList(facultyList) : [];
  const AF = allFaculty ? readAllFaculty(allFaculty) : [];
  if (!FL.length) throw new Error('Faculty_List has no names — nothing imported.');
  const fs = require('fs');
  const path = require('path');

  const existing = await Teacher.find({}).lean();
  const matchT = makeMatcher(existing, (t) => [t.name, ...(t.aliases || [])]);
  const matchAF = makeMatcher(AF);
  const claimed = new Map();          // existing _id → plan entry
  const plan = [];
  const usedEmail = new Set();
  const stats = { facultyList: FL.length, yellow: 0, visiting: 0, matched: 0, created: 0, removed: 0, emails: 0, loginsRemoved: 0 };

  for (const f of FL) {
    let t = matchT(f.name);
    if (t && claimed.has(String(t._id))) t = null;           // two list rows → one record? keep both
    const name = displayName(f.name);
    const a = matchAF(f.name) || (t ? matchAF(t.name) : null);
    let email = (a && a.email) || (t && t.email) || '';
    if (email && usedEmail.has(email)) email = '';
    if (email) usedEmail.add(email);
    const aliases = [...new Set([...(t ? [t.name, ...(t.aliases || [])] : []), f.name.trim(), a ? a.name : ''].map((x) => String(x || '').trim()).filter((x) => x && x !== name))];
    const e = {
      _id: t ? t._id : null, name, email, aliases,
      designation: f.designation || '', inFacultyList: true, isVisiting: !!f.visiting,
      allowInvigilation: !f.yellow && !f.visiting, listYellow: !!f.yellow, active: true,
      department: (t && t.department) || '', facultyId: (t && /^\d{4}$/.test(t.facultyId || '')) ? t.facultyId : '',
    };
    if (t) { claimed.set(String(t._id), e); stats.matched++; } else stats.created++;
    if (email) stats.emails++;
    if (f.yellow) stats.yellow++;
    if (f.visiting) stats.visiting++;
    plan.push(e);
  }
  // two list rows with the same cleaned name → keep them apart
  const seenName = new Map();
  for (const e of plan) { const k = e.name.toLowerCase(); const n = (seenName.get(k) || 0) + 1; seenName.set(k, n); if (n > 1) e.name = `${e.name} (${n})`; }

  // 1) everyone NOT on the Faculty List is removed (backup first) + their faculty logins
  const remove = existing.filter((t) => !claimed.has(String(t._id)));
  const keepIds = new Set(plan.filter((e) => e._id).map((e) => String(e._id)));
  if (remove.length) {
    try {
      const OUT = path.join(__dirname, '..', '..', 'scheduler', 'output');
      if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, `backup_removed_teachers_${Date.now()}.json`), JSON.stringify(remove, null, 1));
    } catch { /* backup best-effort */ }
    await Teacher.deleteMany({ _id: { $in: remove.map((t) => t._id) } });
    stats.removed = remove.length;
  }
  const keepEmails = new Set(plan.map((e) => e.email).filter(Boolean));
  const oldFaculty = await User.find({ role: 'faculty' }).select('_id teacherId username').lean();
  const dropUsers = oldFaculty.filter((u) => !(u.teacherId && keepIds.has(String(u.teacherId))) && !keepEmails.has(u.username));
  if (dropUsers.length) {
    await User.deleteMany({ _id: { $in: dropUsers.map((u) => u._id) } });
    stats.loginsRemoved = dropUsers.length;
  }

  // 2) save the Faculty List (names cleared first, so a rename never hits the unique index)
  const tmp = (id) => `__tmp_${id}`;
  for (const e of plan) if (e._id) await Teacher.updateOne({ _id: e._id }, { $set: { name: tmp(e._id) } });
  for (const e of plan) {
    const doc = { name: e.name, email: e.email, aliases: e.aliases, designation: e.designation, inFacultyList: true, listYellow: e.listYellow,
      isVisiting: e.isVisiting, allowInvigilation: e.allowInvigilation, active: true, department: e.department, facultyId: e.facultyId };
    if (e._id) await Teacher.updateOne({ _id: e._id }, { $set: doc });
    else e._id = (await Teacher.create(doc))._id;
  }
  // a kept login whose e-mail changed → follows its teacher
  for (const e of plan) {
    if (!e.email) continue;
    const u = await User.findOne({ role: 'faculty', teacherId: e._id }).lean();
    if (u && u.username !== e.email && !(await User.exists({ username: e.email }))) await User.updateOne({ _id: u._id }, { $set: { username: e.email, email: e.email, name: e.name } });
  }

  // 3) 4-digit Faculty IDs + logins (faculty123)
  const logins = await ensureFacultyAccounts();
  stats.loginsCreated = logins.created;
  stats.teachers = await Teacher.countDocuments({ active: true });
  stats.allowed = await Teacher.countDocuments({ active: true, allowInvigilation: { $ne: false }, isVisiting: { $ne: true } });
  const msg = `faculty list ${stats.facultyList} (yellow ${stats.yellow}, visiting/adjunct ${stats.visiting}) · matched ${stats.matched}, new ${stats.created} · `
    + `removed ${stats.removed} old teacher(s) + ${stats.loginsRemoved} faculty login(s) · e-mails ${stats.emails} · `
    + `logins created ${stats.loginsCreated} · teachers now ${stats.teachers} (${stats.allowed} may invigilate)`;
  log(`✓ Faculty imported: ${msg}`);
  return { stats, summary: msg };
}

/**
 * Faculty Portal login for every active teacher (idempotent). username = e-mail, or
 * "fac<FacultyID>" when no e-mail. Never changes an existing password or an admin/finance/student account.
 */
async function ensureFacultyAccounts() {
  // any teacher without a 4-digit Faculty ID (added by an import / the Courses page) gets one now
  const missing = await Teacher.find({ facultyId: { $not: /^\d{4}$/ } }).select('_id').lean();
  if (missing.length) {
    const taken = new Set((await Teacher.find({ facultyId: /^\d{4}$/ }).select('facultyId').lean()).map((t) => t.facultyId));
    const ids = await uniqueIds(missing.length, taken);
    for (let i = 0; i < missing.length && i < ids.length; i++) await Teacher.updateOne({ _id: missing[i]._id }, { $set: { facultyId: ids[i] } });
  }
  const teachers = await Teacher.find({ active: true }).lean();
  const hash = await bcrypt.hash(DEFAULT_PASSWORD, await bcrypt.genSalt(10));
  const usernames = teachers.map((t) => (t.email || (t.facultyId ? `fac${t.facultyId}` : ''))).filter(Boolean);
  const users = await User.find({ $or: [{ username: { $in: usernames } }, { teacherId: { $in: teachers.map((t) => t._id) } }] }).lean();
  const byUsername = new Map(users.map((u) => [u.username, u]));
  const byTeacher = new Map(users.filter((u) => u.teacherId).map((u) => [String(u.teacherId), u]));
  let created = 0, linked = 0;
  const now = new Date();
  for (const t of teachers) {
    let u = byTeacher.get(String(t._id));
    const username = (t.email || (t.facultyId ? `fac${t.facultyId}` : '')).toLowerCase();
    if (!u && username) u = byUsername.get(username);
    if (u) {
      if (u.role === 'faculty') {
        const upd = {};
        if (String(u.teacherId || '') !== String(t._id)) upd.teacherId = t._id;
        if (!u.name) upd.name = t.name;
        if (Object.keys(upd).length) await User.updateOne({ _id: u._id }, { $set: upd });
        if (String(t.userId || '') !== String(u._id)) { await Teacher.updateOne({ _id: t._id }, { $set: { userId: u._id } }); linked++; }
      }
      continue;
    }
    if (!username) continue;
    try {
      const doc = await User.create({
        role: 'faculty', username, email: t.email || '', name: t.name, department: t.department || '',
        teacherId: t._id, passwordHash: hash, passwordChangedAt: now, mustChangePassword: true,
      });
      await Teacher.updateOne({ _id: t._id }, { $set: { userId: doc._id } });
      byUsername.set(username, doc);
      created++;
    } catch (e) {
      if (e.code !== 11000) throw e;
    }
  }
  return { created, linked, total: await User.countDocuments({ role: 'faculty' }) };
}

module.exports = { importFaculty, ensureFacultyAccounts, readFacultyList, readAllFaculty, DEFAULT_PASSWORD };
