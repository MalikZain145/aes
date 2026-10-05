const ActivityLog = require('../models/ActivityLog');

/**
 * Fire-and-forget activity logging. Never throws — logging must not
 * break the main request flow.
 */
async function logActivity(action, message, level = 'info', meta = {}) {
  try {
    await ActivityLog.create({ action, message, level, meta });
  } catch (err) {
    console.warn('Activity log failed:', err.message);
  }
}

module.exports = { logActivity };
