/**
 * Generated files (admit cards, seating plans, ID sheets, rosters, datesheets,
 * layout JSON …) are written to scheduler/output on whichever machine made them.
 * A hosted server (Render) has a throw-away disk: it never sees files made on the
 * office PC, and it loses its own files on every restart / redeploy — that is
 * what produced "File wasn't available on site".
 *
 * This keeps a copy of every generated file IN THE DATABASE (MongoDB GridFS,
 * bucket "outputfiles"), so any server sharing the database has them:
 *   • push  — new / changed files in scheduler/output are uploaded (watch + every 10 min)
 *   • pull  — on start-up, files the database has but this disk does not are restored
 *   • ensureLocal(name) — restore one file on demand right before it is served
 * Only files that belong to a GeneratedFile record are kept (the record's files
 * plus their companions: _layout.json, _audit.json, _schedule.json …); copies of
 * deleted records are pruned. Set FILE_STORE=off to disable.
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { OUTPUT_DIR } = require('./pythonRunner');

const BUCKET = 'outputfiles';
const EXT = /\.(pdf|json|xlsx|txt)$/i;
const TEMP = /^(roster_|rosterxlsx_|resection_|acconfig_|acmerged_|acprogress_|db_export_|dsconfig_|dsfilt_|backup_)/i;
const enabled = () => String(process.env.FILE_STORE || 'on').toLowerCase() !== 'off';

let _bucket = null;
function bucket() {
  if (!_bucket) _bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET });
  return _bucket;
}

async function stems() {
  const GeneratedFile = require('../models/GeneratedFile');
  const out = new Set();
  for (const r of await GeneratedFile.find({}).select('files.filename').lean()) {
    for (const f of r.files || []) {
      const n = path.basename(String(f.filename || ''));
      if (n) out.add(n.replace(/\.[^.]+$/, ''));
    }
  }
  return out;
}
function wanted(name, st) {
  if (!EXT.test(name) || TEMP.test(name)) return false;
  const base = name.replace(/\.[^.]+$/, '');
  if (st.has(base)) return true;
  for (const s of st) if (name.startsWith(`${s}_`)) return true;
  return false;
}
async function stored() {
  const m = new Map();
  for (const f of await bucket().find({}).toArray()) {
    const prev = m.get(f.filename);
    if (!prev || f.uploadDate > prev.uploadDate) m.set(f.filename, f);
  }
  return m;
}

function upload(name, stat) {
  return new Promise((resolve, reject) => {
    const up = bucket().openUploadStream(name, { metadata: { size: stat.size, mtime: stat.mtimeMs } });
    fs.createReadStream(path.join(OUTPUT_DIR, name)).on('error', reject).pipe(up).on('error', reject).on('finish', () => resolve(up.id));
  });
}
function download(name, f) {
  return new Promise((resolve, reject) => {
    const dst = path.join(OUTPUT_DIR, name);
    const tmp = `${dst}.part`;
    bucket().openDownloadStream(f._id).on('error', reject)
      .pipe(fs.createWriteStream(tmp)).on('error', reject)
      .on('finish', () => {
        try {
          fs.renameSync(tmp, dst);
          // keep the ORIGINAL time, so this copy is never mistaken for a newer edit
          const mt = f.metadata && f.metadata.mtime;
          if (mt) fs.utimesSync(dst, new Date(), new Date(mt));
          resolve(true);
        } catch (e) { reject(e); }
      });
  });
}
// is the local copy at least as new as the database copy?
function fresh(p, f) {
  try {
    const st = fs.statSync(p);
    if (!st.size) return false;
    const m = f && f.metadata;
    if (!m) return true;
    return st.mtimeMs >= (m.mtime || 0) - 2;
  } catch { return false; }
}

let pushing = null; let again = false;
async function pushAll() {
  if (!enabled() || mongoose.connection.readyState !== 1) return { uploaded: 0 };
  if (pushing) { again = true; return pushing; }
  pushing = (async () => {
    let uploaded = 0; let pruned = 0;
    try {
      if (!fs.existsSync(OUTPUT_DIR)) return { uploaded, pruned };
      const st = await stems();
      const have = await stored();
      for (const name of fs.readdirSync(OUTPUT_DIR)) {
        if (!wanted(name, st)) continue;
        let stat; try { stat = fs.statSync(path.join(OUTPUT_DIR, name)); } catch { continue; }
        if (!stat.isFile() || stat.size === 0) continue;                  // still being written
        if (Date.now() - stat.mtimeMs < 5000) { again = true; continue; }  // settle first
        const cur = have.get(name);
        if (cur && cur.metadata && cur.metadata.size === stat.size && Math.abs((cur.metadata.mtime || 0) - stat.mtimeMs) < 2) continue;
        const id = await upload(name, stat);
        uploaded++;
        for (const old of await bucket().find({ filename: name, _id: { $ne: id } }).toArray()) await bucket().delete(old._id).catch(() => {});
      }
      for (const [name, f] of have) {
        if (!wanted(name, st)) { await bucket().delete(f._id).catch(() => {}); pruned++; }
      }
      if (uploaded || pruned) console.log(`✓ file store: ${uploaded} file(s) saved to the database${pruned ? `, ${pruned} old copies removed` : ''}`);
    } catch (e) {
      console.warn('file store (save):', e.message);
    }
    return { uploaded, pruned };
  })();
  const r = await pushing;
  pushing = null;
  if (again) { again = false; setTimeout(() => pushAll().catch(() => {}), 8000); }
  return r;
}

async function pullAll() {
  if (!enabled() || mongoose.connection.readyState !== 1) return 0;
  let n = 0;
  try {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    for (const [name, f] of await stored()) {
      if (fresh(path.join(OUTPUT_DIR, name), f)) continue;
      await download(name, f); n++;
    }
    if (n) console.log(`✓ file store: ${n} generated file(s) restored from the database`);
  } catch (e) {
    console.warn('file store (restore):', e.message);
  }
  return n;
}

/** make sure OUTPUT_DIR/<name> exists here (restoring it from the database) — true if it does */
async function ensureLocal(name) {
  const safe = path.basename(String(name || ''));
  if (!safe) return false;
  const p = path.join(OUTPUT_DIR, safe);
  const here = fs.existsSync(p) && fs.statSync(p).size > 0;
  if (!enabled() || mongoose.connection.readyState !== 1) return here;
  try {
    const f = (await bucket().find({ filename: safe }).sort({ uploadDate: -1 }).limit(1).toArray())[0];
    if (!f) return here;
    if (here && fresh(p, f)) return true;
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    await download(safe, f);
    return fs.existsSync(p);
  } catch (e) {
    console.warn('file store (restore one):', e.message);
    return fs.existsSync(p);
  }
}

/** start-up: restore what is missing (bounded wait), then keep the database copy in step */
async function init({ waitMs = 90000 } = {}) {
  if (!enabled()) return;
  await Promise.race([pullAll(), new Promise((r) => setTimeout(r, waitMs))]);
  setTimeout(() => pushAll().catch(() => {}), 20000);
  setInterval(() => { pushAll().then(() => pullAll()).catch(() => {}); }, 10 * 60 * 1000).unref();
  try {
    let t = null;
    fs.watch(OUTPUT_DIR, { persistent: false }, () => {
      clearTimeout(t);
      t = setTimeout(() => pushAll().catch(() => {}), 10000);
    });
  } catch { /* the 10-minute sweep still runs */ }
}

module.exports = { init, pushAll, pullAll, ensureLocal };
