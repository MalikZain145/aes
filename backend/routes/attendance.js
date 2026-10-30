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
// Exam Cell corrections — only after a paper has ended
router.post('/mark', ctrl.mark);                // switch a student P ⇄ A
router.post('/add', ctrl.add);                  // add a student who is not on the seating plan
router.post('/remove-added', ctrl.removeAdded); // undo a hand-added student
router.get('/student', ctrl.student);           // pre-fill name / degree / batch by reg no
router.get('/absentees', ctrl.absentees);       // every absent student — after the LAST paper of the exam

module.exports = router;
