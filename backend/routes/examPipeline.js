const router = require('express').Router();
const multer = require('multer');
const os = require('os');
const requireAuth = require('../middleware/auth');
const ctrl = require('../controllers/examPipelineController');

// Any of the exam-office reports: student-wise registration, class-wise enrolment,
// timetable dataset, rooms list. Shapes are detected from the headers.
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xlsx|xls|csv)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only .xlsx, .xls or .csv files are allowed.'), ok);
  },
});

router.use(requireAuth, requireAuth.requireRole('admin'));
router.post('/run', (req, res) => {
  upload.array('files', 10)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    ctrl.run(req, res);
  });
});
router.get('/jobs', ctrl.list);
router.get('/jobs/:id', ctrl.status);

module.exports = router;
