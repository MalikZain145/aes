/**
 * Faculty portal (Phase 3). A teacher who has been made a Student Advisor and/or
 * a Head of Department reviews the registration forms routed to them:
 *   • advisor  → forms in `with_advisor` for a batch they advise
 *   • HoD      → forms in `with_hod` for their department (program)
 * They can open a form (which stamps "seen"), approve it (advance the workflow),
 * or return it to the student with a remark.
 */
const User = require('../models/User');
const Assignment = require('../models/Assignment');
const RegistrationForm = require('../models/RegistrationForm');
const { statusLine, stripIntake, norm } = require('../utils/registrationWorkflow');
const { sendMail } = require('../utils/mailer');
const { logActivity } = require('../utils/logger');
const { renderFormPdf } = require('./registrationAdminController');

async function currentFaculty(req) {
  const u = await User.findById(req.user.id).lean();
  if (!u || !['faculty', 'admin'].includes(u.role)) return null;
  return u;
}

// The advisor batches and HoD programs this user is responsible for.
async function rolesOf(user) {
  const mine = await Assignment.find({ userId: user._id }).lean();
  const advisorBatches = mine.filter((a) => a.type === 'advisor').map((a) => a.batch);
  const hodDepts = mine.filter((a) => a.type === 'hod').map((a) => a.department);
  return { advisorBatches, hodDepts, assignments: mine };
}

// Notify the student when their form moves.
async function notifyStudent(form, { action, remark }) {
  if (!form.email) return;
  const approved = action === 'approved' && form.status === 'approved';
  const returned = action === 'returned';
  const subject = approved ? 'Your registration is approved'
    : returned ? 'Your registration form needs changes'
    : 'Your registration form has been updated';
  const line = approved ? 'Your registration has been fully approved and will be reflected on Odoo within 72 hours.'
    : returned ? `Your form has been returned for changes.${remark ? ` Remark: ${remark}` : ''} Please sign in, edit it, and resubmit.`
    : 'Your form has moved to the next approval step.';
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#12261c;max-width:560px">
    <div style="background:linear-gradient(135deg,#198754,#0f3d2e);color:#fff;padding:18px;border-radius:14px 14px 0 0">
      <h2 style="margin:0;font-size:17px">Abasyn University Islamabad Campus</h2>
      <p style="margin:3px 0 0;font-size:12.5px;opacity:.92">Registration update</p></div>
    <div style="border:1px solid #d7e6dd;border-top:0;border-radius:0 0 14px 14px;padding:18px;font-size:13.5px">
      <p>Dear <b>${form.name || form.regNo}</b>,</p><p>${line}</p>
      <p style="margin-top:14px;font-size:11.5px;color:#8a978f">Automated message from the Abasyn University portal.</p></div></div>`;
  try { await sendMail({ to: form.email, subject, html, text: line }); } catch { /* non-blocking */ }
}

// ── GET /api/faculty/me ───────────────────────────────────────────────────────
exports.me = async (req, res) => {
  const user = await currentFaculty(req);
  if (!user) return res.status(404).json({ error: 'Faculty profile not found.' });
  const { advisorBatches, hodDepts } = await rolesOf(user);
  res.json({
    profile: { name: user.name || '', email: user.email || '', department: user.department || '' },
    isAdvisor: advisorBatches.length > 0, isHod: hodDepts.length > 0,
    advisorBatches, hodDepts,
  });
};

// ── GET /api/faculty/forms ────────────────────────────────────────────────────
// Everything awaiting this faculty member, split into advisor / hod queues,
// plus what they have already actioned (history).
exports.forms = async (req, res) => {
  const user = await currentFaculty(req);
  if (!user) return res.status(404).json({ error: 'Faculty profile not found.' });
  const { advisorBatches, hodDepts } = await rolesOf(user);

  const advisorSet = new Set(advisorBatches.map(norm));
  const hodSet = new Set(hodDepts.map(norm));

  const pendingAdvisor = advisorBatches.length
    ? (await RegistrationForm.find({ status: 'with_advisor' }).sort({ submittedAt: 1 }).lean())
        .filter((f) => advisorSet.has(norm(f.batch)))
    : [];
  const pendingHod = hodDepts.length
    ? (await RegistrationForm.find({ status: 'with_hod' }).sort({ advisorActionAt: 1 }).lean())
        .filter((f) => hodSet.has(norm(f.program || stripIntake(f.batch))))
    : [];

  // Forms this user has acted on (for a "history" view).
  const acted = (await RegistrationForm.find({
    $or: [{ advisorId: user._id }, { hodId: user._id }],
    status: { $in: ['with_hod', 'returned_to_student', 'approved'] },
  }).sort({ updatedAt: -1 }).limit(100).lean());

  const stamp = (f) => ({ ...f, statusLine: statusLine(f) });
  res.json({
    pendingAdvisor: pendingAdvisor.map(stamp),
    pendingHod: pendingHod.map(stamp),
    acted: acted.map(stamp),
  });
};

// ── POST /api/faculty/forms/:id/seen ──────────────────────────────────────────
// Stamp the "seen by advisor / HoD" timestamp when the reviewer opens a form.
exports.markSeen = async (req, res) => {
  const user = await currentFaculty(req);
  if (!user) return res.status(404).json({ error: 'Faculty profile not found.' });
  const form = await RegistrationForm.findById(req.params.id);
  if (!form) return res.status(404).json({ error: 'Form not found.' });
  const now = new Date();
  if (form.status === 'with_advisor' && !form.seenByAdvisorAt) {
    form.seenByAdvisorAt = now;
    form.history.push({ stage: 'advisor', action: 'seen', by: user._id, byName: user.name, at: now });
    await form.save();
  } else if (form.status === 'with_hod' && !form.seenByHodAt) {
    form.seenByHodAt = now;
    form.history.push({ stage: 'hod', action: 'seen', by: user._id, byName: user.name, at: now });
    await form.save();
  }
  res.json({ ok: true, statusLine: statusLine(form.toObject()) });
};

// authorise: is this user the routed reviewer for the form's current stage?
async function canAct(user, form) {
  const { advisorBatches, hodDepts } = await rolesOf(user);
  if (form.status === 'with_advisor') return advisorBatches.map(norm).includes(norm(form.batch));
  if (form.status === 'with_hod') return hodDepts.map(norm).includes(norm(form.program || stripIntake(form.batch)));
  return false;
}

// ── POST /api/faculty/forms/:id/approve ───────────────────────────────────────
exports.approve = async (req, res) => {
  try {
    const user = await currentFaculty(req);
    if (!user) return res.status(404).json({ error: 'Faculty profile not found.' });
    const form = await RegistrationForm.findById(req.params.id);
    if (!form) return res.status(404).json({ error: 'Form not found.' });
    if (!(await canAct(user, form))) return res.status(403).json({ error: 'This form is not in your review queue.' });

    const now = new Date();
    if (form.status === 'with_advisor') {
      form.advisorActionAt = now;
      form.status = 'with_hod';
      if (!form.hodId) { const { resolveApprovers } = require('../utils/registrationWorkflow'); const { hod } = await resolveApprovers({ batch: form.batch, program: form.program }); if (hod) { form.hodId = hod.userId; form.hodName = hod.teacherName; } }
      form.history.push({ stage: 'advisor', action: 'approved', by: user._id, byName: user.name, at: now });
      await form.save();
      // notify HoD
      const hodA = await Assignment.findOne({ type: 'hod', department: form.program || stripIntake(form.batch) }).lean();
      if (hodA && hodA.teacherEmail) {
        try { await sendMail({ to: hodA.teacherEmail, subject: 'A registration form is awaiting your review', text: `A registration form from ${form.name || form.regNo} (${form.regNo}) — approved by the advisor — is awaiting your review as Head of Department.` }); } catch { /* non-blocking */ }
      }
      await logActivity('registration.advisor_ok', `Advisor ${user.name} approved ${form.name || form.regNo}'s form.`, 'info');
    } else if (form.status === 'with_hod') {
      form.hodActionAt = now;
      form.status = 'approved';
      form.approvedAt = now;
      form.history.push({ stage: 'hod', action: 'approved', by: user._id, byName: user.name, at: now });
      await form.save();
      await notifyStudent(form.toObject(), { action: 'approved' });
      await logActivity('registration.approved', `Registration approved for ${form.name || form.regNo} (${form.regNo}) — ready for the Exam Cell.`, 'success');
    }
    res.json({ ok: true, statusLine: statusLine(form.toObject()) });
  } catch (err) {
    console.error('faculty approve error:', err);
    res.status(500).json({ error: err.message || 'Could not approve the form.' });
  }
};

