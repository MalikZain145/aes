import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  UserCheck, RefreshCw, FileText, DoorOpen, ChevronRight, Users, CheckCircle2, XCircle, Clock, Radio,
  Lock, Download, Eye, X, CalendarDays,
} from 'lucide-react';
import api, { errMsg } from '../api/client';
import { downloadFile } from '../api/download';
import { useToast } from '../context/ToastContext';
import { PageHeader, Loader, EmptyState } from '../components/ui';
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

  // live: refresh the rooms + the open file every 10 s
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(() => {
      load(true);
      if (sheet) openSheet(sheet.room, sheet, true, sheet.section ?? null);
    }, 10000);
    return () => clearInterval(t);
  }, [live, load, sheet, openSheet]);

  const download = async (room, p, section) => {
    const sec = section === undefined ? (p.section ?? null) : section;
    const q = new URLSearchParams({ date: p.date, slot: p.slot, room, code: p.code, ...(sec !== null ? { section: sec } : {}), ...(level ? { level } : {}) }).toString();
    setBusy(`d-${room}-${p.code}-${p.date}-${p.slot}-${sec ?? ''}`);
    try {
      await downloadFile(`/attendance/paper.pdf?${q}&v=${Date.now()}`, `Attendance_${p.code}${sec ? '-' + sec : ''}_${room}_${p.date}.pdf`);
    } finally { setTimeout(() => setBusy(''), 800); }
  };

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
            <button className={`btn btn-sm ${live ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setLive((v) => !v)}>
              <Radio size={14} /> {live ? 'Live' : 'Paused'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => load()}><RefreshCw size={14} /> Refresh</button>
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
                          <button className={`btn btn-sm ${sheet.downloadable ? 'btn-primary' : 'btn-ghost'}`} disabled={!sheet.downloadable}
                            onClick={() => download(sheet.room, sheet, sheet.section ?? null)}
                            title={sheet.downloadable ? 'Download the attendance file' : `Downloadable after the paper ends (${endLabel(sheet.slot)})`}>
                            {sheet.downloadable ? <><Download size={13} /> Download</> : <><Lock size={13} /> After {endLabel(sheet.slot)}</>}
                          </button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setSheet(null)} aria-label="Close"><X size={14} /></button>
                        </div>
                        <ScrollX className="vw-tablewrap" style={{ maxHeight: 420, overflow: 'auto' }}>
                          <table className="vw-table" style={{ width: '100%' }}>
                            <thead><tr><th>Seat</th><th>Reg No</th><th style={{ textAlign: 'left' }}>Name</th><th style={{ textAlign: 'left' }}>Degree / Batch</th><th>Sec</th><th>Attendance</th></tr></thead>
                            <tbody>
                              {sheet.rows.map((x) => {
                                const m = MARK[x.mark] || MARK['-'];
                                return (
                                  <tr key={`${x.studentId}-${x.seat}`}>
                                    <td style={{ textAlign: 'center', fontWeight: 800, color: '#0f5132' }}>{x.seat}</td>
                                    <td className="vw-mono" style={{ textAlign: 'center' }}>{x.studentId}</td>
                                    <td>{x.name}</td>
                                    <td style={{ fontSize: 12 }}>{x.batch || x.program}</td>
                                    <td style={{ textAlign: 'center' }}>{x.section || ''}</td>
                                    <td style={{ textAlign: 'center' }}>
                                      <span title={typeof x.scannedAt === 'string' ? `Scanned ${new Date(x.scannedAt).toLocaleTimeString()}` : ''}
                                        style={{ display: 'inline-block', minWidth: 30, fontWeight: 900, fontSize: 13, padding: '2px 8px', borderRadius: 8, background: m.bg, color: m.fg }}>
                                        {x.mark}
                                      </span>
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
    </div>
  );
}
