/**
 * Office of Student Affairs — Digital Student ID Cards.
 * React port of the standalone "Abasyn Student Affairs" desktop app (index.html + app.js),
 * now a module of Abasyn Scheduler. Same 5 steps, same card design, same secure QR:
 *   1 Import Data → 2 Upload Photos → 3 Review → 4 Generate (PDF + ZIP) → Verify / Block.
 * The secret QR key is issued by THIS server (/api/affairs) and checked by the scanner app.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import api, { errMsg } from '../api/client';
import { useToast } from '../context/ToastContext';
import Card from './studentAffairs/card';
import { loadAffairsLibs } from './studentAffairs/libs';
import logoUrl from '../assets/affairs-logo.png';
import './studentAffairs/studentAffairs.css';

const CONFIG = {
  card: {
    uniName: 'Abasyn University',
    campus: 'Islamabad Campus',
    address: 'Park Road Chak Shahzad, Islamabad-Pakistan',
    tel: '+92-51-8438320-1',
    web: 'abasynisb.edu.pk',
    primary: '#0B4A2E',   // dark green
    accent: '#C9A227',    // gold
  },
  maxCardFields: 5,       // fields printed on the front (all columns are still stored)
  zipChunk: 150,          // students per ZIP part (keeps RAM low)
};
const CARD = CONFIG.card;
const GROUP_ALL = 'All Students';
const TABLE_LIMIT = 1500;

/* ---------------- helpers ---------------- */
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const fileKey = (n) => norm(String(n).replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, ''));
const safeName = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);
const tick = () => new Promise((r) => setTimeout(r, 0));
const IMG_EXT = /\.(jpe?g|jfif|pjpeg|png|webp|bmp|gif|avif|ico|tiff?|heic|heif)$/i;
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', pjpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif', avif: 'image/avif', ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif' };
const csvRow = (a) => a.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');
function titleCase(s) { s = String(s || '').trim().replace(/\s+/g, ' '); return s === s.toUpperCase() || s === s.toLowerCase() ? s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()) : s; }

/* ---------------- columns (open-ended) ---------------- */
const ROLE_ALIASES = {
  regNo: ['registration no', 'registration number', 'registration num', 'registration #', 'registration id', 'reg no', 'reg num', 'reg number', 'reg #', 'reg id', 'regno', 'regnum', 'reg', 'student id', 'student no', 'student number', 'id', 'id no', 'roll no', 'roll num', 'roll number', 'roll #', 'rollno', 'enrollment no', 'enrolment no', 'enrollment number', 'enrolment number', 'enrollment', 'enrolment', 'registration'],
  name: ['name', 'student name', 'full name', 'name of student', 'name of the student', 'student full name', 'student'],
  photo: ['photo', 'picture', 'image', 'pic', 'photo file', 'photo name', 'image name', 'photo filename'],
  expiry: ['expiry', 'expiry date', 'expire', 'expires', 'expiration', 'expiration date', 'valid upto', 'valid up to', 'valid till', 'valid until', 'validity', 'card expiry'],
  group: ['batch', 'session', 'intake', 'admission session', 'batch session'],
  blood: ['blood group', 'blood', 'bg', 'blood type'],
  sensitive: ['cnic', 'b form', 'bform', 'cnic b form', 'cnic no', 'contact', 'phone', 'mobile', 'cell', 'contact no', 'phone no', 'mobile no', 'email', 'address', 'dob', 'date of birth'],
};
const NEVER_ON_CARD = new Set(['regNo', 'name', 'photo', 'expiry', 'blood']);
function detectRoles(header) {
  const keys = header.map(norm); const roles = new Array(header.length).fill('field'); const used = new Set();
  for (const pass of [0, 1]) {
    for (const [role, al] of Object.entries(ROLE_ALIASES)) {
      if (role !== 'sensitive' && role !== 'blood' && roles.includes(role)) continue;
      const set = al.map(norm).filter((a) => pass === 0 || a.length > 3);
      keys.forEach((k, i) => {
        if (!k || used.has(i)) return;
        const hit = pass === 0 ? set.includes(k) : set.some((a) => k.includes(a));
        if (hit && (role === 'sensitive' || role === 'blood' || !roles.includes(role))) { roles[i] = role; used.add(i); }
      });
    }
  }
  return roles;
}

/* ---------------- the working store (kept outside React state: it holds blobs / maps) ---------------- */
const newStore = () => ({
  students: [], columns: [], uid: 1,
  photos: new Map(), photoNames: new Map(), enhanced: new Map(), thumbs: new Map(),
  expiry: null, logo: null, cancel: false, busy: false,
  importLog: [], photoLog: [], unmatched: [],
});
const groupCol = (S) => S.columns.find((c) => c.role === 'group');
const expiryCol = (S) => S.columns.find((c) => c.role === 'expiry');
function mergeColumns(S, header, roles) {
  header.forEach((h, i) => {
    const label = String(h).trim(); if (!label || ['regNo', 'name'].includes(roles[i])) return;
    if (S.columns.some((c) => norm(c.label) === norm(label))) return;
    S.columns.push({ label, role: roles[i], onCard: false });
  });
  // default: first N plain fields (incl. batch) go on the card
  if (!S.columns.some((c) => c.onCard)) {
    let n = 0; for (const c of S.columns) if ((c.role === 'field' || c.role === 'group') && n < CONFIG.maxCardFields) { c.onCard = true; n++; }
  }
}
function derive(S, st) {
  const gc = groupCol(S); st.group = (gc && String(st.data[gc.label] || '').trim()) || GROUP_ALL;
  const ec = expiryCol(S); st.expiryOwn = ec ? Card.parseDate(st.data[ec.label]) : null;
  const exp = st.expiryOwn || S.expiry;
  st.expiryDate = exp; st.expiryISO = exp ? Card.iso(exp) : ''; st.expiryText = exp ? Card.human(exp) : '';
  st.expired = exp ? Card.isExpired(exp) : false;
  st.cardFields = S.columns.filter((c) => c.onCard && !NEVER_ON_CARD.has(c.role)).map((c) => [c.label, String(st.data[c.label] ?? '').trim()]).filter((f) => f[1]).slice(0, CONFIG.maxCardFields);
  st.allFields = S.columns.filter((c) => !['photo', 'expiry'].includes(c.role)).map((c) => [c.label, String(st.data[c.label] ?? '').trim()]).filter((f) => f[1]);
}
const deriveAll = (S) => S.students.forEach((st) => derive(S, st));
const log = (arr, msg, cls = '') => { arr.unshift({ id: Math.random(), msg, cls }); if (arr.length > 200) arr.length = 200; };

/* ---------------- data import: ANY layout ----------------
 * Works with a clean sheet (header in row 1) and with ERP-style reports too:
 *  • the header row can be anywhere, repeat on every page, or be missing
 *    (then the Reg No / Name columns are found from the data itself);
 *  • section rows such as "BSCS | Batch | 2023 Fall" set Program / Batch for the
 *    students under them; page titles ("Islamabad Campus · STUDENT LIST") are skipped;
 *  • when a file has no Program / Batch at all, they are read from an Abasyn
 *    registration number (AUIC-23FL-BSCS-8300 → BSCS, 2023 Fall).
 */
