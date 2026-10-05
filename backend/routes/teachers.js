const router = require('express').Router();
const ctrl = require('../controllers/teacherController');
const requireAuth = require('../middleware/auth');

router.use(requireAuth);

router.get('/', ctrl.list);
router.get('/count', ctrl.count);
router.post('/', ctrl.create);
router.put('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);

module.exports = router;
