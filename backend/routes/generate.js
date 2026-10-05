const router = require('express').Router();
const multer = require('multer');
const os = require('os');
const ctrl = require('../controllers/generateController');
const requireAuth = require('../middleware/auth');

// Uploads for one-off datesheet generation go to a temp dir and are deleted
// right after the PDF is produced — the datesheet file is never stored in the DB.
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xlsx|xls|csv)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only .xlsx, .xls or .csv files are allowed.'), ok);
  },
});

router.use(requireAuth);

router.post('/timetable', ctrl.generateTimetable);
router.post('/datesheet', ctrl.generateDatesheet);
// Generate a datesheet straight from an uploaded .xls/.xlsx — no DB involved.
router.post('/datesheet-from-file', upload.single('dataset'), ctrl.generateDatesheetFromFile);
// Generate per-student admit cards + seating plan from an uploaded registration file.
router.post('/admit-cards', upload.single('dataset'), ctrl.generateAdmitCards);
// Live progress for the admit-card counter (polled during generation).
router.get('/admit-cards/progress/:token', ctrl.getAdmitCardsProgress);
router.get('/admit-card/find', ctrl.findStudentCard);
router.get('/admit-card/pdf', ctrl.studentCardPdf);
router.get('/tags', ctrl.generateTags);

router.get('/files', ctrl.listFiles);
router.get('/no-exam/auto', ctrl.noExamAuto);                          // auto no-paper courses (pre-selected)
router.post('/no-exam/from-file', upload.single('dataset'), ctrl.noExamFromFile);   // yellow rows in a report
router.post('/files/keep-latest', requireAuth.requireRole('admin'), ctrl.keepLatestDatesheets);   // keep latest BS/B.Tech/MS sheets, clear old + admit cards
router.delete('/files', ctrl.clearAllFiles);   // wipe all (optional ?kind=)
router.get('/files/:id/download/:filename', ctrl.downloadFile);
router.get('/files/:id/preview/:filename', ctrl.previewFile);
router.delete('/files/:id', ctrl.deleteFile);

module.exports = router;
