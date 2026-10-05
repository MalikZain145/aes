const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { logActivity } = require('../utils/logger');

function signToken(user) {
  return jwt.sign(
    { id: user._id.toString(), username: user.username, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES || '7d' }
  );
}

// POST /api/auth/login
exports.login = async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Enter both username and password.' });
  }

  const user = await User.findOne({ username: String(username).toLowerCase().trim() });
  if (!user || !user.active) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }

  const ok = await user.verifyPassword(password);
  if (!ok) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }

  user.lastLogin = new Date();
  await user.save();
  await logActivity('auth.login', `${user.name || user.username} (${user.role}) signed in`, 'success');

  const token = signToken(user);
  // `admin` key kept for backward-compatibility with the existing frontend.
  res.json({ token, role: user.role, user: user.toPublic(), admin: user.toPublic() });
};

// GET /api/auth/me
exports.me = async (req, res) => {
  const user = await User.findById(req.user.id).select('-passwordHash');
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  res.json({ user: user.toPublic(), admin: user.toPublic() });
};

// PATCH /api/auth/me  — user edits their own display name
exports.updateProfile = async (req, res) => {
  const name = String(req.body?.displayName || req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
  if (name.length > 60) return res.status(400).json({ error: 'Name is too long (max 60 characters).' });
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  user.name = name;
  await user.save();
  await logActivity('auth.profile', `Profile name updated to "${name}"`, 'info');
  res.json({ user: user.toPublic(), admin: user.toPublic() });
};

// POST /api/auth/change-password
exports.changePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  // Existing password must match unless the account is flagged to change it.
  if (!user.mustChangePassword) {
    const ok = await user.verifyPassword(currentPassword || '');
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  await user.setPassword(String(newPassword));
  user.mustChangePassword = false;
  await user.save();
  await logActivity('auth.password', 'Password changed', 'info');
  res.json({ ok: true, user: user.toPublic() });
};
