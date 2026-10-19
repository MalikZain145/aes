const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');
const ctrl = require('../controllers/attendanceController');

// Viewing / downloading attendance is for signed-in staff. (Marking PRESENT is
// done by the public /api/verify scan, which needs no login.)
router.use(requireAuth);
router.use(requireRole('admin'));   // Exam Cell only

router.get('/sessions', ctrl.sessions);         // list (date, slot) with room breakdown + counts
router.get('/sheet', ctrl.sheet);               // live/final sheet for a (date, slot[, room])
router.get('/sheet.pdf', ctrl.sheetPdf);        // downloadable PDF (room optional)
router.get('/rooms', ctrl.rooms);               // every room with papers → its per-paper files
router.get('/paper', ctrl.paper);               // one paper in one room: - / P / A per student
router.get('/paper.pdf', ctrl.paperPdf);        // that file — downloadable once the paper's time is over

module.exports = router;
