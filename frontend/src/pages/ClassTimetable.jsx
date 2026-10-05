import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  CalendarRange, Play, Loader2, CheckCircle2, AlertCircle, Download, RefreshCw,
  Search, Users, GraduationCap, DoorOpen, BookOpen, Radio, UploadCloud, Settings,
} from 'lucide-react';
import api, { errMsg } from '../api/client';
import { downloadFile } from '../api/download';
import { useToast } from '../context/ToastContext';
import { PageHeader, EmptyState } from '../components/ui';
import FancySelect from '../components/FancySelect';

const VIEWS = [
  { k: 'class', label: 'Class group', icon: Users, field: 'classes' },
  { k: 'teacher', label: 'Teacher', icon: GraduationCap, field: 'teachers' },
  { k: 'room', label: 'Room', icon: DoorOpen, field: 'rooms' },
  { k: 'course', label: 'Course', icon: BookOpen, field: 'courses' },
];
const JS_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DSHORT = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun' };
const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); if (!m) return null; let h = +m[1]; if (h < 8) h += 12; return h * 60 + +m[2]; };

export default function ClassTimetable() {
  const toast = useToast();
  const [level, setLevel] = useState('BS');
  const [tab, setTab] = useState('view');   // view | admin

  return (
    <div>
      <PageHeader eyebrow="Scheduling" title="Class Timetable" icon={CalendarRange}
        subtitle="CP-SAT generated weekly timetable — BS (Mon–Fri) and MS (Sat–Sun), straight from the database." />

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
        {/* BS / MS switch */}
        <div className="seg" style={{ display: 'inline-flex', gap: 4, background: 'var(--surface-2,#eef2f0)', padding: 4, borderRadius: 12 }}>
          {['BS', 'MS'].map((l) => (
            <button key={l} className={level === l ? 'btn btn-primary' : 'btn btn-ghost'} style={{ borderRadius: 9, minWidth: 64 }} onClick={() => setLevel(l)}>{l}</button>
          ))}
        </div>
        <div className="seg" style={{ display: 'inline-flex', gap: 4, background: 'var(--surface-2,#eef2f0)', padding: 4, borderRadius: 12, marginLeft: 'auto' }}>
          <button className={tab === 'view' ? 'btn btn-primary' : 'btn btn-ghost'} style={{ borderRadius: 9 }} onClick={() => setTab('view')}><CalendarRange size={15} /> View</button>
          <button className={tab === 'admin' ? 'btn btn-primary' : 'btn btn-ghost'} style={{ borderRadius: 9 }} onClick={() => setTab('admin')}><Settings size={15} /> Generate &amp; Publish</button>
        </div>
      </div>

      {tab === 'view' ? <ViewTab level={level} toast={toast} /> : <AdminTab toast={toast} onPublished={() => setTab('view')} />}
    </div>
  );
}

