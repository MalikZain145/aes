/**
 * Quick Python check — run this to confirm the app can find Python:
 *   node scripts/checkPython.js
 *
 * It mirrors the exact detection the timetable generator uses.
 */
require('dotenv').config();
const { spawnSync } = require('child_process');

const isWindows = process.platform === 'win32';
const fromEnv = (process.env.PYTHON_BIN || '').trim();

const candidates = [];
if (fromEnv) candidates.push(fromEnv);
candidates.push(...(isWindows ? ['py', 'python', 'python3'] : ['python3', 'python']));
const unique = [...new Set(candidates)];

console.log('\nChecking for Python…');
console.log('Platform:', process.platform);
console.log('PYTHON_BIN from .env:', fromEnv || '(not set)');
console.log('Will try in order:', unique.join(', '), '\n');

let working = null;
for (const cmd of unique) {
  try {
    const res = spawnSync(cmd, ['--version'], { encoding: 'utf-8' });
    if (res.error) {
      console.log(`  ✗ "${cmd}" — not found`);
      continue;
    }
    const version = (res.stdout || res.stderr || '').trim();
    console.log(`  ✓ "${cmd}" — ${version}`);
    if (!working) working = { cmd, version };
  } catch {
    console.log(`  ✗ "${cmd}" — not found`);
  }
}

console.log('');
if (working) {
  console.log(`✅ Python is available. The app will use "${working.cmd}" (${working.version}).`);
  console.log('   You can generate timetables.\n');
  process.exit(0);
} else {
  console.log('❌ No Python found.');
  console.log('   Install Python 3 from https://www.python.org/downloads/');
  console.log('   (tick "Add Python to PATH" during install), OR set the full path in backend/.env:');
  console.log('   PYTHON_BIN=C:\\Program Files\\Python312\\python.exe\n');
  process.exit(1);
}
