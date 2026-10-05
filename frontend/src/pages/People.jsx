import { useState, useEffect, useRef } from 'react';
import {
  Users, GraduationCap, UserCheck, ShieldCheck, Upload, Loader2, Trash2,
  RefreshCw, CheckCircle2, FileSpreadsheet, CalendarClock, Bell, Plus, CalendarDays,
  Pencil, X,
} from 'lucide-react';
import api, { errMsg } from '../api/client';
import { useToast } from '../context/ToastContext';
import { PageHeader, EmptyState } from '../components/ui';
import FancySelect from '../components/FancySelect';

/**
 * Admin → People & Assignments.
 *   1. Student logins (roster upload / provision).
 *   2. Academic terms — create a term, open/extend its registration & add/drop
 *      windows.
 *   3. Assign advisors (per batch) and HoDs (per department) for a term.
 */
export default function People() {
  const toast = useToast();

  const [stats, setStats] = useState({ total: 0, withEmail: 0, registrations: 0 });
  const [uploading, setUploading] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const fileRef = useRef(null);

  const [faculty, setFaculty] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [batchesByProgram, setBatchesByProgram] = useState({});
  const [assignments, setAssignments] = useState([]);
  const [terms, setTerms] = useState([]);
  const [loading, setLoading] = useState(true);

  // assignment form
  const [term, setTerm] = useState('');       // selected academic term
  const [type, setType] = useState('advisor');
  const [department, setDepartment] = useState('');
  const [batch, setBatch] = useState('');
  const [teacherId, setTeacherId] = useState('');
  const [saving, setSaving] = useState(false);
  const [editId, setEditId] = useState(null);   // assignment being edited (null = add new)

  const loadAll = async () => {
    setLoading(true);
    try {
      const [s, f, o, a, t] = await Promise.all([
        api.get('/admin/students/stats'),
        api.get('/admin/faculty'),
        api.get('/admin/org-units'),
        api.get('/admin/assignments'),
        api.get('/admin/terms'),
      ]);
      setStats(s.data || { total: 0, withEmail: 0, registrations: 0 });
      setFaculty(f.data.items || []);
      setDepartments(o.data.departments || []);
      setBatchesByProgram(o.data.batchesByProgram || {});
      setAssignments(a.data.items || []);
      setTerms(t.data.items || []);
      if (!term && (t.data.items || []).length) setTerm(t.data.items[0].name);
    } catch (err) {
      toast.error(errMsg(err, 'Could not load people data.'));
    } finally { setLoading(false); }
  };
  useEffect(() => { loadAll(); }, []); // eslint-disable-line

  const provision = async () => {
    setProvisioning(true);
    try {
      const res = await api.post('/admin/students/provision');
      toast.success(`${res.data.created} student login(s) created (Reg No / student123).`);
      loadAll();
    } catch (err) { toast.error(errMsg(err, 'Could not create student logins.')); }
    finally { setProvisioning(false); }
  };

  const onUpload = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const res = await api.post('/admin/students/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      const { created = 0, updated = 0, skipped = 0 } = res.data;
      toast.success(`Roster imported — ${created} new, ${updated} updated${skipped ? `, ${skipped} skipped` : ''}.`);
      loadAll();
    } catch (err) { toast.error(errMsg(err, 'Student upload failed.')); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const startEdit = (row) => {
    setEditId(row._id);
    setType(row.type);
    setTerm(row.term || '');
    setDepartment(row.department || '');
    setBatch(row.batch || '');
    setTeacherId(row.teacherId ? String(row.teacherId) : '');
    // bring the form into view
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const cancelEdit = () => { setEditId(null); setTeacherId(''); setBatch(''); };

  const saveAssignment = async () => {
    if (!department) return toast.error('Choose a department.');
    if (type === 'advisor' && !batch) return toast.error('Choose a batch.');
    if (!teacherId) return toast.error('Choose a faculty member.');
    setSaving(true);
    try {
      const payload = { type, term, department, batch: type === 'advisor' ? batch : '', teacherId };
      if (editId) {
        await api.put(`/admin/assignments/${editId}`, payload);
        toast.success(`${type === 'hod' ? 'HoD' : 'Advisor'} updated${term ? ` for ${term}` : ''}.`);
        setEditId(null);
      } else {
        const res = await api.post('/admin/assignments', payload);
        toast.success(`${type === 'hod' ? 'HoD' : 'Advisor'} saved${term ? ` for ${term}` : ''}.${res.data.facultyLogin ? ` Login: ${res.data.facultyLogin}` : ''}`);
      }
      setTeacherId('');
      loadAll();
    } catch (err) { toast.error(errMsg(err, 'Could not save the assignment.')); }
    finally { setSaving(false); }
  };

  const removeAssignment = async (id) => {
    try {
      await api.delete(`/admin/assignments/${id}`);
      setAssignments((a) => a.filter((x) => x._id !== id));
      if (editId === id) cancelEdit();
    } catch (err) { toast.error(errMsg(err, 'Could not remove the assignment.')); }
  };

  const advisors = assignments.filter((a) => a.type === 'advisor');
  const hods = assignments.filter((a) => a.type === 'hod');
  const deptFaculty = department ? faculty.filter((f) => f.department === department) : faculty;
  const facultyForPicker = deptFaculty.length ? deptFaculty : faculty;

  return (
    <div>
      <PageHeader
        eyebrow="Administration"
        title="People & Assignments"
        subtitle="Manage student logins, academic terms and their registration windows, and appoint advisors & Heads of Department per term."
        actions={<button className="btn btn-ghost" onClick={loadAll}><RefreshCw size={15} /> Refresh</button>}
      />

      {/* ── Student accounts ── */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <GraduationCap size={18} style={{ color: 'var(--brand-600)' }} />
          <h3 style={{ margin: 0, fontSize: 15 }}>Student accounts</h3>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'center' }}>
          <Stat label="Student logins" value={stats.total} />
          <Stat label="With email on file" value={stats.withEmail} />
          <Stat label="Imported reg numbers" value={stats.registrations} />
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {stats.total < stats.registrations && (
              <button className="btn btn-primary" disabled={provisioning} onClick={provision}>
                {provisioning ? <Loader2 size={15} className="spin" /> : <UserCheck size={15} />}
                {provisioning ? 'Creating…' : `Create ${stats.registrations - stats.total} logins from records`}
              </button>
            )}
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={onUpload} />
            <button className={stats.total < stats.registrations ? 'btn btn-ghost' : 'btn btn-primary'} disabled={uploading} onClick={() => fileRef.current && fileRef.current.click()}>
              {uploading ? <Loader2 size={15} className="spin" /> : <Upload size={15} />}
              {uploading ? 'Importing…' : 'Upload roster'}
            </button>
          </div>
        </div>
      </div>

      {/* ── Academic terms ── */}
      <AcademicTerms terms={terms} selected={term} onSelect={setTerm} reload={loadAll} toast={toast} />

      {/* ── Assignment form ── */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <UserCheck size={18} style={{ color: 'var(--brand-600)' }} />
          <h3 style={{ margin: 0, fontSize: 15 }}>{editId ? 'Edit advisor / HoD' : 'Appoint advisor / HoD'}</h3>
          {editId && <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 999, background: '#fff3cd', color: '#664d03' }}>Editing</span>}
          {term && <span style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--text-faint)' }}>for <b style={{ color: 'var(--ink-700)' }}>{term}</b></span>}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: '18px 20px', alignItems: 'end' }}>
          <Field label="Academic term">
            <FancySelect value={term} onChange={setTerm} options={terms.map((t) => ({ value: t.name, label: t.name }))} allLabel="Any term" width="100%" />
          </Field>
          <Field label="Role">
            <FancySelect value={type} onChange={setType} clearable={false} width="100%"
              options={[{ value: 'advisor', label: 'Student Advisor (per batch)' }, { value: 'hod', label: 'Head of Department' }]} />
          </Field>
          <Field label="Department / Program">
            <FancySelect value={department} onChange={(v) => { setDepartment(v); setBatch(''); setTeacherId(''); }} options={departments} allLabel="Select department…" width="100%" />
          </Field>
          {type === 'advisor' && (
            <Field label="Batch">
              <FancySelect value={batch} onChange={setBatch} options={batchesByProgram[department] || []} disabled={!department}
                allLabel={department ? 'Select batch…' : 'Choose department first'} width="100%" />
            </Field>
          )}
          <Field label="Faculty member">
            <FancySelect value={teacherId} onChange={setTeacherId} allLabel="Select faculty…" width="100%"
              options={facultyForPicker.map((f) => ({ value: f.id, label: `${f.name}${f.email ? '' : ' (no email)'}` }))} />
          </Field>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" disabled={saving} onClick={saveAssignment} style={{ flex: 1 }}>
              {saving ? <Loader2 size={15} className="spin" /> : <CheckCircle2 size={15} />} {editId ? 'Update' : 'Save'}
            </button>
            {editId && (
              <button className="btn btn-ghost" disabled={saving} onClick={cancelEdit} title="Cancel edit"><X size={15} /></button>
            )}
          </div>
        </div>
        <p style={{ margin: '12px 0 0', fontSize: 12.5, color: 'var(--text-faint)' }}>
          Assignments are per academic term (pick a term above) and <b>carry forward automatically</b> when you open a new term — advisors/HoDs are never archived. Edit or delete any of them below. Saving also provisions the teacher's Faculty login (email / <code>faculty123</code>).
        </p>
      </div>

      {/* ── Current assignments ── */}
      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-faint)' }}><Loader2 size={22} className="spin" /> Loading…</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))', gap: 18 }}>
          <AssignTable title="Student Advisors" icon={Users} rows={advisors} cols={['Term', 'Department', 'Batch', 'Advisor']}
            render={(r) => [r.term || 'Any', r.department, r.batch, r.teacherName]} onRemove={removeAssignment} onEdit={startEdit} editId={editId} empty="No advisors assigned yet." />
          <AssignTable title="Heads of Department" icon={ShieldCheck} rows={hods} cols={['Term', 'Department', 'HoD']}
            render={(r) => [r.term || 'Any', r.department, r.teacherName]} onRemove={removeAssignment} onEdit={startEdit} editId={editId} empty="No HoDs assigned yet." />
        </div>
      )}
    </div>
  );
}

