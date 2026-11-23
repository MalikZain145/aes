/**
 * seatingNeeds.js — how many exam seats / benches a set of datesheets needs, and
 * whether a set of rooms can hold it. Used before admit cards are generated, so a
 * special exam can never be issued with too few rooms (the Exam Cell is told what
 * is missing and the system can suggest rooms that close the gap).
 *
 * The rule is the seating engine's (scheduler/admit_cards.py):
 *   • a bench has 2 seats; its two students must write DIFFERENT papers
 *     (codes of a merged paper are ONE paper);
 *   • so a sitting needs  max(largest paper, ceil(students / 2))  benches;
 *   • only if that is short, an EXAM HALL (Room.examHall + hallSeats) may seat the
 *     largest paper on both seats of a few benches — as few as needed, with at most
 *     hallSeats students in that hall.
 */
const fs = require('fs');
const path = require('path');

const up = (x) => String(x == null ? '' : x).trim().toUpperCase();
const seatsOf = (r) => Math.max(0, Number(r.examCapacity) || Number(r.capacity) || 0);
const benchesOf = (r) => Math.floor(seatsOf(r) / 2);

/** Read each datesheet's schedule snapshot → sittings [{date, slot, students, papers:[{codes, n}]}]. */
async function sittingsOf(datesheets, outputDir) {
  const fstore = require('./fileStore');
  const cells = new Map();   // date|slot → { codeStudents: Map(code → Set), groups: [[codes]] }
  for (const d of datesheets) {
    const sf = d.meta && d.meta.scheduleFile && path.basename(d.meta.scheduleFile);
    if (!sf) continue;
    try { await fstore.ensureLocal(sf); } catch { /* best-effort */ }
    const p = path.join(outputDir, sf);
    if (!fs.existsSync(p)) continue;
    let snap;
    try { snap = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { continue; }
    for (const c of snap.courses || []) {
      const k = `${c.date}|${c.slot}`;
      if (!cells.has(k)) cells.set(k, { date: c.date, slot: c.slot, codeStudents: new Map(), groups: [] });
      const cell = cells.get(k);
      const code = up(c.code);
      if (!cell.codeStudents.has(code)) cell.codeStudents.set(code, new Set());
      for (const s of c.students || []) cell.codeStudents.get(code).add(String(s));
      const g = String(c.group || c.code).split(/[+/]/).map(up).filter(Boolean);
      if (!g.includes(code)) g.push(code);
      cell.groups.push(g);
    }
  }
  const out = [];
  for (const cell of cells.values()) {
    // union-find: codes of one merged group (from any sheet) are one paper
    const parent = new Map();
    const find = (x) => { if (!parent.has(x)) parent.set(x, x); while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); };
    for (const g of cell.groups) for (const c of g) union(g[0], c);
    const papers = new Map();   // root → { codes:Set, students:Set }
    for (const [code, set] of cell.codeStudents) {
      const r = find(code);
      if (!papers.has(r)) papers.set(r, { codes: new Set(), students: new Set() });
      const p = papers.get(r);
      p.codes.add(code);
      for (const s of set) p.students.add(s);
    }
    // a student sits one paper per sitting; count each student once
    const all = new Set();
    for (const p of papers.values()) for (const s of p.students) all.add(s);
    const list = [...papers.values()].map((p) => ({ codes: [...p.codes].sort(), n: p.students.size }))
      .filter((p) => p.n > 0).sort((a, b) => b.n - a.n);
    if (all.size) out.push({ date: cell.date, slot: cell.slot, students: all.size, papers: list });
  }
  return out.sort((a, b) => (a.date + a.slot).localeCompare(b.date + b.slot));
}

/** Can these rooms seat this sitting? Mirrors seat_session + _hall_plan. */
function fitSitting(sitting, rooms) {
  const P = sitting.papers.length ? sitting.papers[0].n : 0;
  const T = sitting.students;
  const O = T - P;
  const base = rooms.reduce((n, r) => n + benchesOf(r), 0);
  const need = Math.max(P, Math.ceil(T / 2));
  if (need <= base) return { ok: true, benches: base, need, doubles: 0, halls: [] };
  // exam halls, largest hallSeats first
  const halls = rooms.filter((r) => r.examHall && Number(r.hallSeats) > 1)
    .map((r) => ({ name: r.name, rows: benchesOf(r), cap: Math.min(benchesOf(r), Math.floor(Math.min(Number(r.hallSeats), 2 * benchesOf(r)) / 2)) }))
    .sort((a, b) => b.cap - a.cap);
  const opened = [];
  for (const h of halls) {
    opened.push(h);
    const B = base - opened.reduce((n, x) => n + (x.rows - x.cap), 0);
    const D = Math.max(0, P - B);
    if (D <= opened.reduce((n, x) => n + x.cap, 0) && O <= B - D) {
      return { ok: true, benches: base, need, doubles: D, halls: opened.map((x) => x.name) };
    }
  }
  // short: by how many benches (assuming the halls are used as well as they can be)
  const hallExtra = halls.reduce((n, h) => n + h.cap, 0) - halls.reduce((n, h) => n + (h.rows - h.cap), 0);
  const shortP = P - (base + Math.max(0, hallExtra));
  const shortT = Math.ceil(T / 2) - base;
  return { ok: false, benches: base, need, short: Math.max(1, shortP, shortT), halls: halls.map((h) => h.name) };
}

/** Check every sitting against the rooms. */
function checkRooms(sittings, rooms) {
  const rows = sittings.map((s) => {
    const f = fitSitting(s, rooms);
    return {
      date: s.date, slot: s.slot, students: s.students, papers: s.papers.length,
      largest: s.papers[0] ? { codes: s.papers[0].codes, n: s.papers[0].n } : null,
      benchesNeeded: f.need, benchesAvailable: f.benches,
      ok: f.ok, shortBenches: f.ok ? 0 : f.short,
      doubleBenches: f.doubles || 0, hallsUsed: f.ok ? f.halls : [],
    };
  });
  return {
    ok: rows.every((r) => r.ok),
    rooms: rooms.length,
    seats: rooms.reduce((n, r) => n + seatsOf(r), 0),
    benches: rooms.reduce((n, r) => n + benchesOf(r), 0),
    sittings: rows,
    short: rows.filter((r) => !r.ok),
  };
}

/** Add rooms (same buildings first, then biggest) until every sitting fits. */
function suggestRooms(sittings, picked, allRooms) {
  const names = new Set(picked.map((r) => r.name));
  const chosen = [...picked];
  const blds = new Set(picked.map((r) => String(r.building || '').toLowerCase()).filter(Boolean));
  const pool = allRooms.filter((r) => !names.has(r.name) && r.type !== 'lab' && benchesOf(r) >= 5)
    .sort((a, b) => (blds.has(String(b.building || '').toLowerCase()) - blds.has(String(a.building || '').toLowerCase()))
      || benchesOf(b) - benchesOf(a) || String(a.name).localeCompare(String(b.name)));
  let res = checkRooms(sittings, chosen);
  const added = [];
  for (const r of pool) {
    if (res.ok) break;
    chosen.push(r); added.push(r.name);
    res = checkRooms(sittings, chosen);
  }
  return { ok: res.ok, added, rooms: chosen.map((r) => r.name), check: res };
}

module.exports = { sittingsOf, fitSitting, checkRooms, suggestRooms, benchesOf, seatsOf };
