/**
 * Public QR verification page — no login. The admit-card QR encodes
 *   {BASE_URL}/verify/:token
 * A phone camera opens it and this returns a styled HTML page showing the
 * student's exam FOR THE DAY (paper, time, hall, seat) + fee status:
 *   • before the exam day / a non-exam day → "No exam scheduled for today"
 *     (papers are never revealed ahead of their day)
 *   • on the exam day → the paper with an Upcoming / In Progress / Completed pill
 *   • after all papers are over → "No exams found"
 */
const AdmitVerification = require('../models/AdmitVerification');
const Attendance = require('../models/Attendance');
const admitCrypto = require('../utils/admitCrypto');

/**
 * Mark PRESENT for every paper this student is sitting RIGHT NOW (state
 * 'active'). Each mark is an atomic idempotent upsert on (studentId, code, date,
 * slot), so re-scans don't change the first scan time and concurrent scanners in
 * different rooms never clash. Best-effort: a DB hiccup never breaks the scan.
 */
async function markPresent(rec, todayExams) {
  const active = (todayExams || []).filter((e) => e.state === 'active');
  if (!active.length) return [];
  await Promise.all(active.map((e) => Attendance.updateOne(
    { studentId: rec.studentId, code: e.code, date: e.date, slot: e.slot },
    {
      $setOnInsert: {
        name: rec.name, program: rec.program, courseName: e.name,
        room: e.room, seat: e.seat, status: 'present', scannedAt: new Date(),
        batchId: rec.batchId || null, examType: rec.examType || '',
      },
    },
    { upsert: true },
  ).catch(() => {})));
  return active.map((e) => e.code);
}

// The ONE message shown for every failure — forged/hand-made QR, unknown token,
// or a missing / mismatched paper key. Never reveal which case it was (so a forger
// can't tell which check tripped), but warn the scanner it is not a genuine card.
const GENERIC_FAIL = 'This admit card seems to be fake. Please report to the Examination Cell immediately.';

/**
 * Resolve a scanned token to a genuine, untampered record — or null.
 * Fails (null) when the token signature is invalid (hand-made / edited QR),
 * the token is not in the database, or any stored paper key does not match the
 * server-recomputed key. All three are indistinguishable to the caller.
 */
