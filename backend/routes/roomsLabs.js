const router = require('express').Router();
const ctrl = require('../controllers/roomLabController');
const requireAuth = require('../middleware/auth');

router.use(requireAuth);

// combined count for dashboard
router.get('/count', ctrl.countRoomsLabs);

// rooms
router.get('/rooms', ctrl.listRooms);
router.post('/rooms', ctrl.createRoom);
router.put('/rooms/:id', ctrl.updateRoom);
router.delete('/rooms/:id', ctrl.removeRoom);

// labs
router.get('/labs', ctrl.listLabs);
router.post('/labs', ctrl.createLab);
router.put('/labs/:id', ctrl.updateLab);
router.delete('/labs/:id', ctrl.removeLab);

module.exports = router;
