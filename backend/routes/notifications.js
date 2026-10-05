const router = require('express').Router();
const requireAuth = require('../middleware/auth');
const ctrl = require('../controllers/notificationsController');

router.use(requireAuth);
router.get('/', ctrl.list);

module.exports = router;
