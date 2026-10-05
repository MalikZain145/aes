const router = require('express').Router();
const multer = require('multer');
const os = require('os');
const ctrl = require('../controllers/timetableEmailController');
const requireAuth = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xlsx|xls|csv)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only .xlsx, .xls or .csv files are allowed.'), ok);
  },
});

router.use(requireAuth);
router.use(requireRole('admin'));

router.get('/status', ctrl.status);
router.post('/dispatch', upload.single('studentList'), ctrl.dispatch);

module.exports = router;
