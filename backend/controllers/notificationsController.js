/**
 * Role-scoped notifications. Each role sees only what belongs to it:
 *   • admin   → every module's activity (the whole ActivityLog)
 *   • finance → finance events only (admit-card dispatch)
 *   • faculty → the registration forms routed to THIS teacher (advisor / HoD)
 *   • student → the live progress of THIS student's own forms
 * Admin's own operational events are never shown to the other roles.
 */
const ActivityLog = require('../models/ActivityLog');
const User = require('../models/User');
const Assignment = require('../models/Assignment');
const RegistrationForm = require('../models/RegistrationForm');

const norm = (s) => String(s == null ? '' : s).replace(/[^a-z0-9]/gi, '').toLowerCase();

// Finance-owned activity actions.
const FINANCE_ACTIONS = /^admit\./;

exports.list = async (req, res) => {
  const role = req.user.role;
  try {
    if (role === 'admin') {
      const items = await ActivityLog.find({ action: { $not: /^auth\./ } })
        .sort({ createdAt: -1 }).limit(25).lean();
      return res.json({ items: items.map((a) => ({ _id: a._id, message: a.message, level: a.level, createdAt: a.createdAt })) });
    }

    if (role === 'finance') {
      const items = await ActivityLog.find({ action: FINANCE_ACTIONS })
        .sort({ createdAt: -1 }).limit(25).lean();
      return res.json({ items: items.map((a) => ({ _id: a._id, message: a.message, level: a.level, createdAt: a.createdAt })) });
    }

    if (role === 'faculty') {
      const user = await User.findById(req.user.id).lean();
      const mine = await Assignment.find({ userId: req.user.id }).lean();
      const advisorSet = new Set(mine.filter((a) => a.type === 'advisor').map((a) => norm(a.batch)));
      const hodSet = new Set(mine.filter((a) => a.type === 'hod').map((a) => norm(a.department)));
      const notifs = [];
      if (advisorSet.size) {
        const forms = await RegistrationForm.find({ status: 'with_advisor' }).sort({ submittedAt: -1 }).limit(50).lean();
        for (const f of forms) if (advisorSet.has(norm(f.batch))) {
          notifs.push({ _id: `${f._id}-adv`, level: 'info', createdAt: f.submittedAt || f.updatedAt,
            message: `Registration form from ${f.name || f.regNo} is awaiting your advisor review.` });
        }
      }
      if (hodSet.size) {
        const forms = await RegistrationForm.find({ status: 'with_hod' }).sort({ advisorActionAt: -1 }).limit(50).lean();
        for (const f of forms) if (hodSet.has(norm(f.program || ''))) {
          notifs.push({ _id: `${f._id}-hod`, level: 'info', createdAt: f.advisorActionAt || f.submittedAt,
            message: `${f.name || f.regNo}'s form (approved by advisor) is awaiting your HoD review.` });
        }
      }
      notifs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return res.json({ items: notifs.slice(0, 25) });
    }

    if (role === 'student') {
      const user = await User.findById(req.user.id).lean();
      // token may point to a login that was re-provisioned (id changed) → no notifs
      if (!user || !user.regNo) return res.json({ items: [] });
      const forms = await RegistrationForm.find({ regNo: user.regNo }).sort({ updatedAt: -1 }).limit(20).lean();
      const notifs = [];
      for (const f of forms) {
        const tag = f.kind === 'add_drop' ? 'Add/Drop form' : 'Registration form';
        for (const h of (f.history || [])) {
          if (h.stage === 'advisor' && h.action === 'seen') notifs.push(mk(f, h, 'info', `Your advisor opened your ${tag}.`));
          else if (h.stage === 'advisor' && h.action === 'approved') notifs.push(mk(f, h, 'info', `Your advisor approved your ${tag} — it is now with the Head of Department.`));
          else if (h.stage === 'advisor' && h.action === 'returned') notifs.push(mk(f, h, 'warning', `Your advisor returned your ${tag}: ${h.remark || 'please review and resubmit.'}`));
          else if (h.stage === 'hod' && h.action === 'seen') notifs.push(mk(f, h, 'info', `The Head of Department opened your ${tag}.`));
          else if (h.stage === 'hod' && h.action === 'approved') notifs.push(mk(f, h, 'success', `Your ${tag} has been approved — it will reflect on Odoo within 72 hours.`));
          else if (h.stage === 'hod' && h.action === 'returned') notifs.push(mk(f, h, 'warning', `The Head of Department returned your ${tag}: ${h.remark || 'please review and resubmit.'}`));
        }
      }
      notifs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return res.json({ items: notifs.slice(0, 25) });
    }

    return res.json({ items: [] });
  } catch (err) {
    console.error('notifications error:', err);
    res.status(500).json({ error: err.message || 'Could not load notifications.' });
  }
};

const mk = (f, h, level, message) => ({ _id: `${f._id}-${h.stage}-${h.action}-${new Date(h.at).getTime()}`, level, createdAt: h.at, message });
