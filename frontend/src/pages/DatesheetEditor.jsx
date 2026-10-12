import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  X, Loader2, Save, Trash2, Move, GitMerge, Split, Undo2, RotateCcw, Plus, AlertCircle,
  CheckCircle2, Search, Users, Crosshair, CalendarDays, Link2,
} from 'lucide-react';
import api, { errMsg } from '../api/client';
import { useToast } from '../context/ToastContext';
import './datesheetEditor.css';

/*
 * Datesheet editor — opens a generated datesheet as a day × slot grid.
 *   • click a paper → Move (pick a cell), Merge (pick another paper), Unmerge, Delete
 *   • removed / off-sheet courses can be added back
 * Every change is clash-checked live against the real student registrations (and the
 * cohort's other datesheets); Save is only possible with 0 clashes and REPLACES the
 * previous PDF of this datesheet.
 */

// "01:00-02:30" → [780, 870] (exam clock hours 1-7 are afternoon)
const span = (label) => {
  const m = String(label || '').match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const t = (h, mm) => { h = Number(h); if (h < 8) h += 12; return h * 60 + Number(mm); };
  return [t(m[1], m[2]), t(m[3], m[4])];
};
const overlaps = (a, b) => !!(a && b && a[0] < b[1] && b[0] < a[1]);
const fmtDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

