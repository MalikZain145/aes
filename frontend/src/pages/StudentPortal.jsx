import { useState, useEffect } from 'react';
import {
  GraduationCap, CalendarRange, Contact, ClipboardList, Plus, Trash2, Send,
  Loader2, Download, CheckCircle2, Clock, RefreshCw, Inbox, AlertCircle, Pencil,
  PlusCircle, MinusCircle, ArrowRight, ArrowLeft, FileText, Circle, Eye,
  UserCheck, Radio,
} from 'lucide-react';
import api, { errMsg } from '../api/client';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { PageHeader, EmptyState } from '../components/ui';
import FancySelect from '../components/FancySelect';

const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const TONE = {
  ok: { color: '#2f855a', bg: '#e7f5ec', icon: CheckCircle2 },
  warn: { color: '#c53030', bg: '#fdeaea', icon: AlertCircle },
  info: { color: '#2b6cb0', bg: '#e6f0fb', icon: Clock },
};

export default function StudentPortal() {
  const toast = useToast();
  const { admin } = useAuth();
  const [tab, setTab] = useState('register');

  return (
    <div>
      <PageHeader
        eyebrow="Student Portal"
        title={`Welcome${admin?.name ? `, ${admin.name}` : ''}`}
        subtitle="Register your courses, view your personal class timetable, and download your admit card — all in one place."
      />

      <div className="seg" style={{ display: 'inline-flex', gap: 4, background: 'var(--surface-2, #eef2f0)', padding: 4, borderRadius: 12, marginBottom: 18 }}>
        {[
          { k: 'register', label: 'Course Registration', icon: ClipboardList },
          { k: 'timetable', label: 'My Timetable', icon: CalendarRange },
          { k: 'attendance', label: 'My Attendance', icon: UserCheck },
          { k: 'admit', label: 'Admit Card', icon: Contact },
        ].map(({ k, label, icon: Icon }) => (
          <button key={k} onClick={() => setTab(k)}
            className={tab === k ? 'btn btn-primary' : 'btn btn-ghost'}
            style={{ borderRadius: 9 }}>
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>

      {tab === 'register' && <RegistrationTab toast={toast} />}
      {tab === 'timetable' && <TimetableTab toast={toast} />}
      {tab === 'attendance' && <MyAttendanceTab toast={toast} />}
      {tab === 'admit' && <AdmitTab toast={toast} />}
    </div>
  );
}

/* ── credit hours: "3+1"→4, "2+0"→2 ── */
const courseCredits = (ch) => (String(ch || '').match(/\d+/g) || []).reduce((a, n) => a + parseInt(n, 10), 0);
const CREDIT_MIN = 9, CREDIT_MAX = 18;

/* ── Course Registration ─────────────────────────────────────────────────── */
function RegistrationTab({ toast }) {
  const [profile, setProfile] = useState(null);
  const [forms, setForms] = useState([]);
  const [terms, setTerms] = useState([]);
  const [loading, setLoading] = useState(true);

  const [term, setTerm] = useState('');
  const [kind, setKind] = useState('registration');
  const [semester, setSemester] = useState('');
  const BLANK = { code: '', title: '', creditHours: '' };
  const [rows, setRows] = useState([{ ...BLANK }]);        // registration courses
  const [addRows, setAddRows] = useState([{ ...BLANK }]);  // add/drop: add side
  const [registered, setRegistered] = useState([]);        // registered courses for term (drop candidates)
  const [dropSel, setDropSel] = useState(() => new Set()); // codes selected to drop
  const [courseOpts, setCourseOpts] = useState([]);        // {code,title} for autocomplete
  const [editingId, setEditingId] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [m, f, t, c] = await Promise.all([
        api.get('/student/me'), api.get('/student/registrations'),
        api.get('/student/terms'), api.get('/student/courses'),
      ]);
      setProfile(m.data.profile);
      setForms(f.data.items || []);
      setTerms(t.data.items || []);
      setCourseOpts(c.data.items || []);
      if (!term && (t.data.items || []).length) setTerm(t.data.items[0].name);
    } catch (err) { toast.error(errMsg(err, 'Could not load your registration.')); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  const codeMap = new Map(courseOpts.map((c) => [c.code.toUpperCase(), c]));
  const termInfo = terms.find((t) => t.name === term) || null;
  const regOpen = !!(termInfo && termInfo.registration.open);
  const addDropOpen = !!(termInfo && termInfo.addDrop.open);
  // one form per (term, kind): a submitted/processing/approved form locks that kind (edit only via "Edit & resubmit")
  const existingForKind = forms.find((f) => f.term === term && f.kind === kind && f.status !== 'returned_to_student');
  const locked = !editingId && !!existingForKind;

  // when term changes, default the kind to whichever window is open, and load registered courses
  useEffect(() => {
    if (editingId) return;
    if (regOpen) setKind('registration'); else if (addDropOpen) setKind('add_drop');
    if (term) api.get('/student/registered', { params: { term } }).then((r) => setRegistered(r.data.courses || [])).catch(() => setRegistered([]));
  }, [term, regOpen, addDropOpen]); // eslint-disable-line

  const helpersFor = (setFn) => ({
    set: (i, key, val) => setFn((rs) => rs.map((r, j) => (j === i ? { ...r, [key]: val } : r))),
    add: () => setFn((rs) => [...rs, { ...BLANK }]),
    remove: (i) => setFn((rs) => (rs.length > 1 ? rs.filter((_, j) => j !== i) : rs)),
  });
  const rowsH = helpersFor(setRows);
  const addH = helpersFor(setAddRows);
  const toggleDrop = (code) => setDropSel((s) => { const n = new Set(s); n.has(code) ? n.delete(code) : n.add(code); return n; });

  const startEdit = (f) => {
    setEditingId(f._id); setKind(f.kind); setSemester(f.semester || ''); setTerm(f.term || '');
    const map = (c) => ({ code: c.code || '', title: c.title || '', creditHours: c.creditHours || '' });
    if (f.kind === 'add_drop') {
      setAddRows((f.courses || []).filter((c) => c.action !== 'drop').map(map).concat([]).length
        ? (f.courses || []).filter((c) => c.action !== 'drop').map(map) : [{ ...BLANK }]);
      setDropSel(new Set((f.courses || []).filter((c) => c.action === 'drop').map((c) => c.code)));
      api.get('/student/registered', { params: { term: f.term } }).then((r) => setRegistered(r.data.courses || [])).catch(() => {});
    } else {
      setRows((f.courses || []).length ? f.courses.map(map) : [{ ...BLANK }]);
    }
    if (typeof document !== 'undefined') document.querySelector('.reg-form-card')?.scrollIntoView({ behavior: 'smooth' });
  };
  const cancelEdit = () => {
    setEditingId(null); setSemester('');
    setRows([{ ...BLANK }]); setAddRows([{ ...BLANK }]); setDropSel(new Set());
  };

  // live credit total (registration = courses; add/drop = registered − dropped + added)
  const regByCode = new Map(registered.map((c) => [c.code, c]));
  const dropList = [...dropSel].map((code) => regByCode.get(code)).filter(Boolean);
  const addList = addRows.filter((r) => r.code.trim());
  const total = kind === 'add_drop'
    ? registered.filter((c) => !dropSel.has(c.code)).reduce((a, c) => a + courseCredits(c.creditHours), 0) + addList.reduce((a, c) => a + courseCredits(c.creditHours), 0)
    : rows.filter((r) => r.code.trim()).reduce((a, c) => a + courseCredits(c.creditHours), 0);
  const creditOk = total >= CREDIT_MIN && total <= CREDIT_MAX;

  const submit = async () => {
    let courses;
    if (kind === 'add_drop') {
      courses = [...dropList.map((c) => ({ ...c, action: 'drop' })), ...addList.map((c) => ({ ...c, action: 'add' }))];
      if (!courses.length) return toast.error('Select courses to drop or add.');
    } else {
      courses = rows.filter((r) => r.code.trim());
      if (!courses.length) return toast.error('Add at least one course.');
    }
    if (!creditOk) return toast.error(`Total credit hours must be between ${CREDIT_MIN} and ${CREDIT_MAX} (currently ${total}).`);
    setSubmitting(true);
    try {
      if (editingId) {
        await api.put(`/student/registrations/${editingId}`, { kind, term, semester, courses });
        toast.success('Your updated form has been resubmitted to your advisor.');
      } else {
        await api.post('/student/registrations', { kind, term, semester, courses });
        toast.success(`Your ${kind === 'add_drop' ? 'add/drop' : 'registration'} form has been submitted.`);
      }
      cancelEdit(); load();
    } catch (err) { toast.error(errMsg(err, 'Could not submit your form.')); }
    finally { setSubmitting(false); }
  };

  if (loading) return <Loading />;
  const noTerms = terms.length === 0;
  const windowClosedForKind = kind === 'registration' ? !regOpen : !addDropOpen;

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      {noTerms ? (
        <div className="card"><EmptyState icon={ClipboardList} title="No academic term is open yet"
          message="The Exam Cell hasn't opened a registration term. Please check back later." /></div>
      ) : (
        <>
          {/* identity + term */}
          <div className="card reg-form-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
              <GraduationCap size={18} style={{ color: 'var(--brand-600)' }} />
              <h3 style={{ margin: 0, fontSize: 15 }}>{editingId ? 'Edit & resubmit' : 'New'} {kind === 'add_drop' ? 'Add / Drop' : 'Registration'} Form</h3>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
                <FancySelect value={term} onChange={setTerm} clearable={false} disabled={!!editingId} width={180}
                  options={terms.map((t) => ({ value: t.name, label: t.name }))} />
                <FancySelect value={kind} onChange={setKind} clearable={false} disabled={!!editingId} width={210}
                  options={[
                    { value: 'registration', label: `Course Registration${regOpen ? '' : ' (closed)'}`, disabled: !regOpen && !editingId },
                    { value: 'add_drop', label: `Add / Drop${addDropOpen ? '' : ' (closed)'}`, disabled: !addDropOpen && !editingId },
                  ]} />
              </div>
            </div>

            {/* window banner */}
            <WindowBanner termInfo={termInfo} kind={kind} />

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 12, marginTop: 12 }}>
              <ReadonlyField label="Registration No" value={profile?.regNo} />
              <ReadonlyField label="Name" value={profile?.name} />
              <ReadonlyField label="Batch / Program" value={profile?.batch} />
              <ReadonlyField label="Degree" value={profile?.degree} />
              <ReadonlyField label="Phone" value={profile?.phone} />
              <ReadonlyField label="Email" value={profile?.email} />
              <ReadonlyField label="Term" value={term} />
              <label style={{ display: 'block' }}>
                <span style={fieldLabel}>Semester</span>
                <input className="input" placeholder="e.g. Fall 2026" value={semester} onChange={(e) => setSemester(e.target.value)} />
              </label>
            </div>
          </div>

          <CourseDatalists options={courseOpts} />

          {locked ? (
            <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13.5, fontWeight: 600, color: '#2b6cb0' }}>
              <CheckCircle2 size={17} />
              You have already submitted your {kind === 'add_drop' ? 'add/drop' : 'registration'} form for {term}
              {existingForKind?.status === 'approved' ? ' and it is processed' : ' — it is under review'}.
              Track it below{existingForKind?.status === 'returned_to_student' ? '' : ' (one form per term — edit it if it is returned)'}.
            </div>
          ) : (
            <>
              {/* courses */}
              {kind === 'add_drop' ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 14 }}>
                  <DropList registered={registered} dropSel={dropSel} toggle={toggleDrop} />
                  <CourseTable title="Courses to ADD" icon={PlusCircle} accent="#2f855a" rows={addRows} h={addH} codeMap={codeMap} />
                </div>
              ) : (
                <CourseTable title="Courses" icon={ClipboardList} accent="var(--brand-600)" rows={rows} h={rowsH} codeMap={codeMap} />
              )}

              {/* credit meter + submit */}
              <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderRadius: 10, fontWeight: 700,
                  color: creditOk ? '#2f855a' : '#c53030', background: creditOk ? '#e7f5ec' : '#fdeaea' }}>
                  {creditOk ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                  Total credit hours: {total} / {CREDIT_MAX}
                  <span style={{ fontWeight: 500, fontSize: 12 }}>(allowed {CREDIT_MIN}–{CREDIT_MAX})</span>
                </div>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
                  {editingId && <button className="btn btn-ghost" onClick={cancelEdit}>Cancel edit</button>}
                  <button className="btn btn-primary" disabled={submitting || (!editingId && windowClosedForKind) || !creditOk}
                    onClick={submit} title={windowClosedForKind && !editingId ? 'This window is closed' : ''}>
                    {submitting ? <Loader2 size={15} className="spin" /> : <Send size={15} />} {editingId ? 'Resubmit' : 'Submit for approval'}
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {/* submitted forms + live status timeline */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '13px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 9 }}>
          <Clock size={16} style={{ color: 'var(--brand-600)' }} />
          <h3 style={{ margin: 0, fontSize: 14 }}>My forms & status</h3>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-faint)' }}>{forms.length}</span>
        </div>
        {forms.length === 0 ? (
          <EmptyState icon={Inbox} title="No forms submitted yet" message="Submit a form above and track its live approval status here." />
        ) : (
          <div style={{ display: 'grid', gap: 1, background: 'var(--border)' }}>
            {forms.map((f) => <FormStatusCard key={f._id} form={f} onEdit={startEdit} toast={toast} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function WindowBanner({ termInfo, kind }) {
  if (!termInfo) return null;
  const w = kind === 'add_drop' ? termInfo.addDrop : termInfo.registration;
  const open = !!w.open;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 13px', borderRadius: 10, fontSize: 12.5, fontWeight: 600,
      color: open ? '#2f855a' : '#c53030', background: open ? '#e7f5ec' : '#fdeaea' }}>
      {open ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
      {open
        ? `${kind === 'add_drop' ? 'Add/Drop' : 'Registration'} is OPEN${w.closesAt ? ` until ${new Date(w.closesAt).toLocaleString()}` : ''}.`
        : `${kind === 'add_drop' ? 'Add/Drop' : 'Registration'} is currently CLOSED.${w.note ? ` ${w.note}` : ''}`}
    </div>
  );
}

function DropList({ registered, dropSel, toggle }) {
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '11px 14px', fontSize: 11.5, fontWeight: 700, color: '#fff', background: '#c53030', textTransform: 'uppercase', letterSpacing: '.02em' }}>
        Courses to DROP (tick your registered courses)
      </div>
      {registered.length === 0 ? (
        <div style={{ padding: 16, fontSize: 12.5, color: 'var(--text-faint)' }}>No registered courses found for this term to drop.</div>
      ) : (
        <div style={{ display: 'grid' }}>
          {registered.map((c, i) => (
            <label key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', borderTop: i ? '1px solid var(--border)' : 'none', cursor: 'pointer',
              background: dropSel.has(c.code) ? '#fdeaea' : 'transparent' }}>
              <input type="checkbox" checked={dropSel.has(c.code)} onChange={() => toggle(c.code)} />
              <span style={{ fontFamily: 'ui-monospace,Menlo,monospace', fontWeight: 700 }}>{c.code}</span>
              <span style={{ flex: 1, fontSize: 13 }}>{c.title || ''}</span>
              <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{c.creditHours || ''}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── one form card with the arrow status timeline ── */
function FormStatusCard({ form: f, onEdit, toast }) {
  const [dl, setDl] = useState(false);
  const sl = f.statusLine || {};
  const t = TONE[sl.tone] || TONE.info; const TIcon = t.icon;

  const download = async () => {
    setDl(true);
    try {
      const r = await api.get(`/student/registrations/${f._id}/pdf`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([r.data], { type: 'application/pdf' }));
      window.open(url, '_blank'); setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { toast.error('Could not open the PDF.'); } finally { setDl(false); }
  };

  return (
    <div style={{ background: 'var(--surface,#fff)', padding: '15px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ fontWeight: 700 }}>{f.kind === 'add_drop' ? 'Add / Drop' : 'Registration'}</span>
        <span style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>
          {f.term || '—'} · {(f.courses || []).length} courses · {f.totalCredits || 0} cr · Submitted {new Date(f.submittedAt || f.createdAt).toLocaleString()}
        </span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 700, color: t.color, background: t.bg }}>
          <TIcon size={13} /> {sl.label}
        </span>
      </div>

      <StatusTimeline steps={sl.steps || []} direction={sl.direction} />

      {sl.detail && (
        <p style={{ margin: '12px 0 0', fontSize: 12.5, fontWeight: sl.tone === 'warn' ? 600 : 400, color: sl.tone === 'warn' ? '#c53030' : (sl.tone === 'ok' ? '#2f855a' : 'var(--text-faint)') }}>
          {sl.detail}
        </p>
      )}

      <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
        {f.status === 'returned_to_student' && (
          <button className="btn btn-primary btn-sm" onClick={() => onEdit(f)}><Pencil size={13} /> Edit & resubmit</button>
        )}
        <button className="btn btn-ghost btn-sm" onClick={download} disabled={dl}>
          {dl ? <Loader2 size={13} className="spin" /> : <FileText size={13} />} Download PDF
        </button>
      </div>
    </div>
  );
}

const STEP_COLOR = {
  done: '#2f855a', current: '#2b6cb0', seen: '#2b6cb0', rejected: '#c53030', todo: '#c2ccc6',
};
const STEP_ICON = { done: CheckCircle2, current: Circle, seen: Eye, rejected: AlertCircle, todo: Circle };

function StatusTimeline({ steps, direction }) {
  const d = (x) => (x ? new Date(x).toLocaleString() : '');
  const seenNote = (s) => (s.key === 'advisor' && s.state === 'seen') ? 'Seen by Advisor'
    : (s.key === 'hod' && s.state === 'seen') ? 'Seen by HoD' : null;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 0, overflowX: 'auto', padding: '4px 0' }}>
      {steps.map((s, i) => {
        const color = STEP_COLOR[s.state] || STEP_COLOR.todo;
        const Icon = STEP_ICON[s.state] || Circle;
        const next = steps[i + 1];
        // connector after this step
        let conn = null;
        if (next) {
          const rejectedAhead = next.state === 'rejected' || (direction === 'backward' && s.state === 'rejected');
          const filled = s.state === 'done';
          const cColor = rejectedAhead ? '#c53030' : (filled ? '#2f855a' : '#d7dedb');
          const Arrow = rejectedAhead ? ArrowLeft : ArrowRight;
          conn = (
            <div style={{ display: 'flex', alignItems: 'center', minWidth: 46, flex: 1, alignSelf: 'center', marginTop: -18 }}>
              <div style={{ flex: 1, height: 3, background: cColor, borderRadius: 2 }} />
              <Arrow size={16} style={{ color: cColor, margin: '0 -2px' }} />
            </div>
          );
        }
        return (
          <div key={s.key} style={{ display: 'contents' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 96, textAlign: 'center' }}>
              <span style={{ width: 30, height: 30, borderRadius: '50%', display: 'grid', placeItems: 'center',
                background: s.state === 'todo' ? 'transparent' : color, color: s.state === 'todo' ? color : '#fff',
                border: `2px solid ${color}` }}>
                <Icon size={16} />
              </span>
              <span style={{ marginTop: 6, fontSize: 11.5, fontWeight: 700, color: s.state === 'todo' ? 'var(--text-faint)' : color }}>{s.label}</span>
              {(seenNote(s)) && <span style={{ fontSize: 10, color }}>{seenNote(s)}</span>}
              {s.at && <span style={{ fontSize: 9.5, color: 'var(--text-faint)', lineHeight: 1.3 }}>{d(s.at)}</span>}
            </div>
            {conn}
          </div>
        );
      })}
    </div>
  );
}

/* ── time helpers for the live "class now" bar ── */
const JS_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); if (!m) return null; let h = +m[1]; if (h < 8) h += 12; return h * 60 + +m[2]; };
const slotRange = (slot) => { const [a, b] = String(slot || '').split('-'); const s = toMin(a), e = toMin(b); return (s == null || e == null) ? null : { s, e }; };
function useNow(intervalMs = 30000) {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), intervalMs); return () => clearInterval(id); }, [intervalMs]);
  return now;
}

