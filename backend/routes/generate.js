const router = require('express').Router();
const multer = require('multer');
const os = require('os');
const ctrl = require('../controllers/generateController');
const ed = require('../controllers/datesheetEditorController');
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
const { requireRole } = requireAuth;
const admin = requireRole('admin');
const adminOrFinance = requireRole('admin', 'finance');

router.post('/timetable', admin, ctrl.generateTimetable);
router.post('/datesheet', admin, ctrl.generateDatesheet);
// Generate a datesheet straight from an uploaded .xls/.xlsx — no DB involved.
router.post('/datesheet-from-file', admin, upload.single('dataset'), ctrl.generateDatesheetFromFile);
// Generate per-student admit cards + seating plan from an uploaded registration file.
router.post('/admit-cards', adminOrFinance, upload.single('dataset'), ctrl.generateAdmitCards);
// Live progress for the admit-card counter (polled during generation).
router.get('/admit-cards/progress/:token', adminOrFinance, ctrl.getAdmitCardsProgress);
router.get('/admit-card/find', adminOrFinance, ctrl.findStudentCard);
router.get('/admit-card/pdf', adminOrFinance, ctrl.studentCardPdf);
router.get('/tags', adminOrFinance, ctrl.generateTags);

// Datesheet editor: open the grid, then save edits (clash-checked, replaces the old PDF)
router.get('/datesheet/:id/editor', admin, ed.openEditor);
router.post('/datesheet/:id/editor', admin, ed.saveEditor);

router.get('/files', adminOrFinance, ctrl.listFiles);
router.get('/batches', admin, ctrl.listBatches);
router.get('/cohort-courses', admin, ctrl.cohortCourses);                    // every course the level's students take (remove-course list)                              // batches (program + intake) for the datesheet "remove batches" filter
router.get('/no-exam/auto', admin, ctrl.noExamAuto);                          // auto no-paper courses (pre-selected)
router.post('/no-exam/from-file', admin, upload.single('dataset'), ctrl.noExamFromFile);   // yellow rows in a report
router.post('/files/keep-latest', requireAuth.requireRole('admin'), ctrl.keepLatestDatesheets);   // keep latest BS/B.Tech/MS sheets, clear old + admit cards
router.delete('/files', admin, ctrl.clearAllFiles);   // wipe all (optional ?kind=)
router.get('/files/:id/download/:filename', adminOrFinance, ctrl.downloadFile);
router.get('/files/:id/preview/:filename', adminOrFinance, ctrl.previewFile);
router.delete('/files/:id', admin, ctrl.deleteFile);

module.exports = router;
