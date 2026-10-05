const router = require('express').Router();
const multer = require('multer');
const os = require('os');
const path = require('path');
const requireAuth = require('../middleware/auth');
const ctrl = require('../controllers/datasetController');

// Store uploads in the OS temp dir; the controller deletes them after parsing
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xlsx|xls)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only .xlsx or .xls files are allowed.'), ok);
  },
});

router.use(requireAuth);

// Multer error handling wrapper
router.post('/upload', (req, res) => {
  upload.single('dataset')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    ctrl.uploadDataset(req, res);
  });
});

module.exports = router;
