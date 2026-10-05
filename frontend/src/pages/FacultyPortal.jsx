import { useState, useEffect, useMemo } from 'react';
import {
  UserCheck, ShieldCheck, ClipboardList, CheckCircle2, CornerUpLeft, Loader2,
  ChevronDown, ChevronRight, Inbox, RefreshCw, Clock, History, FileText,
  BookOpen, CalendarDays, Save, Download, Users, Circle, XCircle, Lock,
  CalendarRange, Radio,
} from 'lucide-react';
import api, { errMsg } from '../api/client';
import { useToast } from '../context/ToastContext';
import { PageHeader, EmptyState } from '../components/ui';
import FancySelect from '../components/FancySelect';

const todayStr = () => {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export default function FacultyPortal() {
  const toast = useToast();
  const [me, setMe] = useState(null);
  const [data, setData] = useState({ pendingAdvisor: [], pendingHod: [], acted: [] });
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('attendance');

  const load = async () => {
    setLoading(true);
    try {
      const [m, f] = await Promise.all([api.get('/faculty/me'), api.get('/faculty/forms')]);
      setMe(m.data);
      setData(f.data);
      setTab(m.data.isAdvisor ? 'advisor' : m.data.isHod ? 'hod' : 'attendance');
    } catch (err) { toast.error(errMsg(err, 'Could not load your portal.')); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-faint)' }}><Loader2 size={22} className="spin" /> Loading…</div>;

  const roleNote = me
    ? [me.isAdvisor && `Advisor for ${me.advisorBatches.length} batch(es)`, me.isHod && `HoD for ${me.hodDepts.join(', ')}`].filter(Boolean).join(' · ') || 'Mark class attendance and review any forms routed to you.'
    : '';

  return (
    <div>
      <PageHeader
        eyebrow="Faculty Portal"
        title={`Welcome${me?.profile?.name ? `, ${me.profile.name}` : ''}`}
        subtitle={roleNote}
        actions={<button className="btn btn-ghost" onClick={load}><RefreshCw size={15} /> Refresh</button>}
      />

      <div className="seg" style={{ display: 'inline-flex', gap: 4, background: 'var(--surface-2,#eef2f0)', padding: 4, borderRadius: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        <TabBtn active={tab === 'attendance'} onClick={() => setTab('attendance')} icon={UserCheck} label="Attendance" />
        <TabBtn active={tab === 'timetable'} onClick={() => setTab('timetable')} icon={CalendarRange} label="My Timetable" />
        {me?.isAdvisor && <TabBtn active={tab === 'advisor'} onClick={() => setTab('advisor')} icon={ClipboardList} label="Advisor queue" count={data.pendingAdvisor.length} />}
        {me?.isHod && <TabBtn active={tab === 'hod'} onClick={() => setTab('hod')} icon={ShieldCheck} label="HoD queue" count={data.pendingHod.length} />}
        {(me?.isAdvisor || me?.isHod) && <TabBtn active={tab === 'acted'} onClick={() => setTab('acted')} icon={History} label="Reviewed" count={data.acted.length} />}
      </div>

      {tab === 'attendance' && <AttendanceTab toast={toast} />}
      {tab === 'timetable' && <FacultyTimetableTab toast={toast} />}
      {tab === 'advisor' && <FormList forms={data.pendingAdvisor} stage="advisor" toast={toast} reload={load} empty="No forms are waiting for your advisor approval." />}
      {tab === 'hod' && <FormList forms={data.pendingHod} stage="hod" toast={toast} reload={load} empty="No forms are waiting for your HoD approval." />}
      {tab === 'acted' && <FormList forms={data.acted} stage="acted" toast={toast} reload={load} empty="You haven't reviewed any forms yet." />}
    </div>
  );
}

/* ── Class Attendance ─────────────────────────────────────────────────────── */
function AttendanceTab({ toast }) {
  const [courses, setCourses] = useState([]);
  const [records, setRecords] = useState([]);       // saved sheets
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState('');               // selected class key
  const [date, setDate] = useState(todayStr());
  const [roster, setRoster] = useState(null);       // { students, total, locked }
  const [marks, setMarks] = useState({});           // studentId -> 'present'|'absent'
  const [busy, setBusy] = useState(false);
  const [loadingRoster, setLoadingRoster] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [c, r] = await Promise.all([api.get('/faculty/my-courses'), api.get('/faculty/attendance')]);
      setCourses(c.data.items || []);
      setRecords(r.data.items || []);
    } catch (err) { toast.error(errMsg(err, 'Could not load your courses.')); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  const selected = useMemo(() => courses.find((c) => classKey(c) === sel) || null, [courses, sel]);

  const loadRoster = async (cls, d) => {
    if (!cls) return;
    setLoadingRoster(true); setRoster(null);
    try {
      const r = await api.get('/faculty/attendance/roster', { params: { code: cls.code, program: cls.program, section: cls.section, date: d } });
      setRoster(r.data);
      const m = {};
      for (const s of r.data.students || []) m[s.studentId] = s.status || 'present'; // default present
      setMarks(m);
    } catch (err) { toast.error(errMsg(err, 'Could not load the class roster.')); }
    finally { setLoadingRoster(false); }
  };

  const onPick = (key) => { setSel(key); const c = courses.find((x) => classKey(x) === key); if (c) loadRoster(c, date); };
  const onDate = (d) => { setDate(d); if (selected) loadRoster(selected, d); };

  const setAll = (status) => setRoster((r) => { if (r) { const m = {}; for (const s of r.students) m[s.studentId] = status; setMarks(m); } return r; });
  const toggle = (sid) => setMarks((m) => ({ ...m, [sid]: m[sid] === 'present' ? 'absent' : 'present' }));

  const presentCount = roster ? (roster.students || []).filter((s) => marks[s.studentId] === 'present').length : 0;
  const totalCount = roster ? (roster.students || []).length : 0;

  const save = async () => {
    if (!selected || !roster) return;
    setBusy(true);
    try {
      const payload = {
        code: selected.code, courseName: selected.name, section: selected.section,
        program: selected.program, programBatch: selected.programBatch, component: selected.component,
        date,
        records: roster.students.map((s) => ({ studentId: s.studentId, name: s.name, program: s.program, status: marks[s.studentId] === 'present' ? 'present' : 'absent' })),
      };
      const r = await api.post('/faculty/attendance', payload);
      toast.success(`Attendance saved & locked — ${r.data.present}/${r.data.total} present.`);
      await load();
      await loadRoster(selected, date);   // reflect the now-locked state
    } catch (err) { toast.error(errMsg(err, 'Could not save attendance.')); }
    finally { setBusy(false); }
  };

  const viewPdf = async (id) => {
    try {
      const r = await api.get(`/faculty/attendance/${id}/pdf`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([r.data], { type: 'application/pdf' }));
      window.open(url, '_blank'); setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { toast.error('Could not open the PDF.'); }
  };

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-faint)' }}><Loader2 size={22} className="spin" /> Loading…</div>;

  const locked = !!(roster && roster.locked);

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      {/* pick a class + date */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          <BookOpen size={18} style={{ color: 'var(--brand-600)' }} />
          <h3 style={{ margin: 0, fontSize: 15 }}>Generate Attendance Sheet</h3>
        </div>
        {courses.length === 0 ? (
          <EmptyState icon={BookOpen} title="No courses assigned to you"
            message="We couldn't find any course in the database taught by your name. Please contact the Exam Cell if this looks wrong." />
        ) : (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={{ flex: 1, minWidth: 260 }}>
              <span style={fieldLabel}>Course</span>
              <FancySelect value={sel} onChange={onPick} allLabel="Select a course you teach…" placeholder="Select a course you teach…" width="100%"
                options={courses.map((c) => ({ value: classKey(c), label: `${c.code}${c.section ? ` (${c.section})` : ''} — ${c.name}${c.program ? ` · ${c.program}` : ''} · ${c.registered} students` }))} />
            </label>
            <label style={{ width: 170 }}>
              <span style={fieldLabel}>Class date</span>
              <input type="date" className="input" value={date} onChange={(e) => onDate(e.target.value)} />
            </label>
          </div>
        )}
      </div>

      {/* roster + marking */}
      {loadingRoster ? (
        <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-faint)' }}><Loader2 size={20} className="spin" /> Loading roster…</div>
      ) : roster && selected ? (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '13px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Users size={16} style={{ color: 'var(--brand-600)' }} />
            <h3 style={{ margin: 0, fontSize: 14 }}>{selected.code}{selected.section ? ` (${selected.section})` : ''} — {selected.name}</h3>
            {selected.program && <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{selected.program}</span>}
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 800, fontSize: 15, color: 'var(--brand-600)' }}>
              {presentCount}/{totalCount}
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-faint)' }}>present</span>
            </span>
          </div>

          {locked && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 16px', background: '#eef6f0', color: '#2f855a', fontSize: 12.5, fontWeight: 600 }}>
              <Lock size={14} /> Saved & locked{roster.savedAt ? ` on ${new Date(roster.savedAt).toLocaleString()}` : ''}. This sheet can no longer be edited.
            </div>
          )}

          {!locked && (
            <div style={{ display: 'flex', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setAll('present')}><CheckCircle2 size={13} /> All present</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setAll('absent')}><XCircle size={13} /> All absent</button>
            </div>
          )}

          {totalCount === 0 ? (
            <EmptyState icon={Users} title="No registered students" message="No students are registered in this course for the selected program." />
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr>{['#', 'Reg No', 'Name', 'Program', 'Status'].map((h) => (
                <th key={h} style={{ background: 'var(--ink-700)', color: 'var(--on-dark)', textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 700 }}>{h}</th>
              ))}</tr></thead>
              <tbody>
                {roster.students.map((s, i) => {
                  const present = marks[s.studentId] === 'present';
                  return (
                    <tr key={s.studentId} style={{ borderTop: '1px solid var(--border)', background: present ? 'transparent' : '#fdf3f3' }}>
                      <td style={{ padding: '7px 12px', color: 'var(--text-faint)' }}>{i + 1}</td>
                      <td style={{ padding: '7px 12px', fontFamily: 'ui-monospace,Menlo,monospace', fontWeight: 700 }}>{s.studentId}</td>
                      <td style={{ padding: '7px 12px' }}>{s.name || '—'}</td>
                      <td style={{ padding: '7px 12px', fontSize: 12, color: 'var(--text-faint)' }}>{s.program || '—'}</td>
                      <td style={{ padding: '7px 12px' }}>
                        <button disabled={locked} onClick={() => toggle(s.studentId)}
                          className="btn btn-sm" style={{
                            background: present ? '#e7f5ec' : '#fdeaea', color: present ? '#2f855a' : '#c53030',
                            border: `1px solid ${present ? '#c9e9d6' : '#f5c9c9'}`, minWidth: 92, cursor: locked ? 'default' : 'pointer',
                          }}>
                          {present ? <CheckCircle2 size={13} /> : <Circle size={13} />} {present ? 'Present' : 'Absent'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {!locked && totalCount > 0 && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
              <button className="btn btn-primary" disabled={busy} onClick={save}>
                {busy ? <Loader2 size={15} className="spin" /> : <Save size={15} />} Save attendance (lock)
              </button>
            </div>
          )}
        </div>
      ) : null}

      {/* saved records */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '13px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 9 }}>
          <History size={16} style={{ color: 'var(--brand-600)' }} />
          <h3 style={{ margin: 0, fontSize: 14 }}>My attendance records</h3>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-faint)' }}>{records.length}</span>
        </div>
        {records.length === 0 ? (
          <EmptyState icon={Inbox} title="No saved attendance yet" message="Pick a course above, mark the class, and save — it will appear here for download." />
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr>{['Date', 'Course', 'Program', 'Present', ''].map((h) => (
              <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase' }}>{h}</th>
            ))}</tr></thead>
            <tbody>
              {records.map((r) => (
                <tr key={r._id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>{r.date}</td>
                  <td style={{ padding: '8px 12px', fontWeight: 600 }}>{r.code}{r.section ? ` (${r.section})` : ''} <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>{r.courseName}</span></td>
                  <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-faint)' }}>{r.program || '—'}</td>
                  <td style={{ padding: '8px 12px', fontWeight: 700, color: 'var(--brand-600)' }}>{r.present}/{r.total}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => viewPdf(r._id)}><Download size={13} /> PDF</button>
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
const classKey = (c) => `${c.code}|${c.section || ''}|${c.program || ''}`;
const fieldLabel = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-faint)', marginBottom: 5 };

/* ── Faculty "My Timetable" (with the live green class-now bar) ────────────── */
const JS_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); if (!m) return null; let h = +m[1]; if (h < 8) h += 12; return h * 60 + +m[2]; };
const slotRange = (slot) => { const [a, b] = String(slot || '').split('-'); const s = toMin(a), e = toMin(b); return (s == null || e == null) ? null : { s, e }; };
function useNow(intervalMs = 30000) {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), intervalMs); return () => clearInterval(id); }, [intervalMs]);
  return now;
}
function FacultyTimetableTab({ toast }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const now = useNow();
  const load = async () => {
    setLoading(true);
    try { const r = await api.get('/timetable/me'); setData(r.data); }
    catch (err) { toast.error(errMsg(err, 'Could not load your timetable.')); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-faint)' }}><Loader2 size={22} className="spin" /> Loading…</div>;
  if (!data?.hasTimetable) {
    return <div className="card"><EmptyState icon={CalendarRange} title="No timetable published yet" message="Once the Exam Cell generates the class timetable, your weekly teaching schedule will appear here." /></div>;
  }
  const entries = data.entries || [];
  const days = data.days || []; const cols = ttCols(data.slots, data.breakAfterSlot);
  const todayShort = DSHORT[JS_DAYS[now.getDay()]];
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const cell = {}; for (const e of entries) (cell[`${e.day}|${e.slotIndex}`] = cell[`${e.day}|${e.slotIndex}`] || []).push(e);
  const liveSlot = (day, time) => { if (day !== todayShort) return false; const r = slotRange(time); return !!r && nowMin >= r.s && nowMin < r.e; };
  const dateStr = now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  return (
    <div style={{ border: '2px solid #E69138', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
      <div style={{ padding: '12px 16px', background: '#FFF1CC', borderBottom: '2px solid #E69138', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 800, fontSize: 14, color: '#12261C' }}>MY TEACHING TIMETABLE <span style={{ color: '#7B1113' }}>· {data.level}</span></div>
          <div style={{ fontSize: 11.5, color: '#12261C' }}>{dateStr} · <b style={{ color: '#7B1113' }}>{timeStr}</b></div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#C0392B', marginTop: 1 }}>Labs are currently unavailable</div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={load}><RefreshCw size={14} /></button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5, minWidth: 700 }}>
          <thead><tr>
            <th style={ttH(50)}></th>
            {cols.map((c, i) => <th key={i} style={{ ...ttH(c.kind === 'break' ? 54 : undefined), background: c.kind === 'break' ? '#C9C9C9' : '#DAFAD8' }}>{c.label}</th>)}
          </tr></thead>
          <tbody>
            {days.map((d) => (
              <tr key={d}>
                <td style={{ ...ttC, fontWeight: 800, fontSize: 13, textAlign: 'center', background: '#DAFAD8' }}>{d}</td>
                {cols.map((c, i) => {
                  if (c.kind === 'break') return <td key={i} style={{ ...ttC, background: '#C9C9C9', textAlign: 'center', fontSize: 9.5, fontWeight: 700, color: '#555' }}>Prayer &amp; Lunch Break</td>;
                  const list = cell[`${d}|${c.si}`] || []; const live = liveSlot(d, c.label);
                  return (
                    <td key={i} style={{ ...ttC, textAlign: 'center', background: live ? 'rgba(25,135,84,.10)' : '#fff' }}>
                      {list.map((e, j) => (
                        <div key={j} style={{ fontSize: 11, lineHeight: 1.5, fontWeight: 600, color: ttColor(e.courseCode) }}>
                          {e.courseCode}{e.section ? ` (${e.section})` : ''}-{e.courseTitle} [{e.room}]{e.tag ? ` ${e.tag}` : ''}
                          {live && <span style={{ marginLeft: 4, fontSize: 8.5, fontWeight: 800, color: '#fff', background: '#198754', borderRadius: 3, padding: '0 3px' }}>LIVE</span>}
                        </div>
                      ))}
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
const DSHORT = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun' };
const TT_PALETTE = ['#1F3A93', '#1E7145', '#C0392B', '#7D3C98', '#B9770E', '#0E6655', '#A93226', '#2874A6', '#BA4A00', '#6C3483', '#117A65', '#884EA0', '#1A5276'];
const ttColor = (code) => { const m = /^[A-Za-z]+/.exec(String(code) || ''); const dd = (m ? m[0] : 'X').toUpperCase(); let s = 0; for (const c of dd) s += c.charCodeAt(0); return TT_PALETTE[s % TT_PALETTE.length]; };
const ttCols = (slots, breakAfter) => { const c = []; (slots || []).forEach((s, i) => { c.push({ kind: 'slot', label: s, si: i }); if (breakAfter != null && breakAfter >= 0 && i === breakAfter) c.push({ kind: 'break', label: 'Break' }); }); return c; };
const ttH = (w) => ({ background: '#DAFAD8', color: '#12261C', textAlign: 'center', padding: '7px 8px', fontSize: 11, fontWeight: 700, width: w, border: '1px solid #D9C9A0' });
const ttC = { padding: '6px 8px', border: '1px solid #E9DDBF', verticalAlign: 'middle' };

function TabBtn({ active, onClick, icon: Icon, label, count }) {
  return (
    <button onClick={onClick} className={active ? 'btn btn-primary' : 'btn btn-ghost'} style={{ borderRadius: 9 }}>
      <Icon size={15} /> {label}
      {count > 0 && <span style={{ marginLeft: 6, background: active ? 'rgba(255,255,255,.25)' : 'var(--brand-600)', color: '#fff', borderRadius: 20, padding: '1px 8px', fontSize: 11, fontWeight: 700 }}>{count}</span>}
    </button>
  );
}

function FormList({ forms, stage, toast, reload, empty }) {
  if (!forms.length) return <div className="card"><EmptyState icon={Inbox} title={empty} message="" /></div>;
  return <div style={{ display: 'grid', gap: 12 }}>{forms.map((f) => <FormCard key={f._id} form={f} stage={stage} toast={toast} reload={reload} />)}</div>;
}

function FormCard({ form, stage, toast, reload }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [showReturn, setShowReturn] = useState(false);
  const [remark, setRemark] = useState('');
  const canAct = stage === 'advisor' || stage === 'hod';

  const expand = async () => {
    const next = !open; setOpen(next);
    if (next && canAct && !form.seenByAdvisorAt && !form.seenByHodAt) {
      try { await api.post(`/faculty/forms/${form._id}/seen`); } catch { /* non-blocking */ }
    }
  };

  const approve = async () => {
    setBusy('approve');
    try {
      await api.post(`/faculty/forms/${form._id}/approve`);
      toast.success(stage === 'hod' ? 'Approved — the student has been notified.' : 'Approved — forwarded to the Head of Department.');
      reload();
    } catch (err) { toast.error(errMsg(err, 'Could not approve.')); setBusy(''); }
  };
  const doReturn = async () => {
    if (!remark.trim()) return toast.error('Add a remark for the student.');
    setBusy('return');
    try {
      await api.post(`/faculty/forms/${form._id}/return`, { remark });
      toast.success('Returned to the student with your remark.');
      reload();
    } catch (err) { toast.error(errMsg(err, 'Could not return.')); setBusy(''); }
  };
  const downloadPdf = async () => {
    setBusy('pdf');
    try {
      const r = await api.get(`/faculty/forms/${form._id}/pdf`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([r.data], { type: 'application/pdf' }));
      window.open(url, '_blank'); setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { toast.error('Could not open the PDF.'); } finally { setBusy(''); }
  };

  const sl = form.statusLine || {};
  const tone = { ok: { c: '#2f855a', b: '#e7f5ec' }, warn: { c: '#c53030', b: '#fdeaea' }, info: { c: '#2b6cb0', b: '#e6f0fb' } }[sl.tone] || { c: '#5c6b63', b: '#eef2f0' };

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', cursor: 'pointer' }} onClick={expand}>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <div style={{ fontFamily: 'ui-monospace,Menlo,monospace', fontWeight: 700, color: 'var(--ink-700)' }}>{form.regNo}</div>
        <div style={{ fontWeight: 600 }}>{form.name || '—'}</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>{form.batch}</div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{(form.courses || []).length} courses</span>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: tone.c, background: tone.b, borderRadius: 20, padding: '3px 10px' }}>{sl.label}</span>
        </div>
      </div>

      {open && (
        <div style={{ borderTop: '1px solid var(--border)', padding: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10, marginBottom: 14, fontSize: 12.5 }}>
            <Meta label="Semester" value={form.semester} />
            <Meta label="Degree" value={form.degree} />
            <Meta label="Phone" value={form.phone} />
            <Meta label="Email" value={form.email} />
            <Meta label="Type" value={form.kind === 'add_drop' ? 'Add / Drop' : 'Registration'} />
            <Meta label="Submitted" value={form.submittedAt ? new Date(form.submittedAt).toLocaleDateString() : ''} />
          </div>

          {form.kind === 'add_drop' ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 14, marginBottom: 14 }}>
              <CourseList title="Courses to DROP" accent="#c53030" rows={(form.courses || []).filter((c) => c.action === 'drop')} />
              <CourseList title="Courses to ADD" accent="#2f855a" rows={(form.courses || []).filter((c) => c.action !== 'drop')} />
            </div>
          ) : (
            <div style={{ marginBottom: 14 }}><CourseList title="Courses" accent="var(--brand-600)" rows={form.courses || []} /></div>
          )}

          {canAct ? (
            !showReturn ? (
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn btn-primary" disabled={!!busy} onClick={approve}>
                  {busy === 'approve' ? <Loader2 size={15} className="spin" /> : <CheckCircle2 size={15} />} Approve{stage === 'advisor' ? ' & forward to HoD' : ''}
                </button>
                <button className="btn btn-ghost" disabled={!!busy} onClick={() => setShowReturn(true)}><CornerUpLeft size={15} /> Return with remark</button>
                <button className="btn btn-ghost" disabled={busy === 'pdf'} onClick={downloadPdf}>
                  {busy === 'pdf' ? <Loader2 size={15} className="spin" /> : <FileText size={15} />} PDF
                </button>
              </div>
            ) : (
              <div>
                <textarea className="input" rows={3} placeholder="Explain what the student should change…" value={remark} onChange={(e) => setRemark(e.target.value)} style={{ width: '100%', resize: 'vertical', marginBottom: 10 }} />
                <div style={{ display: 'flex', gap: 10 }}>
                  <button className="btn btn-primary" disabled={busy === 'return'} onClick={doReturn} style={{ background: '#c53030', borderColor: '#c53030' }}>
                    {busy === 'return' ? <Loader2 size={15} className="spin" /> : <CornerUpLeft size={15} />} Send back to student
                  </button>
                  <button className="btn btn-ghost" onClick={() => { setShowReturn(false); setRemark(''); }}>Cancel</button>
                </div>
              </div>
            )
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12.5, color: 'var(--text-faint)', flexWrap: 'wrap' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Clock size={14} /> {sl.detail}</span>
              <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} disabled={busy === 'pdf'} onClick={downloadPdf}>
                {busy === 'pdf' ? <Loader2 size={13} className="spin" /> : <FileText size={13} />} PDF
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Meta({ label, value }) {
  return <div><div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase' }}>{label}</div><div>{value || '—'}</div></div>;
}

function CourseList({ title, accent, rows }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '7px 12px', fontSize: 11.5, fontWeight: 700, color: '#fff', background: accent, textTransform: 'uppercase', letterSpacing: '.02em' }}>{title} ({rows.length})</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead><tr>{['#', 'Course Code', 'Title', 'Cr. Hrs'].map((h) => (
          <th key={h} style={{ textAlign: 'left', padding: '6px 10px', fontSize: 10.5, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', background: 'var(--surface-2,#f4f7f5)' }}>{h}</th>
        ))}</tr></thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={4} style={{ padding: '10px 10px', color: 'var(--text-faint)', textAlign: 'center' }}>None</td></tr>
          ) : rows.map((c, i) => (
            <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
              <td style={{ padding: '6px 10px', color: 'var(--text-faint)' }}>{i + 1}</td>
              <td style={{ padding: '6px 10px', fontFamily: 'ui-monospace,Menlo,monospace', fontWeight: 700 }}>{c.code}</td>
              <td style={{ padding: '6px 10px' }}>{c.title || '—'}</td>
              <td style={{ padding: '6px 10px' }}>{c.creditHours || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
