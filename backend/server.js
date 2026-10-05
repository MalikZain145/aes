require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const connectDB = require('./config/db');

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.CLIENT_ORIGIN || '*' }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

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
    const u = new User({ role: a.role, username: a.username, name: a.name, email: a.email });
    await u.setPassword(a.password);
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
