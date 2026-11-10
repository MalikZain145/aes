import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  UserCheck, RefreshCw, FileText, DoorOpen, ChevronRight, Users, CheckCircle2, XCircle, Clock, Radio,
  Lock, Download, Eye, X, CalendarDays, UserPlus, FileSpreadsheet, Trash2, ChevronDown, UserX, Upload,
} from 'lucide-react';
import api, { errMsg } from '../api/client';
import { downloadFile } from '../api/download';
import { useToast } from '../context/ToastContext';
import { PageHeader, Loader, EmptyState, Modal } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import ScrollX from '../components/ScrollX';

/* Exam Attendance — every room that has a paper is a strip. Open a room to see one
   FILE per paper (course code + time). Before / during the paper each student is "-",
   a scan of the admit card turns it into "P", and when the paper's time is over the
   rest become "A" — only then can the file be downloaded. */

const STATE = {
  upcoming: { label: 'UPCOMING', bg: '#cfe2ff', fg: '#084298' },
  live: { label: 'IN PROGRESS', bg: '#fff3cd', fg: '#664d03' },
  final: { label: 'FINAL', bg: '#d1e7dd', fg: '#0f5132' },
};
const MARK = {
  P: { bg: '#d1e7dd', fg: '#0f5132' },
  A: { bg: '#f8d7da', fg: '#842029' },
  '-': { bg: 'transparent', fg: '#8a978f' },
};
const endLabel = (slot) => {
  const m = String(slot || '').split('-')[1]?.match(/(\d{1,2}):(\d{2})/);
  if (!m) return '';
  let h = Number(m[1]); if (h >= 1 && h <= 7) h += 12;
  return `${((h + 11) % 12) + 1}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
};
const shortDate = (d) => String(d || '').replace(/-20\d\d$/, '');

function Badge({ state }) {
  const s = STATE[state] || STATE.upcoming;
  return (
    <span style={{ background: s.bg, color: s.fg, fontWeight: 800, fontSize: 10.5, padding: '3px 9px', borderRadius: 999, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {state === 'live' && <Clock size={11} />}{s.label}
    </span>
  );
}
function Stat({ icon: Icon, label, value, color }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <Icon size={14} color={color} /><b style={{ color }}>{value}</b>
      <span style={{ color: 'var(--text-faint,#6c7b72)', fontSize: 12 }}>{label}</span>
    </span>
  );
}

export default function Attendance() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState({ rooms: [], dates: [], now: null });
  const [date, setDate] = useState(null);           // null = not chosen yet → today / all
  const [level, setLevel] = useState('');           // '' all · ug BS · pg MS
  const [live, setLive] = useState(true);
  const [openRoom, setOpenRoom] = useState(null);
  const [sheet, setSheet] = useState(null);         // the open paper file
  const [secFor, setSecFor] = useState(null);       // paper whose sections (A/B/C) are shown
  const [busy, setBusy] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [exporting, setExporting] = useState('');      // '' | 'absent' | 'present' | 'all'
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);   // identification-sheet Excel import
  const exportRef = useRef(null);
  const { admin } = useAuth();
  const sheetRef = useRef(null);

  const load = useCallback(async (quiet) => {
    if (!quiet) setLoading(true);
    try {
      const res = await api.get('/attendance/rooms', { params: { date: date || 'all', ...(level ? { level } : {}) } });
      setData(res.data);
      if (date === null) {
        const today = res.data.now?.date;
        if ((res.data.dates || []).some((d) => d.date === today)) setDate(today);
        else setDate('all');
      }
    } catch (err) {
      if (!quiet) toast.error(errMsg(err, 'Could not load exam attendance.'));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [date, level, toast]);

  useEffect(() => { load(); }, [load]);

  const openSheet = useCallback(async (room, p, quiet, section) => {
    const sec = section === undefined ? (p.section ?? null) : section;
    if (!quiet) setBusy(`v-${room}-${p.code}-${p.date}-${p.slot}-${sec ?? ''}`);
    try {
      const r = await api.get('/attendance/paper', { params: { date: p.date, slot: p.slot, room, code: p.code, ...(sec !== null ? { section: sec } : {}), ...(level ? { level } : {}) } });
      setSheet(r.data);
      if (!quiet) setTimeout(() => sheetRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    } catch (err) { if (!quiet) toast.error(errMsg(err, 'Could not open the attendance file.')); }
    finally { if (!quiet) setBusy(''); }
  }, [level, toast]);

  // live: refresh the rooms + the open file every 10 s — stops for good once the
  // last paper of the exam is over (nothing can change any more except corrections)
  const examOver = !!data.examEnd?.ended;
  useEffect(() => {
    if (!live || examOver) return undefined;
    const t = setInterval(() => {
      load(true);
      if (sheet) openSheet(sheet.room, sheet, true, sheet.section ?? null);
    }, 10000);
    return () => clearInterval(t);
  }, [live, examOver, load, sheet, openSheet]);

  const download = async (room, p, section) => {
    const sec = section === undefined ? (p.section ?? null) : section;
    const q = new URLSearchParams({ date: p.date, slot: p.slot, room, code: p.code, ...(sec !== null ? { section: sec } : {}), ...(level ? { level } : {}) }).toString();
    setBusy(`d-${room}-${p.code}-${p.date}-${p.slot}-${sec ?? ''}`);
    try {
      await downloadFile(`/attendance/paper.pdf?${q}&v=${Date.now()}`, `Attendance_${p.code}${sec ? '-' + sec : ''}_${room}_${p.date}.pdf`);
    } finally { setTimeout(() => setBusy(''), 800); }
  };

  // ── corrections (only after the paper has ended) ──
  const refreshSheet = async () => { await load(true); if (sheet) await openSheet(sheet.room, sheet, true, sheet.section ?? null); };
  const toggleMark = async (x) => {
    if (!sheet || sheet.state !== 'final') return;
    const to = x.mark === 'P' ? 'A' : 'P';
    setBusy(`m-${x.studentId}`);
    try {
      await api.post('/attendance/mark', { date: sheet.date, slot: sheet.slot, code: sheet.code, room: sheet.room, studentId: x.studentId, mark: to });
      toast.success(`${x.studentId} ${x.name} → ${to === 'P' ? 'Present' : 'Absent'}`);
      await refreshSheet();
    } catch (err) { toast.error(errMsg(err, 'Could not change the attendance.')); }
    finally { setBusy(''); }
  };
  const removeAdded = async (x) => {
    if (!window.confirm(`Remove ${x.studentId} ${x.name} from this list? (only students added by hand can be removed)`)) return;
    try {
      await api.post('/attendance/remove-added', { date: sheet.date, slot: sheet.slot, code: sheet.code, studentId: x.studentId });
      toast.success('Removed.'); await refreshSheet();
    } catch (err) { toast.error(errMsg(err, 'Could not remove the student.')); }
  };
  // Answer-booklet number (optional) — saved when the box loses focus / Enter.
  const saveBooklet = async (x, value) => {
    const v = String(value || '').trim().replace(/\s+/g, '');
    if (v === (x.booklet || '')) return;
    setBusy(`b-${x.studentId}`);
    try {
      const r = await api.post('/attendance/booklet', { date: sheet.date, slot: sheet.slot, code: sheet.code, room: sheet.room, studentId: x.studentId, booklet: v });
      toast.success(v ? `${x.studentId}: booklet ${v} saved${r.data.markedPresent ? ' · marked Present' : ''}` : `${x.studentId}: booklet number cleared`);
      await refreshSheet();
    } catch (err) { toast.error(errMsg(err, 'Could not save the booklet number.')); }
    finally { setBusy(''); }
  };
  // Export → Absentees / Presentees / All. Built by the server from the live
  // attendance at the moment of the click, so every scan and correction is in it.
  useEffect(() => {
    if (!exportOpen) return undefined;
    const close = (e) => { if (exportRef.current && !exportRef.current.contains(e.target)) setExportOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setExportOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [exportOpen]);
  const exportAs = async (type) => {
    setExportOpen(false); setExporting(type);
    try {
      const r = await api.get('/attendance/export', { params: { type, ...(level ? { level } : {}) }, responseType: 'blob', timeout: 600000 });
      const cd = r.headers['content-disposition'] || '';
      const m = cd.match(/filename="?([^";]+)"?/i);
      const name = m ? m[1] : `${type === 'absent' ? 'Absentees' : type === 'present' ? 'Presentees' : 'Attendance_All'}.xlsx`;
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      const n = Number(r.headers['x-export-rows'] || 0);
      toast.success(`${type === 'absent' ? 'Absentees' : type === 'present' ? 'Presentees' : 'Attendance'} exported — ${n} student-paper${n === 1 ? '' : 's'}.`);
    } catch (err) {
      let msg = 'Could not export the attendance.';
      try { const j = JSON.parse(await err.response.data.text()); if (j.error) msg = j.error; } catch { /* not JSON */ }
      toast.error(msg);
    } finally { setExporting(''); }
  };
  const examEnd = data.examEnd;

  const totals = useMemo(() => {
    const t = { rooms: data.rooms.length, papers: 0, students: 0, present: 0, absent: 0 };
    for (const r of data.rooms) { t.papers += r.papers.length; t.students += r.total; t.present += r.present; t.absent += r.absent; }
    return t;
  }, [data.rooms]);

  if (loading && !data.rooms.length) return <div style={{ padding: 40 }}><Loader label="Loading exam rooms…" /></div>;

  const now = data.now;
  return (
    <div>
      <PageHeader
        eyebrow="Examinations"
        title="Exam Attendance"
        subtitle="Every room that has a paper. Open a room to see one file per paper (course code + time); a course with sections opens its Section A / B / C lists. Each student shows “-” until the admit card is scanned in the app during the paper (then “P”); when the paper's time is over the rest become “A” and the list can be downloaded."
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ display: 'inline-flex', border: '1px solid var(--border,rgba(0,0,0,.15))', borderRadius: 10, overflow: 'hidden' }}>
              {[['', 'All'], ['ug', 'BS'], ['pg', 'MS']].map(([v, lbl]) => (
                <button key={lbl} type="button" onClick={() => { setLevel(v); setSheet(null); setSecFor(null); }}
                  className={`btn btn-sm ${level === v ? 'btn-primary' : 'btn-ghost'}`} style={{ borderRadius: 0, minWidth: 46 }}>{lbl}</button>
              ))}
            </div>
            {!examOver ? (
              <>
                <button className={`btn btn-sm ${live ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setLive((v) => !v)}>
                  <Radio size={14} /> {live ? 'Live' : 'Paused'}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => load()}><RefreshCw size={14} /> Refresh</button>
              </>
            ) : (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 700, padding: '5px 10px', borderRadius: 999, background: '#e2e3e5', color: '#41464b' }}
                title={`Last paper ended — ${data.examEnd.dateDisp || ''}`}>
                <CheckCircle2 size={14} /> Exam over · attendance final
              </span>
            )}
            <button className="btn btn-ghost btn-sm" onClick={() => setImportOpen(true)}
              title="Mark attendance and booklet numbers from the reviewed identification-sheet Excel">
              <Upload size={14} /> Import sheets
            </button>
            <div ref={exportRef} style={{ position: 'relative' }}>
              <button className="btn btn-sm btn-brass" disabled={!!exporting || !data.rooms.length} onClick={() => setExportOpen((v) => !v)}
                aria-haspopup="menu" aria-expanded={exportOpen}
                title="Download attendance as Excel — course-wise lists, totals and charts">
                <FileSpreadsheet size={14} /> {exporting ? 'Exporting…' : 'Export'} <ChevronDown size={14} />
              </button>
              {exportOpen && (
                <div role="menu" style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 40, minWidth: 270, background: 'var(--surface,#fff)',
                  border: '1px solid var(--border,rgba(0,0,0,.12))', borderRadius: 12, boxShadow: '0 14px 36px rgba(0,0,0,.16)', padding: 6 }}>
                  {[
                    ['absent', UserX, 'Export Absentees', 'Only absent students, course-wise, with totals'],
                    ['present', CheckCircle2, 'Export Presentees', 'Only present students, course-wise, with totals'],
                    ['all', Users, 'Export All', 'Every student marked Present / Absent, totals and charts'],
                  ].map(([type, Icon, label, hint]) => (
                    <button key={type} role="menuitem" type="button" onClick={() => exportAs(type)}
                      style={{ display: 'flex', gap: 10, alignItems: 'flex-start', width: '100%', textAlign: 'left', padding: '9px 10px', border: 0, borderRadius: 8, background: 'transparent', cursor: 'pointer', color: 'inherit' }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2,#f2f8f5)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                      <Icon size={16} style={{ marginTop: 2, flexShrink: 0, color: type === 'absent' ? '#9c1c1c' : '#0f5132' }} />
                      <span>
                        <span style={{ display: 'block', fontWeight: 700, fontSize: 13.5 }}>{label}</span>
                        <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-faint,#6c7b72)', marginTop: 1 }}>{hint}</span>
                      </span>
                    </button>
                  ))}
                  <div style={{ fontSize: 11, color: 'var(--text-faint,#6c7b72)', padding: '6px 10px 4px', borderTop: '1px solid var(--border,#e5ece8)', marginTop: 4 }}>
                    {level === 'ug' ? 'BS only' : level === 'pg' ? 'MS only' : 'BS + MS'} · latest attendance at the time of download.
                    {examEnd && !examEnd.ended ? ' Papers not over yet show as “Not yet held”.' : ''}
                  </div>
                </div>
              )}
            </div>
          </div>
        }
      />

      {/* dates */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '0 0 12px' }}>
        <button className={`btn btn-sm ${date === 'all' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setDate('all'); setOpenRoom(null); setSheet(null); setSecFor(null); }}>
          <CalendarDays size={14} /> All dates
        </button>
        {data.dates.map((d) => (
          <button key={d.date} className={`btn btn-sm ${date === d.date ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => { setDate(d.date); setOpenRoom(null); setSheet(null); setSecFor(null); }}>
            {String(d.day || '').slice(0, 3)} {shortDate(d.dateDisp)}{now && d.date === now.date ? ' · today' : ''}
          </button>
        ))}
      </div>

      <div className="card" style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center', padding: '10px 14px', marginBottom: 12 }}>
        <Stat icon={DoorOpen} label="rooms" value={totals.rooms} color="#0f5132" />
        <Stat icon={FileText} label="paper files" value={totals.papers} color="#0f5132" />
        <Stat icon={Users} label="students" value={totals.students} color="#5c6b63" />
        <Stat icon={CheckCircle2} label="present" value={totals.present} color="#198754" />
        <Stat icon={XCircle} label="absent" value={totals.absent} color="#b02a37" />
        {now && <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-faint,#6c7b72)' }}>
          Exam clock: {String(Math.floor(now.minutes / 60)).padStart(2, '0')}:{String(now.minutes % 60).padStart(2, '0')} (Pakistan time)
        </span>}
      </div>

      {!data.rooms.length ? (
        <div className="card"><EmptyState icon={UserCheck} title="No rooms with papers"
          message="Generate the admit cards first — every room that gets a paper appears here as a strip." /></div>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {data.rooms.map((r) => {
            const open = openRoom === r.room;
            return (
              <motion.div key={r.room} className="card" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} style={{ padding: 0, overflow: 'hidden' }}>
                {/* the room strip */}
                <div role="button" tabIndex={0} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', cursor: 'pointer', flexWrap: 'wrap' }}
                  onClick={() => { setOpenRoom(open ? null : r.room); if (sheet && sheet.room === r.room) setSheet(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') setOpenRoom(open ? null : r.room); }}>
                  <ChevronRight size={18} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: '.15s' }} />
                  <DoorOpen size={18} color="#0f5132" />
                  <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                    <div style={{ fontWeight: 800, fontSize: 15 }}>{r.room}</div>
                    <div style={{ display: 'flex', gap: 14, marginTop: 3, flexWrap: 'wrap', fontSize: 12.5 }}>
                      <Stat icon={FileText} label={r.papers.length === 1 ? 'paper' : 'papers'} value={r.papers.length} color="#0f5132" />
                      <Stat icon={Users} label="students" value={r.total} color="#5c6b63" />
                      <Stat icon={CheckCircle2} label="present" value={r.present} color="#198754" />
                      {r.absent > 0 && <Stat icon={XCircle} label="absent" value={r.absent} color="#b02a37" />}
                    </div>
                  </div>
                  <Badge state={r.state} />
                </div>

                {open && (
                  <div style={{ borderTop: '1px solid var(--border,#e5ece8)', padding: 12, background: 'var(--surface-2,#f6fbf8)' }}>
                    {/* one file per paper */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 10 }}>
                      {r.papers.map((p) => {
                        const k = `${r.room}-${p.code}-${p.date}-${p.slot}`;
                        const hasSec = p.sections.length > 0;
                        const sel = hasSec ? secFor === k
                          : (sheet && sheet.room === r.room && sheet.code === p.code && sheet.date === p.date && sheet.slot === p.slot);
                        const click = () => {
                          if (hasSec) { setSecFor(secFor === k ? null : k); setSheet(null); } else { setSecFor(null); openSheet(r.room, p, false, null); }
                        };
                        return (
                          <div key={k} className="card" style={{ padding: 12, margin: 0, border: sel ? '2px solid #198754' : undefined, cursor: 'pointer' }}
                            onClick={click}>
                            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                              <FileText size={26} color="#0f5132" style={{ flex: 'none', marginTop: 2 }} />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, alignItems: 'center' }}>
                                  <b style={{ fontSize: 15, color: '#0f5132' }}>{p.code}{hasSec ? <span style={{ fontWeight: 600, fontSize: 11.5, color: '#5c6b63' }}> · {p.sections.length} section{p.sections.length > 1 ? 's' : ''}</span> : null}</b>
                                  <Badge state={p.state} />
                                </div>
                                <div style={{ fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={p.courseName}>{p.courseName || '—'}</div>
                                <div style={{ fontSize: 12, color: 'var(--text-faint,#6c7b72)', marginTop: 2 }}>{p.day ? `${String(p.day).slice(0, 3)} ` : ''}{p.dateDisp} · {p.slot}</div>
                                <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 12 }}>
                                  <span><b>{p.total}</b> students</span>
                                  <span style={{ color: '#198754' }}><b>{p.present}</b> P</span>
                                  {p.state === 'final' ? <span style={{ color: '#b02a37' }}><b>{p.absent}</b> A</span>
                                    : <span style={{ color: '#8a978f' }}><b>{p.total - p.present}</b> -</span>}
                                </div>
                              </div>
                            </div>
                            {hasSec ? (
                              <button className={`btn btn-sm ${sel ? 'btn-primary' : 'btn-soft'}`} style={{ width: '100%', marginTop: 10 }}
                                onClick={(e) => { e.stopPropagation(); click(); }}>
                                <ChevronRight size={13} style={{ transform: sel ? 'rotate(90deg)' : 'none' }} /> Sections {p.sections.map((x) => x.section || '—').join(' · ')}
                              </button>
                            ) : (
                              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                                <button className="btn btn-ghost btn-sm" style={{ flex: 1 }} disabled={busy === `v-${k}-`}
                                  onClick={(e) => { e.stopPropagation(); setSecFor(null); openSheet(r.room, p, false, null); }}><Eye size={13} /> Open</button>
                                <button className={`btn btn-sm ${p.downloadable ? 'btn-primary' : 'btn-ghost'}`} style={{ flex: 1.4 }}
                                  disabled={!p.downloadable || busy === `d-${k}-`}
                                  title={p.downloadable ? 'Download the attendance file' : `Downloadable after the paper ends (${endLabel(p.slot)})`}
                                  onClick={(e) => { e.stopPropagation(); download(r.room, p, null); }}>
                                  {p.downloadable ? <><Download size={13} /> Download</> : <><Lock size={13} /> After {endLabel(p.slot)}</>}
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {/* sections of the chosen course → one attendance list each */}
                    {(() => {
                      const p = r.papers.find((x) => `${r.room}-${x.code}-${x.date}-${x.slot}` === secFor);
                      if (!p) return null;
                      return (
                        <div className="card" style={{ marginTop: 12, padding: 12 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                            <b style={{ color: '#0f5132' }}>{p.code}</b><span>— {p.courseName}</span>
                            <span style={{ fontSize: 12, color: 'var(--text-faint,#6c7b72)' }}>· {r.room} · {p.dateDisp} · {p.slot}</span>
                            <span style={{ marginLeft: 'auto' }}><Badge state={p.state} /></span>
                            <button className="btn btn-ghost btn-sm" onClick={() => { setSecFor(null); setSheet(null); }} aria-label="Close"><X size={14} /></button>
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
                            {p.sections.map((x) => {
                              const sk = x.section || '';
                              const on = sheet && sheet.code === p.code && sheet.date === p.date && sheet.slot === p.slot && sheet.room === r.room && (sheet.section ?? null) === sk;
                              return (
                                <div key={sk || 'none'} className="card" style={{ padding: 12, margin: 0, cursor: 'pointer', border: on ? '2px solid #198754' : undefined }}
                                  onClick={() => openSheet(r.room, p, false, sk)}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <FileText size={22} color="#0f5132" />
                                    <b style={{ fontSize: 15 }}>{x.section ? `Section ${x.section}` : 'No section'}</b>
                                  </div>
                                  <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 12 }}>
                                    <span><b>{x.total}</b> students</span>
                                    <span style={{ color: '#198754' }}><b>{x.present}</b> P</span>
                                    {p.state === 'final' ? <span style={{ color: '#b02a37' }}><b>{x.absent}</b> A</span>
                                      : <span style={{ color: '#8a978f' }}><b>{x.total - x.present}</b> -</span>}
                                  </div>
                                  <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                                    <button className="btn btn-ghost btn-sm" style={{ flex: 1 }}
                                      onClick={(e) => { e.stopPropagation(); openSheet(r.room, p, false, sk); }}><Eye size={13} /> Open</button>
                                    <button className={`btn btn-sm ${p.downloadable ? 'btn-primary' : 'btn-ghost'}`} style={{ flex: 1.4 }}
                                      disabled={!p.downloadable || busy === `d-${secFor}-${sk}`}
                                      title={p.downloadable ? `Download Section ${x.section} attendance` : `Downloadable after the paper ends (${endLabel(p.slot)})`}
                                      onClick={(e) => { e.stopPropagation(); download(r.room, p, sk); }}>
                                      {p.downloadable ? <><Download size={13} /> Download</> : <><Lock size={13} /> After {endLabel(p.slot)}</>}
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}

                    {/* the open file */}
                    {sheet && sheet.room === r.room && (
                      <div ref={sheetRef} className="card" style={{ marginTop: 12, padding: 0, overflow: 'hidden' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderBottom: '1px solid var(--border,#e5ece8)', flexWrap: 'wrap' }}>
                          <div style={{ flex: 1, minWidth: 200 }}>
                            <b style={{ color: '#0f5132' }}>{sheet.code}{sheet.section ? ` · Section ${sheet.section}` : ''}</b> — {sheet.courseName}
                            <div style={{ fontSize: 12, color: 'var(--text-faint,#6c7b72)' }}>
                              {sheet.room} · {sheet.day ? `${sheet.day}, ` : ''}{sheet.dateDisp} · {sheet.slot} · {sheet.counts.present} P · {sheet.state === 'final' ? `${sheet.counts.absent} A` : `${sheet.counts.notYet} not scanned yet`} · {sheet.counts.total} total
                            </div>
                          </div>
                          <Badge state={sheet.state} />
                          {sheet.state === 'final' && (
                            <button className="btn btn-ghost btn-sm" onClick={() => setAddOpen(true)} title="Add a student who sat this paper but is not on this list">
                              <UserPlus size={13} /> Add a student
                            </button>
                          )}
                          <button className={`btn btn-sm ${sheet.downloadable ? 'btn-primary' : 'btn-ghost'}`} disabled={!sheet.downloadable}
                            onClick={() => download(sheet.room, sheet, sheet.section ?? null)}
                            title={sheet.downloadable ? 'Download the attendance file' : `Downloadable after the paper ends (${endLabel(sheet.slot)})`}>
                            {sheet.downloadable ? <><Download size={13} /> Download</> : <><Lock size={13} /> After {endLabel(sheet.slot)}</>}
                          </button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setSheet(null)} aria-label="Close"><X size={14} /></button>
                        </div>
                        {sheet.state === 'final' && (
                          <div style={{ padding: '7px 14px', fontSize: 12, background: '#fffbea', color: '#664d03', borderBottom: '1px solid var(--border,#e5ece8)' }}>
                            Final list — click a <b>P</b> / <b>A</b> to switch it. Changes are saved at once and shown with a ✎. Type a booklet number and press Enter to save it (optional).
                          </div>
                        )}
                        <ScrollX className="vw-tablewrap" style={{ maxHeight: 420, overflow: 'auto' }}>
                          <table className="vw-table" style={{ width: '100%' }}>
                            <thead><tr><th>Seat</th><th>Reg No</th><th style={{ textAlign: 'left' }}>Name</th><th style={{ textAlign: 'left' }}>Degree / Batch</th><th>Sec</th><th>Booklet No.</th><th>Attendance</th></tr></thead>
                            <tbody>
                              {sheet.rows.map((x) => {
                                const m = MARK[x.mark] || MARK['-'];
                                return (
                                  <tr key={`${x.studentId}-${x.seat}`}>
                                    <td style={{ textAlign: 'center', fontWeight: 800, color: '#0f5132' }}>{x.seat}</td>
                                    <td className="vw-mono" style={{ textAlign: 'center' }}>{x.studentId}</td>
                                    <td>{x.name}{x.added && <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 800, color: '#084298', background: '#cfe2ff', borderRadius: 999, padding: '1px 7px' }}>ADDED</span>}</td>
                                    <td style={{ fontSize: 12 }}>{x.batch || x.program}</td>
                                    <td style={{ textAlign: 'center' }}>{x.section || ''}</td>
                                    <td style={{ textAlign: 'center' }}>
                                      {sheet.state !== 'upcoming' ? (
                                        <input key={`${x.studentId}-${x.booklet || ''}`} className="input vw-mono" defaultValue={x.booklet || ''} placeholder="—"
                                          disabled={busy === `b-${x.studentId}`} maxLength={20} inputMode="numeric"
                                          title={x.fromSheet ? 'From the identification sheet — edit if wrong' : 'Answer-booklet number (optional)'}
                                          onBlur={(e) => saveBooklet(x, e.target.value)}
                                          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = x.booklet || ''; e.currentTarget.blur(); } }}
                                          style={{ width: 96, padding: '3px 6px', fontSize: 12.5, textAlign: 'center' }} />
                                      ) : <span style={{ color: '#8a978f' }}>—</span>}
                                    </td>
                                    <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                                      {sheet.state === 'final' ? (
                                        <button type="button" onClick={() => toggleMark(x)} disabled={busy === `m-${x.studentId}`}
                                          title={`Click to mark ${x.mark === 'P' ? 'ABSENT' : 'PRESENT'}${x.manual ? ` · changed by ${x.editedBy || 'Exam Cell'}` : ''}`}
                                          style={{ cursor: 'pointer', border: `1px solid ${m.fg}55`, minWidth: 30, fontWeight: 900, fontSize: 13, padding: '2px 8px', borderRadius: 8, background: m.bg, color: m.fg }}>
                                          {x.mark}{x.manual ? ' ✎' : ''}
                                        </button>
                                      ) : (
                                        <span title={typeof x.scannedAt === 'string' ? `Scanned ${new Date(x.scannedAt).toLocaleTimeString()}` : ''}
                                          style={{ display: 'inline-block', minWidth: 30, fontWeight: 900, fontSize: 13, padding: '2px 8px', borderRadius: 8, background: m.bg, color: m.fg }}>
                                          {x.mark}
                                        </span>
                                      )}
                                      {x.added && sheet.state === 'final' && (
                                        <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 6, padding: '2px 6px' }} title="Remove this added student" onClick={() => removeAdded(x)}>
                                          <Trash2 size={12} />
                                        </button>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </ScrollX>
                      </div>
                    )}
                  </div>
                )}
              </motion.div>
            );
          })}
        </div>
      )}
      <AddStudentModal open={addOpen} sheet={sheet} onClose={() => setAddOpen(false)}
        onDone={async () => { setAddOpen(false); await refreshSheet(); }} />
      <SheetImportModal open={importOpen} onClose={() => setImportOpen(false)}
        onDone={async () => { await load(true); if (sheet) await openSheet(sheet.room, sheet, true, sheet.section ?? null); }} />
    </div>
  );
}

/* Add a student who sat this paper but is not on its list (only after the paper ended). */
function AddStudentModal({ open, sheet, onClose, onDone }) {
  const toast = useToast();
  const blank = { studentId: '', name: '', program: '', batch: '', seat: '', section: '', mark: 'P' };
  const [f, setF] = useState(blank);
  const [saving, setSaving] = useState(false);
  // reg no → fill name / degree / batch; fields filled this way are replaced (or cleared)
  // when the reg no changes, fields typed by hand are never overwritten
  const auto = useRef({});
  useEffect(() => { if (open) { setF({ ...blank, section: sheet?.section || '' }); auto.current = {}; } }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!sheet) return null;
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const lookup = async () => {
    const sid = f.studentId.trim(); if (!sid) return;
    let found = null;
    try { const r = await api.get('/attendance/student', { params: { sid } }); if (r.data.found) found = r.data; } catch { /* no pre-fill */ }
    setF((x) => {
      const next = { ...x };
      for (const k of ['name', 'program', 'batch']) {
        const typed = x[k] && x[k] !== auto.current[k];
        if (!typed) next[k] = (found && found[k]) || '';
      }
      auto.current = found ? { name: found.name || '', program: found.program || '', batch: found.batch || '' } : {};
      return next;
    });
  };
  const save = async () => {
    if (!f.studentId.trim() || !f.name.trim()) { toast.error('Registration No and Student Name are required.'); return; }
    setSaving(true);
    try {
      await api.post('/attendance/add', { date: sheet.date, slot: sheet.slot, code: sheet.code, room: sheet.room, ...f });
      toast.success(`${f.studentId} ${f.name} added as ${f.mark === 'P' ? 'Present' : 'Absent'}.`);
      onDone();
    } catch (err) { toast.error(errMsg(err, 'Could not add the student.')); }
    finally { setSaving(false); }
  };
  const lbl = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5, fontWeight: 600 };
  return (
    <Modal open={open} onClose={onClose} title="Add a student to this attendance" width={520}>
      <div style={{ fontSize: 12.5, color: 'var(--text-faint,#6c7b72)', marginBottom: 12 }}>
        <b style={{ color: '#0f5132' }}>{sheet.code}{sheet.section ? ` · Section ${sheet.section}` : ''}</b> — {sheet.courseName} · {sheet.room} · {sheet.dateDisp} · {sheet.slot}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <label style={lbl}>Registration No *<input className="input" value={f.studentId} onChange={set('studentId')} onBlur={lookup} placeholder="e.g. 7828" autoFocus /></label>
        <label style={lbl}>Student Name *<input className="input" value={f.name} onChange={set('name')} /></label>
        <label style={lbl}>Degree / Program<input className="input" value={f.program} onChange={set('program')} placeholder="e.g. BS Computer Science" /></label>
        <label style={lbl}>Batch<input className="input" value={f.batch} onChange={set('batch')} placeholder="e.g. BS Computer Science Spring 2023" /></label>
        <label style={lbl}>Seat No<input className="input" value={f.seat} onChange={set('seat')} placeholder="optional" /></label>
        <label style={lbl}>Section<input className="input" value={f.section} onChange={set('section')} placeholder="optional" /></label>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>Attendance *</span>
        {[['P', 'Present (P)'], ['A', 'Absent (A)']].map(([v, t]) => (
          <button key={v} type="button" className={`btn btn-sm ${f.mark === v ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setF((x) => ({ ...x, mark: v }))}>{t}</button>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}><UserPlus size={14} /> {saving ? 'Adding…' : 'Add to attendance'}</button>
      </div>
    </Modal>
  );
}

/* Identification sheets → attendance. The scanned sheets are read into an Excel
   ("Import" sheet: Date | Time | Course | Room | Reg No | Mark | Booklet No. | Source),
   the Exam Cell reviews it, then uploads it here. Check first (nothing is written),
   then Apply. A scanned admit card is never overridden. */
function SheetImportModal({ open, onClose, onDone }) {
  const toast = useToast();
  const [file, setFile] = useState(null);
  const [rep, setRep] = useState(null);
  const [busy, setBusy] = useState('');
  useEffect(() => { if (open) { setFile(null); setRep(null); setBusy(''); } }, [open]);
  const send = async (dry) => {
    if (!file) { toast.error('Choose the reviewed Excel file first.'); return; }
    const fd = new FormData(); fd.append('dryRun', dry ? '1' : '0'); fd.append('file', file);
    setBusy(dry ? 'check' : 'apply');
    try {
      const r = await api.post('/attendance/sheet-import', fd, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 180000 });
      setRep(r.data);
      if (!dry) { toast.success(`Applied: ${r.data.presentNew} marked present, ${r.data.addedNew || 0} added, ${r.data.bookletFilled} booklet numbers saved.`); await onDone(); }
    } catch (err) { toast.error(errMsg(err, 'Could not read the Excel file.')); }
    finally { setBusy(''); }
  };
  const box = { border: '1px solid var(--border,#e5ece8)', borderRadius: 10, padding: '8px 10px', textAlign: 'center' };
  const n = (v, l, c) => (<div style={box}><div style={{ fontSize: 20, fontWeight: 800, color: c }}>{v}</div><div style={{ fontSize: 11.5, color: 'var(--text-faint,#6c7b72)' }}>{l}</div></div>);
  return (
    <Modal open={open} onClose={onClose} title="Import identification sheets" width={640}>
      <div style={{ fontSize: 12.5, color: 'var(--text-faint,#6c7b72)', marginBottom: 12, lineHeight: 1.5 }}>
        Upload the reviewed identification-sheet Excel (sheet <b>Import</b>). <b>Check</b> shows what will change; nothing is saved until you press <b>Apply</b>.
        A student whose admit card was scanned stays Present; rows still marked CHECK are skipped. Students written by hand under a list are added only where “Add to list” is YES.
      </div>
      <input type="file" accept=".xlsx,.xls" onChange={(e) => { setFile(e.target.files[0] || null); setRep(null); }} />
      {rep && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(110px,1fr))', gap: 8 }}>
            {n(rep.rows, 'rows read', '#0f5132')}
            {n(rep.presentNew, 'new Present', '#0f5132')}
            {n(rep.addedNew || 0, 'added (hand-written)', '#0f5132')}
            {n(rep.bookletFilled, 'booklet numbers', '#084298')}
            {n(rep.alreadyPresent, 'already Present', '#41464b')}
            {n(rep.conflicts.length, 'conflicts (not changed)', '#9c1c1c')}
            {n(rep.skipped.length, 'skipped', '#664d03')}
          </div>
          {rep.dryRun && <div style={{ fontSize: 12, marginTop: 8, color: '#664d03' }}>Preview only — nothing has been saved yet.</div>}
          {[['Conflicts — sheet says A but the system has P (left as is)', rep.conflicts.map((c) => `Row ${c.row}: ${c.sid} ${c.code} ${c.date} ${c.slot} — system ${c.system} (${c.why}), sheet ${c.sheet}`)],
            ['Skipped rows', rep.skipped.map((c) => `Row ${c.row}: ${c.sid || '?'} — ${c.reason}`)]].map(([t, list]) => list.length ? (
            <details key={t} style={{ marginTop: 10 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>{t} ({list.length})</summary>
              <div style={{ maxHeight: 180, overflow: 'auto', fontSize: 12, marginTop: 6, fontFamily: 'ui-monospace,monospace' }}>
                {list.map((l) => <div key={l}>{l}</div>)}
              </div>
            </details>
          ) : null)}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
        <button type="button" className="btn btn-ghost" disabled={!file || !!busy} onClick={() => send(true)}>{busy === 'check' ? 'Checking…' : 'Check'}</button>
        <button type="button" className="btn btn-primary" disabled={!file || !!busy || !rep || !rep.dryRun || !rep.writes}
          onClick={() => { if (window.confirm(`Save ${rep.presentNew} new Present marks, ${rep.addedNew || 0} hand-written students and ${rep.bookletFilled} booklet numbers?`)) send(false); }}>
          <Upload size={14} /> {busy === 'apply' ? 'Applying…' : 'Apply'}
        </button>
      </div>
    </Modal>
  );
}
