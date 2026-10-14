import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Search, Plus, Pencil, Trash2, Users, ShieldCheck, RotateCcw } from 'lucide-react';
import api, { errMsg } from '../api/client';
import { useToast } from '../context/ToastContext';
import useDebounce from '../api/useDebounce';
import { PageHeader, Modal, ConfirmDialog, EmptyState, Loader } from '../components/ui';
import Switch from '../components/Switch';
import '../styles/table.css';
import ScrollX from '../components/ScrollX';

const EMPTY = { name: '', email: '', facultyId: '', department: '', designation: '', isVisiting: false, allowInvigilation: true };
const FILTERS = [
  ['all', 'All'],
  ['on', 'Invigilating'],
  ['off', 'No invigilation'],
  ['visiting', 'Visiting / Adjunct'],
];

// Invigilation duty rule by designation (same as the admit-card generator)
const dutyTier = (d) => {
  const s = String(d || '').toLowerCase();
  if (/\blab\b/.test(s)) return 'lab';
  if (/assist\w*\s*prof|asst\.?\s*prof/.test(s)) return 'asst';
  if (/lectur|lectut/.test(s)) return 'lect';
  if (/prof|dean/.test(s)) return 'senior';
  return s ? 'other' : 'lect';
};
const DUTY = { lab: 'Every exam day', lect: 'Up to 6 days', asst: '4–5 days', other: '4–5 days', senior: 'Only if needed' };

const canInvigilate = (t) => t.allowInvigilation !== false && !t.isVisiting;