const CONTEXT_LABELS = { batch: 'Batch', program: 'Program', programme: 'Program', degree: 'Program', session: 'Session', semester: 'Semester', department: 'Department', dept: 'Department', intake: 'Batch', class: 'Class', section: 'Section' };
const cellStr = (v) => String(v ?? '').trim();
const looksLikeReg = (v) => { const t = cellStr(v); return t.length >= 3 && t.length <= 40 && /\d{3,}/.test(t.replace(/[^0-9]/g, '')) && (t.match(/\s/g) || []).length <= 2; };
const looksLikePhone = (v) => { const t = cellStr(v); return !/[A-Za-z]/.test(t) && t.replace(/\D/g, '').length >= 7; };
const PHONE_COL = /phone|mobile|cell|contact|whatsapp/i;
const looksLikeName = (v) => { const t = cellStr(v); return t.length >= 2 && t.length <= 80 && /^[A-Za-z][A-Za-z .,'`’()-]*$/.test(t) && /[A-Za-z]{2}/.test(t); };
const TERM = { FL: 'Fall', FA: 'Fall', SG: 'Spring', SP: 'Spring', SU: 'Summer', SM: 'Summer' };
function fromAbasynReg(reg) {
  const r = String(reg).toUpperCase();
  let m = r.match(/^AUIC-(\d{2})(FL|FA|SG|SP|SU|SM)-(.+)-\d+$/);            // AUIC-23FL-BSCS-8300
  if (m) return { Program: m[3], Batch: `${2000 + Number(m[1])} ${TERM[m[2]]}` };
  m = r.match(/^AUIC-(FL|FA|SG|SP|SU|SM)(\d{2})-\d+$/);                     // AUIC-SG23-7828
  return m ? { Batch: `${2000 + Number(m[2])} ${TERM[m[1]]}` } : null;
}
function sectionOf(row, iReg, iName) {
  // "BSVS | Batch | 2022 Fall" → { Program: BSVS, Batch: 2022 Fall }; null if not a section row
  const nameCell = cellStr(row[iName]);
  if (looksLikeReg(row[iReg]) && nameCell && !CONTEXT_LABELS[norm(nameCell)]) return null;   // a student row
  const cells = row.map(cellStr);
  const labelAt = cells.map((c) => CONTEXT_LABELS[norm(c)] || null);
  if (!labelAt.some(Boolean)) return null;
  const ctx = {}; const used = new Set();
  labelAt.forEach((lab, i) => {
    if (!lab) return; used.add(i);
    for (let j = i + 1; j < cells.length; j++) { if (!cells[j]) continue; if (!labelAt[j]) { ctx[lab] = cells[j]; used.add(j); } break; }
  });
  const rest = cells.map((c, i) => (c && !used.has(i) ? c : null)).filter(Boolean);
  if (rest.length && !ctx.Program) ctx.Program = rest[0];
  // a shifted / broken report row can put a phone number where the batch should be — ignore such values
  for (const k of Object.keys(ctx)) if (looksLikePhone(ctx[k])) delete ctx[k];
  return Object.keys(ctx).length ? ctx : null;
}
function inferColumns(rows) {
  // no header anywhere → pick the Reg No and Name columns from the values themselves
  const sample = rows.slice(0, 800); const width = Math.max(0, ...sample.map((r) => r.length));
  let iReg = -1; let iName = -1; let bestR = 0; let bestN = 0;
  for (let c = 0; c < width; c++) {
    const vals = sample.map((r) => cellStr(r[c])).filter(Boolean);
    if (vals.length < 3) continue;
    const reg = vals.filter((v) => looksLikeReg(v) && /[A-Za-z-]/.test(v)).length / vals.length
      + 0.5 * (vals.filter((v) => /^\d{3,8}$/.test(v)).length / vals.length);
    const uniq = new Set(vals).size / vals.length;
    const rs = reg * uniq; if (rs > bestR) { bestR = rs; iReg = c; }
    const ns = vals.filter((v) => looksLikeName(v) && /\s/.test(v)).length / vals.length;
    if (ns > bestN) { bestN = ns; iName = c; }
  }
  if (bestR < 0.5 || bestN < 0.5 || iReg === iName) return null;
  return { iReg, iName };
}

async function importDataFile(S, file) {
  const buf = await file.arrayBuffer();
  const wb = /\.csv$/i.test(file.name)
    ? XLSX.read(new TextDecoder('utf-8').decode(buf), { type: 'string', cellDates: true })
    : XLSX.read(buf, { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: false, dateNF: 'yyyy-mm-dd' });
  const width = Math.max(0, ...rows.map((r) => r.length));

  // 1. header rows — anywhere in the file (ERP reports repeat them on every page)
  const headerIdx = new Set(); const candidates = [];
  rows.forEach((r, i) => {
    const roles = detectRoles(r.map((c) => String(c ?? '')));
    const iR = roles.indexOf('regNo'); const iN = roles.indexOf('name');
    if (iR >= 0 && iN >= 0 && !looksLikeReg(r[iR])) { headerIdx.add(i); candidates.push({ i, r, roles, filled: r.filter((c) => cellStr(c)).length }); }
  });
  let header = new Array(width).fill(''); let roles; let inferred = false;
  if (candidates.length) {
    // the fullest header row wins; blank columns are filled from the other header rows
    const best = candidates.slice().sort((x, y) => y.filled - x.filled || x.i - y.i)[0];
    header = header.map((_, c) => cellStr(best.r[c]));
    const bR = best.roles.indexOf('regNo'); const bN = best.roles.indexOf('name');
    for (const cand of candidates) {
      if (cand.roles.indexOf('regNo') !== bR || cand.roles.indexOf('name') !== bN) continue;
      cand.r.forEach((v, c) => { const t = cellStr(v); if (!header[c] && t && !/^\d{4}\s+(fall|spring|summer)$/i.test(t)) header[c] = t; });
    }
    roles = detectRoles(header);
  } else {
    const inf = inferColumns(rows);
    if (!inf) throw new Error('Could not find the Registration No and Name columns in this file.');
    inferred = true;
    roles = new Array(width).fill('field'); roles[inf.iReg] = 'regNo'; roles[inf.iName] = 'name';
    header = header.map((_, c) => (c === inf.iReg ? 'Registration No' : c === inf.iName ? 'Name' : ''));
  }
  // columns with no heading at all are kept only if they hold data (labelled "Column D")
  const iReg = roles.indexOf('regNo'); const iName = roles.indexOf('name'); const iPhoto = roles.indexOf('photo');
  const colLetter = (c) => XLSX.utils.encode_col(c);
  header = header.map((h, c) => h || (c !== iReg && c !== iName && rows.some((r, i) => !headerIdx.has(i) && looksLikeReg(r[iReg]) && cellStr(r[c])) ? `Column ${colLetter(c)}` : ''));
  const plainCols = header.map((h, c) => (h && c !== iReg && c !== iName ? c : -1)).filter((c) => c >= 0);
  const ownLabel = new Set(plainCols.map((c) => norm(header[c])));

  // 2. student rows (section rows set Program / Batch for the rows below them)
  let ctx = {}; let added = 0; let updated = 0; let skipped = 0; let sections = 0; let dup = 0; let fromReg = 0;
  const ctxLabels = new Set(); const seen = new Map();
  const existing = new Map(S.students.map((s) => [norm(s.regNo), s]));
  const startCols = S.columns.length;
  const rowsData = [];
  rows.forEach((r, i) => {
    if (headerIdx.has(i)) return;
    const sec = sectionOf(r, iReg, iName);
    if (sec) { ctx = sec; sections++; Object.keys(sec).forEach((k) => ctxLabels.add(k)); return; }
    const regNo = cellStr(r[iReg]).toUpperCase().replace(/\s+/g, ''); const name = cellStr(r[iName]);
    if (!looksLikeReg(regNo) || !name || CONTEXT_LABELS[norm(name)]) { if (r.some((c) => cellStr(c))) skipped++; return; }
    const data = {};
    plainCols.forEach((c) => {
      const h = header[c]; let v = roles[c] === 'field' && /name/i.test(h) ? titleCase(r[c]) : cellStr(r[c]);
      if (PHONE_COL.test(h) && v && !looksLikePhone(v)) v = '';   // e.g. "2020 Fall" pushed into a phone column
      data[h] = v;
    });
    for (const [k, v] of Object.entries(ctx)) if (!ownLabel.has(norm(k)) || !data[k]) data[k] = v;
    const g = (!data.Program || !data.Batch) ? fromAbasynReg(regNo) : null;
    if (g) { let used = false; for (const [k, v] of Object.entries(g)) if (!data[k]) { data[k] = v; ctxLabels.add(k); used = true; } if (used) fromReg++; }
    const prev = seen.get(norm(regNo));
    if (prev) {   // same student again in this file → keep the first values, only fill blanks
      dup++;
      for (const [k, v] of Object.entries(data)) if (v && !prev.data[k]) prev.data[k] = v;
      return;
    }
    const rec = { regNo, name, data, photoRef: iPhoto >= 0 ? cellStr(r[iPhoto]) : '' };
    seen.set(norm(regNo), rec); rowsData.push(rec);
  });
  if (!rowsData.length) throw new Error('No student rows found — every row needs a Registration No and a Name.');

  // 3. columns: the file's own + Program / Batch taken from section rows or reg numbers
  const hdr = [...plainCols.map((c) => header[c]), ...[...ctxLabels].filter((k) => !ownLabel.has(norm(k)))];
  const hdrRoles = detectRoles(['Registration No', 'Name', ...hdr]).slice(2);   // so "Father Name" is not taken for Name
  mergeColumns(S, ['Registration No', 'Name', ...hdr], ['regNo', 'name', ...hdrRoles]);
  if (inferred) S.columns.slice(startCols).forEach((c) => { if (/^Column [A-Z]+$/.test(c.label)) c.onCard = false; });
  for (const rec of rowsData) {
    const st0 = { regNo: rec.regNo, name: titleCase(rec.name), photoRef: rec.photoRef };
    const ex = existing.get(norm(rec.regNo));
    if (ex) { Object.assign(ex, st0); Object.assign(ex.data, rec.data); updated++; }
    else { const st = { uid: S.uid++, ...st0, data: rec.data, token: null }; S.students.push(st); existing.set(norm(rec.regNo), st); added++; }
  }
  deriveAll(S);
  log(S.importLog, `✔ ${file.name}: ${added} added, ${updated} updated${skipped ? ` · ${skipped} other rows ignored (titles / blank / no reg no)` : ''} · columns: ${hdr.join(', ') || '—'}.`, 's');
  if (inferred) log(S.importLog, 'No heading row found — Registration No and Name columns were picked from the data.', 'w');
  if (sections) log(S.importLog, `${sections} section rows read (e.g. "BSCS · Batch · 2023 Fall") — Program / Batch filled for the students under them.`, 'w');
  if (fromReg) log(S.importLog, `${fromReg} students got Program / Batch from their registration number.`, 'w');
  if (dup) log(S.importLog, `${dup} rows repeated a registration number already in the file — merged into one student (first row's values kept).`, 'w');
  if (expiryCol(S)) { const bad = S.students.filter((s) => !s.expiryOwn).length; log(S.importLog, `Expiry column "${expiryCol(S).label}" found — used per student${bad ? ` (${bad} blank/unreadable → the date you enter on Generate is used)` : ''}.`, 'w'); }
  matchPhotos(S);
  return added + updated;
}

/* ---------------- photos ---------------- */
function addPhoto(S, blob, name) { const k = fileKey(name); if (!k) return false; S.photos.set(k, blob); S.photoNames.set(k, name.replace(/^.*[\\/]/, '')); return true; }
async function importZip(S, file, onProg) {
  const { JSZip } = await loadAffairsLibs();
  const zip = await JSZip.loadAsync(file); let n = 0;
  const entries = Object.values(zip.files).filter((e) => !e.dir && IMG_EXT.test(e.name) && !/(^|\/)(__MACOSX|\.)/.test(e.name));
  for (const e of entries) {
    const ext = e.name.split('.').pop().toLowerCase();
    if (addPhoto(S, new Blob([await e.async('uint8array')], { type: MIME[ext] || 'application/octet-stream' }), e.name)) n++;
    if (n % 50 === 0) { onProg && onProg(`Extracting… ${n}/${entries.length}`); await tick(); }
  }
  onProg && onProg('');
  return n;
}
async function importPhotos(S, files, onProg) {
  let n = 0; let zips = 0; let skipped = 0;
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) { n += await importZip(S, f, onProg); zips++; continue; }
    if (IMG_EXT.test(f.name) || (f.type || '').startsWith('image/')) { if (addPhoto(S, f, f.name)) n++; } else skipped++;
  }
  log(S.photoLog, `✔ ${n} photos imported${zips ? ` (incl. ${zips} zip)` : ''}${skipped ? `, ${skipped} non-image files ignored` : ''}.`, 's');
  const heic = [...S.photoNames.values()].filter((x) => /\.(heic|heif|tiff?)$/i.test(x)).length;
  if (heic) log(S.photoLog, `${heic} HEIC/TIFF photos — these may not open on every PC. Convert to JPG if a card shows "Photo not available".`, 'w');
  matchPhotos(S);
  const linked = S.photos.size - S.unmatched.length;
  log(S.photoLog, `${linked} of ${S.photos.size} photos linked to a student${S.unmatched.length ? ` — ${S.unmatched.length} not linked: name the file with the Registration No (or the last digits of it, e.g. 8300.jpg), or use Review → Preview → Replace photo.` : '.'}`, S.unmatched.length ? 'e' : 's');
}
function matchPhotos(S) {
  const keys = [...S.photos.keys()]; const linked = new Set();
  // looser keys, used only when they point to exactly ONE student:
  //   "11257.jpg" → the student whose reg no ends in 11257 · "Nadia Mazhar.jpg" → that name
  const tail = new Map(); const byName = new Map();
  const add = (m, k, st) => { if (!k) return; m.set(k, m.has(k) && m.get(k) !== st ? null : st); };
  for (const st of S.students) {
    const t = (String(st.regNo).match(/(\d{4,})\D*$/) || [])[1]; add(tail, t, st);
    add(byName, norm(st.name), st);
  }
  const loose = new Map();
  for (const k of keys) {
    const st = (/^\d{4,}$/.test(k) && tail.get(k)) || byName.get(k) || null;
    if (st) loose.set(st.uid, k);
  }
  for (const st of S.students) {
    if (st.manualPhoto) continue;
    const cands = [fileKey(st.photoRef || ''), norm(st.regNo)].filter(Boolean);
    let key = cands.find((k) => S.photos.has(k));
    if (!key) { const rk = norm(st.regNo); key = rk.length >= 4 ? keys.find((k) => k.startsWith(rk) || k.endsWith(rk)) : undefined; }
    if (!key) key = loose.get(st.uid);
    if (st.photoKey !== key) { st.photoKey = key; S.enhanced.delete(st.uid); S.thumbs.delete(st.uid); }
    if (key) linked.add(key);
  }
  S.unmatched = keys.filter((k) => !linked.has(k)).map((k) => S.photoNames.get(k));
}
const photoBlob = (S, st) => st.manualPhoto || (st.photoKey ? S.photos.get(st.photoKey) : null);
async function getEnhanced(S, st) {
  const src = photoBlob(S, st); if (!src) return null;
  let e = S.enhanced.get(st.uid);
  if (!e) { try { e = await Card.enhancePhoto(src); } catch (err) { e = { error: err.message }; } S.enhanced.set(st.uid, e); }
  return e.error ? null : e;
}
async function getAssets(S, st) { const e = await getEnhanced(S, st); return { logo: S.logo, photo: e ? await createImageBitmap(e.blob) : null }; }
async function photoThumb(S, st) {
  const e = await getEnhanced(S, st); if (!e) return '';
  const bmp = await createImageBitmap(e.blob, { resizeWidth: 260, resizeHeight: 320, resizeQuality: 'high' });
  const c = document.createElement('canvas'); c.width = 260; c.height = 320; c.getContext('2d').drawImage(bmp, 0, 0); bmp.close();
  return c.toDataURL('image/jpeg', 0.8);
}

