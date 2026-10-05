const jwt = require('jsonwebtoken');

/**
 * Protects routes. Expects "Authorization: Bearer <token>".
 * On success attaches req.user = { id, username, role } (and req.admin as an
 * alias so existing admin-only controllers keep working unchanged).
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  let token = header.startsWith('Bearer ') ? header.slice(7) : null;

  // Fallback: token via query string. Needed for direct file downloads — a
  // browser navigation / <a download> for a large file (e.g. the ~13 MB admit
  // cards PDF) streams straight to disk but cannot send an Authorization header.
  if (!token && req.query && req.query.token) token = String(req.query.token);

  if (!token) {
    return res.status(401).json({ error: 'Not signed in. Please sign in to continue.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.id, username: payload.username, role: payload.role || 'admin' };
    req.admin = req.user;   // back-compat
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
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
