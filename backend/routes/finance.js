const router = require('express').Router();
const multer = require('multer');
const os = require('os');
const ctrl = require('../controllers/financeController');
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
// Finance-only (admin may also view/dispatch as a super-role).
router.use(requireRole('finance', 'admin'));

router.get('/batches', ctrl.listBatches);
router.get('/smtp', ctrl.smtpStatus);
router.post('/dispatch', upload.single('feeList'), ctrl.dispatch);
// Mark a single student's fee Paid / Unpaid (individual counterpart of the list).
router.post('/fee', ctrl.setFee);

module.exports = router;