export default function Teachers() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const [items, setItems] = useState([]);
  const [stats, setStats] = useState(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const debounced = useDebounce(search, 350);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [toDelete, setToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState({});          // per-row switch in flight
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/teachers', { params: { search: debounced } });
      setItems(res.data.items);
      if (res.data.stats) setStats(res.data.stats);
    } catch (err) {
      toast.error(errMsg(err, 'Could not load teachers.'));
    } finally {
      setLoading(false);
    }
  }, [debounced]); // eslint-disable-line

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (params.get('new') === '1') {
      openNew();
      params.delete('new');
      setParams(params, { replace: true });
    }
  }, []); // eslint-disable-line

  const shown = useMemo(() => items.filter((t) => (
    filter === 'all' ? true
      : filter === 'on' ? canInvigilate(t)
        : filter === 'off' ? !canInvigilate(t)
          : !!t.isVisiting
  )), [items, filter]);

  // master toggle: ON when every non-visiting teacher may invigilate
  const allOn = stats ? stats.allowed > 0 && stats.allowed === stats.total - stats.visiting : false;

  const openNew = () => { setEditing(null); setForm(EMPTY); setModalOpen(true); };
  const openEdit = (t) => {
    setEditing(t);
    setForm({
      name: t.name, email: t.email || '', facultyId: t.facultyId || '', department: t.department || '',
      designation: t.designation || '', isVisiting: !!t.isVisiting, allowInvigilation: canInvigilate(t),
    });
    setModalOpen(true);
  };

  const patchRow = (id, data) => setItems((list) => list.map((x) => (x._id === id ? { ...x, ...data } : x)));

  const setInvig = async (t, change) => {
    const prev = { isVisiting: !!t.isVisiting, allowInvigilation: t.allowInvigilation !== false };
    const next = { ...prev, ...change };
    if (next.isVisiting) next.allowInvigilation = false;
    patchRow(t._id, next);
    setBusy((b) => ({ ...b, [t._id]: true }));
    try {
      const res = await api.patch(`/teachers/${t._id}/invigilation`, change);
      patchRow(t._id, res.data.teacher);
      if (res.data.stats) setStats(res.data.stats);
    } catch (err) {
      patchRow(t._id, prev);
      toast.error(errMsg(err, 'Could not update the teacher.'));
    } finally {
      setBusy((b) => { const n = { ...b }; delete n[t._id]; return n; });
    }
  };

  const setAll = async (allow) => {
    setBulkBusy(true);
    try {
      const res = await api.post('/teachers/invigilation/all', { allow });
      setItems((list) => list.map((x) => (x.isVisiting ? { ...x, allowInvigilation: false } : { ...x, allowInvigilation: allow })));
      if (res.data.stats) setStats(res.data.stats);
      toast.success(allow ? 'Invigilation enabled for all faculty (visiting / adjunct stay off).' : 'Invigilation disabled for all faculty.');
    } catch (err) {
      toast.error(errMsg(err, 'Could not update all teachers.'));
    } finally {
      setBulkBusy(false);
    }
  };

  const resetDefaults = async () => {
    setBulkBusy(true);
    try {
      const res = await api.post('/teachers/invigilation/reset');
      if (res.data.stats) setStats(res.data.stats);
      await load();
      toast.success('Invigilation reset to the Faculty List — everyone on, except yellow rows and visiting / adjunct.');
    } catch (err) {
      toast.error(errMsg(err, 'Could not reset.'));
    } finally {
      setBulkBusy(false);
    }
  };

  const save = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { toast.error('Teacher name is required.'); return; }
    if (editing && form.facultyId && !/^\d{4}$/.test(form.facultyId.trim())) { toast.error('Faculty ID must be 4 digits.'); return; }
    setSaving(true);
    try {
      const body = { ...form, allowInvigilation: form.isVisiting ? false : form.allowInvigilation };
      if (!editing) delete body.facultyId;           // new teachers get a random 4-digit ID
      if (editing) {
        await api.put(`/teachers/${editing._id}`, body);
        toast.success(`${form.name} updated.`);
      } else {
        const res = await api.post('/teachers', body);
        const t = res.data.teacher || {};
        toast.success(`${form.name} added — Faculty ID ${t.facultyId || ''}${res.data.login ? ' · login created (faculty123)' : ''}.`);
      }
      setModalOpen(false);
      load();
    } catch (err) {
      toast.error(errMsg(err, 'Could not save the teacher.'));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await api.delete(`/teachers/${toDelete._id}`);
      toast.success(`${toDelete.name} removed.`);
      setToDelete(null);
      load();
    } catch (err) {
      toast.error(errMsg(err, 'Could not remove the teacher.'));
    } finally {
      setDeleting(false);
    }
  };

  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div>
      <PageHeader
        eyebrow="Manage"
        title="Teachers"
        subtitle="Faculty roster with 4-digit Faculty IDs. Only teachers with Allow Invigilation on (and not Visiting / Adjunct) are given exam duties."
        actions={<button className="btn btn-primary" onClick={openNew}><Plus size={17} /> Add teacher</button>}
      />

      {stats && (
        <div className="fac-stats">
          <div className="fac-stat"><b>{stats.total}</b><span>Faculty</span></div>
          <div className="fac-stat ok"><b>{stats.allowed}</b><span>Can invigilate</span></div>
          <div className="fac-stat err"><b>{stats.blocked}</b><span>No invigilation</span></div>
          <div className="fac-stat warn"><b>{stats.visiting}</b><span>Visiting / Adjunct</span></div>
        </div>
      )}

      <div className="toolbar">
        <div className="toolbar-search">
          <Search size={17} />
          <input placeholder="Search by name, email, faculty ID or designation…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select className="toolbar-select" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter">
          {FILTERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <div className="toolbar-spacer" />
        <div className="fac-bulk" title="Enable / disable invigilation for every teacher at once. Visiting / Adjunct faculty always stay off.">
          <ShieldCheck size={16} />
          <span>Allow invigilation — all <small>({allOn ? 'enabled' : 'disabled'})</small></span>
          <Switch checked={allOn} busy={bulkBusy} onChange={(v) => setAll(v)} label={allOn ? 'Disable invigilation for all' : 'Enable invigilation for all'} />
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={resetDefaults} disabled={bulkBusy}
          title="Allow invigilation exactly as the Faculty List says (yellow rows and visiting / adjunct off)">
          <RotateCcw size={14} /> Reset to Faculty List
        </button>
        <span className="toolbar-count">{shown.length} teacher{shown.length !== 1 ? 's' : ''}</span>
      </div>

      <motion.div className="data-card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
        {loading ? (
          <Loader label="Loading faculty…" minHeight={320} />
        ) : shown.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No teachers found"
            message={search || filter !== 'all' ? 'Try a different search or filter.' : 'Add your first teacher to get started.'}
            action={<button className="btn btn-primary" onClick={openNew}><Plus size={16} /> Add teacher</button>}
          />
        ) : (
          <ScrollX className="data-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Faculty ID</th>
                  <th>Name</th>
                  <th>Designation</th>
                  <th>Email</th>
                  <th>Department</th>
                  <th>Visiting/Adjunct</th>
                  <th>Allow Invigilation</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => {
                  const on = canInvigilate(t);
                  return (
                    <tr key={t._id}>
                      <td>{t.facultyId ? <span className="cell-code">{t.facultyId}</span> : '—'}</td>
                      <td className="fac-name">
                        <span className="cell-strong">{t.name}</span>
                      </td>
                      <td className="fac-desig">
                        {t.designation || '—'}
                        {(() => { const r = DUTY[dutyTier(t.designation)]; return r ? <span className={`fac-tier fac-tier-${dutyTier(t.designation)}`}>{r}</span> : null; })()}
                      </td>
                      <td className="muted">{t.email || '—'}</td>
                      <td className="muted">{t.department || '—'}</td>
                      <td>
                        <span className={`fac-sw ${t.isVisiting ? 'visit' : ''}`}>
                          <Switch size="sm" checked={!!t.isVisiting} busy={!!busy[t._id]} onChange={(v) => setInvig(t, { isVisiting: v })}
                            label={`Visiting / Adjunct — ${t.name}`} />
                          {t.isVisiting ? 'Yes' : 'No'}
                        </span>
                      </td>
                      <td>
                        <span className={`fac-sw ${on ? 'on' : ''}`}>
                          <Switch size="sm" checked={on} disabled={!!t.isVisiting} busy={!!busy[t._id]} onChange={(v) => setInvig(t, { allowInvigilation: v })}
                            label={`Allow invigilation — ${t.name}`}
                            title={t.isVisiting ? 'Visiting / Adjunct faculty cannot invigilate — switch Visiting off first' : undefined} />
                          {on ? 'Allowed' : 'Off'}
                        </span>
                      </td>
                      <td>
                        <div className="cell-actions">
                          <button className="row-action" onClick={() => openEdit(t)} aria-label="Edit"><Pencil size={15} /></button>
                          <button className="row-action danger" onClick={() => setToDelete(t)} aria-label="Delete"><Trash2 size={15} /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollX>
        )}
      </motion.div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit teacher' : 'Add teacher'} width={520}>
        <form onSubmit={save}>
          <div className="form-grid">
            <div className="field field-full">
              <label>Full name</label>
              <input className="input" placeholder="Mr. Muhammad Salman" value={form.name} onChange={(e) => setF('name', e.target.value)} autoFocus />
            </div>
            <div className="field field-full">
              <label>Email <span className="faint">(used as the faculty login)</span></label>
              <input className="input" type="email" placeholder="name@abasynisb.edu.pk" value={form.email} onChange={(e) => setF('email', e.target.value)} />
            </div>
            <div className="field">
              <label>Faculty ID</label>
              {editing
                ? <input className="input" inputMode="numeric" maxLength={4} placeholder="4 digits" value={form.facultyId} onChange={(e) => setF('facultyId', e.target.value.replace(/\D/g, '').slice(0, 4))} />
                : <input className="input" value="Assigned automatically" disabled />}
            </div>
            <div className="field">
              <label>Designation <span className="faint">(optional)</span></label>
              <input className="input" placeholder="Lecturer" value={form.designation} onChange={(e) => setF('designation', e.target.value)} />
            </div>
            <div className="field field-full">
              <label>Department <span className="faint">(optional)</span></label>
              <input className="input" placeholder="Computer Science" value={form.department} onChange={(e) => setF('department', e.target.value)} />
            </div>
            <div className="field field-full fac-checks">
              <div className="fac-check">
                <span>Visiting / Adjunct<small>Visiting / adjunct faculty never get invigilation duty.</small></span>
                <Switch checked={form.isVisiting} onChange={(v) => setForm((f) => ({ ...f, isVisiting: v, allowInvigilation: v ? false : f.allowInvigilation }))} label="Visiting / Adjunct" />
              </div>
              <div className="fac-check">
                <span>Allow invigilation<small>{form.isVisiting ? 'Switch Visiting off first.' : 'Off = no duty in any paper.'}</small></span>
                <Switch checked={!form.isVisiting && form.allowInvigilation} disabled={form.isVisiting} onChange={(v) => setF('allowInvigilation', v)} label="Allow invigilation" />
              </div>
            </div>
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setModalOpen(false)} disabled={saving}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? <><span className="spinner" /> Saving…</> : editing ? 'Save changes' : 'Add teacher'}
            </button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={confirmDelete}
        loading={deleting}
        title="Remove teacher"
        message={toDelete ? `Remove "${toDelete.name}"? Courses assigned to them will show as TBA.` : ''}
        confirmText="Remove teacher"
      />
    </div>
  );
}
