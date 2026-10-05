const router = require('express').Router();
const ctrl = require('../controllers/timetableController');
const requireAuth = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');

router.use(requireAuth);

// ── read (any signed-in user) ──
router.get('/me', ctrl.me);
router.get('/filters', ctrl.filters);
router.get('/', ctrl.read);

// ── admin only ──
router.get('/config', requireRole('admin'), ctrl.getConfig);
router.put('/config', requireRole('admin'), ctrl.putConfig);
router.get('/runs', requireRole('admin'), ctrl.listRuns);
router.post('/runs', requireRole('admin'), ctrl.createRun);
router.get('/runs/:id', requireRole('admin'), ctrl.getRun);
router.post('/runs/:id/publish', requireRole('admin'), ctrl.publishRun);
router.get('/runs/:id/export.xlsx', requireRole('admin'), ctrl.exportXlsx);
router.get('/runs/:id/export.pdf', requireRole('admin'), ctrl.exportPdf);

module.exports = router;
