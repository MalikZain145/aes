const router = require('express').Router();
const ctrl = require('../controllers/teacherController');
const requireAuth = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');

router.use(requireAuth);
router.use(requireRole('admin'));   // Exam Cell only

router.get('/', ctrl.list);
router.get('/count', ctrl.count);
router.post('/', ctrl.create);
router.post('/invigilation/all', ctrl.setInvigilationAll);
router.post('/invigilation/reset', ctrl.resetInvigilation);
router.patch('/:id/invigilation', ctrl.setInvigilation);
router.put('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);

module.exports = router;
