const mongoose = require('mongoose');

const teacherSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, default: '', trim: true, lowercase: true },
    facultyId: { type: String, default: '', trim: true }, // e.g. CE-075
    department: { type: String, default: '' }, // dept key or readable label
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Same name shouldn't be duplicated
teacherSchema.index({ name: 1 }, { unique: true });

module.exports = mongoose.model('Teacher', teacherSchema);
