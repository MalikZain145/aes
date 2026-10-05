import { useState, useEffect, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import {
  UserCheck, RefreshCw, FileText, DoorOpen, ChevronRight, Users, CheckCircle2, XCircle, Clock, Radio,
} from 'lucide-react';
import api, { errMsg } from '../api/client';
import { downloadFile } from '../api/download';
import { useToast } from '../context/ToastContext';
import { PageHeader, Loader, EmptyState } from '../components/ui';

const slotName = (s) => String(s || '');

export default function Attendance() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [sessions, setSessions] = useState([]);
  const [openKey, setOpenKey] = useState(null);      // expanded (date|slot)
  const [live, setLive] = useState(true);            // auto-refresh
  const [level, setLevel] = useState('ug');          // ug = BS, pg = MS (separate sheets)
  const [roomSheet, setRoomSheet] = useState(null);  // { date, slot, room, rows, counts, final }
  const [busy, setBusy] = useState('');
  const timer = useRef(null);

  const load = useCallback(async (quiet) => {
    if (!quiet) setLoading(true);
    try {
      const res = await api.get('/attendance/sessions', { params: { level } });
      setSessions(res.data.sessions || []);
    } catch (err) {
      if (!quiet) toast.error(errMsg(err, 'Could not load attendance.'));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [toast, level]);

  useEffect(() => { load(); setOpenKey(null); setRoomSheet(null); }, [load]);

  // live auto-refresh every 12s (sessions + the open room sheet)
  useEffect(() => {
    if (!live) { if (timer.current) clearInterval(timer.current); return; }
    timer.current = setInterval(async () => {
      load(true);
      if (roomSheet) {
        try {
          const p = { date: roomSheet.date, slot: roomSheet.slot, room: roomSheet.room, level };
          const r = await api.get('/attendance/sheet', { params: p });
          setRoomSheet(r.data);
        } catch { /* ignore */ }
      }
    }, 12000);
    return () => clearInterval(timer.current);
  }, [live, load, roomSheet]);

  const openRoom = async (date, slot, room) => {
    setBusy(`${room}`);
    try {
      const r = await api.get('/attendance/sheet', { params: { date, slot, room, level } });
      setRoomSheet(r.data);
    } catch (err) { toast.error(errMsg(err, 'Could not open the room sheet.')); }
    finally { setBusy(''); }
  };

  const download = async (date, slot, room) => {
    const q = new URLSearchParams({ date, slot, level, ...(room ? { room } : {}) }).toString();
    setBusy(`dl-${room || 'all'}`);
    try {
      await downloadFile(`/attendance/sheet.pdf?${q}`, `Attendance_${date}_${slotName(slot)}${room ? '_' + room : ''}.pdf`);
    } catch (err) { toast.error(errMsg(err, 'Could not download the sheet.')); }
    finally { setBusy(''); }
  };

  const Stat = ({ icon: Icon, label, value, color }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <Icon size={15} color={color} /><b style={{ color }}>{value}</b>
      <span style={{ color: 'var(--muted,#6c7b72)', fontSize: 12 }}>{label}</span>
    </div>
  );

  if (loading) return <div style={{ padding: 40 }}><Loader label="Loading attendance…" /></div>;

  return (
    <div>
      <PageHeader
        eyebrow="Examinations"
        title="Exam Attendance"
        subtitle="Live, room-wise digital attendance. Nothing shows until scanning begins — a room appears the moment its first card is scanned and fills up seat-by-seat. When the slot's time ends, the un-scanned students become Absent and the complete list is ready to download."
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* BS (Undergraduate) vs MS (Postgraduate) — kept as separate sheets */}
            <div style={{ display: 'inline-flex', border: '1px solid var(--border,rgba(0,0,0,.15))', borderRadius: 10, overflow: 'hidden' }}>
              {[['ug', 'BS'], ['pg', 'MS']].map(([v, lbl]) => (
                <button key={v} type="button" onClick={() => setLevel(v)}
                  className={`btn btn-sm ${level === v ? 'btn-primary' : 'btn-ghost'}`} style={{ borderRadius: 0, minWidth: 46 }}>
                  {lbl}
                </button>
              ))}
            </div>
            <button className={`btn btn-sm ${live ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setLive((v) => !v)}>
              <Radio size={14} /> {live ? 'Live' : 'Paused'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => load()}><RefreshCw size={14} /> Refresh</button>
          </div>
        }
      />

      {!sessions.length ? (
        <div className="card"><EmptyState icon={UserCheck} title="No attendance yet"
          message="Nothing is shown until scanning starts. A room appears here live the moment its first admit card is scanned during the exam, and fills up seat-by-seat. When the slot's time ends, the un-scanned students become Absent and the complete list is ready to download." /></div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {sessions.map((s) => {
            const key = `${s.date}|${s.slot}`;
            const open = openKey === key;
            return (
              <motion.div key={key} className="card" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', cursor: 'pointer' }}
                  onClick={() => { setOpenKey(open ? null : key); setRoomSheet(null); }}>
                  <ChevronRight size={18} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: '.15s' }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 800 }}>{s.date} · {s.slot}</div>
                    <div style={{ display: 'flex', gap: 16, marginTop: 4, flexWrap: 'wrap' }}>
                      <Stat icon={Users} label="students" value={s.total} color="#0f5132" />
                      <Stat icon={CheckCircle2} label="present" value={s.present} color="#198754" />
                      {s.final && <Stat icon={XCircle} label="absent" value={s.absent} color="#b02a37" />}
                      <Stat icon={DoorOpen} label="rooms" value={s.rooms.length} color="#5c6b63" />
                    </div>
                  </div>
                  <span className="badge" style={{ background: s.final ? '#e2e3e5' : '#fff3cd', color: s.final ? '#41464b' : '#664d03', fontWeight: 800, fontSize: 11, padding: '3px 10px', borderRadius: 999 }}>
                    {s.final ? 'FINAL' : <><Clock size={11} /> LIVE</>}
                  </span>
                  <button className="btn btn-soft btn-sm"
                    title={s.final ? 'Download all rooms' : 'Ready to download once the slot ends'}
                    onClick={(e) => { e.stopPropagation(); download(s.date, s.slot, ''); }}
                    disabled={busy === 'dl-all' || !s.final}>
                    <FileText size={14} /> {s.final ? 'All rooms' : 'Locked'}
                  </button>
                </div>

                {open && (
                  <div style={{ borderTop: '1px solid var(--border,#e5ece8)' }}>
                    <div className="vw-tablewrap">
                      <table className="vw-table" style={{ width: '100%' }}>
                        <thead><tr>
                          <th style={{ textAlign: 'left' }}>Room</th><th>Students</th><th>Present</th><th>Absent</th><th>Status</th><th></th>
                        </tr></thead>
                        <tbody>
                          {s.rooms.map((r) => (
                            <tr key={r.room}>
                              <td style={{ fontWeight: 700 }}>{r.room}</td>
                              <td style={{ textAlign: 'center' }}>{r.total}</td>
                              <td style={{ textAlign: 'center', color: '#198754', fontWeight: 800 }}>{r.present}</td>
                              <td style={{ textAlign: 'center', color: r.final ? '#b02a37' : '#9aa', fontWeight: 800 }}>{r.final ? r.absent : '—'}</td>
                              <td style={{ textAlign: 'center', fontSize: 11, fontWeight: 800, color: r.final ? '#41464b' : '#664d03' }}>{r.final ? 'FINAL' : 'LIVE'}</td>
                              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                                <button className="btn btn-ghost btn-sm" onClick={() => openRoom(s.date, s.slot, r.room)} disabled={busy === r.room}>View</button>
                                <button className="btn btn-soft btn-sm"
                                  title={r.final ? 'Download attendance sheet' : 'Ready once the slot ends'}
                                  onClick={() => download(s.date, s.slot, r.room)}
                                  disabled={busy === `dl-${r.room}` || !r.final}><FileText size={13} /> PDF</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {roomSheet && roomSheet.slot === s.slot && roomSheet.date === s.date && (
                      <div style={{ padding: 14, background: 'var(--surface-2,#f6fbf8)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                          <b>Room {roomSheet.room} — {roomSheet.final
                            ? `${roomSheet.counts.present} present · ${roomSheet.counts.absent} absent · ${roomSheet.counts.total} total · FINAL`
                            : `${roomSheet.counts.present} scanned of ${roomSheet.counts.total} · ${roomSheet.counts.pending} not scanned yet · LIVE`}</b>
                          <button className="btn btn-ghost btn-sm" onClick={() => setRoomSheet(null)}>Close</button>
                        </div>
                        {roomSheet.rows.length === 0 && (
                          <div style={{ padding: 18, textAlign: 'center', color: 'var(--text-faint,#6c7b72)', fontSize: 13 }}>
                            No students scanned yet — attendance fills in live as cards are scanned.
                          </div>
                        )}
                        <div className="vw-tablewrap" style={{ maxHeight: 360, overflow: 'auto' }}>
                          <table className="vw-table" style={{ width: '100%' }}>
                            <thead><tr><th>Seat</th><th>Reg No</th><th>Name</th><th>Course</th><th>Status</th></tr></thead>
                            <tbody>
                              {roomSheet.rows.map((r, i) => (
                                <tr key={i}>
                                  <td style={{ textAlign: 'center', fontWeight: 800, color: '#0f5132' }}>{r.seat}</td>
                                  <td className="vw-mono">{r.studentId}</td>
                                  <td>{r.name}</td>
                                  <td className="vw-mono">{r.code}</td>
                                  <td style={{ textAlign: 'center' }}>
                                    <span style={{ fontSize: 11, fontWeight: 800, padding: '2px 9px', borderRadius: 999,
                                      background: r.status === 'present' ? '#d1e7dd' : r.status === 'absent' ? '#f8d7da' : '#fff3cd',
                                      color: r.status === 'present' ? '#0f5132' : r.status === 'absent' ? '#842029' : '#664d03' }}>
                                      {r.status === 'present' ? 'PRESENT' : r.status === 'absent' ? 'ABSENT' : 'PENDING'}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
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
