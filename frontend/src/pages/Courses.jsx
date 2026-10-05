import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Search, Plus, Pencil, Trash2, BookOpen, ChevronLeft, ChevronRight } from 'lucide-react';
import api, { errMsg } from '../api/client';
import { useToast } from '../context/ToastContext';
import useDebounce from '../api/useDebounce';
import { PageHeader, Modal, ConfirmDialog, EmptyState, Loader } from '../components/ui';
import FancySelect from '../components/FancySelect';
import '../styles/table.css';

const EMPTY_FORM = {
  code: '', name: '', component: 'Lecture', section: '',
  programBatch: '', teacher: '', enrolled: 0, creditHours: 3,
};

export default function Courses() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const [items, setItems] = useState([]);
  const [programs, setPrograms] = useState([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [program, setProgram] = useState('');
  const [component, setComponent] = useState('');
  const [loading, setLoading] = useState(true);

  const debouncedSearch = useDebounce(search, 350);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [toDelete, setToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/courses', {
        params: { search: debouncedSearch, program, component, page, limit: 25 },
      });
      setItems(res.data.items);
      setTotal(res.data.total);
      setPages(res.data.pages);
    } catch (err) {
      toast.error(errMsg(err, 'Could not load courses.'));
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, program, component, page]); // eslint-disable-line

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.get('/courses/programs').then((res) => setPrograms(res.data.programs)).catch(() => {});
  }, []);

  // Open "new" modal if ?new=1
  useEffect(() => {
    if (params.get('new') === '1') {
      openNew();
      params.delete('new');
      setParams(params, { replace: true });
    }
  }, []); // eslint-disable-line

  useEffect(() => { setPage(1); }, [debouncedSearch, program, component]);

  const openNew = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setModalOpen(true);
  };

  const openEdit = (c) => {
    setEditing(c);
    setForm({
      code: c.code, name: c.name, component: c.component, section: c.section || '',
      programBatch: c.programBatch || '', teacher: c.teacher || '',
      enrolled: c.enrolled || 0, creditHours: c.creditHours ?? 3,
    });
    setModalOpen(true);
  };

  const save = async (e) => {
    e.preventDefault();
    if (!form.code.trim() || !form.name.trim()) {
      toast.error('Course code and name are required.');
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/courses/${editing._id}`, form);
        toast.success(`${form.name} updated.`);
      } else {
        await api.post('/courses', form);
        toast.success(`${form.name} added.`);
      }
      setModalOpen(false);
      load();
    } catch (err) {
      toast.error(errMsg(err, 'Could not save the course.'));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await api.delete(`/courses/${toDelete._id}`);
      toast.success(`${toDelete.name} removed.`);
      setToDelete(null);
      // If last item on page, step back
      if (items.length === 1 && page > 1) setPage((p) => p - 1);
      else load();
    } catch (err) {
      toast.error(errMsg(err, 'Could not remove the course.'));
    } finally {
      setDeleting(false);
    }
  };

  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div>
      <PageHeader
        eyebrow="Manage"
        title="Courses"
        subtitle="Every lecture and lab component the scheduler will place. Add, edit or remove courses — changes apply on the next generation."
        actions={<button className="btn btn-primary" onClick={openNew}><Plus size={17} /> Add course</button>}
      />

      <div className="toolbar">
        <div className="toolbar-search">
          <Search size={17} />
          <input
            placeholder="Search code, name, teacher or batch…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <FancySelect value={program} onChange={setProgram} options={programs} allLabel="All programmes" width={230} />
        <FancySelect value={component} onChange={setComponent} options={['Lecture', 'Lab']} allLabel="All types" width={150} />
        <div className="toolbar-spacer" />
        <span className="toolbar-count">{total} course{total !== 1 ? 's' : ''}</span>
      </div>

      <motion.div className="data-card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
        {loading ? (
          <Loader label="Loading courses…" minHeight={320} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title="No courses found"
            message={search || program || component ? 'Try changing your filters.' : 'Add your first course to get started.'}
            action={<button className="btn btn-primary" onClick={openNew}><Plus size={16} /> Add course</button>}
          />
        ) : (
          <>
            <div className="data-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Course</th>
                    <th>Type</th>
                    <th>Sec</th>
                    <th>Programme</th>
                    <th>Teacher</th>
                    <th style={{ textAlign: 'center' }}>Enr.</th>
                    <th style={{ textAlign: 'center' }}>Cr.</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((c) => (
                    <tr key={c._id}>
                      <td><span className="cell-code">{c.code}</span></td>
                      <td className="cell-name"><span className="cell-strong">{c.name}</span></td>
                      <td><span className={`comp-tag comp-${c.component.toLowerCase()}`}>{c.component}</span></td>
                      <td>{c.section || '—'}</td>
                      <td className="muted">{c.program}</td>
                      <td className={c.teacher === 'TBA' ? 'faint' : ''}>{c.teacher}</td>
                      <td style={{ textAlign: 'center' }}>{c.enrolled}</td>
                      <td style={{ textAlign: 'center' }}>{c.creditHours}</td>
                      <td>
                        <div className="cell-actions">
                          <button className="row-action" onClick={() => openEdit(c)} aria-label="Edit"><Pencil size={15} /></button>
                          <button className="row-action danger" onClick={() => setToDelete(c)} aria-label="Delete"><Trash2 size={15} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {pages > 1 && (
              <div className="pagination">
                <span className="pagination-info">Page {page} of {pages}</span>
                <div className="pagination-controls">
                  <button className="page-btn" disabled={page === 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft size={16} /></button>
                  <button className="page-btn" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}><ChevronRight size={16} /></button>
                </div>
              </div>
            )}
          </>
        )}
      </motion.div>

      {/* Add/Edit modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit course' : 'Add course'} width={560}>
        <form onSubmit={save}>
          <div className="form-grid">
            <div className="field">
              <label>Course code</label>
              <input className="input" placeholder="CS386" value={form.code} onChange={(e) => setF('code', e.target.value)} />
            </div>
            <div className="field">
              <label>Component</label>
              <FancySelect value={form.component} onChange={(v) => setF('component', v)} clearable={false} width="100%" options={['Lecture', 'Lab']} />
            </div>
            <div className="field field-full">
              <label>Course name</label>
              <input className="input" placeholder="Advance Database Management System" value={form.name} onChange={(e) => setF('name', e.target.value)} />
            </div>
            <div className="field">
              <label>Programme batch</label>
              <input className="input" placeholder="BSCS-Spring 24" value={form.programBatch} onChange={(e) => setF('programBatch', e.target.value)} />
            </div>
            <div className="field">
              <label>Section <span className="faint">(optional)</span></label>
              <input className="input" placeholder="A" maxLength={1} value={form.section} onChange={(e) => setF('section', e.target.value.toUpperCase())} />
            </div>
            <div className="field field-full">
              <label>Teacher <span className="faint">(leave blank for TBA)</span></label>
              <input className="input" placeholder="Mr. Muhammad Salman" value={form.teacher} onChange={(e) => setF('teacher', e.target.value)} />
            </div>
            <div className="field">
              <label>Enrolled students</label>
              <input className="input" type="number" min="0" value={form.enrolled} onChange={(e) => setF('enrolled', e.target.value)} />
            </div>
            <div className="field">
              <label>Credit hours</label>
              <input className="input" type="number" min="0" step="0.5" value={form.creditHours} onChange={(e) => setF('creditHours', e.target.value)} />
            </div>
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setModalOpen(false)} disabled={saving}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? <><span className="spinner" /> Saving…</> : editing ? 'Save changes' : 'Add course'}
            </button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={confirmDelete}
        loading={deleting}
        title="Remove course"
        message={toDelete ? `Remove "${toDelete.name}" (${toDelete.code})? This cannot be undone.` : ''}
        confirmText="Remove course"
      />
    </div>
  );
}