/* ── View: BS/MS timetable by class/teacher/room/course ─────────────────────── */
function ViewTab({ level, toast }) {
  const [view, setView] = useState('class');
  const [filters, setFilters] = useState({});
  const [key, setKey] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadFilters = useCallback(async () => {
    try { const r = await api.get('/timetable/filters', { params: { level } }); setFilters(r.data); } catch { setFilters({}); }
  }, [level]);
  const load = useCallback(async () => {
    setLoading(true);
    try { const r = await api.get('/timetable', { params: { level, view, key } }); setData(r.data); }
    catch (err) { toast.error(errMsg(err, 'Could not load the timetable.')); } finally { setLoading(false); }
  }, [level, view, key]); // eslint-disable-line
  useEffect(() => { loadFilters(); setKey(''); }, [level, loadFilters]);
  useEffect(() => { load(); }, [load]);

  const cur = VIEWS.find((v) => v.k === view);
  const options = filters[cur.field] || [];

  if (loading && !data) return <Loading />;
  if (!data || !data.hasTimetable) {
    return <div className="card"><EmptyState icon={CalendarRange} title="No published timetable yet" message="Generate and publish a timetable from the Generate & Publish tab." /></div>;
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <MetricsStrip metrics={data.metrics} />

      <div className="card" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="seg" style={{ display: 'inline-flex', gap: 4, background: 'var(--surface-2,#eef2f0)', padding: 4, borderRadius: 12, flexWrap: 'wrap' }}>
          {VIEWS.map((v) => (
            <button key={v.k} className={view === v.k ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm'} style={{ borderRadius: 9 }} onClick={() => { setView(v.k); setKey(''); }}><v.icon size={14} /> {v.label}</button>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 240 }}>
          <FancySelect value={key} onChange={setKey} options={options} allLabel={`All ${cur.label.toLowerCase()}s`} placeholder={`Select a ${cur.label.toLowerCase()}…`} width="100%" />
        </div>
        <button className="btn btn-ghost btn-sm" onClick={load}><RefreshCw size={14} /></button>
      </div>

      <TimetableGrid level={level} days={data.days} slots={data.slots} breakAfter={data.breakAfterSlot} entries={data.entries} />

      {data.runId && (
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => downloadFile(`/timetable/runs/${data.runId}/export.pdf`, 'timetable.pdf')}><Download size={13} /> PDF</button>
          <button className="btn btn-ghost btn-sm" onClick={() => downloadFile(`/timetable/runs/${data.runId}/export.xlsx`, 'timetable.xlsx')}><Download size={13} /> Excel</button>
        </div>
      )}
    </div>
  );
}

/* ── weekly grid — official AUIC house style (day rows × slot columns) ───────── */
const DEPT_PALETTE = ['#1F3A93', '#1E7145', '#C0392B', '#7D3C98', '#B9770E', '#0E6655', '#A93226', '#2874A6', '#BA4A00', '#6C3483', '#117A65', '#884EA0', '#1A5276'];
const deptColor = (code) => { const m = /^[A-Za-z]+/.exec(String(code) || ''); const d = (m ? m[0] : 'X').toUpperCase(); let s = 0; for (const c of d) s += c.charCodeAt(0); return DEPT_PALETTE[s % DEPT_PALETTE.length]; };

function displayCols(slots, breakAfter) {
  const cols = [];
  slots.forEach((s, i) => { cols.push({ kind: 'slot', label: s, si: i }); if (breakAfter != null && breakAfter >= 0 && i === breakAfter) cols.push({ kind: 'break', label: 'Break' }); });
  return cols;
}

function TimetableGrid({ level, days, slots, breakAfter, entries }) {
  const now = new Date();
  const todayShort = DSHORT[JS_DAYS[now.getDay()]];
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const cell = {};
  for (const e of entries) { (cell[`${e.day}|${e.slotIndex}`] = cell[`${e.day}|${e.slotIndex}`] || []).push(e); }
  const isLiveSlot = (day, slotTime) => {
    if (day !== todayShort) return false;
    const [a, b] = String(slotTime).split('-'); const s = toMin(a), en = toMin(b);
    return s != null && en != null && nowMin >= s && nowMin < en;
  };
  const cols = displayCols(slots, breakAfter);

  return (
    <div style={{ border: '2px solid #E69138', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
      {/* cream header band */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: '#FFF1CC', borderBottom: '2px solid #E69138' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 800, fontSize: 15, color: '#12261C', letterSpacing: '.01em' }}>ABASYN UNIVERSITY, ISLAMABAD CAMPUS</div>
          <div style={{ fontWeight: 800, fontSize: 14, color: '#7B1113' }}>{level} TIMETABLE</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#C0392B', marginTop: 2 }}>Labs are currently unavailable</div>
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5, minWidth: 820 }}>
          <thead>
            <tr>
              <th style={hStyle(56)}></th>
              {cols.map((c, i) => (
                <th key={i} style={{ ...hStyle(c.kind === 'break' ? 60 : undefined), background: c.kind === 'break' ? '#C9C9C9' : '#DAFAD8', color: '#12261C' }}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d}>
                <td style={{ ...cStyle, fontWeight: 800, fontSize: 13, textAlign: 'center', background: '#DAFAD8', whiteSpace: 'nowrap' }}>{d}</td>
                {cols.map((c, i) => {
                  if (c.kind === 'break') return <td key={i} style={{ ...cStyle, background: '#C9C9C9', textAlign: 'center', fontSize: 10, fontWeight: 700, color: '#555' }}>Prayer &amp; Lunch Break</td>;
                  const list = cell[`${d}|${c.si}`] || [];
                  const live = isLiveSlot(d, c.label);
                  return (
                    <td key={i} style={{ ...cStyle, verticalAlign: 'middle', textAlign: 'center', background: live ? 'rgba(25,135,84,.10)' : '#fff' }}>
                      {list.map((e, j) => <ClassLine key={j} e={e} live={live} />)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
function ClassLine({ e, live }) {
  const over = e.students > e.roomCapacity;
  const col = deptColor(e.courseCode);
  return (
    <div style={{ fontSize: 11, lineHeight: 1.5, color: col, fontWeight: 600 }}>
      {e.courseCode}{e.section ? ` (${e.section})` : ''}-{e.courseTitle}-{e.teacher} [{e.room}]{e.tag ? ` ${e.tag}` : ''}
      {over && <span title="over room capacity" style={{ color: '#B45F06' }}> ⚠</span>}
      {live && <span style={{ marginLeft: 4, fontSize: 8.5, fontWeight: 800, color: '#fff', background: '#198754', borderRadius: 3, padding: '0 3px' }}>LIVE</span>}
    </div>
  );
}

function MetricsStrip({ metrics: m }) {
  if (!m) return null;
  const clashes = (m.room_double_booked || 0) + (m.teacher_clash || 0) + (m.student_clash || 0);
  const tile = (label, value, tone) => (
    <div style={{ flex: 1, minWidth: 130, padding: '10px 14px', borderRadius: 10, background: 'var(--surface,#fff)', border: '1px solid var(--border)' }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: tone || 'var(--ink-700)' }}>{value}</div>
      <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{label}</div>
    </div>
  );
  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      {tile('Clashes (room/teacher/student)', clashes, clashes ? '#c53030' : '#2f855a')}
      {tile('Room utilisation', (m.room_utilisation_pct != null ? m.room_utilisation_pct + '%' : '—'))}
      {tile('Sessions over capacity', m.sessions_over_room_capacity || 0, (m.sessions_over_room_capacity ? '#b7791f' : '#2f855a'))}
      {tile('Sections / Sessions', `${m.sections || 0} / ${m.sessions || 0}`)}
    </div>
  );
}

/* ── Admin: generate + live log + publish ───────────────────────────────────── */
function AdminTab({ toast, onPublished }) {
  const [runs, setRuns] = useState([]);
  const [active, setActive] = useState(null);   // polled run
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(null);

  const loadRuns = useCallback(async () => {
    try { const r = await api.get('/timetable/runs'); setRuns(r.data.items || []); } catch (err) { toast.error(errMsg(err)); }
  }, []); // eslint-disable-line
  useEffect(() => { loadRuns(); return () => clearInterval(pollRef.current); }, [loadRuns]);

  const poll = (id) => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const r = await api.get(`/timetable/runs/${id}`);
        setActive(r.data.run);
        if (['done', 'failed'].includes(r.data.run.status)) { clearInterval(pollRef.current); loadRuns(); }
      } catch { clearInterval(pollRef.current); }
    }, 2000);
  };

  const generate = async () => {
    setBusy(true);
    try {
      const r = await api.post('/timetable/runs', {});
      toast.success('Timetable generation started — solving BS & MS…');
      setActive({ _id: r.data.runId, status: 'queued', summary: r.data.summary, log: '' });
      poll(r.data.runId);
    } catch (err) {
      if (err?.response?.status === 409) toast.error('A run is already in progress.');
      else toast.error(errMsg(err, 'Could not start the run.'));
    } finally { setBusy(false); }
  };
  const publish = async (id) => {
    try { await api.post(`/timetable/runs/${id}/publish`); toast.success('Published — this is now the live timetable.'); loadRuns(); onPublished && onPublished(); }
    catch (err) { toast.error(errMsg(err, 'Could not publish.')); }
  };

  const a = active;
  const running = a && ['queued', 'running'].includes(a.status);

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <UploadCloud size={18} style={{ color: 'var(--brand-600)' }} />
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>Generate from the database</h3>
            <p style={{ margin: '3px 0 0', fontSize: 12.5, color: 'var(--text-faint)' }}>Rooms, courses and student registrations are read live from the DB — no upload. BS &amp; MS solve together.</p>
          </div>
          <button className="btn btn-primary" disabled={busy || running} onClick={generate}>
            {running ? <Loader2 size={15} className="spin" /> : <Play size={15} />} {running ? 'Running…' : 'Generate Timetable'}
          </button>
        </div>

        {a && (
          <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <StatusBadge status={a.status} />
              {a.summary && <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{a.summary.courses} courses · {a.summary.sections} sections · {a.summary.students} students</span>}
            </div>
            {a.error && <div style={{ color: '#c53030', fontSize: 12.5, marginBottom: 8 }}><AlertCircle size={14} /> {a.error}</div>}
            {a.log && <pre style={{ maxHeight: 220, overflow: 'auto', background: '#0f1a14', color: '#c8f0d6', fontSize: 11.5, padding: 12, borderRadius: 8, whiteSpace: 'pre-wrap', margin: 0 }}>{a.log.slice(-4000)}</pre>}
            {a.status === 'done' && a.metrics && (
              <div style={{ marginTop: 12 }}>
                {['BS', 'MS'].map((lvl) => a.metrics[lvl] && (
                  <div key={lvl} style={{ fontSize: 12.5, marginBottom: 4 }}>
                    <b>{lvl}</b>: {a.metrics[lvl].sessions} sessions · clashes {(a.metrics[lvl].room_double_booked || 0) + (a.metrics[lvl].teacher_clash || 0) + (a.metrics[lvl].student_clash || 0)} · util {a.metrics[lvl].room_utilisation_pct}% · over-cap {a.metrics[lvl].sessions_over_room_capacity}
                  </div>
                ))}
                {a.metrics.verify && <pre style={{ fontSize: 11, color: 'var(--text-faint)', whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{a.metrics.verify}</pre>}
                <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                  <button className="btn btn-primary btn-sm" onClick={() => publish(a._id)}><CheckCircle2 size={14} /> Publish this run</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => downloadFile(`/timetable/runs/${a._id}/export.pdf`, 'timetable.pdf')}><Download size={14} /> PDF</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => downloadFile(`/timetable/runs/${a._id}/export.xlsx`, 'timetable.xlsx')}><Download size={14} /> Excel</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '13px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 9 }}>
          <RefreshCw size={16} style={{ color: 'var(--brand-600)' }} />
          <h3 style={{ margin: 0, fontSize: 14 }}>Recent runs</h3>
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={loadRuns}><RefreshCw size={13} /></button>
        </div>
        {runs.length === 0 ? <EmptyState icon={CalendarRange} title="No runs yet" message="Generate a timetable above." /> : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr>{['When', 'Status', 'BS', 'MS', 'Published', ''].map((h) => <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase' }}>{h}</th>)}</tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r._id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>{new Date(r.createdAt).toLocaleString()}</td>
                  <td style={{ padding: '8px 12px' }}><StatusBadge status={r.status} /></td>
                  <td style={{ padding: '8px 12px' }}>{r.summary?.BS ?? '—'}</td>
                  <td style={{ padding: '8px 12px' }}>{r.summary?.MS ?? '—'}</td>
                  <td style={{ padding: '8px 12px' }}>{r.published ? <span style={{ color: '#2f855a', fontWeight: 700 }}>● live</span> : ''}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                    {r.status === 'done' && !r.published && <button className="btn btn-ghost btn-sm" onClick={() => publish(r._id)}>Publish</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
function StatusBadge({ status }) {
  const map = { queued: { c: '#2b6cb0', b: '#e6f0fb', t: 'Queued' }, running: { c: '#b7791f', b: '#fdf6e3', t: 'Running' }, done: { c: '#2f855a', b: '#e7f5ec', t: 'Done' }, failed: { c: '#c53030', b: '#fdeaea', t: 'Failed' } };
  const s = map[status] || map.queued;
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: s.c, background: s.b, borderRadius: 999, padding: '3px 10px' }}>{status === 'running' && <Loader2 size={12} className="spin" />}{s.t}</span>;
}

const hStyle = (w) => ({ background: '#DAFAD8', color: '#12261C', textAlign: 'center', padding: '8px 10px', fontSize: 11.5, fontWeight: 700, width: w, border: '1px solid #D9C9A0' });
const cStyle = { padding: '6px 8px', border: '1px solid #E9DDBF', verticalAlign: 'middle' };
function Loading() { return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-faint)' }}><Loader2 size={22} className="spin" /> Loading…</div>; }
