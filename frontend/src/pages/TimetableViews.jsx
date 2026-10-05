import { useState, useEffect, useMemo, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  GraduationCap, Users, DoorOpen, CalendarRange, BarChart3, Database,
  FileSpreadsheet, FileText, Search, ArrowUpDown, ArrowUp, ArrowDown,
  CalendarPlus, Loader2, X, RefreshCw,
} from 'lucide-react';
import api, { errMsg } from '../api/client';
import { useToast } from '../context/ToastContext';
import { PageHeader, EmptyState, Loader } from '../components/ui';
import FancySelect from '../components/FancySelect';
import { useAuth } from '../context/AuthContext';
import { exportExcel, exportPDF } from '../api/exportTable';
import './views.css';

const adminName = (a) => (a && (a.displayName || a.name)) || 'Admin';

/* Arrangements the user can flip between. The first four group the same session
   table by a different key; the last two are their own layouts. */
const VIEWS = [
  { key: 'program', label: 'By Program', icon: GraduationCap, group: 'program', groupLabel: 'Program' },
  { key: 'faculty', label: 'By Faculty', icon: Users, group: 'teacher', groupLabel: 'Faculty' },
  { key: 'room', label: 'By Room', icon: DoorOpen, group: 'room', groupLabel: 'Room' },
  { key: 'day', label: 'By Day & Time', icon: CalendarRange, group: 'day', groupLabel: 'Day' },
  { key: 'utilization', label: 'Room Utilization', icon: BarChart3 },
  { key: 'master', label: 'Master Data', icon: Database },
];

const COLS = [
  { key: 'code', label: 'Code' },
  { key: 'name', label: 'Course' },
  { key: 'section', label: 'Sec' },
  { key: 'program', label: 'Program' },
  { key: 'teacher', label: 'Faculty' },
  { key: 'room', label: 'Room' },
  { key: 'component', label: 'Type' },
  { key: 'day', label: 'Day' },
  { key: 'slot', label: 'Time' },
  { key: 'enrolled', label: 'Enr' },
  { key: 'cap', label: 'Cap' },
];

const uniqSorted = (arr) => [...new Set(arr.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));

// Physical room name — drop the "(2 Hrs)" render tag so a 2-hour class counts
// against the same room as its 1.5-hour siblings.
const baseRoom = (r) => String(r || '').replace(/\s*\(2 Hrs\)\s*/i, '').trim();

// Start-of-slot in minutes (hours 1–7 are afternoon → +12) so every slot,
// including 2-hour ones like "08:30-10:30", orders correctly.
const slotStart = (slot) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(slot || ''));
  if (!m) return 9999;
  let h = +m[1]; const min = +m[2];
  if (h < 8) h += 12;
  return h * 60 + min;
};
const orderSlots = (slots) => [...new Set(slots.filter(Boolean))].sort((a, b) => slotStart(a) - slotStart(b));

