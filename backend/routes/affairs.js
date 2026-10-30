const router = require('express').Router();
const ctrl = require('../controllers/affairsController');
const { requireAuth, requireRole } = require('../middleware/auth');
const { rateLimit } = require('../utils/security');

// Public — the gate scanner app (no login). Rate-limited per device / IP.
router.post('/scan', rateLimit({ windowMs: 60 * 1000, max: 120, message: 'Too many scans from this device. Wait a minute and try again.' }), ctrl.scan);

// Office of Student Affairs portal (and the Exam Cell admin).
const staff = [requireAuth, requireRole('affairs', 'admin')];
router.get('/status', staff, ctrl.status);
router.get('/stats', staff, ctrl.stats);
router.post('/cards/issue', staff, ctrl.issue);
router.post('/cards/block', staff, ctrl.block);
router.get('/students/:regNo', staff, ctrl.lookup);

module.exports = router;
