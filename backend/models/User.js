const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

/**
 * Unified account for every portal role.
 *   role: 'admin'    → Exam Cell (scheduling, datesheets, invigilation, etc.)
 *         'finance'  → Finance Office (admit-card generation + fee-gated email)
 *         'faculty'  → Faculty (advisor / HoD review of registration forms)
 *         'student'  → Student (digital course-registration & add/drop forms)
 *
 * `username` is what you sign in with: an email for staff, the registration
 * number (lower-cased) for students. Profile fields are role-dependent and
 * simply left blank when not applicable.
 */
const userSchema = new mongoose.Schema(
  {
    role: { type: String, required: true, enum: ['admin', 'finance', 'faculty', 'student'], index: true },
    username: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },

    name: { type: String, default: '' },
    email: { type: String, default: '', trim: true, lowercase: true },
    phone: { type: String, default: '' },

    // Student / faculty context
    regNo: { type: String, default: '', trim: true, index: true },
    department: { type: String, default: '' },
    batch: { type: String, default: '' },
    degree: { type: String, default: '' },

    // Faculty may also be linked to a Teacher record (advisor/HoD assignment).
    teacherId: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', default: null },

    mustChangePassword: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    lastLogin: { type: Date },
  },
  { timestamps: true }
);

userSchema.methods.setPassword = async function (plain) {
  const salt = await bcrypt.genSalt(10);
  this.passwordHash = await bcrypt.hash(plain, salt);
};

userSchema.methods.verifyPassword = function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

/** Safe public projection (never leak the hash). */
userSchema.methods.toPublic = function () {
  return {
    id: this._id,
    role: this.role,
    username: this.username,
    name: this.name || this.username,
    displayName: this.name || this.username,   // back-compat with the old admin shape
    email: this.email,
    phone: this.phone,
    regNo: this.regNo,
    department: this.department,
    batch: this.batch,
    degree: this.degree,
    mustChangePassword: this.mustChangePassword,
  };
};

module.exports = mongoose.model('User', userSchema);