export default function TimetableViews() {
  const toast = useToast();
  const navigate = useNavigate();
  const { admin } = useAuth();
  const who = adminName(admin);
  const [params, setParams] = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);      // { sessions, meta, ... } or {hasTimetable:false}
  const [view, setView] = useState(params.get('view') || 'program');
  const [level, setLevel] = useState(params.get('level') === 'pg' ? 'pg' : 'ug'); // ug=BS, pg=MS

  // filters
  const [q, setQ] = useState('');
  const [fProgram, setFProgram] = useState('');
  const [fTeacher, setFTeacher] = useState('');
  const [fRoom, setFRoom] = useState('');
  const [fDay, setFDay] = useState('');
  const [fType, setFType] = useState('');
  // sort
  const [sortKey, setSortKey] = useState('program');
  const [sortDir, setSortDir] = useState('asc');

  const load = useCallback(async (lvl) => {
    setLoading(true);
    try {
      const res = await api.get('/schedule/latest', { params: { level: lvl } });
      const d = res.data;
      // Normalise room names once (strip the "(2 Hrs)" render tag).
      if (d?.sessions) d.sessions = d.sessions.map((s) => ({ ...s, room: baseRoom(s.room) }));
      setData(d);
    } catch (err) {
      toast.error(errMsg(err, 'Could not load the schedule.'));
      setData({ hasTimetable: false });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  // Reload whenever the BS/MS switch changes so both timetables can be viewed.
  useEffect(() => { load(level); }, [load, level]);

  // keep ?level= in the URL alongside ?view=
  useEffect(() => {
    const cur = params.get('level') || 'ug';
    if (cur !== level) { const p = new URLSearchParams(params); p.set('level', level); setParams(p, { replace: true }); }
  }, [level]); // eslint-disable-line

  // keep ?view= in the URL so Downloads menu deep-links work and refresh keeps the tab
  useEffect(() => {
    const cur = params.get('view');
    if (cur !== view) { const p = new URLSearchParams(params); p.set('view', view); setParams(p, { replace: true }); }
  }, [view]); // eslint-disable-line
  // URL → state: a Downloads-menu click changes ?view while we're already mounted
  useEffect(() => {
    const v = params.get('view');
    if (v && v !== view && VIEWS.some((x) => x.key === v)) setView(v);
  }, [params]); // eslint-disable-line

  const sessions = data?.sessions || [];
  const meta = data?.meta || { days: [], theorySlots: [], labSlots: [], roomCaps: {} };

  const dayIx = useMemo(() => Object.fromEntries((meta.days || []).map((d, i) => [d, i])), [meta.days]);
  // Order every distinct slot present in the data (covers 2-hour theory slots too).
  const allSlots = useMemo(() => orderSlots(sessions.map((s) => s.slot)), [sessions]);
  const slotIx = useMemo(() => Object.fromEntries(allSlots.map((s, i) => [s, i])), [allSlots]);

  // ── filtering ──────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return sessions.filter((s) => {
      if (fProgram && s.program !== fProgram) return false;
      if (fTeacher && s.teacher !== fTeacher) return false;
      if (fRoom && s.room !== fRoom) return false;
      if (fDay && s.day !== fDay) return false;
      if (fType && s.component !== fType) return false;
      if (term) {
        const hay = `${s.code} ${s.name} ${s.teacher} ${s.room} ${s.program} ${s.section}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [sessions, q, fProgram, fTeacher, fRoom, fDay, fType]);

  // ── sorting ──────────────────────────────────────────────────────────────--
  const sorted = useMemo(() => {
    const arr = [...filtered];
    const dir = sortDir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      let va = a[sortKey], vb = b[sortKey];
      if (sortKey === 'day') { va = dayIx[a.day] ?? 99; vb = dayIx[b.day] ?? 99; }
      else if (sortKey === 'slot') { va = slotIx[a.slot] ?? 99; vb = slotIx[b.slot] ?? 99; }
      else if (sortKey === 'enrolled' || sortKey === 'cap') { va = Number(va) || 0; vb = Number(vb) || 0; }
      else { va = String(va ?? '').toLowerCase(); vb = String(vb ?? '').toLowerCase(); }
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      // stable secondary sort by day then slot
      const d = (dayIx[a.day] ?? 99) - (dayIx[b.day] ?? 99);
      if (d) return d;
      return (slotIx[a.slot] ?? 99) - (slotIx[b.slot] ?? 99);
    });
    return arr;
  }, [filtered, sortKey, sortDir, dayIx, slotIx]);

  const activeView = VIEWS.find((v) => v.key === view) || VIEWS[0];
  const groupKey = activeView.group;

  // when switching to a grouped view, sort primarily by that key
  useEffect(() => {
    if (groupKey) { setSortKey(groupKey === 'day' ? 'day' : groupKey); setSortDir('asc'); }
  }, [groupKey]);

  // grouped rows for the table views
  const groups = useMemo(() => {
    if (!groupKey) return [];
    const map = new Map();
    for (const s of sorted) {
      const k = groupKey === 'day' ? s.day : (s[groupKey] || '—');
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(s);
    }
    let entries = [...map.entries()];
    if (groupKey === 'day') entries.sort((a, b) => (dayIx[a[0]] ?? 99) - (dayIx[b[0]] ?? 99));
    else entries.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return entries;
  }, [sorted, groupKey, dayIx]);

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };

  const clearFilters = () => { setQ(''); setFProgram(''); setFTeacher(''); setFRoom(''); setFDay(''); setFType(''); };
  const anyFilter = q || fProgram || fTeacher || fRoom || fDay || fType;

  // ── exports ──────────────────────────────────────────────────────────────--
  const baseName = `Timetable_${activeView.label.replace(/[^a-z0-9]+/gi, '_')}`;
  const exportRowsExcel = () => {
    if (!sorted.length) return toast.error('Nothing to export with the current filters.');
    // one sheet per group when grouped, else a single sheet
    const sheets = groupKey
      ? groups.map(([name, rows]) => ({ name: String(name).slice(0, 28), columns: COLS, rows }))
      : [{ name: 'Timetable', columns: COLS, rows: sorted }];
    exportExcel(sheets, baseName, { admin: who, heading: `${activeView.label} — Weekly Timetable` });
    toast.success('Excel downloaded.');
  };
  const exportRowsPDF = () => {
    if (!sorted.length) return toast.error('Nothing to export with the current filters.');
    exportPDF({
      heading: `${activeView.label} — Weekly Timetable`, admin: who,
      columns: COLS, rows: sorted, filename: baseName,
    });
    toast.success('PDF downloaded.');
  };

  // ── loading / empty states ─────────────────────────────────────────────────
  if (loading) return <div style={{ padding: 40 }}><Loader label="Loading timetable data…" /></div>;

  if (!data?.hasTimetable) {
    return (
      <div>
        <PageHeader eyebrow="Downloads" title="Timetable Views"
          subtitle="Browse the live timetable department-, faculty-, room- and program-wise, then download any view as Excel or PDF." />
        <div className="card">
          <EmptyState
            icon={CalendarPlus}
            title={data?.stale ? 'Regenerate the timetable' : 'No timetable yet'}
            message={data?.stale
              ? 'The latest timetable was generated before these views existed. Generate it again to unlock the arranged views and downloads.'
              : 'Generate a clash-free weekly timetable first — then you can slice it by department, faculty, room or program and export each view.'}
            action={<button className="btn btn-primary" onClick={() => navigate('/class-timetable')}><CalendarPlus size={16} /> Open Timetable</button>}
          />
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Downloads"
        title="Timetable Views"
        subtitle={`Live ${level === 'pg' ? 'MS' : 'BS'} timetable · ${sessions.length} sessions · generated ${new Date(data.generatedAt).toLocaleString()}`}
        actions={
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {/* BS (undergrad) vs MS (postgrad) — both timetables coexist */}
            <div style={{ display: 'inline-flex', border: '1px solid var(--border, rgba(0,0,0,.15))', borderRadius: 10, overflow: 'hidden' }}>
              {[['ug', 'BS'], ['pg', 'MS']].map(([v, lbl]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setLevel(v)}
                  className={`btn btn-sm ${level === v ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ borderRadius: 0, minWidth: 54 }}
                >
                  {lbl}
                </button>
              ))}
            </div>
            <button className="btn btn-ghost" onClick={() => load(level)}><RefreshCw size={15} /> Refresh</button>
          </div>
        }
      />

      {data.levelMatched === false && (
        <div className="card" style={{ padding: '12px 16px', marginBottom: 14, borderLeft: '3px solid var(--warning, #d97706)' }}>
          No {level === 'pg' ? 'MS' : 'BS'} timetable has been generated yet — showing the latest {data.level === 'pg' ? 'MS' : 'BS'} timetable instead.
          Generate the {level === 'pg' ? 'MS (Sat/Sun)' : 'undergraduate'} timetable to see it here.
        </div>
      )}

      {/* View tabs */}
      <div className="vw-tabs">
        {VIEWS.map((v) => {
          const Icon = v.icon;
          return (
            <button key={v.key} className={`vw-tab ${view === v.key ? 'active' : ''}`} onClick={() => setView(v.key)}>
              <Icon size={15} /> {v.label}
            </button>
          );
        })}
      </div>

      {view === 'utilization' ? (
        <UtilizationView sessions={sessions} meta={meta} who={who} />
      ) : view === 'master' ? (
        <MasterDataView sessions={sessions} meta={meta} who={who} />
      ) : (
        <>
          {/* Filter + export bar */}
          <div className="vw-toolbar card">
            <div className="vw-search">
              <Search size={15} />
              <input placeholder="Search code, course, faculty, room…" value={q} onChange={(e) => setQ(e.target.value)} />
              {q && <button className="vw-clear-x" onClick={() => setQ('')}><X size={13} /></button>}
            </div>
            <div className="vw-filters" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <FancySelect value={fProgram} onChange={setFProgram} options={uniqSorted(sessions.map((s) => s.program))} allLabel="All programs" width={190} />
              <FancySelect value={fTeacher} onChange={setFTeacher} options={uniqSorted(sessions.map((s) => s.teacher))} allLabel="All faculty" width={170} />
              <FancySelect value={fRoom} onChange={setFRoom} options={uniqSorted(sessions.map((s) => s.room))} allLabel="All rooms" width={140} />
              <FancySelect value={fDay} onChange={setFDay} options={meta.days || []} allLabel="All days" width={130} />
              <FancySelect value={fType} onChange={setFType} options={['Lecture', 'Lab']} allLabel="All types" width={130} />
              {anyFilter && <button className="btn btn-ghost btn-sm" onClick={clearFilters}><X size={13} /> Clear</button>}
            </div>
            <div className="vw-exports">
              <span className="vw-count">{sorted.length} row{sorted.length !== 1 ? 's' : ''}</span>
              <button className="btn btn-soft btn-sm" onClick={exportRowsExcel}><FileSpreadsheet size={15} /> Excel</button>
              <button className="btn btn-soft btn-sm" onClick={exportRowsPDF}><FileText size={15} /> PDF</button>
            </div>
          </div>

          {/* Grouped table */}
          <div className="card vw-tablecard">
            <div className="vw-tablewrap">
              <table className="vw-table">
                <thead>
                  <tr>
                    {COLS.map((c) => (
                      <th key={c.key} onClick={() => toggleSort(c.key)} className="vw-th">
                        <span>{c.label}</span>
                        {sortKey === c.key ? (sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ArrowUpDown size={11} className="vw-th-idle" />}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.length === 0 && (
                    <tr><td colSpan={COLS.length} className="vw-empty">No sessions match these filters.</td></tr>
                  )}
                  {groups.map(([name, rows]) => (
                    <GroupBlock key={name} name={name} label={activeView.groupLabel} rows={rows} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* A group header row followed by its sessions. */
function GroupBlock({ name, label, rows }) {
  const totalEnr = rows.reduce((a, r) => a + (Number(r.enrolled) || 0), 0);
  return (
    <>
      <tr className="vw-grouprow">
        <td colSpan={COLS.length}>
          <span className="vw-groupname">{name}</span>
          <span className="vw-groupmeta">{rows.length} session{rows.length !== 1 ? 's' : ''} · {totalEnr} seats</span>
        </td>
      </tr>
      {rows.map((s, i) => (
        <tr key={`${s.code}-${s.day}-${s.slot}-${s.room}-${i}`}>
          <td className="vw-code">{s.code}</td>
          <td className="vw-name" title={s.name}>{s.name}</td>
          <td>{s.section || '—'}</td>
          <td className="vw-muted">{s.program}</td>
          <td>{s.teacher}</td>
          <td>{s.room}</td>
          <td><span className={`vw-pill ${s.component === 'Lab' ? 'lab' : 'lec'}`}>{s.component}</span></td>
          <td>{s.day}</td>
          <td className="vw-mono">{s.slot}</td>
          <td className="vw-num">{s.enrolled || '—'}</td>
          <td className="vw-num vw-muted">{s.cap || '—'}</td>
        </tr>
      ))}
    </>
  );
}

/* ── Room utilization: per-slot classes + utilization %, per day ──
   For each day, each teaching slot shows how many classes run during it
   (a lab spanning several slots counts in each), the utilization % of the
   available venues (rooms + labs), the lunch break at 0, and a per-day total. */
const CANON_SLOTS = [
  { label: '08:30 – 10:00', start: '08:30', end: '10:00', teaching: true },
  { label: '10:00 – 11:30', start: '10:00', end: '11:30', teaching: true },
  { label: '11:30 – 01:00', start: '11:30', end: '01:00', teaching: true },
  { label: '01:00 – 02:00  (Lunch)', start: '01:00', end: '02:00', teaching: false, lunch: true },
  { label: '02:00 – 03:30', start: '02:00', end: '03:30', teaching: true },
  { label: '03:30 – 05:00', start: '03:30', end: '05:00', teaching: true },
];
const toMin = (t) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); if (!m) return null;
  let h = +m[1]; if (h < 8) h += 12; return h * 60 + +m[2];
};
const parseRange = (slot) => {
  const p = String(slot || '').split('-'); return [toMin(p[0]), toMin(p[1])];
};

// Each class belongs to EXACTLY ONE column — its own slot — exactly like the
// timetable grid. A 2-hour theory class maps to the 1.5-hour column it starts
// in (as the timetable shows it with a "(2 Hrs)" note); a lab stays in its own
// lab slot. This is why a class is NEVER shown in two overlapping slots — the
// three morning lab slots are alternative start times, not parallel periods.
const TWO_HR_COL = {
  '08:30-10:30': '08:30-10:00', '10:00-12:00': '10:00-11:30',
  '02:00-04:00': '02:00-03:30', '03:00-05:00': '03:30-05:00',
};
const theoryColumn = (slot) => TWO_HR_COL[slot] || slot;

function UtilizationView({ sessions, meta, who }) {
  const toast = useToast();
  const days = meta.days || [];
  const theorySlots = (meta.theorySlots && meta.theorySlots.length) ? meta.theorySlots
    : ['08:30-10:00', '10:00-11:30', '11:30-01:00', '02:00-03:30', '03:30-05:00'];
  const labSlots = (meta.labSlots && meta.labSlots.length) ? meta.labSlots
    : ['08:30-11:30', '09:00-12:00', '10:00-01:00', '02:00-05:00'];
  const roomSet = useMemo(() => new Set(meta.allRooms || []), [meta]);
  const labSet = useMemo(() => new Set(meta.labs || []), [meta]);
  const nRooms = (meta.allRooms || []).length || new Set(sessions.filter((s) => (s.component !== 'Lab')).map((s) => s.room)).size;
  const nLabs = (meta.labs || []).length || new Set(sessions.filter((s) => (s.component === 'Lab')).map((s) => s.room)).size;

  const isLab = (s) => labSet.has(s.room) || (!roomSet.has(s.room) && s.component === 'Lab');

  // Build, per day: a rooms matrix (theory slots) and a labs matrix (lab slots),
  // each with per-entity totals and a per-slot "rooms/labs used (util%)" row.
  const data = useMemo(() => {
    // isLabKind: labs stay in their own slot; rooms map 2-hour → start column.
    const build = (entitySessions, slots, totalCount, entityLabel, isLabKind) => {
      const colOf = (s) => (isLabKind ? s.slot : theoryColumn(s.slot));
      const cap = isLabKind ? 2 : slots.length;   // max classes/day (labs: AM + PM)
      const names = [...new Set(entitySessions.map((s) => s.room))].sort((a, b) => a.localeCompare(b));
      const rows = names.map((name) => {
        const own = entitySessions.filter((s) => s.room === name);
        const cells = slots.map((sl) => own.filter((s) => colOf(s) === sl).length);
        return { name, cells, total: own.length, util: Math.min(100, Math.round((own.length / cap) * 100)) };
      });
      const slotBusy = slots.map((_, i) => rows.filter((r) => r.cells[i] > 0).length);
      const slotUtil = slots.map((_, i) => (totalCount ? Math.round((slotBusy[i] / totalCount) * 100) : 0));
      const totalClasses = entitySessions.length;
      const overall = totalCount ? Math.min(100, Math.round((totalClasses / (totalCount * cap)) * 100)) : 0;
      return { entityLabel, slots, rows, slotBusy, slotUtil, overall, totalCount, totalClasses };
    };
    return days.map((day) => {
      const dayS = sessions.filter((s) => s.day === day);
      const rooms = build(dayS.filter((s) => !isLab(s)), theorySlots, nRooms, 'Room', false);
      const labs = build(dayS.filter((s) => isLab(s)), labSlots, nLabs, 'Lab', true);
      return { day, rooms, labs };
    });
  }, [sessions, days]); // eslint-disable-line

  // Turn a built matrix into export columns+rows (with a totals row).
  const toBlock = (title, m) => {
    const columns = [{ key: 'name', label: m.entityLabel }, ...m.slots.map((sl, i) => ({ key: `s${i}`, label: sl })),
      { key: 'total', label: 'Total' }, { key: 'util', label: 'Util %' }];
    const rows = m.rows.map((r) => {
      const o = { name: r.name, total: r.total, util: `${r.util}%` };
      m.slots.forEach((sl, i) => { o[`s${i}`] = r.cells[i] || ''; });
      return o;
    });
    const tot = { name: `Time-slot total (used / ${m.totalCount})`, total: '', util: `${m.overall}%` };
    m.slots.forEach((sl, i) => { tot[`s${i}`] = `${m.slotBusy[i]} · ${m.slotUtil[i]}%`; });
    rows.push(tot);
    return { title, columns, rows };
  };

  const excel = () => {
    // All days in ONE sheet, stacked, so the whole week is visible together —
    // plus one tab per day for convenience.
    const allBlocks = [];
    for (const d of data) {
      allBlocks.push(toBlock(`${d.day} — ROOMS (${d.rooms.overall}% used)`, d.rooms));
      allBlocks.push(toBlock(`${d.day} — LABS (${d.labs.overall}% used)`, d.labs));
    }
    const sheets = [{ name: 'All Days', blocks: allBlocks }];
    for (const d of data) sheets.push({
      name: d.day,
      blocks: [toBlock(`${d.day} — Rooms (${d.rooms.overall}% used)`, d.rooms),
        toBlock(`${d.day} — Labs (${d.labs.overall}% used)`, d.labs)],
    });
    exportExcel(sheets, 'Room_Lab_Utilization', { admin: who, heading: 'Room/Lab Utilization Breakdown' });
    toast.success('Excel downloaded — all days (one sheet + a tab per day).');
  };
  const pdf = () => {
    const sections = [];
    for (const d of data) { sections.push(toBlock(`${d.day} — Rooms`, d.rooms)); sections.push(toBlock(`${d.day} — Labs`, d.labs)); }
    exportPDF({ heading: 'Room/Lab Utilization Breakdown', admin: who, sections, filename: 'Room_Lab_Utilization' });
    toast.success('PDF downloaded.');
  };

  const overall = data.length ? Math.round(data.reduce((a, d) => a + d.rooms.overall, 0) / data.length) : 0;

  const Matrix = ({ m }) => (
    <div className="vw-tablewrap vw-util-mtxwrap">
      <table className="vw-table vw-matrix vw-util-mtx">
        <thead>
          <tr>
            <th className="vw-sticky-l">{m.entityLabel}</th>
            {m.slots.map((sl) => <th key={sl} className="vw-mono vw-slothead">{sl}</th>)}
            <th>Total</th><th>Util</th>
          </tr>
        </thead>
        <tbody>
          {m.rows.length === 0 && <tr><td colSpan={m.slots.length + 3} className="vw-empty">No classes.</td></tr>}
          {m.rows.map((r) => (
            <tr key={r.name}>
              <td className="vw-sticky-l vw-code">{r.name}</td>
              {r.cells.map((n, i) => <td key={i} className={`vw-cell ${n ? 'busy' : ''}`}>{n || ''}</td>)}
              <td className="vw-num"><b>{r.total}</b></td>
              <td className="vw-num">{r.util}%</td>
            </tr>
          ))}
          <tr className="vw-util-sum">
            <td className="vw-sticky-l">Time-slot total</td>
            {m.slots.map((sl, i) => <td key={sl}><b>{m.slotBusy[i]}</b><span className="vw-muted"> · {m.slotUtil[i]}%</span></td>)}
            <td></td><td className="vw-num"><b>{m.overall}%</b></td>
          </tr>
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <div className="vw-toolbar card">
        <div className="vw-util-stats">
          <div><b>{nRooms}</b> rooms · <b>{nLabs}</b> labs</div>
          <div><b>{overall}%</b> avg room utilization</div>
          <div className="vw-muted" style={{ fontSize: 12 }}>Rooms use theory slots · labs use lab slots · a class spanning slots counts in each</div>
        </div>
        <div className="vw-exports">
          <button className="btn btn-soft btn-sm" onClick={excel}><FileSpreadsheet size={15} /> Excel</button>
          <button className="btn btn-soft btn-sm" onClick={pdf}><FileText size={15} /> PDF</button>
        </div>
      </div>

      {data.map((d) => (
        <div key={d.day} className="card vw-util-daycard">
          <div className="vw-util-daytitle">
            <span>{d.day}</span>
            <span className="vw-util-daypill">Rooms {d.rooms.overall}% · Labs {d.labs.overall}%</span>
          </div>
          <div className="vw-util-sec">Rooms</div>
          <Matrix m={d.rooms} />
          <div className="vw-util-sec">Labs</div>
          <Matrix m={d.labs} />
        </div>
      ))}
    </>
  );
}

/* ── Master data: course / department / faculty / room lists ── */
function MasterDataView({ sessions, meta, who }) {
  const toast = useToast();

  const lists = useMemo(() => {
    const courses = new Map(); const depts = new Map(); const faculty = new Map(); const rooms = new Map();
    for (const s of sessions) {
      // courses (by code)
      if (!courses.has(s.code)) courses.set(s.code, { code: s.code, name: s.name, program: s.program, sections: new Set(), teachers: new Set(), sessions: 0 });
      const c = courses.get(s.code); c.sections.add(s.section || 'A'); if (s.teacher) c.teachers.add(s.teacher); c.sessions += 1;
      // departments (by program)
      if (!depts.has(s.program)) depts.set(s.program, { program: s.program, courses: new Set(), faculty: new Set(), sessions: 0 });
      const d = depts.get(s.program); d.courses.add(s.code); if (s.teacher) d.faculty.add(s.teacher); d.sessions += 1;
      // faculty (by teacher)
      if (s.teacher) {
        if (!faculty.has(s.teacher)) faculty.set(s.teacher, { teacher: s.teacher, courses: new Set(), programs: new Set(), sessions: 0 });
        const f = faculty.get(s.teacher); f.courses.add(s.code); f.programs.add(s.program); f.sessions += 1;
      }
      // rooms
      if (!rooms.has(s.room)) rooms.set(s.room, { room: s.room, cap: meta.roomCaps?.[s.room] || '', sessions: 0 });
      rooms.get(s.room).sessions += 1;
    }
    return {
      courses: [...courses.values()].map((c) => ({ code: c.code, name: c.name, program: c.program, sections: c.sections.size, faculty: [...c.teachers].join(', ') || 'TBA', sessions: c.sessions })).sort((a, b) => a.code.localeCompare(b.code)),
      depts: [...depts.values()].map((d) => ({ program: d.program, courses: d.courses.size, faculty: d.faculty.size, sessions: d.sessions })).sort((a, b) => a.program.localeCompare(b.program)),
      faculty: [...faculty.values()].map((f) => ({ teacher: f.teacher, courses: f.courses.size, programs: f.programs.size, sessions: f.sessions })).sort((a, b) => b.sessions - a.sessions),
      rooms: [...rooms.values()].map((r) => ({ room: r.room, cap: r.cap, sessions: r.sessions })).sort((a, b) => b.sessions - a.sessions),
    };
  }, [sessions, meta]);

  const CARDS = [
    { key: 'courses', title: 'Course List', icon: GraduationCap, rows: lists.courses,
      columns: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Course' }, { key: 'program', label: 'Program' }, { key: 'sections', label: 'Sections' }, { key: 'faculty', label: 'Faculty' }, { key: 'sessions', label: 'Sessions' }] },
    { key: 'depts', title: 'Department / Program List', icon: Database, rows: lists.depts,
      columns: [{ key: 'program', label: 'Program' }, { key: 'courses', label: 'Courses' }, { key: 'faculty', label: 'Faculty' }, { key: 'sessions', label: 'Sessions' }] },
    { key: 'faculty', title: 'Faculty List', icon: Users, rows: lists.faculty,
      columns: [{ key: 'teacher', label: 'Faculty' }, { key: 'courses', label: 'Courses' }, { key: 'programs', label: 'Programs' }, { key: 'sessions', label: 'Sessions / week' }] },
    { key: 'rooms', title: 'Room & Lab List', icon: DoorOpen, rows: lists.rooms,
      columns: [{ key: 'room', label: 'Room / Lab' }, { key: 'cap', label: 'Capacity' }, { key: 'sessions', label: 'Sessions / week' }] },
  ];

  const excelOne = (c) => { exportExcel([{ name: c.title, columns: c.columns, rows: c.rows }], c.title.replace(/[^a-z0-9]+/gi, '_'), { admin: who, heading: c.title }); toast.success('Excel downloaded.'); };
  const pdfOne = (c) => { exportPDF({ heading: c.title, admin: who, columns: c.columns, rows: c.rows, filename: c.title.replace(/[^a-z0-9]+/gi, '_') }); toast.success('PDF downloaded.'); };
  const excelAll = () => { exportExcel(CARDS.map((c) => ({ name: c.title, columns: c.columns, rows: c.rows })), 'Master_Data', { admin: who, heading: 'Master Data' }); toast.success('Master data (Excel) downloaded.'); };

  return (
    <>
      <div className="vw-toolbar card">
        <div className="vw-util-stats">
          <div><b>{lists.courses.length}</b> courses</div>
          <div><b>{lists.depts.length}</b> programs</div>
          <div><b>{lists.faculty.length}</b> faculty</div>
          <div><b>{lists.rooms.length}</b> rooms/labs</div>
        </div>
        <div className="vw-exports">
          <button className="btn btn-primary btn-sm" onClick={excelAll}><Database size={15} /> Download all (Excel)</button>
        </div>
      </div>
      <div className="vw-master-grid">
        {CARDS.map((c) => {
          const Icon = c.icon;
          return (
            <motion.div key={c.key} className="card vw-master-card" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
              <div className="vw-master-head">
                <div className="vw-master-title"><Icon size={17} /> {c.title}<span className="vw-master-count">{c.rows.length}</span></div>
                <div className="vw-exports">
                  <button className="vw-icnbtn" title="Excel" onClick={() => excelOne(c)}><FileSpreadsheet size={15} /></button>
                  <button className="vw-icnbtn" title="PDF" onClick={() => pdfOne(c)}><FileText size={15} /></button>
                </div>
              </div>
              <div className="vw-tablewrap vw-master-tw">
                <table className="vw-table">
                  <thead><tr>{c.columns.map((col) => <th key={col.key}>{col.label}</th>)}</tr></thead>
                  <tbody>
                    {c.rows.slice(0, 60).map((r, i) => (
                      <tr key={i}>{c.columns.map((col) => <td key={col.key} className={col.key === 'code' || col.key === 'room' ? 'vw-code' : ''}>{r[col.key]}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
                {c.rows.length > 60 && <div className="vw-more">+ {c.rows.length - 60} more — download to see all</div>}
              </div>
            </motion.div>
          );
        })}
      </div>
    </>
  );
}
