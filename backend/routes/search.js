const router = require('express').Router();
const ctrl = require('../controllers/searchController');
const requireAuth = require('../middleware/auth');

router.use(requireAuth);

// List searchable timetables + datesheets (for the filter panel).
router.get('/sources', ctrl.getSources);
// Run a query against a selected source (or the latest).
router.post('/', ctrl.search);

module.exports = router;