/* ---------------- server: the secret key for every card is issued here ---------------- */
async function issueTokens(S, list, reissue, onProgress) {
  const CH = 15;
  for (let i = 0; i < list.length; i += CH) {
    if (S.cancel) throw new Error('cancelled');
    const chunk = list.slice(i, i + CH); const students = [];
    for (const st of chunk) students.push({ regNo: st.regNo, name: st.name, batch: st.group === GROUP_ALL ? '' : st.group, expiry: st.expiryISO, fields: st.allFields, photo: await photoThumb(S, st) });
    let j;
    try { j = (await api.post('/affairs/cards/issue', { students, reissue })).data; }
    catch (e) { throw new Error(errMsg(e, 'Server not reachable — check your internet connection.')); }
    const map = new Map(j.cards.map((c) => [norm(c.regNo), c.token]));
    chunk.forEach((st) => { st.token = map.get(norm(st.regNo)) || null; });
    if (j.rejected && j.rejected.length) throw new Error(`Server rejected: ${j.rejected.join(', ')}`);
    onProgress && onProgress(Math.min(i + CH, list.length));
  }
}

/* ---------------- rendering & PDF ---------------- */
async function canvasURL(c) { const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9)); c.width = 1; c.height = 1; return URL.createObjectURL(b); }
async function renderCardImages(S, st) {
  await loadAffairsLibs();
  const a = await getAssets(S, st);
  const f = await Card.front(st, CARD, a); const b = await Card.back(st, CARD, a);
  if (a.photo) a.photo.close();
  return { front: await canvasURL(f), back: await canvasURL(b) };
}
async function cardPdf(S, st) {
  const a = await getAssets(S, st);
  const f = await Card.front(st, CARD, a); const fj = await Card.toBytes(f, 'jpg'); f.width = 1; f.height = 1;
  const b = await Card.back(st, CARD, a); const bj = await Card.toBytes(b, 'jpg'); b.width = 1; b.height = 1;
  if (a.photo) a.photo.close();
  const W = 54; const H = 85.6;   // CR80 card, mm
  const doc = new jsPDF({ unit: 'mm', format: [W, H], orientation: 'portrait', compress: true });
  doc.setProperties({ title: `${st.name} — ${st.regNo} · Digital Student ID Card`, subject: 'Digital Student ID Card', author: `${CARD.uniName}, ${CARD.campus}`, creator: 'Abasyn Student Affairs' });
  doc.addImage(fj, 'JPEG', 0, 0, W, H, undefined, 'NONE');
  doc.addPage([W, H], 'portrait');
  doc.addImage(bj, 'JPEG', 0, 0, W, H, undefined, 'NONE');
  return new Uint8Array(doc.output('arraybuffer'));
}
function saveBlob(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 8000);
}

