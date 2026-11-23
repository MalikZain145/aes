const router = require('express').Router();
const ctrl = require('../controllers/scannerController');
const security = require('../utils/security');

// Public (the scanner app has no login): the pack is encrypted per card, and
// attendance marks are only accepted for genuine tokens during their paper.
router.get('/pack', security.rateLimit({ windowMs: 60 * 1000, max: 30, message: 'Too many downloads. Wait a minute.' }), ctrl.pack);
router.post('/attendance', security.rateLimit({ windowMs: 60 * 1000, max: 120, message: 'Too many uploads. Wait a minute.' }), ctrl.attendance);

module.exports = router;
