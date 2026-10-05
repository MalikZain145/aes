/**
 * Exam Cell → email each person their OWN timetable.
 *
 * "Email now" builds, from the latest generated timetable, a personal weekly
 * schedule for every teacher (their courses only) and every student (their
 * registered courses only) — so nobody has to read the full university grid —
 * and emails it. Repeat clicks are incremental: anyone already emailed for this
 * timetable is skipped, so only the still-missing recipients get it.
 *
 * Emails: teachers come from the Teacher records; student emails come from the
 * student's DB account or an optional uploaded RegNo→Email list.
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const GeneratedFile = require('../models/GeneratedFile');
const Teacher = require('../models/Teacher');
const StudentRegistration = require('../models/StudentRegistration');
const User = require('../models/User');
const EmailDispatch = require('../models/EmailDispatch');
const { logActivity } = require('../utils/logger');
const { sendMail, isConfigured } = require('../utils/mailer');
const { OUTPUT_DIR } = require('../utils/pythonRunner');

const norm = (s) => String(s == null ? '' : s).replace(/[^a-z0-9]/gi, '').toUpperCase();
const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');
const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const slotStart = (slot) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(slot || '')); if (!m) return 9999;
  let h = +m[1]; if (h < 8) h += 12; return h * 60 + +m[2];
};
const isTBA = (t) => !t || /^tba$/i.test(String(t).trim());

function readSchedule(record) {
  const name = record && record.meta && record.meta.scheduleFile;
  if (!name) return null;
  const p = path.join(OUTPUT_DIR, path.basename(name));
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

// Merge the newest BS (ug) and MS (pg) timetables so every student/teacher gets
// their own classes regardless of which level was generated most recently.
// Each schedule's student_index is remapped onto the combined sessions array.
async function loadLatestTimetable() {
  const all = await GeneratedFile.find({ kind: 'timetable', status: 'ready' }).sort({ createdAt: -1 }).lean();
  if (!all.length) return null;

  const pickLevel = (lvl) => all.find((r) => ((r.meta && r.meta.level) || 'ug') === lvl) || null;
  const seen = new Set();
  const records = [pickLevel('ug'), pickLevel('pg')].filter(Boolean)
    .filter((r) => { const k = String(r._id); if (seen.has(k)) return false; seen.add(k); return true; });

  const sessions = [];
  const studentIndex = {};
  let anySchedule = false;
  for (const rec of records) {
    const sch = readSchedule(rec);
    if (!sch || !Array.isArray(sch.sessions)) continue;
    anySchedule = true;
    const offset = sessions.length;
    sessions.push(...sch.sessions);
    for (const [reg, idxs] of Object.entries(sch.student_index || {})) {
      if (!Array.isArray(idxs)) continue;
      if (!studentIndex[reg]) studentIndex[reg] = [];
      for (const i of idxs) studentIndex[reg].push(i + offset);
    }
  }

  const record = all[0];
  if (!anySchedule) return { record, schedule: null };
  return { record, schedule: { sessions, student_index: studentIndex } };
}

/** A clean weekly schedule table for one person. */
function renderTimetableHTML({ title, subtitle, who, sessions }) {
  const sorted = [...sessions].sort((a, b) =>
    (DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day)) || (slotStart(a.slot) - slotStart(b.slot)));
  const rows = sorted.map((s) => `<tr>
    <td>${s.day || ''}</td><td>${s.slot || ''}</td>
    <td><b>${s.code || ''}</b>${s.section ? ` (${s.section})` : ''}</td>
    <td>${s.name || ''}</td><td>${s.room || ''}</td>
    <td>${s.component === 'Lab' ? 'Lab' : 'Lecture'}</td></tr>`).join('');
  return `<div style="font-family:Segoe UI,Arial,sans-serif;color:#12261c;max-width:640px">
    <div style="background:linear-gradient(135deg,#198754,#0f3d2e);color:#fff;padding:18px;border-radius:14px 14px 0 0">
      <h2 style="margin:0;font-size:17px">Abasyn University Islamabad Campus</h2>
      <p style="margin:3px 0 0;font-size:12.5px;opacity:.92">${title}</p>
    </div>
    <div style="border:1px solid #d7e6dd;border-top:0;border-radius:0 0 14px 14px;padding:18px;font-size:13.5px">
      <p style="margin:0 0 4px">Dear <b>${who}</b>,</p>
      <p style="margin:0 0 14px;color:#5c6b63">${subtitle} Your weekly schedule for your ${sessions.length} class session(s):</p>
      <table style="width:100%;border-collapse:collapse;font-size:12.5px">
        <thead><tr>${['Day', 'Time', 'Course', 'Title', 'Room', 'Type'].map((h) => `<th style="background:#0f5132;color:#fff;text-align:left;padding:7px 9px;font-size:11.5px">${h}</th>`).join('')}</tr></thead>
        <tbody>${rows || '<tr><td colspan="6" style="padding:14px;text-align:center;color:#8a978f">No classes found.</td></tr>'}</tbody>
      </table>
      <p style="margin-top:14px;font-size:11.5px;color:#8a978f">Automated message from the Abasyn University Examination System. Only your own classes are shown.</p>
    </div></div>`;
}

