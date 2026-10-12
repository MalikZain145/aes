const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { logActivity } = require('../utils/logger');
const { isDefaultPassword, checkPasswordPolicy, clientIp } = require('../utils/security');
const { forgetUser } = require('../middleware/auth');

const MAX_FAILED = 5;                    // wrong passwords before the account is locked
const LOCK_MINUTES = 15;                 // lock duration

function signToken(user) {
  return jwt.sign(
    { id: user._id.toString(), username: user.username, role: user.role, tv: user.tokenVersion || 0 },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES || '12h', algorithm: 'HS256' }
  );
}

// Same response for "no such user" and "wrong password" so usernames can't be probed.
const BAD_LOGIN = 'Incorrect username or password.';

// POST /api/auth/login
exports.login = async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
    return res.status(400).json({ error: 'Enter both username and password.' });
  }
  if (username.length > 120 || password.length > 200) {
    return res.status(400).json({ error: BAD_LOGIN });
  }

  const uname = username.toLowerCase().trim();
  let user = await User.findOne({ username: uname });
  // Students sign in with their registration number exactly as printed
  // (e.g. "AUIC-SG23-7828"); their login is stored letters/digits only.
  if (!user) {
    const alnum = uname.replace(/[^a-z0-9]/g, '');
    if (alnum && alnum !== uname) user = await User.findOne({ username: alnum, role: 'student' });
  }
  if (!user || !user.active) {
    // spend similar time as a real check so timing does not reveal valid usernames
    await new Promise((r) => setTimeout(r, 250 + Math.floor(Math.random() * 150)));
    return res.status(401).json({ error: BAD_LOGIN });
  }

  if (user.isLocked()) {
    const mins = Math.max(1, Math.ceil((user.lockUntil.getTime() - Date.now()) / 60000));
    return res.status(423).json({ error: `Too many wrong passwords. This account is locked for ${mins} more minute${mins > 1 ? 's' : ''}.` });
  }

  const ok = await user.verifyPassword(password);
  if (!ok) {
    user.failedLogins = (user.failedLogins || 0) + 1;
    let msg = BAD_LOGIN;
    if (user.failedLogins >= MAX_FAILED) {
      user.lockUntil = new Date(Date.now() + LOCK_MINUTES * 60000);
      user.failedLogins = 0;
      msg = `Too many wrong passwords. This account is locked for ${LOCK_MINUTES} minutes.`;
      await logActivity('auth.locked', `${user.username} (${user.role}) locked after ${MAX_FAILED} wrong passwords from ${clientIp(req)}`, 'warning');
    } else if (user.failedLogins >= MAX_FAILED - 2) {
      const left = MAX_FAILED - user.failedLogins;
      msg = `${BAD_LOGIN} ${left} attempt${left > 1 ? 's' : ''} left before the account is locked.`;
    }
    await user.save();
    return res.status(401).json({ error: msg });
  }

  // Signed in with a factory / default password (student123, faculty123,
  // finance123, admin123) → must set a personal password before anything else.
  if (isDefaultPassword(password)) user.mustChangePassword = true;

  user.failedLogins = 0;
  user.lockUntil = null;
  user.lastLogin = new Date();
  await user.save();
  forgetUser(user._id);
  await logActivity('auth.login', `${user.name || user.username} (${user.role}) signed in`, 'success');

  const token = signToken(user);
  // `admin` key kept for backward-compatibility with the existing frontend.
  res.json({ token, role: user.role, mustChangePassword: !!user.mustChangePassword, user: user.toPublic(), admin: user.toPublic() });
};

// GET /api/auth/me
exports.me = async (req, res) => {
  const user = await User.findById(req.user.id).select('-passwordHash');
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  res.json({ user: user.toPublic(), admin: user.toPublic() });
};

// PATCH /api/auth/me  — user edits their own display name
exports.updateProfile = async (req, res) => {
  const name = String(req.body?.displayName || req.body?.name || '').replace(/[<>]/g, '').trim();
  if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
  if (name.length > 60) return res.status(400).json({ error: 'Name is too long (max 60 characters).' });
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  user.name = name;
  await user.save();
  await logActivity('auth.profile', `Profile name updated to "${name}"`, 'info');
  res.json({ user: user.toPublic(), admin: user.toPublic() });
};

// POST /api/auth/change-password  { currentPassword?, newPassword, confirmPassword }
// • forced change (account on a default password): current password not needed —
//   the user just proved it by signing in.
// • normal change: the current password is required.
// Returns a NEW token; every other device / old token is signed out.
exports.changePassword = async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  if (typeof newPassword !== 'string') return res.status(400).json({ error: 'Enter a new password.' });
  if (confirmPassword !== undefined && confirmPassword !== newPassword) {
    return res.status(400).json({ error: 'The two passwords do not match.' });
  }
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Account not found.' });

  if (!user.mustChangePassword) {
    const ok = await user.verifyPassword(typeof currentPassword === 'string' ? currentPassword : '');
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  const policy = checkPasswordPolicy(newPassword, user);
  if (policy) return res.status(400).json({ error: policy });
  if (await user.verifyPassword(newPassword)) {
    return res.status(400).json({ error: 'The new password must be different from the current one.' });
  }

  await user.setPassword(newPassword);
  user.mustChangePassword = false;
  user.tokenVersion = (user.tokenVersion || 0) + 1;     // sign out every old session
  user.failedLogins = 0;
  user.lockUntil = null;
  await user.save();
  forgetUser(user._id);
  await logActivity('auth.password', `${user.username} (${user.role}) set a new password`, 'info');
  res.json({ ok: true, token: signToken(user), user: user.toPublic(), admin: user.toPublic() });
};

// POST /api/auth/logout-all — sign this account out on every device
exports.logoutAll = async (req, res) => {
  await User.updateOne({ _id: req.user.id }, { $inc: { tokenVersion: 1 } });
  forgetUser(req.user.id);
  res.json({ ok: true });
};
