const router = require('express').Router();
const requireAuth = require('../middleware/auth');
const ctrl = require('../controllers/archiveController');

router.use(requireAuth);

router.get('/terms', ctrl.terms);          // list archived semesters (folder cards)
router.get('/files', ctrl.files);          // one term's records, grouped into folders
router.get('/download', ctrl.download);     // whole term as a single ZIP

module.exports = router;
