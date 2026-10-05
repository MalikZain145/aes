const router = require('express').Router();
const multer = require('multer');
const os = require('os');
const ctrl = require('../controllers/peopleController');
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

// dropdown data
router.get('/org-units', ctrl.orgUnits);
router.get('/faculty', ctrl.listFaculty);

// advisor / HoD assignments
router.get('/assignments', ctrl.listAssignments);
router.post('/assignments', ctrl.upsertAssignment);
router.put('/assignments/:id', ctrl.updateAssignment);
router.delete('/assignments/:id', ctrl.deleteAssignment);

// student accounts
router.get('/students/stats', ctrl.studentStats);
router.post('/students/upload', upload.single('file'), ctrl.uploadStudents);
router.post('/students/provision', ctrl.provisionStudents);

// registration window + reminders
router.get('/registration-window', ctrl.getWindow);
router.put('/registration-window', ctrl.setWindow);
router.post('/registration-remind', ctrl.remindApprovers);

module.exports = router;