// ── POST /api/faculty/forms/:id/return  { remark } ────────────────────────────
exports.returnForm = async (req, res) => {
  try {
    const user = await currentFaculty(req);
    if (!user) return res.status(404).json({ error: 'Faculty profile not found.' });
    const remark = String((req.body && req.body.remark) || '').trim();
    if (!remark) return res.status(400).json({ error: 'Please add a remark explaining what the student should change.' });
    const form = await RegistrationForm.findById(req.params.id);
    if (!form) return res.status(404).json({ error: 'Form not found.' });
    if (!(await canAct(user, form))) return res.status(403).json({ error: 'This form is not in your review queue.' });

    const now = new Date();
    const by = form.status === 'with_hod' ? 'hod' : 'advisor';
    if (by === 'advisor') form.advisorActionAt = now; else form.hodActionAt = now;
    form.status = 'returned_to_student';
    form.returnedBy = by;
    form.lastRemark = remark;
    form.history.push({ stage: by, action: 'returned', by: user._id, byName: user.name, at: now, remark });
    await form.save();
    await notifyStudent(form.toObject(), { action: 'returned', remark });
    await logActivity('registration.returned', `${by === 'hod' ? 'HoD' : 'Advisor'} ${user.name} returned ${form.name || form.regNo}'s form for changes.`, 'warning');
    res.json({ ok: true, statusLine: statusLine(form.toObject()) });
  } catch (err) {
    console.error('faculty return error:', err);
    res.status(500).json({ error: err.message || 'Could not return the form.' });
  }
};

// ── GET /api/faculty/forms/:id/pdf ────────────────────────────────────────────
// Download a form (with stamps) — only forms this faculty is the advisor/HoD of.
exports.formPdf = async (req, res) => {
  try {
    const user = await currentFaculty(req);
    if (!user) return res.status(404).json({ error: 'Faculty profile not found.' });
    const form = await RegistrationForm.findById(req.params.id).lean();
    if (!form) return res.status(404).json({ error: 'Form not found.' });
    const mine = String(form.advisorId) === String(user._id) || String(form.hodId) === String(user._id) || user.role === 'admin';
    if (!mine) return res.status(403).json({ error: 'This form is not in your review scope.' });
    const bytes = await renderFormPdf(form);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${form.kind === 'add_drop' ? 'AddDrop' : 'Registration'}_${form.regNo}.pdf"`);
    res.send(bytes);
  } catch (err) {
    console.error('faculty form pdf error:', err);
    res.status(500).json({ error: err.message || 'Could not build the PDF.' });
  }
};
