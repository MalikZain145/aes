const router = require('express').Router();
const requireAuth = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');
const ctrl = require('../controllers/studentCourseController');

router.use(requireAuth);
router.use(requireRole('admin'));

router.get('/student-courses', ctrl.list);
router.post('/student-courses/:reg/course', ctrl.editCourse);

module.exports = router;