/* ═══════════════════════════════ UI ═══════════════════════════════ */
const STEPS = [
  { id: 'import', n: '1', label: 'Import Data' },
  { id: 'photos', n: '2', label: 'Upload Photos' },
  { id: 'students', n: '3', label: 'Review Students' },
  { id: 'generate', n: '4', label: 'Generate ID Cards' },
];

function Drop({ icon, title, sub, accept, multiple, folder, onFiles }) {
  const [over, setOver] = useState(false);
  const ref = useRef(null);
  return (
    <label
      className={`sa-drop${over ? ' over' : ''}`}
      onDragEnter={(e) => { e.preventDefault(); setOver(true); }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={(e) => { e.preventDefault(); setOver(false); }}
      onDrop={(e) => { e.preventDefault(); setOver(false); onFiles([...e.dataTransfer.files]); }}
    >
      <input
        ref={ref} type="file" hidden accept={accept} multiple={multiple}
        {...(folder ? { webkitdirectory: '', directory: '' } : {})}
        onChange={(e) => { onFiles([...e.target.files]); e.target.value = ''; }}
      />
      <div className="sa-drop-ic">{icon}</div>
      <div className="sa-drop-t">{title}</div>
      <div className="sa-drop-s">{sub}</div>
    </label>
  );
}
const Log = ({ items }) => (
  <div className="sa-log">{items.map((l) => <div key={l.id} className={l.cls}>{l.msg}</div>)}</div>
);
const StatusBadge = ({ s }) => (!s.expiryDate
  ? <span className="sa-badge nf">No expiry</span>
  : <span className={`sa-badge ${s.expired ? 'expired' : 'valid'}`}>{s.expired ? 'Expired' : 'Valid'}</span>);

export default function StudentAffairs() {
  const toast = useToast();
  const S = useRef(null);
  if (!S.current) S.current = newStore();
  const st0 = S.current;
  const [, setVer] = useState(0);
  const bump = useCallback(() => setVer((v) => v + 1), []);

  const [view, setView] = useState('import');
  const [server, setServer] = useState({ state: 'checking' });
  const [stats, setStats] = useState(null);
  const [photoProg, setPhotoProg] = useState('');
  // review filters
  const [q, setQ] = useState(''); const [fGroup, setFGroup] = useState(''); const [fStatus, setFStatus] = useState('');
  // generate
  const [gExpiry, setGExpiry] = useState(() => { try { return localStorage.getItem('asa.expiry') || ''; } catch { return ''; } });
  const [gGroup, setGGroup] = useState(''); const [gWhich, setGWhich] = useState('all'); const [gReissue, setGReissue] = useState(false);
  const [gen, setGen] = useState(null);   // { pct, text, running }
  const [sample, setSample] = useState({ front: '', back: '' });
  // verify
  const [vId, setVId] = useState(''); const [vRes, setVRes] = useState(null);
  // preview / edit modal
  const [modalUid, setModalUid] = useState(null);

  /* boot: libraries, logo, server check */
  useEffect(() => {
    loadAffairsLibs().catch((e) => toast.error(e.message));
    const i = new Image(); i.onload = () => { st0.logo = i; }; i.src = logoUrl;
    api.get('/affairs/status')
      .then((r) => setServer({ state: r.data.db ? 'on' : 'off', text: r.data.db ? 'Server online' : 'Server up, database offline' }))
      .catch(() => setServer({ state: 'off', text: 'Server offline' }));
    api.get('/affairs/stats').then((r) => setStats(r.data)).catch(() => {});
    const warn = (e) => { if (st0.students.length) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  /* expiry date entered on Generate applies to every student without their own */
  useEffect(() => {
    st0.expiry = Card.parseDate(gExpiry);
    try { localStorage.setItem('asa.expiry', gExpiry); } catch { /* private mode */ }
    deriveAll(st0); bump();
  }, [gExpiry]);   // eslint-disable-line react-hooks/exhaustive-deps

  const students = st0.students;
  const groups = [...new Set(students.map((s) => s.group))].sort();
  const matched = students.filter((s) => photoBlob(st0, s)).length;
  const expiredN = students.filter((s) => s.expired).length; const noExpN = students.filter((s) => !s.expiryDate).length;

  /* ---------- 1. import ---------- */
  const onDataFile = async (files) => {
    const f = files[0]; if (!f) return;
    try { const n = await importDataFile(st0, f); toast.success(`${n} students loaded`); }
    catch (e) { console.error(e); log(st0.importLog, `✖ ${e.message}`, 'e'); toast.error(e.message); }
    bump();
  };
  const toggleCol = (i, on) => {
    const cnt = st0.columns.filter((c) => c.onCard).length;
    if (on && cnt >= CONFIG.maxCardFields) { toast.error(`Maximum ${CONFIG.maxCardFields} fields fit on the card`); return; }
    st0.columns[i].onCard = on; deriveAll(st0); bump();
  };
  const downloadTemplate = () => {
    const csv = '﻿Registration No,Name,Father Name,Program,Department,Batch,Photo\r\nAUIC-FA26-0001,Ali Ahmed,Ahmed Khan,BS Computer Science,Computing,Fall 2026,AUIC-FA26-0001.jpg\r\n';
    saveBlob(new Blob([csv], { type: 'text/csv' }), 'Abasyn_Student_Template.csv');
  };
  const clearAll = () => {
    if (!window.confirm('Remove all loaded students and photos?')) return;
    Object.assign(st0, newStore(), { logo: st0.logo, expiry: st0.expiry }); bump();
  };

  /* ---------- 2. photos ---------- */
  const onPhotos = async (files) => {
    try { await importPhotos(st0, files, setPhotoProg); } catch (e) { log(st0.photoLog, `✖ ${e.message}`, 'e'); toast.error(e.message); }
    bump();
  };

  /* ---------- 3. review ---------- */
  const qq = norm(q);
  const filtered = students.filter((s) => (!fGroup || s.group === fGroup)
      && (!qq || norm(s.name + s.regNo + Object.values(s.data).join(' ')).includes(qq))
      && (!fStatus || (fStatus === 'valid' && s.expiryDate && !s.expired) || (fStatus === 'expired' && s.expired) || (fStatus === 'nophoto' && !photoBlob(st0, s))));
  const thumbRun = useRef(false);
  useEffect(() => {
    if (view !== 'students' || thumbRun.current) return;
    const queue = filtered.slice(0, TABLE_LIMIT).filter((s) => photoBlob(st0, s) && !st0.thumbs.has(s.uid));
    if (!queue.length) return;
    thumbRun.current = true;
    (async () => {
      let n = 0;
      for (const s of queue) {
        try {
          const bmp = await createImageBitmap(photoBlob(st0, s), { resizeWidth: 96, resizeQuality: 'medium', imageOrientation: 'from-image' });
          const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; c.getContext('2d').drawImage(bmp, 0, 0); bmp.close();
          st0.thumbs.set(s.uid, c.toDataURL('image/jpeg', 0.7));
        } catch { st0.thumbs.set(s.uid, 'err'); }
        if (++n % 12 === 0) { bump(); await tick(); }
      }
      thumbRun.current = false; bump();
    })();
  });

  /* ---------- 4. generate ---------- */
  useEffect(() => {
    if (!groups.length) { if (gGroup) setGGroup(''); return; }
    const valid = (groups.length > 1 && gGroup === '*') || groups.includes(gGroup);
    if (!valid) setGGroup(groups.length > 1 ? '*' : groups[0]);
  }, [groups.join('|')]);   // eslint-disable-line react-hooks/exhaustive-deps
  const selected = () => students.filter((s) => (gGroup === '*' || s.group === gGroup) && (gWhich === 'all' || photoBlob(st0, s)));
  const previewFirst = async () => {
    const s = selected()[0] || students[0];
    if (!s) { toast.error('No students to preview'); return; }
    try {
      const imgs = await renderCardImages(st0, s);
      setSample((old) => { [old.front, old.back].forEach((u) => u && URL.revokeObjectURL(u)); return imgs; });
    } catch (e) { toast.error(e.message); }
  };
  const generate = async () => {
    if (st0.busy) return;
    const list = selected().sort((x, y) => x.group.localeCompare(y.group) || x.regNo.localeCompare(y.regNo, undefined, { numeric: true }));
    if (!list.length) {
      const inGroup = students.filter((s) => gGroup === '*' || s.group === gGroup).length;
      if (!students.length) toast.error('Import student data first.');
      else if (gWhich === 'photo' && inGroup) toast.error(`None of the ${inGroup} students in this selection has a matched photo. Name each photo file with the Registration No (e.g. AUIC-23FL-BSCS-8300.jpg), or set Include → All students.`, 9000);
      else toast.error('No students in this batch — choose another option under Students.');
      return;
    }
    if (list.some((s) => !s.expiryDate)) { toast.error('Enter Expiry Date of Card first'); return; }
    st0.busy = true; st0.cancel = false;
    const total = list.length; const t0 = Date.now(); let done = 0;
    const bar = (n, text) => setGen({ running: true, pct: (n / total) * 100, text });
    try {
      const { JSZip } = await loadAffairsLibs();
      bar(0, 'Issuing secure keys on server…');
      await issueTokens(st0, list, gReissue, (n) => bar(n * 0.25, `Issuing secure keys… ${n}/${total}`));
      setGReissue(false);
      const byGroup = new Map(); list.forEach((s) => { if (!byGroup.has(s.group)) byGroup.set(s.group, []); byGroup.get(s.group).push(s); });
      for (const [g, members] of byGroup) {
        const size = Math.max(20, CONFIG.zipChunk); const parts = Math.ceil(members.length / size);
        for (let p = 0; p < parts; p++) {
          const part = members.slice(p * size, (p + 1) * size);
          const root = `Abasyn_Digital_ID_Cards_${safeName(g).replace(/\s+/g, '_')}${parts > 1 ? `_Part${p + 1}` : ''}`;
          const zip = new JSZip(); const dir = zip.folder(root);
          const cols = st0.columns.filter((c) => c.role !== 'photo');
          const summary = [csvRow(['Reg No', 'Name', ...cols.map((c) => c.label), 'Expiry', 'Status', 'Photo'])];
          for (const s of part) {
            if (st0.cancel) throw new Error('cancelled');
            dir.file(`${safeName(`${s.regNo} - ${s.name}`)}.pdf`, await cardPdf(st0, s));
            summary.push(csvRow([s.regNo, s.name, ...cols.map((c) => s.data[c.label] ?? ''), s.expiryText, s.expired ? 'Expired' : 'Valid', photoBlob(st0, s) ? 'Yes' : 'Missing']));
            if (st0.students.length > 400) st0.enhanced.delete(s.uid);
            done++;
            const eta = Math.round(((Date.now() - t0) / done) * (total - done) / 1000);
            bar(total * 0.25 + done * 0.75, `${done}/${total} · ${s.regNo}${eta ? ` · ~${eta}s left` : ''}`);
            await tick();
          }
          dir.file('Summary.csv', `﻿${summary.join('\r\n')}`);
          bar(total * 0.25 + done * 0.75, `Packing ${root}.zip…`);
          const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
          saveBlob(blob, `${root}.zip`);
          toast.success(`${root}.zip ready (${(blob.size / 1048576).toFixed(1)} MB)`);
        }
      }
      setGen({ running: false, pct: 100, text: `Done — ${total} digital ID cards generated in ${Math.round((Date.now() - t0) / 1000)}s.` });
      api.get('/affairs/stats').then((r) => setStats(r.data)).catch(() => {});
    } catch (e) {
      if (e.message === 'cancelled') setGen((g) => ({ ...(g || {}), running: false, text: 'Cancelled.' }));
      else { console.error(e); toast.error(e.message); setGen((g) => ({ ...(g || {}), running: false, text: `Error: ${e.message}` })); }
    } finally { st0.busy = false; bump(); }
  };

  /* ---------- verify / block ---------- */
  const verify = async (idArg) => {
    const id = String(idArg ?? vId).trim(); if (!id) return;
    setVRes({ loading: true });
    try { const r = await api.get(`/affairs/students/${encodeURIComponent(id)}`); setVRes({ id, ...r.data }); }
    catch (e) { setVRes({ error: errMsg(e) }); }
  };
  const setBlocked = async (b) => {
    const id = vId.trim();
    if (b && !window.confirm(`Block card ${id}? It will be refused at the gate.`)) return;
    try { await api.post('/affairs/cards/block', { regNo: id, blocked: b }); toast.success(b ? 'Card blocked' : 'Card unblocked'); verify(id); }
    catch (e) { toast.error(errMsg(e)); }
  };

  /* ---------- render ---------- */
  return (
    <div className="sa-root">
      <aside className="sa-side">
        <div className="sa-brand">
          <div className="sa-brand-mark"><img src={logoUrl} alt="Abasyn University" /></div>
          <div><div className="sa-brand-t">Abasyn Student Affairs</div><div className="sa-brand-s">Digital ID Cards</div></div>
        </div>
        <nav className="sa-nav">
          {STEPS.map((s) => (
            <button key={s.id} type="button" className={`sa-nav-i${view === s.id ? ' active' : ''}`} onClick={() => setView(s.id)}>
              <span className="n">{s.n}</span>{s.label}
            </button>
          ))}
          <div className="sa-nav-sep" />
          <button type="button" className={`sa-nav-i${view === 'verify' ? ' active' : ''}`} onClick={() => setView('verify')}><span className="n ic">✓</span>Verify / Block Card</button>
        </nav>
        <div className="sa-side-foot">
          <span className={`sa-dot ${server.state}`} /> {server.state === 'checking' ? 'Checking server…' : server.text}
          {stats && <div className="sa-side-stats">{stats.total} cards issued · {stats.scans24h} scans / 24h{stats.fake24h ? ` · ${stats.fake24h} fake` : ''}</div>}
          <div>Abasyn University · Islamabad Campus</div>
        </div>
      </aside>

      <div className="sa-main">
        <header className="sa-stats">
          <div className="sa-stat"><b>{students.length}</b><span>Students</span></div>
          <div className="sa-stat"><b>{st0.photos.size}</b><span>Photos uploaded</span></div>
          <div className="sa-stat ok"><b>{matched}</b><span>Photos matched</span></div>
          <div className="sa-stat warn"><b>{students.length - matched}</b><span>Missing photos</span></div>
          <div className="sa-stat ok"><b>{students.length - expiredN - noExpN}</b><span>Valid</span></div>
          <div className="sa-stat bad"><b>{expiredN}</b><span>Expired</span></div>
        </header>

        {view === 'import' && (
          <section>
            <h1>Import Student Data</h1>
            <p className="sa-lead">Upload an Excel (.xlsx / .xls) or CSV file. Every column in the file is picked up automatically — no fixed format needed.</p>
            <div className="sa-grid2">
              <Drop icon="⬆" title={<>Drop data file here or <u>browse</u></>} sub="XLSX · XLS · CSV · ODS" accept=".xlsx,.xls,.csv,.ods" onFiles={onDataFile} />
              <div className="sa-card">
                <h3>How it works</h3>
                <p className="sa-hint">Only <b>Registration No</b> and <b>Name</b> columns are required — any other columns (Father Name, Program, Department, Batch, Session, Semester, anything) are read as they are.
                  Photos are matched by file name = Registration No (e.g. <code>AUIC-FA26-0001.jpg</code>) or by a <b>Photo</b> column.</p>
                <div className="sa-row">
                  <button type="button" className="sa-btn ghost" onClick={downloadTemplate}>Download sample template</button>
                  <button type="button" className="sa-btn ghost danger" onClick={clearAll}>Clear all data</button>
                </div>
              </div>
            </div>
            {st0.columns.length > 0 && (
              <div className="sa-card">
                <h3>Columns found in your file</h3>
                <p className="sa-hint">Tick the fields to show on the front of the card (max {CONFIG.maxCardFields}). All columns are saved in the database and shown in the scanner app. Blood group is never printed on the card.</p>
                <div className="sa-cols">
                  <div className="sa-col on"><input type="checkbox" checked disabled readOnly />Registration No<span className="sa-tag">Always</span></div>
                  <div className="sa-col on"><input type="checkbox" checked disabled readOnly />Name<span className="sa-tag">Always</span></div>
                  {st0.columns.map((c, i) => {
                    const tag = { photo: 'Photo file', expiry: 'Expiry date', blood: 'Not on card', group: 'Batch', sensitive: 'Private' }[c.role] || '';
                    const never = NEVER_ON_CARD.has(c.role);
                    return (
                      <label key={c.label} className={`sa-col${c.onCard ? ' on' : ''}`}>
                        <input type="checkbox" checked={c.onCard} disabled={never} onChange={(e) => toggleCol(i, e.target.checked)} />
                        {c.label}{tag && <span className={`sa-tag${never ? ' off' : ''}`}>{tag}</span>}
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="sa-card"><h3>Import log</h3><Log items={st0.importLog} /></div>
          </section>
        )}

        {view === 'photos' && (
          <section>
            <h1>Upload Student Photos</h1>
            <p className="sa-lead">Any format: JPG, JPEG, PNG, WEBP, BMP, GIF, AVIF — or a ZIP of photos. Low-quality images are auto-cropped, upscaled to HD and sharpened.</p>
            <div className="sa-grid3">
              <Drop icon="🖼" title={<>Select photos <u>browse</u></>} sub="Multiple files allowed" accept="image/*,.jfif,.zip" multiple onFiles={onPhotos} />
              <Drop icon="📁" title={<>Select a whole <u>folder</u></>} sub="All images inside are imported" folder multiple onFiles={onPhotos} />
              <Drop icon="🗜" title={<>Upload photos <u>ZIP</u></>} sub="Extracted automatically" accept=".zip" onFiles={onPhotos} />
            </div>
            <div className="sa-card">
              <div className="sa-row between"><h3>Photo matching</h3><span className="sa-muted">{photoProg}</span></div>
              <Log items={st0.photoLog} />
              {st0.unmatched.length > 0 && (
                <>
                  <h4>Photos not linked to any student</h4>
                  <div className="sa-chips">
                    {st0.unmatched.slice(0, 300).map((n) => <span key={n} className="sa-chip">{n}</span>)}
                    {st0.unmatched.length > 300 && <span className="sa-chip">+{st0.unmatched.length - 300} more</span>}
                  </div>
                </>
              )}
            </div>
          </section>
        )}

        {view === 'students' && (
          <section>
            <div className="sa-row between">
              <h1>Review Students</h1>
              <div className="sa-row">
                <input className="sa-inp" placeholder="Search anything" value={q} onChange={(e) => setQ(e.target.value)} />
                <select className="sa-inp" value={fGroup} onChange={(e) => setFGroup(e.target.value)}>
                  <option value="">All batches</option>{groups.map((b) => <option key={b}>{b}</option>)}
                </select>
                <select className="sa-inp" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
                  <option value="">All</option><option value="valid">Valid</option><option value="expired">Expired</option><option value="nophoto">Missing photo</option>
                </select>
              </div>
            </div>
            <div className="sa-tablewrap">
              <table className="sa-tbl">
                <thead><tr><th>#</th><th>Photo</th><th>Reg No</th><th>Name</th><th>Card details</th><th>Expiry</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {!students.length && <tr><td colSpan={8} className="sa-empty">No students yet — import a data file first.</td></tr>}
                  {students.length > 0 && !filtered.length && <tr><td colSpan={8} className="sa-empty">No students match the filter.</td></tr>}
                  {filtered.slice(0, TABLE_LIMIT).map((s, i) => {
                    const th = st0.thumbs.get(s.uid);
                    return (
                      <tr key={s.uid}>
                        <td>{i + 1}</td>
                        <td>{photoBlob(st0, s) ? <img className="sa-th" src={th && th !== 'err' ? th : undefined} alt="" /> : <div className="sa-th none">NO<br />PHOTO</div>}</td>
                        <td className="sa-mono">{s.regNo}</td>
                        <td><b>{s.name}</b></td>
                        <td className="sa-muted">{s.cardFields.map((f) => f[1]).join(' · ')}</td>
                        <td>{s.expiryText || '—'}</td>
                        <td><StatusBadge s={s} /></td>
                        <td><button type="button" className="sa-btn ghost sm" onClick={() => setModalUid(s.uid)}>Preview</button></td>
                      </tr>
                    );
                  })}
                  {filtered.length > TABLE_LIMIT && <tr><td colSpan={8} className="sa-empty">Showing first {TABLE_LIMIT} of {filtered.length} — use search to narrow down.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {view === 'generate' && (
          <section>
            <h1>Generate Digital ID Cards</h1>
            <p className="sa-lead">Every student gets a PDF digital card (front + back). A unique secret key is issued by the server and hidden inside each QR code.</p>
            <div className="sa-grid2">
              <div className="sa-card">
                <label className="sa-fld big">Enter Expiry Date of Card *
                  <input type="date" className="sa-inp" value={gExpiry} onChange={(e) => setGExpiry(e.target.value)} />
                </label>
                <p className="sa-hint">{expiryCol(st0)
                  ? `Your file has an "${expiryCol(st0).label}" column — it is used per student; this date fills any blanks.`
                  : 'Applied to every student in this run. After this date the scanner shows "Card Expired. Do not allow entry".'}</p>
                <label className="sa-fld">Students
                  <select className="sa-inp" value={gGroup} onChange={(e) => setGGroup(e.target.value)}>
                    {!groups.length && <option value="">No students loaded</option>}
                    {groups.length > 1 && <option value="*">All batches (one ZIP per batch)</option>}
                    {groups.map((b) => <option key={b} value={b}>{b} ({students.filter((s) => s.group === b).length})</option>)}
                  </select>
                </label>
                <label className="sa-fld">Include
                  <select className="sa-inp" value={gWhich} onChange={(e) => setGWhich(e.target.value)}>
                    <option value="all">All students</option><option value="photo">Only students with photo</option>
                  </select>
                </label>
                <label className="sa-check"><input type="checkbox" checked={gReissue} onChange={(e) => setGReissue(e.target.checked)} /> Issue new keys <span className="sa-muted">(previously issued cards of these students will show as FAKE)</span></label>
                <div className="sa-row">
                  <button type="button" className="sa-btn primary big" disabled={!groups.length || (gen && gen.running)} onClick={generate}>Generate ID Cards (PDF)</button>
                  <button type="button" className="sa-btn ghost" onClick={previewFirst}>Preview</button>
                </div>
                {gen && (
                  <div className="sa-prog">
                    <div className="sa-bar"><i style={{ width: `${gen.pct || 0}%` }} /></div>
                    <div className="sa-row between"><span>{gen.text}</span>{gen.running && <button type="button" className="sa-btn ghost sm" onClick={() => { st0.cancel = true; }}>Cancel</button>}</div>
                  </div>
                )}
              </div>
              <div className="sa-card center">
                <h3>Sample</h3>
                <div className="sa-sample">{sample.front ? <><img src={sample.front} alt="Front" /><img src={sample.back} alt="Back" /></> : <p className="sa-hint">Click <b>Preview</b> to see the first card.</p>}</div>
                <p className="sa-hint">Output: one ZIP per batch → one PDF per student (<code>RegNo - Name.pdf</code>) + Summary.csv</p>
              </div>
            </div>
          </section>
        )}

        {view === 'verify' && (
          <section>
            <h1>Verify / Block a Card</h1>
            <p className="sa-lead">Look up a student in the university database. Block a lost or stolen card — it will be refused at the gate immediately.</p>
            <div className="sa-row">
              <input className="sa-inp wide" placeholder="Registration No e.g. AUIC-FA26-0001" value={vId} onChange={(e) => setVId(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && verify()} />
              <button type="button" className="sa-btn primary" onClick={() => verify()}>Check</button>
            </div>
            <VerifyResult r={vRes} onBlock={setBlocked} />
          </section>
        )}
      </div>

      {modalUid != null && (
        <PreviewModal
          S={st0} uid={modalUid} onClose={() => setModalUid(null)} bump={bump} toast={toast}
        />
      )}
    </div>
  );
}

function VerifyResult({ r, onBlock }) {
  if (!r) return null;
  if (r.loading) return <p className="sa-muted">Checking…</p>;
  if (r.error) return <p className="sa-log"><span className="e">✖ {r.error}</span></p>;
  if (!r.found) {
    return <div className="sa-vcard"><div><h2>{r.id}</h2><div className="sa-big-status nf">Not in database</div><p className="sa-hint">No card has been issued for this registration number.</p></div></div>;
  }
  const s = r.student; const cls = r.status === 'Valid' ? 'valid' : r.status === 'Expired' ? 'expired' : 'nf';
  return (
    <div className="sa-vcard">
      {s.photo && <img src={s.photo} alt="" />}
      <div>
        <h2>{s.name}</h2>
        <div className="sa-mono">{s.regNo}</div>
        <div className="sa-muted">{s.fields.map((f) => `${f[0]}: ${f[1]}`).join(' · ')}</div>
        <div className="sa-muted">Expiry: {s.expiryText} · Scanned {r.scans} times</div>
        <div className={`sa-big-status ${cls}`}>Status: {r.status}</div>
        <div className="sa-row">
          {r.status === 'Blocked'
            ? <button type="button" className="sa-btn ghost" onClick={() => onBlock(false)}>Unblock card</button>
            : <button type="button" className="sa-btn ghost danger" onClick={() => onBlock(true)}>Block card (lost / stolen)</button>}
        </div>
      </div>
    </div>
  );
}

function PreviewModal({ S, uid, onClose, bump, toast }) {
  const st = S.students.find((s) => s.uid === uid);
  const [imgs, setImgs] = useState({ front: '', back: '' });
  const [draft, setDraft] = useState(() => (st ? { __name: st.name, ...st.data } : {}));
  const [info, setInfo] = useState(null);
  const [rev, setRev] = useState(0);
  const fileRef = useRef(null);

  useEffect(() => {
    if (!st) return undefined;
    let alive = true;
    (async () => {
      const e = await getEnhanced(S, st); const raw = S.enhanced.get(st.uid);
      if (alive) setInfo({ e, raw });
      try {
        const out = await renderCardImages(S, st);
        if (alive) setImgs((old) => { [old.front, old.back].forEach((u) => u && URL.revokeObjectURL(u)); return out; });
        else [out.front, out.back].forEach((u) => URL.revokeObjectURL(u));
      } catch (err) { toast.error(err.message); }
    })();
    return () => { alive = false; };
  }, [uid, rev]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { [imgs.front, imgs.back].forEach((u) => u && URL.revokeObjectURL(u)); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!st) return null;

  const save = () => {
    Object.entries(draft).forEach(([k, v]) => { const val = String(v ?? '').trim(); if (k === '__name') st.name = val || st.name; else st.data[k] = val; });
    derive(S, st); bump(); setRev((x) => x + 1);
  };
  const replacePhoto = (f) => {
    if (!f) return;
    st.manualPhoto = f; S.enhanced.delete(st.uid); S.thumbs.delete(st.uid); bump(); setRev((x) => x + 1);
  };
  const download = async () => {
    if (!st.expiryDate) { toast.error('Enter Expiry Date of Card on the Generate page first'); return; }
    try {
      if (!st.token) await issueTokens(S, [st], false);
      saveBlob(new Blob([await cardPdf(S, st)], { type: 'application/pdf' }), `${safeName(`${st.regNo} - ${st.name}`)}.pdf`);
      bump(); setRev((x) => x + 1);
    } catch (e) { toast.error(e.message); }
  };
  const hasPhoto = !!photoBlob(S, st);

  return (
    <div className="sa-modal">
      <div className="sa-modal-box">
        <div className="sa-row between"><h2>{st.name} — {st.regNo}</h2><button type="button" className="sa-btn ghost sm" onClick={onClose}>✕</button></div>
        <div className="sa-modal-body">
          <div className="sa-sample big">{imgs.front ? <><img src={imgs.front} alt="Front" /><img src={imgs.back} alt="Back" /></> : <p className="sa-muted">Rendering…</p>}</div>
          <div className="sa-edit">
            <h3>Edit details</h3>
            <label className="sa-fld">Name<input className="sa-inp" value={draft.__name ?? ''} onChange={(e) => setDraft((d) => ({ ...d, __name: e.target.value }))} /></label>
            {S.columns.filter((c) => c.role !== 'photo').map((c) => (
              <label key={c.label} className="sa-fld">{c.label}
                <input className="sa-inp" value={draft[c.label] ?? ''} onChange={(e) => setDraft((d) => ({ ...d, [c.label]: e.target.value }))} />
              </label>
            ))}
            <div className="sa-row"><button type="button" className="sa-btn primary" onClick={save}>Save &amp; re-render</button></div>
            <div className="sa-row">
              <button type="button" className="sa-btn ghost" onClick={() => fileRef.current && fileRef.current.click()}>Replace photo</button>
              <button type="button" className="sa-btn ghost" onClick={download}>Download PDF card</button>
              <input ref={fileRef} type="file" hidden accept="image/*,.jfif" onChange={(e) => { replacePhoto(e.target.files[0]); e.target.value = ''; }} />
            </div>
            <p className="sa-hint">
              Status: <StatusBadge s={st} /> · Expiry {st.expiryText || 'not set'}<br />
              Photo: {!hasPhoto ? <b className="sa-bad">missing</b>
                : info && info.raw && info.raw.error ? <b className="sa-bad">{info.raw.error}</b>
                  : info && info.e ? <>{info.e.srcW}×{info.e.srcH}px source{info.e.upscaled ? <> → <b>upscaled to HD</b> &amp; sharpened</> : ' → HD'}</> : '…'}<br />
              QR key: {st.token ? <b className="sa-ok">issued</b> : 'issued by the server when the card is generated'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
