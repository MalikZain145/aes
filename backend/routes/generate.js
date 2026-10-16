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
// Course pack: one course's ID sheets / seating / invigilation / admit cards from the issued batch
const cp = require('../controllers/admitCoursePackController');
router.get('/admit-course/search', adminOrFinance, cp.search);
// Re-apply the section rule to an issued batch (sections never merged; A→B→C seating)
router.post('/admit-cards/:id/sections', admin, async (req, res) => {
  try { res.json({ ok: true, ...(await require('../utils/sections').resectionBatch(req.params.id)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/invigilation-xlsx', adminOrFinance, cp.batchXlsx);
router.get('/admit-course/:code/xlsx', adminOrFinance, cp.courseXlsx);
router.get('/admit-course/:code', adminOrFinance, cp.summary);
router.get('/admit-course/:code/pdf/:doc', adminOrFinance, cp.pdf);

// Datesheet editor: open the grid, then save edits (clash-checked, replaces the old PDF)
router.get('/datesheet/:id/editor', admin, ed.openEditor);
router.post('/datesheet/:id/editor', admin, ed.saveEditor);
// Update an existing datesheet with the current registrations (keeps every placement +
// merge, adds missing theory courses clash-free, fixes clashes from new students)
router.post('/datesheet/:id/refresh', admin, ed.refresh);
router.post('/datesheets/refresh-all', admin, ed.refreshAll);

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
