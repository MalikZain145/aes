const router = require('express').Router();
const ctrl = require('../controllers/authController');
const requireAuth = require('../middleware/auth');

const { rateLimit } = require('../utils/security');

// Brute-force protection (on top of the per-account lockout after 5 wrong passwords):
//   • max 10 attempts per IP + username in 10 minutes
//   • max 300 attempts per IP in 10 minutes (a whole computer lab shares one IP)
const uname = (req) => String((req.body && req.body.username) || '').toLowerCase().replace(/[^a-z0-9@._-]/g, '').slice(0, 80);
const perUser = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, keyFn: (req) => `${req.ip}|${uname(req)}`, message: 'Too many sign-in attempts. Please wait 10 minutes and try again.' });
const perIp = rateLimit({ windowMs: 10 * 60 * 1000, max: 300, message: 'Too many sign-in attempts from this network. Please wait a few minutes.' });
const loginLimiter = [perIp, perUser];
const pwLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 15, keyFn: (req) => (req.user ? `u:${req.user.id}` : req.ip) });

router.post('/login', loginLimiter, ctrl.login);
router.get('/me', requireAuth, ctrl.me);
router.patch('/me', requireAuth, ctrl.updateProfile);
router.post('/change-password', requireAuth, pwLimiter, ctrl.changePassword);
router.post('/logout-all', requireAuth, ctrl.logoutAll);

module.exports = router;