async function resolveVerified(rawToken) {
  const token = String(rawToken || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 64);
  const qid = admitCrypto.verifyToken(token);
  if (!qid) return null;                                   // bad shape / forged signature
  let rec = null;
  try { rec = await AdmitVerification.findOne({ token }).lean(); } catch { return null; }
  if (!rec) return null;                                   // token does not exist
  for (const e of (rec.exams || [])) {
    const expected = admitCrypto.paperKey(token, e.code, e.date, e.slot);
    if (!e.key || !admitCrypto.safeEqual(e.key, expected)) return null;  // missing / mismatch
  }
  return { rec, token };
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// '01:00' on an exam clock means 1 PM → 13:00. Hours 1–7 are afternoon.
function toMinutes(hhmm) {
  const m = String(hhmm || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2]);
  if (h >= 1 && h <= 7) h += 12;
  return h * 60 + min;
}
function localDateStr(d) {
  const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function page(bodyHtml, title = 'Exam Verification') {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Abasyn University</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#eef4f0;color:#12261c;
    min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:18px}
  .card{width:100%;max-width:460px;background:#fff;border-radius:20px;overflow:hidden;
    box-shadow:0 18px 50px rgba(15,61,46,.18);margin-top:16px}
  .top{background:linear-gradient(135deg,#198754,#0f3d2e);color:#fff;padding:22px 20px 18px;text-align:center}
  .top h1{font-size:19px;letter-spacing:.5px}
  .top p{font-size:12px;opacity:.9;margin-top:3px}
  .stu{padding:16px 20px;border-bottom:1px solid #eef2f0}
  .stu .nm{font-size:17px;font-weight:800}
  .stu .rw{display:flex;justify-content:space-between;font-size:13px;color:#5c6b63;margin-top:5px}
  .stu .rw b{color:#12261c}
  .fee{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;padding:4px 11px;border-radius:999px;margin-top:10px}
  .fee.paid{background:#d1e7dd;color:#0f5132}
  .fee.unpaid{background:#f8d7da;color:#842029}
  .sec{padding:18px 20px}
  .pill{display:inline-block;font-size:11px;font-weight:800;padding:3px 10px;border-radius:999px;text-transform:uppercase;letter-spacing:.4px}
  .pill.up{background:#cfe2ff;color:#084298}
  .pill.now{background:#fff3cd;color:#664d03}
  .pill.done{background:#e2e3e5;color:#41464b}
  .exam{border:1px solid #cfe6da;border-radius:14px;padding:15px;margin-bottom:12px;background:#f6fbf8}
  .exam .code{font-size:18px;font-weight:800;color:#0f5132}
  .exam .name{font-size:13.5px;margin:2px 0 12px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .kv .k{font-size:10.5px;color:#6c7b72;text-transform:uppercase;letter-spacing:.4px}
  .kv .v{font-size:15px;font-weight:800;color:#12261c}
  .big{text-align:center;padding:30px 16px}
  .big .ic{font-size:40px}
  .big h2{font-size:18px;margin-top:10px;color:#0f3d2e}
  .big p{font-size:13px;color:#5c6b63;margin-top:6px}
  .foot{padding:12px 20px 18px;text-align:center;font-size:11px;color:#8a978f}
</style></head><body><div class="card">${bodyHtml}</div></body></html>`;
}

function studentBlock(rec) {
  // 'Unpaid' contains "paid" — test for UNPAID first, else it shows green.
  const feeCls = /unpaid|not\s*paid/i.test(rec.feeStatus) ? 'unpaid' : (/paid/i.test(rec.feeStatus) ? 'paid' : 'unpaid');
  return `<div class="stu">
    <div class="nm">${esc(rec.name)}</div>
    <div class="rw"><span>Registration No</span><b>${esc(rec.studentId) || '—'}</b></div>
    <div class="rw"><span>Degree</span><b>${esc(rec.program) || '—'}</b></div>
    <div class="rw"><span>Batch</span><b>${esc(rec.batch) || '—'}</b></div>
    <div><span class="fee ${feeCls}">● Fee: ${esc(rec.feeStatus || 'Paid')}</span></div>
  </div>`;
}

/**
 * Shared status computation. Returns { status, ... } where status is one of
 * 'today' | 'over' | 'no_today' | 'no_exams'.
 */
function computeStatus(rec) {
  const exams = (rec.exams || []).slice().sort((a, b) =>
    (a.date || '').localeCompare(b.date || '') || (toMinutes(a.start) || 0) - (toMinutes(b.start) || 0));
  if (!exams.length) return { status: 'no_exams', today: [] };

  const now = new Date();
  const today = localDateStr(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const todays = exams.filter((e) => e.date === today);
  const maxDate = exams[exams.length - 1].date;

  if (todays.length) {
    const withState = todays.map((e) => {
      const st = toMinutes(e.start); const fi = toMinutes(e.finish);
      let state = 'upcoming';
      if (st != null && fi != null) {
        if (nowMin >= st && nowMin <= fi) state = 'active';
        else if (nowMin > fi) state = 'completed';
      }
      const { key, ...safe } = e;   // never expose the verification key
      return { ...safe, state };
    });
    return { status: 'today', today: withState };
  }
  if (today > maxDate) return { status: 'over', today: [] };
  return { status: 'no_today', today: [], todayDate: today };
}

/** JSON API for the mobile scanner app. */
exports.verifyJson = async (req, res) => {
  const v = await resolveVerified(req.params.token);
  if (!v) return res.status(404).json({ ok: false, reason: 'not_found', message: GENERIC_FAIL });
  const rec = v.rec;
  const s = computeStatus(rec);
  // Scanning IS the attendance: mark present for any paper active right now.
  const markedCodes = await markPresent(rec, s.today);
  return res.json({
    ok: true,
    student: { name: rec.name, registrationNo: rec.studentId, degree: rec.program, batch: rec.batch },
    feeStatus: rec.feeStatus || 'Paid',
    heading: rec.heading || '',
    status: s.status,        // today | over | no_today | no_exams
    today: s.today,          // [{code,name,teacher,dateDisp,slot,room,seat,state}]
    attendanceMarked: markedCodes.length > 0,
    attendanceCourses: markedCodes,     // paper(s) marked present on this scan
    verifiedAt: new Date().toISOString(),
  });
};

exports.renderVerify = async (req, res) => {
  const v = await resolveVerified(req.params.token);

  res.set('Content-Type', 'text/html; charset=utf-8');
  if (!v) {
    return res.status(404).send(page(`<div class="top"><h1>ABASYN UNIVERSITY</h1><p>Examination Verification</p></div>
      <div class="big"><div class="ic">⚠️</div><h2>Admit card seems to be fake</h2>
      <p>Please report to the Examination Cell immediately.</p></div>`, 'Invalid admit card'));
  }
  const rec = v.rec;

  const header = `<div class="top"><h1>ABASYN UNIVERSITY</h1><p>${esc(rec.heading || 'Examination Verification')}</p></div>`
    + studentBlock(rec);

  const exams = (rec.exams || []).slice().sort((a, b) =>
    (a.date || '').localeCompare(b.date || '') || (toMinutes(a.start) || 0) - (toMinutes(b.start) || 0));

  if (!exams.length) {
    return res.send(page(header + `<div class="big"><div class="ic">📄</div>
      <h2>No exams found</h2><p>No papers are recorded for this admit card.</p></div>`));
  }

  const now = new Date();
  const today = localDateStr(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const todays = exams.filter((e) => e.date === today);
  const maxDate = exams[exams.length - 1].date;

  let body;
  if (todays.length) {
    const cards = todays.map((e) => {
      const st = toMinutes(e.start); const fi = toMinutes(e.finish);
      let pill = '<span class="pill up">Upcoming</span>';
      if (st != null && fi != null) {
        if (nowMin >= st && nowMin <= fi) pill = '<span class="pill now">In Progress</span>';
        else if (nowMin > fi) pill = '<span class="pill done">Completed</span>';
      }
      return `<div class="exam">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div class="code">${esc(e.code)}</div>${pill}</div>
        <div class="name">${esc(e.name)}</div>
        <div class="grid">
          <div class="kv"><div class="k">Date</div><div class="v">${esc(e.dateDisp || e.date)}</div></div>
          <div class="kv"><div class="k">Time</div><div class="v">${esc(e.slot)}</div></div>
          <div class="kv"><div class="k">Exam Hall</div><div class="v">${esc(e.room)}</div></div>
          <div class="kv"><div class="k">Seat No</div><div class="v">${esc(e.seat)}</div></div>
        </div></div>`;
    }).join('');
    body = `<div class="sec"><div style="font-size:12px;color:#6c7b72;margin-bottom:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px">Today's Paper</div>${cards}</div>`;
  } else if (today > maxDate) {
    body = `<div class="big"><div class="ic">✅</div><h2>No exams found</h2>
      <p>All papers for this student are over.</p></div>`;
  } else {
    body = `<div class="big"><div class="ic">🗓️</div><h2>No exam today</h2>
      <p>There is no paper scheduled for today (${esc(today)}).</p></div>`;
  }

  const foot = `<div class="foot">Verified on ${esc(now.toLocaleString())} · Abasyn University Examination System</div>`;
  return res.send(page(header + body + foot));
};
