require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const connectDB = require('./config/db');
const security = require('./utils/security');

security.ensureJwtSecret();   // never run with a missing / guessable token secret

const app = express();

// ── Security middleware ───────────────────────────────────────────────────────
app.disable('x-powered-by');                       // don't advertise Express
app.set('trust proxy', 1);                         // real client IP behind Render / nginx
app.use(security.securityHeaders());               // CSP, no-sniff, frame, referrer, HSTS…
app.use(cors(security.corsDelegate));              // only allowed web origins
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(security.sanitizeInput);                   // block {"$ne": …} NoSQL injection
// Rate limits: general API ceiling per IP, stricter on the public verify endpoints.
app.use('/api/', security.rateLimit({ windowMs: 60 * 1000, max: 3000 }));   // generous: a whole lab can share one IP
app.use(['/api/verify', '/verify'], security.rateLimit({ windowMs: 60 * 1000, max: 120, message: 'Too many scans from this device. Wait a minute and try again.' }));

// Simple request logging in dev
if (process.env.NODE_ENV !== 'production') {
  app.use((req, _res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
  });
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'Abasyn Scheduler API', time: new Date().toISOString() });
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api/courses', require('./routes/courses'));
app.use('/api/teachers', require('./routes/teachers'));
app.use('/api/rooms-labs', require('./routes/roomsLabs'));
app.use('/api/generate', require('./routes/generate'));
app.use('/api/exam-pipeline', require('./routes/examPipeline'));   // one-click end-to-end exam engine
app.use('/api/search', require('./routes/search'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/dataset', require('./routes/dataset'));
app.use('/api/schedule', require('./routes/schedule'));
app.use('/api/finance', require('./routes/finance'));
// Timetable email dispatch retired — teachers/students view timetables in the portal.
app.use('/api/timetable', require('./routes/timetable'));   // new CP-SAT engine (DB-driven)
app.use('/api/registrations', require('./routes/registrations'));
app.use('/api/exam', require('./routes/studentCourses'));
app.use('/api/admin', require('./routes/people'));
app.use('/api/admin/terms', require('./routes/terms'));
app.use('/api/student', require('./routes/student'));
app.use('/api/faculty', require('./routes/faculty'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/archive', require('./routes/archive'));

// ── Public QR verification (no auth) ────────────────────────────────────────
const _verify = require('./controllers/verifyController');
app.get('/verify/:token', _verify.renderVerify);   // phone browser → HTML page
app.get('/api/verify/:token', _verify.verifyJson); // mobile scanner app → JSON

// ── Serve built frontend in production ───────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.join(__dirname, '..', 'frontend', 'dist');
  app.use(express.static(clientDist));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) return res.status(413).json({ error: 'The upload is too large.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/abasyn_scheduler';

(async () => {
  await connectDB(MONGO_URI);
  // Assignments became term-scoped — rebuild indexes so the old unique index
  // (type,department,program,batch) is replaced by (type,term,department,program,batch).
  try { await require('./models/Assignment').syncIndexes(); } catch (e) { console.warn('Assignment index sync:', e.message); }
  // First-run bootstrap: on a brand-new database (e.g. a fresh Atlas cluster in
  // production) there are no login accounts, so seed the staff accounts once. This
  // makes a fresh deploy usable immediately — data is then imported in-app. Existing
  // databases are untouched (it only runs when NO admin exists).
  try { await seedStaffIfEmpty(); } catch (e) { console.warn('Staff seed:', e.message); }
  // Every registered student gets a Student Portal login (reg no / student123):
  // created now for anyone missing, then new registration records are detected
  // automatically and their logins are created too.
  try { require('./utils/studentAccounts').startStudentAccountSync(); } catch (e) { console.warn('Student login sync:', e.message); }
  // Security: any account that still uses a factory password (admin123, finance123,
  // faculty123, student123) is flagged so its next sign-in forces a new password.
  setTimeout(() => flagDefaultPasswords().catch((e) => console.warn('Default-password audit:', e.message)), 15000);
  // Bind to 0.0.0.0 so phones on the same WiFi (the QR scanner app) can reach it,
  // not just localhost.
  app.listen(PORT, '0.0.0.0', () => {
    const os = require('os');
    const lans = [];
    const ifaces = os.networkInterfaces();
    for (const n of Object.keys(ifaces)) {
      for (const i of ifaces[n] || []) {
        if (i.family === 'IPv4' && !i.internal && !/^169\.254\./.test(i.address)) lans.push(i.address);
      }
    }
    console.log(`\n🚀 Abasyn Scheduler API running on http://localhost:${PORT}`);
    if (lans.length) {
      console.log(`   Scanner / phone URL (same WiFi):`);
      lans.forEach((a) => console.log(`      http://${a}:${PORT}`));
    }
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
    ensureFirewallOpen(PORT);
    console.log('');
  });
})();

// Background audit: flag every account still using a default password. Staff
// accounts are always checked; students only if not already flagged.
async function flagDefaultPasswords() {
  const User = require('./models/User');
  const bcrypt = require('bcryptjs');
  const users = await User.find({ mustChangePassword: { $ne: true }, active: { $ne: false } }).select('_id role passwordHash username').lean();
  let flagged = 0;
  for (const u of users) {
    const tryList = u.role === 'student' ? ['student123'] : security.DEFAULT_PASSWORDS;
    for (const pw of tryList) {
      // eslint-disable-next-line no-await-in-loop
      if (await bcrypt.compare(pw, u.passwordHash)) {
        // eslint-disable-next-line no-await-in-loop
        await User.updateOne({ _id: u._id }, { $set: { mustChangePassword: true } });
        flagged += 1;
        break;
      }
    }
  }
  if (flagged) console.log(`🔒 ${flagged} account(s) still on a default password — they must set a new one at next sign-in.`);
}

// Seed the staff login accounts on a fresh database only (no admin yet). The admin
// username/password come from env when provided, else the project defaults — matching
// scripts/seed.js so local and deployed credentials stay the same.
async function seedStaffIfEmpty() {
  const User = require('./models/User');
  if (await User.exists({ role: 'admin' })) return;   // already set up — leave as-is
  const accounts = [
    { role: 'admin',   username: process.env.ADMIN_USERNAME || 'examcell.abasynisb.edu.pk', password: process.env.ADMIN_PASSWORD || 'admin123', name: 'Exam Cell',      email: 'examcell@abasynisb.edu.pk' },
    { role: 'finance', username: 'finance@abasynisb.edu.pk', password: 'finance123', name: 'Finance Office', email: 'finance@abasynisb.edu.pk' },
    { role: 'faculty', username: 'faculty@abasynisb.edu.pk', password: 'faculty123', name: 'Faculty',        email: 'faculty@abasynisb.edu.pk' },
  ];
  for (const a of accounts) {
    const u = new User({ role: a.role, username: a.username, name: a.name, email: a.email,
      mustChangePassword: security.isDefaultPassword(a.password) });
    await u.setPassword(a.password, { fast: true });
    await u.save();
  }
  console.log(`✓ Seeded ${accounts.length} staff accounts on fresh DB (admin: "${accounts[0].username}")`);
}

// On Windows, the phone can only reach the server if the firewall lets port 5000
// in. A *new* WiFi is treated as a "Public" network where inbound is blocked by
// default — that's why the scanner works at home but fails elsewhere. We add a
// one-time inbound allow rule for all profiles (best-effort: needs admin the
// first time; if it can't, we print the exact command to run).
function ensureFirewallOpen(port) {
  if (process.platform !== 'win32') return;
  const { exec } = require('child_process');
  const name = `Abasyn Exam Server ${port}`;
  const add = `netsh advfirewall firewall add rule name="${name}" dir=in action=allow protocol=TCP localport=${port} profile=any`;
  exec(`netsh advfirewall firewall show rule name="${name}"`, (err, out) => {
    if (!err && /LocalPort/i.test(out || '')) {
      console.log(`   Firewall: port ${port} already open for any network ✔`);
      return;
    }
    exec(add, (e2) => {
      if (!e2) console.log(`   Firewall: opened port ${port} for any network ✔`);
      else console.log(`   Firewall: could not auto-open port ${port}. Run ONCE in an ADMIN terminal:\n      ${add}`);
    });
  });
}
