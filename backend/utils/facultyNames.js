/**
 * facultyNames.js — name normalisation / fuzzy matching for faculty rosters.
 * The class-wise report, Faculty_List and the All-Faculty user export spell the
 * same person differently ("Mr. M. Shahrukh Pasha" / "Mr. Muhammad Shahrukh Pasha",
 * "Rafia Hayat" / "Rafia Hayyat", "Mr.Zeeshan Ashraf" / "Zeeshan Ashraf").
 */
const TITLES = new Set(['mr', 'ms', 'mrs', 'miss', 'dr', 'engr', 'eng', 'prof', 'professor', 'sir', 'madam', 'syed', 'hafiz']);
const MUHAMMAD = new Set(['m', 'muhammad', 'muhamamd', 'muhammed', 'mohammad', 'mohammed', 'muhamad', 'mohd', 'md']);

/** Strip titles, brackets, punctuation → lower-case word list. */
function words(name) {
  return String(name || '')
    .replace(/^\s*[A-Z]{2,4}-\d+\s*-\s*/, '')   // "CS-038 - Dr. Sadaf Tanvir"
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')          // "(Leave)", "(Visiting)"
    .replace(/[^a-z\s-]/g, ' ')           // dots, digits, commas
    .replace(/-/g, ' ')                    // "Qura-Tul-Ain" → qura tul ain
    .split(/\s+/)
    .filter(Boolean);
}

const squeeze = (w) => w.replace(/(.)\1+/g, '$1');      // hayyat → hayat, afzaal → afzal

/** Titles + Muhammad dropped, letters squeezed, word order kept, no spaces. */
function orderedCompact(name) {
  return words(name).filter((w) => !TITLES.has(w) && !MUHAMMAD.has(w)).map(squeeze).join('');
}

/** Exact key: titles dropped. */
function exactKey(name) {
  return words(name).filter((w) => !TITLES.has(w)).join(' ');
}

/** Loose key: also drops "Muhammad"/"M." and squeezes doubled letters; tokens sorted. */
function looseKey(name) {
  return words(name).filter((w) => !TITLES.has(w) && !MUHAMMAD.has(w)).map(squeeze).sort().join(' ');
}

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/**
 * Build a matcher over `items` (objects with `.name`). match(name) returns the
 * single best item or null: exact key → loose key → close spelling (edit distance
 * ≤ 2 on the loose key, ≥ 8 letters, and unambiguous).
 */
function makeMatcher(items, nameOf = (x) => x.name) {
  const byExact = new Map(), byLoose = new Map(), byOrdered = new Map();
  const push = (m, k, it) => { if (!k) return; if (!m.has(k)) m.set(k, []); if (!m.get(k).includes(it)) m.get(k).push(it); };
  for (const it of items) {
    const names = [].concat(nameOf(it) || []);
    for (const n of names) { push(byExact, exactKey(n), it); push(byLoose, looseKey(n), it); push(byOrdered, orderedCompact(n), it); }
  }
  const looseKeys = [...byLoose.keys()];
  return function match(name) {
    const e = byExact.get(exactKey(name));
    if (e && e.length === 1) return e[0];
    const lk = looseKey(name);
    const l = byLoose.get(lk);
    if (l && l.length === 1) return l[0];
    // "Najeebullah" = "Najeeb Ullah Khan": same letters with the spaces removed, or one
    // name runs straight on into the other (≥ 8 letters, unique)
    const oc = orderedCompact(name);
    const cHits = new Set();
    for (const [k, list] of oc.length >= 8 ? byOrdered : []) {
      if (k.length < 8) continue;
      if (k === oc || k.startsWith(oc) || oc.startsWith(k)) list.forEach((it) => cHits.add(it));
    }
    if (cHits.size === 1) return [...cHits][0];
    let best = null, bestD = 3, tie = false;
    for (const k of lk.replace(/\s/g, '').length >= 8 ? looseKeys : []) {
      if (Math.abs(k.length - lk.length) > 2) continue;
      // same number of words, each starting with the same letter (Fouzia Nahid ≈ Fozia Naheed,
      // but never Amir Ahmad ≈ Nazir Ahmad)
      const a = k.split(' '), b = lk.split(' ');
      if (a.length !== b.length || a.some((w, i) => w[0] !== b[i][0])) continue;
      const d = lev(k, lk);
      if (d < bestD) { bestD = d; best = k; tie = false; } else if (d === bestD) tie = true;
    }
    if (best && !tie && bestD <= 2 && byLoose.get(best).length === 1) return byLoose.get(best)[0];
    // one name is the other plus extra words ("Zohaib Aman" ⊂ "Zohaib Aman Khan"), ≥ 2 shared words, unique
    const q = lk.split(' ');
    if (q.length >= 2) {
      const hits = new Set();
      for (const k of looseKeys) {
        const t = k.split(' ');
        if (t.length < 2 || t.length === q.length) continue;
        const [small, big] = t.length < q.length ? [t, q] : [q, t];
        if (small.every((w) => big.includes(w))) byLoose.get(k).forEach((it) => hits.add(it));
      }
      if (hits.size === 1) return [...hits][0];
    }
    return null;
  };
}

/** "Ms. Tahira Batool " → "Ms. Tahira Batool"; "Mr.Faizan zafar" → "Mr. Faizan Zafar"; "(Leave)" removed. */
function displayName(name) {
  let s = String(name || '').replace(/\([^)]*\)/g, ' ').replace(/^\s*[.,]+\s*/, '').replace(/\.(?=[A-Za-z])/g, '. ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^(mr|ms|mrs|dr|engr|prof)\.?\s*/i, (m, t) => `${t[0].toUpperCase()}${t.slice(1).toLowerCase()}. `);
  return s.replace(/\b([a-z])([a-z]*)/g, (m, a, b) => (m.length <= 2 && /^(ul|ur|ud|e|al|bin)$/i.test(m) ? m : a.toUpperCase() + b)).trim();
}

/**
 * Invigilation duty tier from a Faculty List designation:
 *   lab    Lab Engineer / Lab Demonstrator / Lab Technician / Lab Assistant → every exam day
 *   asst   Assistant Professor (incl. "/HoD")                              → 4–5 exam days
 *   lect   Lecturer, Sr. / Jr. Lecturer                                     → up to 6 exam days
 *   senior Professor, Associate Professor, Dean                            → only when needed
 *   other  anything else (office manager, coordinator …)                   → 4–5 exam days
 */
function dutyTier(designation) {
  const d = String(designation || '').toLowerCase();
  if (/\blab\b/.test(d)) return 'lab';
  if (/assist\w*\s*prof|asst\.?\s*prof/.test(d)) return 'asst';
  if (/lectur|lectut/.test(d)) return 'lect';
  if (/prof|dean/.test(d)) return 'senior';
  return d ? 'other' : 'lect';
}

module.exports = {
  dutyTier, words, exactKey, looseKey, makeMatcher, displayName, lev };
