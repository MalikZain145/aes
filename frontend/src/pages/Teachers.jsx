import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Search, Plus, Pencil, Trash2, Users } from 'lucide-react';
import api, { errMsg } from '../api/client';
import { useToast } from '../context/ToastContext';
import useDebounce from '../api/useDebounce';
import { PageHeader, Modal, ConfirmDialog, EmptyState, Loader } from '../components/ui';
import '../styles/table.css';

const EMPTY = { name: '', email: '', facultyId: '', department: '' };

export default function Teachers() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const debounced = useDebounce(search, 350);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [toDelete, setToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/teachers', { params: { search: debounced } });
      setItems(res.data.items);
      setTotal(res.data.total ?? res.data.items.length);
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

  const openNew = () => { setEditing(null); setForm(EMPTY); setModalOpen(true); };
  const openEdit = (t) => {
    setEditing(t);
    setForm({ name: t.name, email: t.email || '', facultyId: t.facultyId || '', department: t.department || '' });
    setModalOpen(true);
  };

  const save = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { toast.error('Teacher name is required.'); return; }
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/teachers/${editing._id}`, form);
        toast.success(`${form.name} updated.`);
      } else {
        await api.post('/teachers', form);
        toast.success(`${form.name} added.`);
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
        subtitle="The faculty roster used when assigning courses. A teacher is never double-booked across the timetable."
        actions={<button className="btn btn-primary" onClick={openNew}><Plus size={17} /> Add teacher</button>}
      />

      <div className="toolbar">
        <div className="toolbar-search">
          <Search size={17} />
          <input placeholder="Search by name, email or faculty ID…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="toolbar-spacer" />
        <span className="toolbar-count">{total} teacher{total !== 1 ? 's' : ''}</span>
      </div>

      <motion.div className="data-card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
        {loading ? (
          <Loader label="Loading faculty…" minHeight={320} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No teachers found"
            message={search ? 'Try a different search.' : 'Add your first teacher to get started.'}
            action={<button className="btn btn-primary" onClick={openNew}><Plus size={16} /> Add teacher</button>}
          />
        ) : (
          <div className="data-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Faculty ID</th>
                  <th>Department</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((t) => (
                  <tr key={t._id}>
                    <td><span className="cell-strong">{t.name}</span></td>
                    <td className="muted">{t.email || '—'}</td>
                    <td>{t.facultyId ? <span className="cell-code">{t.facultyId}</span> : '—'}</td>
                    <td className="muted">{t.department || '—'}</td>
                    <td>
                      <div className="cell-actions">
                        <button className="row-action" onClick={() => openEdit(t)} aria-label="Edit"><Pencil size={15} /></button>
                        <button className="row-action danger" onClick={() => setToDelete(t)} aria-label="Delete"><Trash2 size={15} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </motion.div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit teacher' : 'Add teacher'} width={500}>
        <form onSubmit={save}>
          <div className="form-grid">
            <div className="field field-full">
              <label>Full name</label>
              <input className="input" placeholder="Mr. Muhammad Salman" value={form.name} onChange={(e) => setF('name', e.target.value)} autoFocus />
            </div>
            <div className="field field-full">
              <label>Email <span className="faint">(optional)</span></label>
              <input className="input" type="email" placeholder="salman@abasyn.edu.pk" value={form.email} onChange={(e) => setF('email', e.target.value)} />
            </div>
            <div className="field">
              <label>Faculty ID <span className="faint">(optional)</span></label>
              <input className="input" placeholder="FAC-1234" value={form.facultyId} onChange={(e) => setF('facultyId', e.target.value)} />
            </div>
            <div className="field">
              <label>Department <span className="faint">(optional)</span></label>
              <input className="input" placeholder="Computer Science" value={form.department} onChange={(e) => setF('department', e.target.value)} />
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
