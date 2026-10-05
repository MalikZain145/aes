const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth');
const ctrl = require('../controllers/attendanceController');

// Viewing / downloading attendance is for signed-in staff. (Marking PRESENT is
// done by the public /api/verify scan, which needs no login.)
router.use(requireAuth);

router.get('/sessions', ctrl.sessions);         // list (date, slot) with room breakdown + counts
router.get('/sheet', ctrl.sheet);               // live/final sheet for a (date, slot[, room])
router.get('/sheet.pdf', ctrl.sheetPdf);        // downloadable PDF (room optional)

module.exports = router;