// ── datetime-local helpers ──
const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

function AcademicTerms({ terms, selected, onSelect, reload, toast }) {
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const term = terms.find((t) => t.name === selected) || null;

  const create = async () => {
    if (!newName.trim()) return toast.error('Enter a term name, e.g. "Fall 2026".');
    setCreating(true);
    try {
      const r = await api.post('/admin/terms', { name: newName.trim() });
      toast.success(`Term "${r.data.term.name}" created.`);
      setNewName(''); await reload(); onSelect(r.data.term.name);
    } catch (err) { toast.error(errMsg(err, 'Could not create the term.')); }
    finally { setCreating(false); }
  };

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <CalendarDays size={18} style={{ color: 'var(--brand-600)' }} />
        <h3 style={{ margin: 0, fontSize: 15 }}>Academic terms</h3>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <input className="input" placeholder="New term e.g. Fall 2026" value={newName}
            onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} style={{ width: 190 }} />
          <button className="btn btn-primary" disabled={creating} onClick={create}>
            {creating ? <Loader2 size={15} className="spin" /> : <Plus size={15} />} Create term
          </button>
        </div>
      </div>

      {terms.length === 0 ? (
        <EmptyState icon={CalendarDays} title="No academic terms yet" message="Create a term (e.g. Fall 2026), then open its registration window below." />
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            {terms.map((t) => (
              <button key={t._id} onClick={() => onSelect(t.name)}
                className={selected === t.name ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm'}>
                {t.name}
                <span style={{ marginLeft: 6, fontSize: 11, opacity: 0.85 }}>
                  {t.registration.open ? '· reg open' : t.addDrop.open ? '· add/drop open' : '· closed'}
                </span>
              </button>
            ))}
          </div>
          {term && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 16 }}>
              <TermWindow term={term} which="registration" label="Registration window" reload={reload} toast={toast} />
              <TermWindow term={term} which="addDrop" label="Add / Drop window" reload={reload} toast={toast} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TermWindow({ term, which, label, reload, toast }) {
  const src = term[which] || {};
  const [w, setW] = useState({ enabled: !!src.enabled, opensAt: toLocalInput(src.opensAt), closesAt: toLocalInput(src.closesAt), note: src.note || '' });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const s = term[which] || {};
    setW({ enabled: !!s.enabled, opensAt: toLocalInput(s.opensAt), closesAt: toLocalInput(s.closesAt), note: s.note || '' });
  }, [term._id, which]); // eslint-disable-line

  const save = async () => {
    setSaving(true);
    try {
      const payload = { [which]: {
        enabled: w.enabled, note: w.note,
        opensAt: w.opensAt ? new Date(w.opensAt).toISOString() : null,
        closesAt: w.closesAt ? new Date(w.closesAt).toISOString() : null,
      } };
      const r = await api.put(`/admin/terms/${term._id}`, payload);
      const st = r.data.term[which];
      toast.success(`${label} ${st.open ? 'is now OPEN' : (st.enabled ? 'saved (scheduled/closed)' : 'closed')}.`);
      reload();
    } catch (err) { toast.error(errMsg(err, 'Could not save.')); }
    finally { setSaving(false); }
  };

  const live = term[which] || {};
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <CalendarClock size={15} style={{ color: 'var(--brand-600)' }} />
        <b style={{ fontSize: 13.5 }}>{label}</b>
        <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
          color: live.open ? '#2f855a' : '#c53030', background: live.open ? '#e7f5ec' : '#fdeaea' }}>
          {live.open ? 'OPEN' : 'CLOSED'}
        </span>
      </div>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, marginBottom: 10 }}>
        <input type="checkbox" checked={w.enabled} onChange={(e) => setW({ ...w, enabled: e.target.checked })} /> Enable this window
      </label>
      <div style={{ display: 'grid', gap: 10, opacity: w.enabled ? 1 : 0.55 }}>
        <Field label="Opens at"><input type="datetime-local" className="input" value={w.opensAt} disabled={!w.enabled} onChange={(e) => setW({ ...w, opensAt: e.target.value })} /></Field>
        <Field label="Closes at (extend anytime)"><input type="datetime-local" className="input" value={w.closesAt} disabled={!w.enabled} onChange={(e) => setW({ ...w, closesAt: e.target.value })} /></Field>
        <Field label="Note to students"><input className="input" value={w.note} disabled={!w.enabled} onChange={(e) => setW({ ...w, note: e.target.value })} placeholder="optional" /></Field>
      </div>
      <button className="btn btn-primary btn-sm" disabled={saving} onClick={save} style={{ marginTop: 12 }}>
        {saving ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />} Save {label.split(' ')[0].toLowerCase()}
      </button>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--ink-700)', lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 4 }}>{label}</div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'block' }}>
      <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-faint)', marginBottom: 5 }}>{label}</span>
      {children}
    </label>
  );
}

