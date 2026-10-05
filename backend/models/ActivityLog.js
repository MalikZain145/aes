const mongoose = require('mongoose');

/**
 * Records notable admin actions so the dashboard "Recent Activities"
 * feed and the Logs page have real data.
 */
const activityLogSchema = new mongoose.Schema(
  {
    action: { type: String, required: true }, // e.g. "course.create"
    message: { type: String, required: true }, // human-readable
    level: { type: String, default: 'info', enum: ['info', 'success', 'warning', 'error'] },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

activityLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('ActivityLog', activityLogSchema);
