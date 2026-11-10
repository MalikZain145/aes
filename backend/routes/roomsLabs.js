const router = require('express').Router();
const ctrl = require('../controllers/roomLabController');
const requireAuth = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');
const admin = requireRole('admin');

router.use(requireAuth);

// combined count for dashboard
router.get('/count', requireRole('admin', 'finance'), ctrl.countRoomsLabs);

// rooms
router.get('/rooms', admin, ctrl.listRooms);
router.post('/rooms', admin, ctrl.createRoom);
router.put('/rooms/:id', admin, ctrl.updateRoom);
router.delete('/rooms/:id', admin, ctrl.removeRoom);

// labs
router.get('/labs', admin, ctrl.listLabs);
router.post('/labs', admin, ctrl.createLab);
router.put('/labs/:id', admin, ctrl.updateLab);
router.delete('/labs/:id', admin, ctrl.removeLab);

module.exports = router;
