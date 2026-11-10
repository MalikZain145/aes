const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');
const ctrl = require('../controllers/attendanceController');
const multer = require('multer');
const os = require('os');

// Reviewed identification-sheet Excel (deleted by the controller after reading)
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xlsx|xls)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only .xlsx or .xls files are allowed.'), ok);
  },
});

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
router.post('/booklet', ctrl.booklet);          // answer-booklet number of one student (optional)
router.post('/sheet-import', (req, res) => {   // scanned identification sheets → reviewed Excel (dryRun=1 previews)
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    ctrl.sheetImport(req, res);
  });
});
router.get('/student', ctrl.student);           // pre-fill name / degree / batch by reg no
router.get('/absentees', ctrl.absentees);
router.get('/export', ctrl.exportXlsx);           // Excel: ?type=absent|present|all — live data       // every absent student — after the LAST paper of the exam

module.exports = router;