/* ── My Timetable (own weekly grid from the published CP-SAT run) ──────────── */
const DSHORT = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun' };
const TT_PALETTE = ['#1F3A93', '#1E7145', '#C0392B', '#7D3C98', '#B9770E', '#0E6655', '#A93226', '#2874A6', '#BA4A00', '#6C3483', '#117A65', '#884EA0', '#1A5276'];
const ttColor = (code) => { const m = /^[A-Za-z]+/.exec(String(code) || ''); const d = (m ? m[0] : 'X').toUpperCase(); let s = 0; for (const c of d) s += c.charCodeAt(0); return TT_PALETTE[s % TT_PALETTE.length]; };
function ttCols(slots, breakAfter) { const c = []; (slots || []).forEach((s, i) => { c.push({ kind: 'slot', label: s, si: i }); if (breakAfter != null && breakAfter >= 0 && i === breakAfter) c.push({ kind: 'break', label: 'Break' }); }); return c; }

function TimetableTab({ toast }) {
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

  if (loading) return <Loading />;
  if (!data?.hasTimetable) {
    return <div className="card"><EmptyState icon={CalendarRange} title="No timetable published yet" message="Once the Exam Cell generates and publishes the class timetable, your personal weekly schedule appears here." /></div>;
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
          <div style={{ fontWeight: 800, fontSize: 14, color: '#12261C' }}>MY TIMETABLE <span style={{ color: '#7B1113' }}>· {data.level}</span></div>
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
                          {e.courseCode}{e.section ? ` (${e.section})` : ''}-{e.courseTitle}-{e.teacher} [{e.room}]{e.tag ? ` ${e.tag}` : ''}
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
const ttH = (w) => ({ background: '#DAFAD8', color: '#12261C', textAlign: 'center', padding: '7px 8px', fontSize: 11, fontWeight: 700, width: w, border: '1px solid #D9C9A0' });
const ttC = { padding: '6px 8px', border: '1px solid #E9DDBF', verticalAlign: 'middle' };

/* ── My Attendance ───────────────────────────────────────────────────────── */
function MyAttendanceTab({ toast }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(null);
  const load = async () => {
    setLoading(true);
    try { const r = await api.get('/student/attendance'); setData(r.data); }
    catch (err) { toast.error(errMsg(err, 'Could not load your attendance.')); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  if (loading) return <Loading />;
  const courses = (data && data.courses) || [];
  const pct = (c) => c.percent;
  const tone = (p) => (p >= 75 ? { c: '#2f855a', b: '#e7f5ec' } : p >= 50 ? { c: '#b7791f', b: '#fdf6e3' } : { c: '#c53030', b: '#fdeaea' });

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '13px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 9 }}>
        <UserCheck size={16} style={{ color: 'var(--brand-600)' }} />
        <h3 style={{ margin: 0, fontSize: 14 }}>My Attendance</h3>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-faint)' }}>{courses.length} courses</span>
        <button className="btn btn-ghost btn-sm" onClick={load}><RefreshCw size={14} /></button>
      </div>
      {courses.length === 0 ? (
        <EmptyState icon={UserCheck} title="No attendance recorded yet" message="Once your teachers save class attendance, your present/total for each course will appear here." />
      ) : (
        <div style={{ display: 'grid', gap: 1, background: 'var(--border)' }}>
          {courses.map((c) => {
            const t = tone(pct(c));
            const isOpen = open === c.code;
            return (
              <div key={c.code} style={{ background: 'var(--surface,#fff)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', cursor: 'pointer' }} onClick={() => setOpen(isOpen ? null : c.code)}>
                  {isOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
                  <span style={{ fontFamily: 'ui-monospace,Menlo,monospace', fontWeight: 700 }}>{c.code}</span>
                  <span style={{ flex: 1, fontSize: 13 }}>{c.name || ''}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{c.teacher}</span>
                  <span style={{ fontWeight: 800, fontSize: 14 }}>{c.present}/{c.total}</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', minWidth: 52, justifyContent: 'center', fontSize: 12, fontWeight: 700, color: t.c, background: t.b, borderRadius: 999, padding: '3px 10px' }}>{pct(c)}%</span>
                </div>
                {isOpen && (
                  <div style={{ borderTop: '1px solid var(--border)', padding: '4px 0' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                      <thead><tr>{['Date', 'Time', 'Status'].map((h) => (
                        <th key={h} style={{ textAlign: 'left', padding: '6px 16px', fontSize: 10.5, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase' }}>{h}</th>
                      ))}</tr></thead>
                      <tbody>
                        {(c.sessions || []).map((s, i) => (
                          <tr key={i} style={{ borderTop: '1px solid var(--border-soft,#eef2f0)' }}>
                            <td style={{ padding: '6px 16px' }}>{s.date}</td>
                            <td style={{ padding: '6px 16px', color: 'var(--text-faint)' }}>{s.slot || '—'}</td>
                            <td style={{ padding: '6px 16px', fontWeight: 700, color: s.status === 'present' ? '#2f855a' : '#c53030' }}>{s.status === 'present' ? 'Present' : 'Absent'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
function ChevronDownIcon() { return <ArrowRight size={14} style={{ transform: 'rotate(90deg)', color: 'var(--text-faint)' }} />; }
function ChevronRightIcon() { return <ArrowRight size={14} style={{ color: 'var(--text-faint)' }} />; }

/* ── Admit Card ──────────────────────────────────────────────────────────── */
function AdmitTab({ toast }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const load = async () => {
    setLoading(true);
    try { const r = await api.get('/student/admit-card/status'); setStatus(r.data); }
    catch (err) { toast.error(errMsg(err, 'Could not check your admit card.')); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  const view = async () => {
    setDownloading(true);
    try {
      const r = await api.get('/student/admit-card', { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([r.data], { type: 'application/pdf' }));
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      // blob error bodies need decoding
      let msg = 'Could not open your admit card.';
      try { msg = JSON.parse(await err.response.data.text()).error || msg; } catch { /* keep default */ }
      toast.error(msg);
    } finally { setDownloading(false); }
  };

  if (loading) return <Loading />;

  return (
    <div className="card" style={{ maxWidth: 560 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <Contact size={18} style={{ color: 'var(--brand-600)' }} />
        <h3 style={{ margin: 0, fontSize: 15 }}>Examination Admit Card</h3>
      </div>
      {status?.available ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 10, background: '#e7f5ec', color: '#2f855a', fontSize: 13, fontWeight: 600, marginBottom: 14 }}>
            <CheckCircle2 size={16} /> Your admit card is ready.
          </div>
          <p style={{ fontSize: 13.5, color: 'var(--text)', margin: '0 0 4px' }}>{status.title}</p>
          {status.issuedAt && <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: '0 0 16px' }}>Issued {new Date(status.issuedAt).toLocaleDateString()}</p>}
          <button className="btn btn-primary" onClick={view} disabled={downloading}>
            {downloading ? <Loader2 size={15} className="spin" /> : <Download size={15} />} View / Download admit card
          </button>
          <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: '14px 0 0' }}>Print your admit card and bring it to every paper. It is also emailed to you by the Finance Office once your fee is cleared.</p>
        </>
      ) : (
        <EmptyState icon={Contact} title="Admit card not issued yet" message="Your admit card will appear here once the examination admit cards are generated and your fee is cleared. You will also receive it by email." />
      )}
    </div>
  );
}

/* An editable course table (used once for registration, twice for add/drop). */
function CourseTable({ title, icon: Icon, accent, rows, h, codeMap }) {
  // typing a code → auto-fill the title from the course list (prevents mistakes)
  const onCode = (i, val, row) => {
    h.set(i, 'code', val);
    const m = codeMap && codeMap.get(String(val).toUpperCase());
    if (m && (!row.title || codeMap.get(String(row.code).toUpperCase())?.title === row.title)) h.set(i, 'title', m.title);
  };
  const onTitle = (i, val) => {
    h.set(i, 'title', val);
    const hit = [...(codeMap ? codeMap.values() : [])].find((c) => c.title === val);
    if (hit) h.set(i, 'code', hit.code);   // picked a title suggestion → fill the code
  };
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '13px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 9 }}>
        <Icon size={16} style={{ color: accent }} />
        <h3 style={{ margin: 0, fontSize: 14 }}>{title}</h3>
        <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={h.add}><Plus size={14} /> Add course</button>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>{['#', 'Course Code', 'Title', 'Cr. Hrs', ''].map((head) => (
            <th key={head} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase' }}>{head}</th>
          ))}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
              <td style={{ padding: '8px 12px', color: 'var(--text-faint)' }}>{i + 1}</td>
              <td style={{ padding: '6px 12px' }}><input className="input" list="course-codes" placeholder="CS301" value={r.code} onChange={(e) => onCode(i, e.target.value, r)} style={{ fontFamily: 'ui-monospace,Menlo,monospace' }} /></td>
              <td style={{ padding: '6px 12px' }}><input className="input" list="course-titles" placeholder="Title" value={r.title} onChange={(e) => onTitle(i, e.target.value)} /></td>
              <td style={{ padding: '6px 12px' }}><input className="input" placeholder="3+0" value={r.creditHours} onChange={(e) => h.set(i, 'creditHours', e.target.value)} style={{ maxWidth: 74 }} /></td>
              <td style={{ padding: '6px 12px', textAlign: 'right' }}><button className="btn btn-ghost btn-sm" onClick={() => h.remove(i)} disabled={rows.length === 1}><Trash2 size={14} /></button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Shared course suggestion lists (rendered once per portal).
function CourseDatalists({ options }) {
  return (
    <>
      <datalist id="course-codes">
        {options.map((c) => <option key={c.code} value={c.code}>{c.title}</option>)}
      </datalist>
      <datalist id="course-titles">
        {options.map((c) => <option key={c.code} value={c.title}>{c.code}</option>)}
      </datalist>
    </>
  );
}

/* ── small shared bits ───────────────────────────────────────────────────── */
const fieldLabel = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-faint)', marginBottom: 5 };
function ReadonlyField({ label, value }) {
  return (
    <div>
      <span style={fieldLabel}>{label}</span>
      <div style={{ padding: '9px 11px', borderRadius: 9, background: 'var(--surface-2, #f4f7f5)', border: '1px solid var(--border)', fontSize: 13, color: value ? 'var(--text)' : 'var(--text-faint)', minHeight: 20 }}>{value || '—'}</div>
    </div>
  );
}
function Loading() {
  return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-faint)' }}><Loader2 size={22} className="spin" /> Loading…</div>;
}
