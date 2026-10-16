const router = require('express').Router();
const ctrl = require('../controllers/assistantController');
const requireAuth = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');

router.use(requireAuth);
router.use(requireRole('admin'));   // Exam Cell only

// "Ask Abasyn" — voice / text questions about the live exam data
router.post('/ask', ctrl.ask);

module.exports = router;
