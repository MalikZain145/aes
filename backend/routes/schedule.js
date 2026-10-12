const router = require('express').Router();
const ctrl = require('../controllers/scheduleController');
const requireAuth = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');

router.use(requireAuth);
router.use(requireRole('admin'));   // Exam Cell only

// Latest timetable's structured schedule for the Views screen.
router.get('/latest', ctrl.getLatest);

module.exports = router;