// Optional uploaded RegNo → Email list (same tolerant parsing as the fee list).
function parseEmailList(filePath) {
  try {
    const wb = XLSX.readFile(filePath);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false, defval: '' });
    const H = { reg: ['registrationnumber', 'registrationno', 'registration', 'regno', 'reg', 'studentid', 'rollno', 'roll', 'id'], email: ['email', 'emailaddress', 'mail', 'studentemail'] };
    const mh = (h) => { const n = norm(h).toLowerCase(); for (const [k, a] of Object.entries(H)) if (a.includes(n)) return k; return null; };
    let hIdx = rows.findIndex((r) => r.some((c) => mh(c) === 'reg')); if (hIdx < 0) hIdx = 0;
    const header = rows[hIdx].map(mh); const cReg = header.indexOf('reg'), cEmail = header.indexOf('email');
    const map = new Map();
    if (cReg >= 0 && cEmail >= 0) for (let i = hIdx + 1; i < rows.length; i++) {
      const reg = String(rows[i][cReg] || '').trim(); const em = String(rows[i][cEmail] || '').trim();
      if (reg && em) { map.set(norm(reg), em); if (digits(reg)) map.set('D' + digits(reg), em); }
    }
    return map;
  } catch { return new Map(); }
}

// POST /api/timetable-email/dispatch  (admin; optional multipart studentList; body.kind = students|teachers|both)
exports.dispatch = async (req, res) => {
  const uploadPath = req.file && req.file.path;
  try {
    const kind = String(req.body.kind || 'both');
    const doTeachers = kind === 'both' || kind === 'teachers';
    const doStudents = kind === 'both' || kind === 'students';

    const tt = await loadLatestTimetable();
    if (!tt || !tt.record) return res.status(400).json({ error: 'No timetable found. Generate a timetable first.' });
    if (!tt.schedule || !Array.isArray(tt.schedule.sessions)) return res.status(400).json({ error: 'The latest timetable has no structured schedule. Please regenerate it.' });
    const refId = String(tt.record._id);
    const sessions = tt.schedule.sessions;

    const out = { devMode: !isConfigured(), teachers: null, students: null };

    // ── Teachers ────────────────────────────────────────────────────────────
    if (doTeachers) {
      const byTeacher = new Map();
      for (const s of sessions) {
        for (const t of String(s.teacher || '').split(/\s*[/&,]\s*/)) {   // combined "A / B"
          const nm = t.trim(); if (isTBA(nm)) continue;
          if (!byTeacher.has(nm)) byTeacher.set(nm, []);
          byTeacher.get(nm).push(s);
        }
      }
      const prior = await EmailDispatch.find({ scope: 'teacher_tt', refId }).select('ident').lean();
      const already = new Set(prior.map((d) => d.ident));
      const r = { sent: 0, alreadyEmailed: 0, noEmail: 0, failed: [] };
      for (const [name, sess] of byTeacher) {
        const id = norm(name);
        if (already.has(id)) { r.alreadyEmailed += 1; continue; }
        const teacher = await Teacher.findOne({ name }).select('email').lean();
        const email = teacher && teacher.email;
        if (!email) { r.noEmail += 1; r.failed.push({ ident: name, name, email: '', reason: 'No email on record' }); continue; }
        const html = renderTimetableHTML({ title: 'Class Timetable — Teaching Schedule', subtitle: 'This is your personal teaching timetable.', who: name, sessions: sess });
        const sent = await sendMail({ to: email, subject: 'Your Teaching Timetable — Abasyn University', html, text: `Dear ${name}, your teaching timetable (${sess.length} sessions) is in this email.` });
        if (sent.ok) { r.sent += 1; try { await EmailDispatch.create({ scope: 'teacher_tt', refId, ident: id, email, name }); } catch { /* race */ } }
        else r.failed.push({ ident: name, name, email, reason: `Email failed: ${sent.error || 'unknown'}` });
      }
      out.teachers = { total: byTeacher.size, ...r, failedCount: r.failed.length };
    }

    // ── Students ────────────────────────────────────────────────────────────
    if (doStudents) {
      const regs = await StudentRegistration.find({}).lean();
      const listMap = uploadPath ? parseEmailList(uploadPath) : new Map();
      const needDb = regs.length > 0;
      const dbUsers = needDb ? await User.find({ role: 'student' }).select('regNo email').lean() : [];
      const emailByReg = new Map();
      for (const u of dbUsers) if (u.email) { emailByReg.set(norm(u.regNo), u.email); if (digits(u.regNo)) emailByReg.set('D' + digits(u.regNo), u.email); }

      // index sessions by short course code for fast per-student filtering (fallback)
      const byCode = new Map();
      for (const s of sessions) { const c = norm(s.code); if (!byCode.has(c)) byCode.set(c, []); byCode.get(c).push(s); }
      // exact per-student sessions (with correct SECTION) from the scheduler
      const studentIndex = (tt.schedule && tt.schedule.student_index) || {};

      const prior = await EmailDispatch.find({ scope: 'student_tt', refId }).select('ident').lean();
      const already = new Set(prior.map((d) => d.ident));
      const r = { sent: 0, alreadyEmailed: 0, noEmail: 0, noClasses: 0, failed: [] };
      for (const reg of regs) {
        const id = norm(reg.studentId);
        if (already.has(id)) { r.alreadyEmailed += 1; continue; }
        const email = listMap.get(id) || listMap.get('D' + digits(reg.studentId))
          || emailByReg.get(id) || emailByReg.get('D' + digits(reg.studentId)) || '';
        if (!email) { r.noEmail += 1; r.failed.push({ ident: reg.studentId, name: reg.studentId, email: '', reason: 'No email on record' }); continue; }
        let mine = [];
        const sidx = studentIndex[String(reg.studentId)] || studentIndex[id];
        if (Array.isArray(sidx) && sidx.length) {
          for (const i of sidx) { const s = sessions[i]; if (s) mine.push(s); }   // exact section
        } else {
          for (const code of (reg.courses || [])) { const arr = byCode.get(norm(code)); if (arr) mine.push(...arr); }
        }
        if (!mine.length) { r.noClasses += 1; continue; }
        const html = renderTimetableHTML({ title: 'Class Timetable — Your Courses', subtitle: 'This is your personal class timetable (your section) for this semester.', who: reg.studentId, sessions: mine });
        const sent = await sendMail({ to: email, subject: 'Your Class Timetable — Abasyn University', html, text: `Your class timetable (${mine.length} sessions) is in this email.` });
        if (sent.ok) { r.sent += 1; try { await EmailDispatch.create({ scope: 'student_tt', refId, ident: id, email, name: reg.studentId }); } catch { /* race */ } }
        else r.failed.push({ ident: reg.studentId, name: reg.studentId, email, reason: `Email failed: ${sent.error || 'unknown'}` });
      }
      out.students = { total: regs.length, ...r, failedCount: r.failed.length };
    }

    const sentTotal = (out.teachers?.sent || 0) + (out.students?.sent || 0);
    const failTotal = (out.teachers?.failedCount || 0) + (out.students?.failedCount || 0);
    const alreadyTotal = (out.teachers?.alreadyEmailed || 0) + (out.students?.alreadyEmailed || 0);
    // Be honest: in dev mode nothing was actually emailed — it was only prepared.
    await logActivity('timetable.email',
      out.devMode
        ? `Timetables PREPARED in dev mode — ${sentTotal} saved to disk but NOT emailed (configure SMTP to send)${failTotal ? `, ${failTotal} without an email` : ''}.`
        : `Timetables emailed — ${sentTotal} sent${alreadyTotal ? `, ${alreadyTotal} already emailed` : ''}${failTotal ? `, ${failTotal} failed` : ''}.`,
      out.devMode || failTotal ? 'warning' : 'success');

    res.json({ ok: true, timetable: { id: refId, title: tt.record.title }, ...out });
  } catch (err) {
    console.error('Timetable email error:', err);
    res.status(500).json({ error: err.message || 'Timetable email failed.' });
  } finally {
    try { if (uploadPath && fs.existsSync(uploadPath)) fs.unlinkSync(uploadPath); } catch { /* ignore */ }
  }
};

// GET /api/timetable-email/status — is there a timetable + counts + smtp mode
exports.status = async (_req, res) => {
  const tt = await loadLatestTimetable();
  const students = await StudentRegistration.countDocuments({});
  const teachers = await Teacher.countDocuments({ active: true });
  res.json({
    hasTimetable: !!(tt && tt.record && tt.schedule),
    title: tt && tt.record ? tt.record.title : '',
    students, teachers, smtpConfigured: isConfigured(),
  });
};