export default function DatesheetEditor({ datesheetId, onClose, onSaved }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [courses, setCourses] = useState([]);      // [{code,name,group,d,s}]
  const [removed, setRemoved] = useState([]);      // codes deleted in this session
  const [history, setHistory] = useState([]);      // undo stack of {courses, removed}
  const [sel, setSel] = useState(null);            // selected group id
  const [mode, setMode] = useState(null);          // 'move' | 'merge' | 'add'
  const [addCode, setAddCode] = useState('');
  const [addSearch, setAddSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [serverClashes, setServerClashes] = useState([]);
  const [confirmClose, setConfirmClose] = useState(false);
  const [q, setQ] = useState('');                  // header search
  const [qOpen, setQOpen] = useState(false);
  const [qIdx, setQIdx] = useState(0);
  const [flash, setFlash] = useState(null);        // group id to scroll to + highlight
  const searchRef = useRef(null);

  useEffect(() => {
    let alive = true;
    api.get(`/generate/datesheet/${datesheetId}/editor`)
      .then((r) => { if (!alive) return; setData(r.data); setCourses(r.data.courses || []); })
      .catch((e) => alive && setLoadErr(errMsg(e, 'Could not open the datesheet.')));
    return () => { alive = false; };
  }, [datesheetId]);

  const dirty = history.length > 0;
  const commit = (next, nextRemoved = removed) => {
    setHistory((h) => [...h, { courses, removed }].slice(-100));
    setCourses(next); setRemoved(nextRemoved); setServerClashes([]);
  };
  const undo = () => {
    const last = history[history.length - 1];
    if (!last) return;
    setHistory((h) => h.slice(0, -1)); setCourses(last.courses); setRemoved(last.removed);
    setSel(null); setMode(null);
  };
  const reset = () => {
    if (!data) return;
    setHistory([]); setCourses(data.courses || []); setRemoved([]); setSel(null); setMode(null); setServerClashes([]);
  };

  // ── derived ────────────────────────────────────────────────────────────────
  const groups = useMemo(() => {
    const m = new Map();
    for (const c of courses) {
      if (!m.has(c.group)) m.set(c.group, { id: c.group, d: c.d, s: c.s, codes: [], names: [] });
      const g = m.get(c.group); g.codes.push(c.code); g.names.push(c.name);
    }
    return m;
  }, [courses]);

  const students = data?.students || {};
  const groupStudents = useMemo(() => {
    const m = new Map();
    for (const g of groups.values()) {
      const set = new Set();
      for (const c of g.codes) for (const s of students[c] || []) set.add(s);
      m.set(g.id, set);
    }
    return m;
  }, [groups, students]);

  // student → sittings (groups + other datesheets of the same programme)
  const sittingsOf = useMemo(() => {
    const m = new Map();
    const push = (sid, it) => { if (!m.has(sid)) m.set(sid, []); m.get(sid).push(it); };
    for (const g of groups.values()) for (const sid of groupStudents.get(g.id) || []) {
      push(sid, { group: g.id, date: data?.dates?.[g.d]?.iso, span: span(data?.slots?.[g.s]) });
    }
    for (const e of data?.external || []) for (const sid of students[e.code] || []) {
      push(sid, { ext: e, date: e.date, span: span(e.slot) });
    }
    return m;
  }, [groups, groupStudents, data, students]);

  // clashes of a group if it sat at (d,s): [{sid, other}]
  const clashesAt = (gid, d, s, codesOverride) => {
    if (!data) return [];
    const date = data.dates[d]?.iso; const sp = span(data.slots[s]);
    const sids = codesOverride
      ? new Set(codesOverride.flatMap((c) => students[c] || []))
      : (groupStudents.get(gid) || new Set());
    const out = [];
    for (const sid of sids) {
      for (const it of sittingsOf.get(sid) || []) {
        if (it.group === gid || (codesOverride && it.group && codesOverride.some((c) => (groups.get(it.group)?.codes || []).includes(c)))) continue;
        if (it.date === date && overlaps(it.span, sp)) { out.push({ sid, other: it.ext ? `${it.ext.code} (${it.ext.sheet})` : groups.get(it.group)?.codes.join(' + ') }); break; }
      }
    }
    return out;
  };
  const cellAllowed = (d, s) => (data?.allowed?.[d] || []).includes(s);

  const allClashes = useMemo(() => {
    if (!data) return [];
    const out = [];
    for (const g of groups.values()) {
      if (!cellAllowed(g.d, g.s)) out.push({ type: 'slot', gid: g.id, text: `${g.codes.join(' + ')} is in a slot not allowed on ${data.dates[g.d]?.day}` });
      // a merged paper can't have a student registered in two of its courses
      const seen = new Map();
      for (const c of g.codes) for (const sid of students[c] || []) {
        if (seen.has(sid) && seen.get(sid) !== c) out.push({ type: 'merge', gid: g.id, text: `${g.codes.join(' + ')}: student ${sid} takes both ${seen.get(sid)} and ${c}` });
        else seen.set(sid, c);
      }
    }
    const pairs = new Set();
    for (const [sid, list] of sittingsOf) {
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.ext && b.ext) continue;
        if (a.group && a.group === b.group) continue;
        if (a.date === b.date && overlaps(a.span, b.span)) {
          const ga = a.group || `ext:${a.ext.code}`; const gb = b.group || `ext:${b.ext.code}`;
          const key = [ga, gb].sort().join('|');
          if (!pairs.has(key)) pairs.add(key);
          out.push({ type: 'student', gid: a.group || b.group, key, sid,
            text: `${a.group ? groups.get(a.group).codes.join(' + ') : a.ext.code} ⟷ ${b.group ? groups.get(b.group).codes.join(' + ') : `${b.ext.code} (${b.ext.sheet})`}` });
        }
      }
    }
    return out;
  }, [groups, sittingsOf, data, students]); // eslint-disable-line

  const clashGroups = useMemo(() => new Set(allClashes.map((c) => c.gid).filter(Boolean)), [allClashes]);
  const clashSummary = useMemo(() => {
    const byPair = new Map();
    for (const c of allClashes) {
      const k = c.type === 'student' ? c.key : `${c.type}|${c.text}`;
      if (!byPair.has(k)) byPair.set(k, { text: c.text, students: new Set(), type: c.type });
      if (c.sid) byPair.get(k).students.add(c.sid);
    }
    return [...byPair.values()];
  }, [allClashes]);

  const twoPerDay = useMemo(() => {
    let n = 0;
    for (const list of sittingsOf.values()) {
      const days = new Map();
      for (const it of list) if (it.group) days.set(it.date, (days.get(it.date) || 0) + 1);
      if ([...days.values()].some((x) => x >= 2)) n += 1;
    }
    return n;
  }, [sittingsOf]);

  // ── actions ────────────────────────────────────────────────────────────────
  const selected = sel ? groups.get(sel) : null;
  const pick = (gid) => {
    if (mode === 'merge' && selected && gid !== sel) return doMerge(gid);
    setSel(gid === sel ? null : gid); setMode(null);
  };
  const doMove = (d, s) => {
    if (!selected) return;
    if (!cellAllowed(d, s)) { toast.error('This slot is not used on that day.'); return; }
    const c = clashesAt(sel, d, s);
    if (c.length) { toast.error(`${c.length} student clash(es) there — e.g. student ${c[0].sid} also sits ${c[0].other}.`); return; }
    commit(courses.map((x) => (x.group === sel ? { ...x, d, s } : x)));
    setMode(null);
    toast.success(`${selected.codes.join(' + ')} moved to ${data.dates[d].day} ${fmtDate(data.dates[d].iso)}, ${data.slots[s]}.`);
  };
  const doMerge = (targetGid) => {
    const t = groups.get(targetGid); if (!selected || !t) return;
    const codes = [...t.codes, ...selected.codes];
    // a student can't be in two of the merged courses
    const seen = new Set(); let both = null;
    for (const c of codes) for (const sid of students[c] || []) { if (seen.has(sid)) { both = sid; break; } seen.add(sid); }
    if (both) { toast.error(`Can't merge — student ${both} is registered in both.`); return; }
    const newId = codes.join('+');
    const c = clashesAt(newId, t.d, t.s, codes);
    if (c.length) { toast.error(`Merging here clashes for ${c.length} student(s) — e.g. ${c[0].sid} with ${c[0].other}.`); return; }
    commit(courses.map((x) => (x.group === sel || x.group === targetGid ? { ...x, group: newId, d: t.d, s: t.s } : x)));
    setSel(newId); setMode(null);
    toast.success(`Merged: ${codes.join(' + ')} (${data.dates[t.d].day} ${data.slots[t.s]}).`);
  };
  const doUnmerge = () => {
    if (!selected || selected.codes.length < 2) return;
    commit(courses.map((x) => (x.group === sel ? { ...x, group: x.code } : x)));
    setSel(null); setMode(null);
    toast.success(`Unmerged: ${selected.codes.join(', ')} are now separate papers (same slot — move any of them if needed).`);
  };
  const doDelete = () => {
    if (!selected) return;
    commit(courses.filter((x) => x.group !== sel), [...new Set([...removed, ...selected.codes])]);
    toast.success(`${selected.codes.join(' + ')} removed from the datesheet.`);
    setSel(null); setMode(null);
  };
  // single course out of a merge (search panel)
  const doUnmergeOne = (code) => {
    const c = courses.find((x) => x.code === code); const g = c && groups.get(c.group);
    if (!g || g.codes.length < 2) return;
    const restId = g.codes.filter((x) => x !== code).join('+');
    commit(courses.map((x) => (x.code === code ? { ...x, group: code } : x.group === g.id ? { ...x, group: restId } : x)));
    setSel(code); setMode(null); setFlash(code);
    toast.success(`${code} separated from ${restId} (same slot — move it if needed).`);
  };
  const doDeleteOne = (code) => {
    const c = courses.find((x) => x.code === code); const g = c && groups.get(c.group);
    if (!g) return;
    const restId = g.codes.filter((x) => x !== code).join('+');
    commit(courses.filter((x) => x.code !== code).map((x) => (x.group === g.id ? { ...x, group: restId } : x)),
      [...new Set([...removed, code])]);
    if (sel === g.id) setSel(null);
    setMode(null);
    toast.success(`${code} removed from the datesheet${g.codes.length > 1 ? ` (${restId} stays)` : ''}.`);
  };
  const focusGroup = (gid, nextMode = null) => {
    setSel(gid); setMode(nextMode); setFlash(gid); setQOpen(false);
  };

  const doAdd = (d, s) => {
    if (!addCode) return;
    if (!cellAllowed(d, s)) { toast.error('This slot is not used on that day.'); return; }
    const c = clashesAt(addCode, d, s, [addCode]);
    if (c.length) { toast.error(`${c.length} student clash(es) there — e.g. student ${c[0].sid} also sits ${c[0].other}.`); return; }
    commit([...courses, { code: addCode, name: data.names?.[addCode] || '', group: addCode, d, s }], removed.filter((x) => x !== addCode));
    toast.success(`${addCode} added.`);
    setAddCode(''); setMode(null);
  };
  const onCell = (d, s) => {
    if (mode === 'move') doMove(d, s);
    else if (mode === 'add') doAdd(d, s);
  };

  // cell colouring while moving / adding
  const cellState = (d, s) => {
    if (!cellAllowed(d, s)) return 'off';
    const reserve = (data?.reserve?.[d] || []).includes(s);
    if (mode === 'move' && selected) {
      if (selected.d === d && selected.s === s) return 'here';
      return clashesAt(sel, d, s).length ? 'bad' : (reserve ? 'okres' : 'ok');
    }
    if (mode === 'add' && addCode) return clashesAt(addCode, d, s, [addCode]).length ? 'bad' : (reserve ? 'okres' : 'ok');
    return '';
  };

  const addable = useMemo(() => {
    if (!data) return [];
    const on = new Set(courses.map((c) => c.code));
    const pool = [...new Set([...(data.offSheet || []), ...removed])].filter((c) => !on.has(c)).sort();
    const q = addSearch.trim().toUpperCase();
    return q ? pool.filter((c) => c.includes(q) || (data.names?.[c] || '').toUpperCase().includes(q)) : pool;
  }, [data, courses, removed, addSearch]);

  // ── header search ───────────────────────────────────────────────────────────
  const results = useMemo(() => {
    const t = q.trim().toUpperCase();
    if (!data || !t) return [];
    const hit = (code, name) => code.includes(t) || String(name || '').toUpperCase().includes(t);
    const out = [];
    for (const c of courses) {
      if (!hit(c.code, c.name || data.names?.[c.code])) continue;
      const g = groups.get(c.group);
      out.push({ kind: 'on', code: c.code, name: c.name || data.names?.[c.code] || '', gid: g.id,
        mergedWith: g.codes.filter((x) => x !== c.code), d: g.d, s: g.s, clash: clashGroups.has(g.id) });
    }
    const on = new Set(courses.map((c) => c.code));
    for (const code of [...new Set([...(data.offSheet || []), ...removed])]) {
      if (on.has(code) || !hit(code, data.names?.[code])) continue;
      out.push({ kind: removed.includes(code) ? 'removed' : 'off', code, name: data.names?.[code] || '' });
    }
    const rank = (r) => (r.code === t ? 0 : r.code.startsWith(t) ? 1 : r.code.includes(t) ? 2 : 3);
    return out.sort((a, b) => rank(a) - rank(b) || (a.kind === 'on' ? 0 : 1) - (b.kind === 'on' ? 0 : 1) || a.code.localeCompare(b.code)).slice(0, 40);
  }, [q, data, courses, groups, removed, clashGroups]);

  useEffect(() => { setQIdx(0); }, [q]);
  useEffect(() => {
    const off = (e) => { if (searchRef.current && !searchRef.current.contains(e.target)) setQOpen(false); };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, []);
  useEffect(() => {
    if (!flash) return undefined;
    const el = document.querySelector(`[data-gid="${CSS.escape(flash)}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
  }, [flash]);

  const resultMain = (r) => {
    if (r.kind !== 'on') { setAddCode(r.code); setSel(null); setMode('add'); setQOpen(false); return; }
    if (mode === 'merge' && selected && r.gid !== sel) { doMerge(r.gid); setQOpen(false); return; }
    focusGroup(r.gid);
  };
  const onSearchKey = (e) => {
    if (e.key === 'Escape') { if (q) setQ(''); else setQOpen(false); return; }
    if (!results.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setQOpen(true); setQIdx((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setQIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); resultMain(results[qIdx] || results[0]); }
  };

  const save = async () => {
    if (allClashes.length) { toast.error('Fix the clashes first — a datesheet with clashes cannot be saved.'); return; }
    setSaving(true);
    try {
      const r = await api.post(`/generate/datesheet/${datesheetId}/editor`, { courses, removed }, { timeout: 5 * 60 * 1000 });
      toast.success('Datesheet saved — the previous PDF has been replaced.');
      if (r.data.staleAdmitCards) toast.info('Admit cards made before this edit are out of date — generate them again.', 9000);
      onSaved && onSaved(r.data.record);
    } catch (e) {
      const cl = e?.response?.data?.clashes;
      if (cl && cl.length) setServerClashes(cl);
      toast.error(errMsg(e, 'Could not save the datesheet.'));
    } finally { setSaving(false); }
  };

  const tryClose = () => { if (dirty) setConfirmClose(true); else onClose(); };

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <motion.div className="dse-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div className="dse-shell" initial={{ y: 14, scale: 0.985 }} animate={{ y: 0, scale: 1 }}>
        <header className="dse-head">
          <div className="dse-title">
            <h3 className="font-display">Edit datesheet</h3>
            <span>{data?.heading || 'Loading…'}</span>
          </div>

          {data && (
            <div className="dse-qwrap" ref={searchRef}>
              <div className="dse-q">
                <Search size={16} />
                <input value={q} placeholder="Search a course on this datesheet — code or name"
                  onChange={(e) => { setQ(e.target.value); setQOpen(true); }}
                  onFocus={() => setQOpen(true)} onKeyDown={onSearchKey} />
                {q && <button type="button" className="dse-q-x" onClick={() => { setQ(''); setQOpen(false); }} title="Clear"><X size={14} /></button>}
              </div>
              {qOpen && q.trim() && (
                <div className="dse-qpanel">
                  {mode === 'merge' && selected && (
                    <div className="dse-qnote"><GitMerge size={13} /> Pick the paper to merge <b>{selected.codes.join(' + ')}</b> with</div>
                  )}
                  {results.length === 0 && <div className="dse-qempty">No course matches “{q.trim()}”.</div>}
                  {results.map((r, i) => (
                    <div key={r.code} className={`dse-qrow ${i === qIdx ? 'on' : ''}`} onMouseEnter={() => setQIdx(i)}>
                      <button type="button" className="dse-qmain" onClick={() => resultMain(r)}>
                        <div className="dse-qtop">
                          <b>{r.code}</b>
                          <span className="dse-qname" title={r.name}>{r.name}</span>
                          <small>{(students[r.code] || []).length} students</small>
                        </div>
                        <div className="dse-qmeta">
                          {r.kind === 'on' ? (
                            <>
                              <span><CalendarDays size={12} /> {data.dates[r.d]?.day}, {fmtDate(data.dates[r.d]?.iso)} · {data.slots[r.s]}</span>
                              {r.mergedWith.length
                                ? <span className="dse-tag merged"><Link2 size={11} /> Merged with {r.mergedWith.join(', ')}</span>
                                : <span className="dse-tag">Not merged</span>}
                              {r.clash && <span className="dse-tag bad"><AlertCircle size={11} /> In a clash</span>}
                            </>
                          ) : (
                            <span className="dse-tag off">{r.kind === 'removed' ? 'Removed in this edit' : 'Not on this datesheet'}</span>
                          )}
                        </div>
                      </button>
                      <div className="dse-qacts">
                        {r.kind === 'on' ? (
                          mode === 'merge' && selected && r.gid !== sel ? (
                            <button type="button" className="btn btn-brass btn-sm" onClick={() => resultMain(r)}><GitMerge size={13} /> Merge here</button>
                          ) : (
                            <>
                              <button type="button" className="btn btn-ghost btn-sm" onClick={() => focusGroup(r.gid)} title="Show on the grid"><Crosshair size={13} /></button>
                              <button type="button" className="btn btn-ghost btn-sm" onClick={() => focusGroup(r.gid, 'move')}><Move size={13} /> Move</button>
                              <button type="button" className="btn btn-ghost btn-sm" onClick={() => focusGroup(r.gid, 'merge')}><GitMerge size={13} /> Merge</button>
                              {r.mergedWith.length > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { doUnmergeOne(r.code); setQOpen(false); }} title={`Take ${r.code} out of the merge`}><Split size={13} /> Unmerge</button>}
                              <button type="button" className="btn btn-ghost btn-sm dse-danger" onClick={() => doDeleteOne(r.code)} title={`Remove ${r.code} from the datesheet`}><Trash2 size={13} /></button>
                            </>
                          )
                        ) : (
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => resultMain(r)}><Plus size={13} /> Add</button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {data && (
            <div className="dse-status">
              {allClashes.length === 0
                ? <span className="dse-pill ok"><CheckCircle2 size={14} /> 0 clashes</span>
                : <span className="dse-pill bad"><AlertCircle size={14} /> {clashSummary.length} clash{clashSummary.length > 1 ? 'es' : ''}</span>}
              <span className="dse-pill"><Users size={14} /> {twoPerDay} with 2 papers/day</span>
              <span className="dse-pill">{groups.size} papers · {courses.length} courses</span>
            </div>
          )}
          <button className="dse-x" onClick={tryClose} title="Close"><X size={18} /></button>
        </header>

        {!data && !loadErr && <div className="dse-loading"><Loader2 className="spin" size={22} /> Opening datesheet…</div>}
        {loadErr && <div className="dse-loading err"><AlertCircle size={18} /> {loadErr}</div>}

        {data && (
          <div className="dse-body">
            <div className="dse-grid-wrap">
              {(mode === 'move' || mode === 'add') && (
                <div className="dse-hint">
                  {mode === 'move' ? <>Pick a new slot for <b>{selected?.codes.join(' + ')}</b></> : <>Pick a slot for <b>{addCode}</b></>}
                  <span className="dse-legend"><i className="ok" /> clash-free {data.reserve?.some((r) => r.length) && <><i className="okres" /> reserve (only if needed)</>} <i className="bad" /> clash <i className="off" /> not used that day</span>
                  <button className="btn btn-ghost btn-sm" onClick={() => setMode(null)}>Cancel</button>
                </div>
              )}
              {mode === 'merge' && (
                <div className="dse-hint">Click the paper to merge <b>{selected?.codes.join(' + ')}</b> with — it moves into that paper's slot.
                  <button className="btn btn-ghost btn-sm" onClick={() => setMode(null)}>Cancel</button>
                </div>
              )}
              <table className="dse-grid">
                <thead>
                  <tr>
                    <th className="dse-dcol">Day / Date</th>
                    {data.slots.map((s) => <th key={s}>{s}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {data.dates.map((dt, d) => (
                    <tr key={dt.iso}>
                      <td className="dse-dcol"><b>{dt.day}</b><span>{fmtDate(dt.iso)}</span></td>
                      {data.slots.map((sl, s) => {
                        const st = cellState(d, s);
                        const here = [...groups.values()].filter((g) => g.d === d && g.s === s);
                        const reserve = (data.reserve?.[d] || []).includes(s);
                        return (
                          <td key={sl} className={`dse-cell ${st} ${reserve ? 'reserve' : ''}`} onClick={() => onCell(d, s)}
                            title={st === 'off' ? 'Not used on this day' : reserve ? 'Reserve slot — use only if needed' : ''}>
                            {here.map((g) => (
                              <button key={g.id} type="button" data-gid={g.id}
                                className={`dse-chip ${flash === g.id ? 'flash' : ''} ${sel === g.id ? 'sel' : ''} ${clashGroups.has(g.id) ? 'clash' : ''} ${g.codes.length > 1 ? 'merged' : ''}`}
                                onClick={(e) => { e.stopPropagation(); if (mode === 'move' || mode === 'add') onCell(d, s); else pick(g.id); }}
                                title={g.codes.map((c, i) => `${c}: ${g.names[i] || ''} (${(students[c] || []).length} students)`).join('\n')}>
                                {g.codes.length > 1 && <GitMerge size={11} />}
                                <b>{g.codes.join(' + ')}</b>
                                <small>{(groupStudents.get(g.id) || new Set()).size}</small>
                              </button>
                            ))}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <aside className="dse-side">
              {selected ? (
                <div className="dse-card">
                  <div className="dse-card-title">{selected.codes.join(' + ')}</div>
                  {selected.codes.map((c, i) => (
                    <div key={c} className="dse-course"><b>{c}</b> {selected.names[i]} <small>{(students[c] || []).length} students</small></div>
                  ))}
                  <div className="dse-when">{data.dates[selected.d]?.day}, {fmtDate(data.dates[selected.d]?.iso)} · {data.slots[selected.s]}</div>
                  <div className="dse-actions">
                    <button className={`btn btn-sm ${mode === 'move' ? 'btn-brass' : 'btn-ghost'}`} onClick={() => setMode(mode === 'move' ? null : 'move')}><Move size={14} /> Move</button>
                    <button className={`btn btn-sm ${mode === 'merge' ? 'btn-brass' : 'btn-ghost'}`} onClick={() => setMode(mode === 'merge' ? null : 'merge')}><GitMerge size={14} /> Merge with…</button>
                    {selected.codes.length > 1 && <button className="btn btn-ghost btn-sm" onClick={doUnmerge}><Split size={14} /> Unmerge</button>}
                    <button className="btn btn-ghost btn-sm dse-danger" onClick={doDelete}><Trash2 size={14} /> Delete</button>
                  </div>
                </div>
              ) : (
                <div className="dse-card muted">Click a paper to move, merge, unmerge or delete it.</div>
              )}

              <div className="dse-card">
                <div className="dse-card-title">Add a course</div>
                <div className="dse-search"><Search size={13} /><input className="input" placeholder="Search removed / not-scheduled courses" value={addSearch} onChange={(e) => setAddSearch(e.target.value)} /></div>
                <div className="dse-addlist">
                  {addable.length === 0 && <small className="muted">Nothing to add.</small>}
                  {addable.slice(0, 60).map((c) => (
                    <button key={c} type="button" className={`dse-add ${addCode === c ? 'on' : ''}`} onClick={() => { setAddCode(c); setSel(null); setMode('add'); }}>
                      <Plus size={12} /> <b>{c}</b> <span>{data.names?.[c] || ''}</span> <small>{(students[c] || []).length}</small>
                    </button>
                  ))}
                </div>
              </div>

              <div className="dse-card">
                <div className="dse-card-title">{allClashes.length ? 'Clashes — fix before saving' : 'Clash check'}</div>
                {clashSummary.length === 0
                  ? <div className="dse-okline"><CheckCircle2 size={14} /> No student has two papers at the same time.</div>
                  : clashSummary.slice(0, 30).map((c, i) => (
                    <div key={i} className="dse-clash"><AlertCircle size={13} /> {c.text}{c.students.size ? ` — ${c.students.size} student(s)` : ''}</div>
                  ))}
                {serverClashes.length > 0 && <div className="dse-clash">Server found {serverClashes.length} clash(es) — reload the editor.</div>}
                {removed.length > 0 && <div className="dse-removed">Removed: {removed.join(', ')}</div>}
              </div>
            </aside>
          </div>
        )}

        <footer className="dse-foot">
          <div>
            <button className="btn btn-ghost btn-sm" onClick={undo} disabled={!history.length}><Undo2 size={14} /> Undo</button>
            <button className="btn btn-ghost btn-sm" onClick={reset} disabled={!history.length}><RotateCcw size={14} /> Reset</button>
          </div>
          <div>
            <button className="btn btn-ghost" onClick={tryClose}>Cancel</button>
            <button className="btn btn-brass" onClick={save} disabled={!data || saving || !dirty || allClashes.length > 0}
              title={allClashes.length ? 'Fix the clashes first' : (!dirty ? 'No changes yet' : 'Save and replace the previous datesheet')}>
              {saving ? <Loader2 size={15} className="spin" /> : <Save size={15} />} Save &amp; replace
            </button>
          </div>
        </footer>

        {confirmClose && (
          <div className="dse-confirm">
            <div className="dse-confirm-box">
              <b>Discard your changes?</b>
              <p>The datesheet stays exactly as it was.</p>
              <div>
                <button className="btn btn-ghost btn-sm" onClick={() => setConfirmClose(false)}>Keep editing</button>
                <button className="btn btn-sm dse-danger" onClick={onClose}>Discard</button>
              </div>
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
