const router = require('express').Router();
const ctrl = require('../controllers/facultyController');
const att = require('../controllers/classAttendanceController');
const requireAuth = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');

router.use(requireAuth);
router.use(requireRole('faculty', 'admin'));

router.get('/me', ctrl.me);
router.get('/forms', ctrl.forms);
router.post('/forms/:id/seen', ctrl.markSeen);
router.post('/forms/:id/approve', ctrl.approve);
router.post('/forms/:id/return', ctrl.returnForm);
router.get('/forms/:id/pdf', ctrl.formPdf);

// Class attendance + own timetable (available to every faculty member)
router.get('/timetable', att.facultyTimetable);
router.get('/my-courses', att.myCourses);
router.get('/attendance', att.list);
router.get('/attendance/roster', att.roster);
router.post('/attendance', att.save);
router.get('/attendance/:id/pdf', att.pdf);

module.exports = router;