function AssignTable({ title, icon: Icon, rows, cols, render, onRemove, onEdit, editId, empty }) {
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '13px 16px', borderBottom: '1px solid var(--border)' }}>
        <Icon size={16} style={{ color: 'var(--brand-600)' }} />
        <h3 style={{ margin: 0, fontSize: 14 }}>{title}</h3>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-faint)' }}>{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <EmptyState icon={Icon} title={empty} message="" />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>{[...cols, ''].map((h) => (
                <th key={h} style={{ textAlign: 'left', padding: '8px 14px', fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase' }}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const cells = render(r);
                return (
                  <tr key={r._id} style={{ borderTop: '1px solid var(--border)', background: editId === r._id ? '#fffbe6' : 'transparent' }}>
                    {cells.map((c, i) => (
                      <td key={i} style={{ padding: '9px 14px', fontWeight: i === cells.length - 1 ? 600 : 400 }}>{c || '—'}</td>
                    ))}
                    <td style={{ padding: '9px 14px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {onEdit && <button className="btn btn-ghost btn-sm" title="Edit" onClick={() => onEdit(r)} style={{ marginRight: 4 }}><Pencil size={14} /></button>}
                      <button className="btn btn-ghost btn-sm" title="Remove" onClick={() => onRemove(r._id)}><Trash2 size={14} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
