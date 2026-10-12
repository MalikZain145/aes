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
    passwordChangedAt: { type: Date },

    // Security: bumping tokenVersion instantly signs the account out everywhere
    // (used after a password change). failedLogins / lockUntil = brute-force lockout.
    tokenVersion: { type: Number, default: 0 },
    failedLogins: { type: Number, default: 0 },
    lockUntil: { type: Date, default: null },
    active: { type: Boolean, default: true },
    lastLogin: { type: Date },
  },
  { timestamps: true }
);

// bcrypt cost 12 for passwords people choose themselves. Default passwords
// (bulk-created student / faculty logins) keep cost 10 so creating thousands of
// accounts stays fast — they must be changed on first sign-in anyway.
userSchema.methods.setPassword = async function (plain, { fast = false } = {}) {
  const salt = await bcrypt.genSalt(fast ? 10 : 12);
  this.passwordHash = await bcrypt.hash(String(plain), salt);
  this.passwordChangedAt = new Date();
};

userSchema.methods.isLocked = function () {
  return !!(this.lockUntil && this.lockUntil.getTime() > Date.now());
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
