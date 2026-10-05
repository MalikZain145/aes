const mongoose = require('mongoose');

/** Tiny key/value store for app-wide settings (e.g. the registration window). */
const settingSchema = new mongoose.Schema(
  { key: { type: String, unique: true, required: true }, value: { type: mongoose.Schema.Types.Mixed, default: null } },
  { timestamps: true }
);

module.exports = mongoose.model('Setting', settingSchema);
