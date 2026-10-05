const router = require('express').Router();
const requireAuth = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');
const ctrl = require('../controllers/registrationAdminController');

router.use(requireAuth);
router.use(requireRole('admin'));

// list forms for the "New Registration Forms" tab (defaults to approved)
router.get('/', ctrl.list);
router.get('/summary', ctrl.summary);
router.get('/pdf', ctrl.batchPdf);        // per-batch / all, one page per student
router.get('/:id/pdf', ctrl.formPdf);     // a single form

module.exports = router;
