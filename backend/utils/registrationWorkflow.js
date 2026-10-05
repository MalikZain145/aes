/**
 * Shared helpers for the registration approval workflow — used by the student,
 * faculty and admin controllers so routing, credit rules and wording stay
 * consistent.
 */
const Assignment = require('../models/Assignment');
const AcademicTerm = require('../models/AcademicTerm');

const norm = (s) => String(s == null ? '' : s).replace(/[^a-z0-9]/gi, '').toLowerCase();
// "BS Computer Science Fall 2023" → "BS Computer Science"
const stripIntake = (b) => String(b || '').replace(/\s+(Fall|Spring|Summer)\s+\d{4}\s*$/i, '').trim();

// ── credit hours ──────────────────────────────────────────────────────────────
const CREDIT_MIN = 9;
const CREDIT_MAX = 18;
// "3+1" → 4, "2+1" → 3, "3+0" → 3, "2+0" → 2, "3" → 3
function courseCredits(creditHours) {
  const parts = String(creditHours || '').match(/\d+/g);
  if (!parts) return 0;
  return parts.reduce((a, n) => a + parseInt(n, 10), 0);
}
function sumCredits(courses) {
  return (courses || []).reduce((a, c) => a + courseCredits(c.creditHours), 0);
}

/** Resolve advisor (by batch) & HoD (by program) for a form, preferring the
 *  term-specific assignment, then any term-less one. */
async function resolveApprovers({ batch, program, term = '' }) {
  const prog = program || stripIntake(batch);
  const advisors = await Assignment.find({ type: 'advisor' }).lean();
  const hods = await Assignment.find({ type: 'hod' }).lean();
  const pickAdvisor = (t) => advisors.find((a) => norm(a.batch) === norm(batch) && norm(a.term) === norm(t));
  const pickHod = (t) => hods.find((h) => norm(h.department) === norm(prog) && norm(h.term) === norm(t));
  const advisor = pickAdvisor(term) || pickAdvisor('') || null;
  const hod = pickHod(term) || pickHod('') || null;
  return { advisor, hod, program: prog };
}

// ── per-term windows ──────────────────────────────────────────────────────────
function windowState(w) {
  const now = Date.now();
  const opensAt = w && w.opensAt ? new Date(w.opensAt) : null;
  const closesAt = w && w.closesAt ? new Date(w.closesAt) : null;
  let open = !!(w && w.enabled);
  if (open && opensAt && now < opensAt.getTime()) open = false;
  if (open && closesAt && now > closesAt.getTime()) open = false;
  return { enabled: !!(w && w.enabled), opensAt, closesAt, open, note: (w && w.note) || '' };
}

/** which = 'registration' | 'addDrop' */
async function getTermWindow(termName, which) {
  const t = termName ? await AcademicTerm.findOne({ name: termName }).lean() : null;
  if (!t) return { enabled: false, open: false, opensAt: null, closesAt: null, note: '', termExists: false };
  return { ...windowState(t[which] || {}), termExists: true };
}

// ── student-facing status + arrow timeline ────────────────────────────────────
function statusLine(form) {
  const returned = form.status === 'returned_to_student';
  const advReturned = returned && form.returnedBy === 'advisor';
  const hodReturned = returned && form.returnedBy === 'hod';

  // advisor step
  let adv;
  if (advReturned) adv = { state: 'rejected', at: form.advisorActionAt };
  else if (form.advisorActionAt && form.status !== 'returned_to_student') adv = { state: 'done', at: form.advisorActionAt };
  else if (form.status === 'with_advisor' && form.seenByAdvisorAt) adv = { state: 'seen', at: form.seenByAdvisorAt };
  else if (form.status === 'with_advisor') adv = { state: 'current', at: null };
  else if (returned && form.returnedBy === 'advisor') adv = { state: 'rejected', at: form.advisorActionAt };
  else adv = { state: form.advisorActionAt ? 'done' : 'todo', at: form.advisorActionAt };

  // hod step
  let hod;
  if (hodReturned) hod = { state: 'rejected', at: form.hodActionAt };
  else if (form.status === 'approved') hod = { state: 'done', at: form.hodActionAt };
  else if (form.status === 'with_hod' && form.seenByHodAt) hod = { state: 'seen', at: form.seenByHodAt };
  else if (form.status === 'with_hod') hod = { state: 'current', at: null };
  else hod = { state: 'todo', at: null };

  const processed = form.status === 'approved' ? { state: 'done', at: form.approvedAt } : { state: 'todo', at: null };

  const steps = [
    { key: 'initiated', label: 'Initiated', at: form.submittedAt, state: 'done' },
    { key: 'advisor', label: 'Student Advisor', ...adv },
    { key: 'hod', label: 'Head of Department', ...hod },
    { key: 'processed', label: 'Processed', ...processed },
  ];

  const d = (x) => (x ? new Date(x).toLocaleString() : '');
  let label, detail, tone, arrowTo;
  const direction = returned ? 'backward' : 'forward';
  switch (form.status) {
    case 'with_advisor':
      arrowTo = 'advisor';
      label = form.seenByAdvisorAt ? 'Seen by Advisor' : 'Departed to Advisor';
      detail = form.seenByAdvisorAt
        ? `Your advisor opened your form on ${d(form.seenByAdvisorAt)}.`
        : 'Your form has been sent to your student advisor for review.';
      tone = 'info'; break;
    case 'with_hod':
      arrowTo = 'hod';
      label = form.seenByHodAt ? 'Seen by Head of Department' : 'Approved by Advisor — Departed to HoD';
      detail = form.seenByHodAt
        ? `The Head of Department opened your form on ${d(form.seenByHodAt)}.`
        : `Your advisor approved it on ${d(form.advisorActionAt)}. It is now with the Head of Department.`;
      tone = 'info'; break;
    case 'returned_to_student':
      arrowTo = 'student';
      label = `Returned by ${form.returnedBy === 'hod' ? 'Head of Department' : 'Advisor'}`;
      detail = form.lastRemark ? `Remark: ${form.lastRemark}` : 'Please review the remarks, edit your form and resubmit.';
      tone = 'warn'; break;
    case 'approved':
      arrowTo = 'done';
      label = 'Processed successfully';
      detail = 'Your form has been processed. Your courses will reflect on Odoo in 72 hours.';
      tone = 'ok'; break;
    default:
      arrowTo = 'advisor'; label = form.status; detail = ''; tone = 'info';
  }
  return { label, detail, tone, direction, arrowTo, steps, submittedAt: form.submittedAt };
}

module.exports = {
  norm, stripIntake, resolveApprovers, statusLine,
  courseCredits, sumCredits, CREDIT_MIN, CREDIT_MAX,
  getTermWindow, windowState,
};
