const router = require('express').Router();
const ctrl = require('../controllers/dashboardController');
const requireAuth = require('../middleware/auth');

router.use(requireAuth);

router.get('/summary', ctrl.summary);
router.get('/activity', ctrl.activity);
router.get('/today', ctrl.todaySchedule);

module.exports = router;
