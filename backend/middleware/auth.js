const jwt = require('jsonwebtoken');
const User = require('../models/User');

/**
 * Protects routes. Expects "Authorization: Bearer <token>".
 * On success attaches req.user = { id, username, role } (and req.admin as an
 * alias so existing admin-only controllers keep working unchanged).
 *
 * Every request is checked against the LIVE account, so:
 *   • a deactivated / deleted account is signed out immediately,
 *   • a password change signs out every other device (tokenVersion),
 *   • the role always comes from the database, never only from the token,
 *   • an account still on a default password can do NOTHING except set its
 *     own password (the web app shows a blocking "change password" screen).
 */

// Paths an account that must change its password may still call.
const PASSWORD_CHANGE_ALLOWED = ['/api/auth/me', '/api/auth/change-password', '/api/auth/logout'];

// Tiny cache so a burst of requests doesn't hit MongoDB every time (5 s).
const _cache = new Map();
const CACHE_MS = 5000;
function forgetUser(id) { _cache.delete(String(id)); }

async function loadUser(id) {
  const key = String(id);
  const hit = _cache.get(key);
  if (hit && hit.at > Date.now() - CACHE_MS) return hit.user;
  const user = await User.findById(id).select('username role active tokenVersion mustChangePassword').lean();
  _cache.set(key, { at: Date.now(), user });
  if (_cache.size > 5000) _cache.clear();
  return user;
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  let token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

  // Fallback: token via query string — ONLY for GET downloads. A browser
  // navigation / <a download> for a large file (e.g. the admit cards PDF)
  // cannot send an Authorization header.
  if (!token && req.method === 'GET' && req.query && typeof req.query.token === 'string') token = req.query.token;

  if (!token || token.length > 2048) {
    return res.status(401).json({ error: 'Not signed in. Please sign in to continue.' });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }

  try {
    const user = payload && payload.id ? await loadUser(payload.id) : null;
    if (!user || user.active === false) {
      return res.status(401).json({ error: 'Your account is not active. Please sign in again.' });
    }
    if ((payload.tv || 0) !== (user.tokenVersion || 0)) {
      return res.status(401).json({ error: 'Your password was changed. Please sign in again.' });
    }
    req.user = { id: String(user._id), username: user.username, role: user.role || 'admin', mustChangePassword: !!user.mustChangePassword };
    req.admin = req.user;   // back-compat

    if (user.mustChangePassword) {
      const p = (req.originalUrl || '').split('?')[0];
      if (!PASSWORD_CHANGE_ALLOWED.includes(p)) {
        return res.status(403).json({
          error: 'Please set your own password before continuing.',
          code: 'PASSWORD_CHANGE_REQUIRED',
        });
      }
    }
    next();
  } catch (err) {
    return res.status(500).json({ error: 'Could not verify your session.' });
  }
}

/**
 * Restrict a route to one or more roles. Use after requireAuth:
 *   router.post('/x', requireAuth, requireRole('finance', 'admin'), handler)
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have access to this action.' });
    }
    next();
  };
}

module.exports = requireAuth;
module.exports.requireAuth = requireAuth;
module.exports.requireRole = requireRole;
module.exports.forgetUser = forgetUser;
