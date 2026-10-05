const router = require('express').Router();
const ctrl = require('../controllers/studentController');
const att = require('../controllers/classAttendanceController');
const requireAuth = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');

router.use(requireAuth);
router.use(requireRole('student'));

router.get('/me', ctrl.me);
router.get('/timetable', ctrl.timetable);
router.get('/attendance', att.myAttendance);
router.get('/admit-card/status', ctrl.admitStatus);
router.get('/admit-card', ctrl.admitCard);
router.get('/terms', ctrl.terms);
router.get('/courses', ctrl.courses);
router.get('/registered', ctrl.registered);
router.get('/registrations', ctrl.listRegistrations);
router.get('/registrations/:id/pdf', ctrl.formPdf);
router.post('/registrations', ctrl.submitRegistration);
router.put('/registrations/:id', ctrl.resubmitRegistration);

module.exports = router;
