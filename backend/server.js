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
app.use('/api/assistant', require('./routes/assistant'));   // Ask Abasyn (voice) — exam data
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
app.use('/api/affairs', require('./routes/affairs'));   // Office of Student Affairs — digital ID cards (+ public /scan)

// ── Public QR verification (no auth) ────────────────────────────────────────
const _verify = require('./controllers/verifyController');
app.get('/verify/:token', _verify.renderVerify);   // phone browser → HTML page
app.get('/api/verify/:token', _verify.verifyJson); // mobile scanner app → JSON
// Scanner app version gate. Set SCANNER_MIN_VERSION (e.g. 1.1.0) + SCANNER_APK_URL
// only when a NEW APK is required; older apps then show "Update Abasyn Scheduler to
// proceed" with a download button. Everyday code changes go out with `eas update`.
app.get('/api/app/version', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    minVersion: String(process.env.SCANNER_MIN_VERSION || '').trim(),
    apkUrl: String(process.env.SCANNER_APK_URL || '').trim(),
    message: String(process.env.SCANNER_UPDATE_MESSAGE || '').trim(),
  });
});

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

// Start LISTENING IMMEDIATELY — before the DB connect + bootstrap below. The platform's
// deploy health check (GET /api/health, which needs no database) then passes even on a
// slow cold start of this large image, instead of the deploy timing out while the server
// waited on connectDB/index-sync. The connection + startup tasks run in the background;
// Mongoose buffers queries until the connection is ready, so API routes work the moment
// the DB connects. Bind to 0.0.0.0 so phones on the same WiFi (the scanner) can reach it.
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

(async () => {
  try { await connectDB(MONGO_URI); } catch (e) { console.error('DB connect failed:', e.message); }
  // Assignments became term-scoped — rebuild indexes so the old unique index
  // (type,department,program,batch) is replaced by (type,term,department,program,batch).
  try { await require('./models/Assignment').syncIndexes(); } catch (e) { console.warn('Assignment index sync:', e.message); }
  // First-run bootstrap: on a brand-new database there are no login accounts, so seed
  // the staff accounts once. Existing databases are untouched (runs only when NO admin).
  try { await seedStaffIfEmpty(); } catch (e) { console.warn('Staff seed:', e.message); }
  // Office of Student Affairs login (created once if missing; never reset afterwards).
  try { await ensureAffairsAccount(); } catch (e) { console.warn('Student Affairs login:', e.message); }
  // Generated files live in the database too (GridFS) — restore any this disk is missing
  // (a hosted server's disk is wiped on every restart), then run the env-gated one-time
  // maintenance tasks (which work on those files). Both in the BACKGROUND.
  Promise.resolve()
    .then(() => require('./utils/fileStore').init())
    .catch((e) => console.warn('File store:', e.message))
    .then(() => require('./utils/oneTimeTasks').runOneTimeTasks())
    .catch((e) => console.warn('One-time tasks:', e.message));
  // Every registered student gets a Student Portal login (reg no / student123): created
  // now for anyone missing, then new registration records get logins automatically.
  try { require('./utils/studentAccounts').startStudentAccountSync(); } catch (e) { console.warn('Student login sync:', e.message); }
  // Security: any account still on a factory password is flagged to force a reset next sign-in.
  setTimeout(() => flagDefaultPasswords().catch((e) => console.warn('Default-password audit:', e.message)), 15000);
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
    { role: 'admin',   username: 'examination@abasynisb.edu.pk', password: process.env.ADMIN_PASSWORD || 'admin123', name: 'Exam Cell',      email: 'examination@abasynisb.edu.pk' },
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

// Office of Student Affairs login — studentaffairs@abasynisb.edu.pk. Created only when
// it does not exist yet; an existing account (and any password set on it) is left as-is.
async function ensureAffairsAccount() {
  const User = require('./models/User');
  const username = 'studentaffairs@abasynisb.edu.pk';
  if (await User.exists({ username })) return;
  const u = new User({ role: 'affairs', username, name: 'Student Affairs', email: username, mustChangePassword: false });
  await u.setPassword(process.env.AFFAIRS_PASSWORD || 'affairs123', { fast: true });
  await u.save();
  console.log(`✓ Student Affairs login created ("${username}")`);
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
