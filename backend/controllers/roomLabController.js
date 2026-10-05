const Room = require('../models/Room');
const Lab = require('../models/Lab');
const { logActivity } = require('../utils/logger');

/* ─────────────  ROOMS  ───────────── */

exports.listRooms = async (req, res) => {
  const { search = '' } = req.query;
  const q = { active: true };
  if (search) q.name = new RegExp(search, 'i');
  const items = await Room.find(q).sort({ name: 1 }).lean();
  res.json({ items, total: items.length });
};

exports.createRoom = async (req, res) => {
  const { name, capacity, building, examCapacity } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Room name is required.' });
  if (!capacity || capacity < 1) return res.status(400).json({ error: 'Enter a valid capacity.' });

  const exists = await Room.findOne({ name: name.trim() });
  if (exists) return res.status(409).json({ error: 'A room with this name already exists.' });

  const room = await Room.create({
    name: name.trim(),
    capacity: Number(capacity),
    building: building || '',
    examCapacity: examCapacity ? Number(examCapacity) : null,
  });
  await logActivity('room.create', `Room added: ${room.name} (cap ${room.capacity})`, 'success');
  res.status(201).json({ room });
};

exports.updateRoom = async (req, res) => {
  const room = await Room.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  await logActivity('room.update', `Room updated: ${room.name}`, 'info');
  res.json({ room });
};

exports.removeRoom = async (req, res) => {
  const room = await Room.findByIdAndDelete(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  await logActivity('room.delete', `Room removed: ${room.name}`, 'warning');
  res.json({ ok: true, message: `${room.name} removed.` });
};

/* ─────────────  LABS  ───────────── */

exports.listLabs = async (req, res) => {
  const { search = '' } = req.query;
  const q = { active: true };
  if (search) q.name = new RegExp(search, 'i');
  const items = await Lab.find(q).sort({ name: 1 }).lean();
  res.json({ items, total: items.length });
};

exports.createLab = async (req, res) => {
  const { name, capacity, departments, examCapacity } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Lab name is required.' });
  if (!capacity || capacity < 1) return res.status(400).json({ error: 'Enter a valid capacity.' });

  const exists = await Lab.findOne({ name: name.trim() });
  if (exists) return res.status(409).json({ error: 'A lab with this name already exists.' });

  const lab = await Lab.create({
    name: name.trim(),
    capacity: Number(capacity),
    departments: Array.isArray(departments) ? departments : [],
    examCapacity: examCapacity ? Number(examCapacity) : null,
  });
  await logActivity('lab.create', `Lab added: ${lab.name} (cap ${lab.capacity})`, 'success');
  res.status(201).json({ lab });
};

exports.updateLab = async (req, res) => {
  const lab = await Lab.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!lab) return res.status(404).json({ error: 'Lab not found.' });
  await logActivity('lab.update', `Lab updated: ${lab.name}`, 'info');
  res.json({ lab });
};

exports.removeLab = async (req, res) => {
  const lab = await Lab.findByIdAndDelete(req.params.id);
  if (!lab) return res.status(404).json({ error: 'Lab not found.' });
  await logActivity('lab.delete', `Lab removed: ${lab.name}`, 'warning');
  res.json({ ok: true, message: `${lab.name} removed.` });
};

/* combined count for dashboard */
exports.countRoomsLabs = async (_req, res) => {
  const [rooms, labs] = await Promise.all([
    Room.countDocuments({ active: true }),
    Lab.countDocuments({ active: true }),
  ]);
  res.json({ rooms, labs, total: rooms + labs });
};
