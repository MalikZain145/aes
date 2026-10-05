import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Pencil, Trash2, DoorOpen, FlaskConical, Building2, Users, Search } from 'lucide-react';
import api, { errMsg } from '../api/client';
import { useToast } from '../context/ToastContext';
import { PageHeader, Modal, ConfirmDialog, EmptyState, Loader } from '../components/ui';
import '../styles/table.css';
import './roomslabs.css';

// Department keys labs can serve (mirrors the scheduler's lab pools)
const DEPARTMENTS = [
  'CS', 'SE', 'AI', 'CYBERSEC', 'DS',
  'ENG', 'PHY', 'CHEM', 'BIO', 'DPT',
  'PHARM', 'MGMT', 'GENERAL',
];

const EMPTY_ROOM = { name: '', capacity: 40, building: '', examCapacity: '' };
const EMPTY_LAB = { name: '', capacity: 30, departments: [], examCapacity: '' };

export default function RoomsLabs() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState('rooms');

  const [rooms, setRooms] = useState([]);
  const [labs, setLabs] = useState([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_ROOM);
  const [saving, setSaving] = useState(false);
  const [toDelete, setToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, l] = await Promise.all([api.get('/rooms-labs/rooms'), api.get('/rooms-labs/labs')]);
      setRooms(r.data.items);
      setLabs(l.data.items);
    } catch (err) {
      toast.error(errMsg(err, 'Could not load rooms and labs.'));
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (params.get('new') === '1') {
      openNew('rooms');
      params.delete('new');
      setParams(params, { replace: true });
    }
  }, []); // eslint-disable-line

  const openNew = (which) => {
    setTab(which);
    setEditing(null);
    setForm(which === 'rooms' ? EMPTY_ROOM : EMPTY_LAB);
    setModalOpen(true);
  };

  const openEdit = (item) => {
    setEditing(item);
    if (tab === 'rooms') {
      setForm({ name: item.name, capacity: item.capacity, building: item.building || '', examCapacity: item.examCapacity || '' });
    } else {
      setForm({ name: item.name, capacity: item.capacity, departments: item.departments || [], examCapacity: item.examCapacity || '' });
    }
    setModalOpen(true);
  };

  const save = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { toast.error('Name is required.'); return; }
    if (!form.capacity || form.capacity < 1) { toast.error('Capacity must be at least 1.'); return; }
    setSaving(true);
    const base = tab === 'rooms' ? '/rooms-labs/rooms' : '/rooms-labs/labs';
    const noun = tab === 'rooms' ? 'Room' : 'Lab';
    try {
      if (editing) {
        await api.put(`${base}/${editing._id}`, form);
        toast.success(`${noun} "${form.name}" updated.`);
      } else {
        await api.post(base, form);
        toast.success(`${noun} "${form.name}" added successfully.`);
      }
      setModalOpen(false);
      load();
    } catch (err) {
      toast.error(errMsg(err, `Could not save the ${noun.toLowerCase()}.`));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    const base = tab === 'rooms' ? '/rooms-labs/rooms' : '/rooms-labs/labs';
    const noun = tab === 'rooms' ? 'Room' : 'Lab';
    try {
      await api.delete(`${base}/${toDelete._id}`);
      toast.success(`${noun} "${toDelete.name}" removed successfully.`);
      setToDelete(null);
      load();
    } catch (err) {
      toast.error(errMsg(err, `Could not remove the ${noun.toLowerCase()}.`));
    } finally {
      setDeleting(false);
    }
  };

  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleDept = (d) =>
    setForm((f) => {
      const current = f.departments || [];
      return {
        ...f,
        departments: current.includes(d)
          ? current.filter((x) => x !== d)
          : [...current, d],
      };
    });

  const list = (tab === 'rooms' ? rooms : labs).filter((x) =>
    !search.trim() || String(x.name).toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div>
      <PageHeader
        eyebrow="Manage"
        title="Rooms & Labs"
        subtitle="The physical spaces the scheduler assigns. Theory rooms host lectures; labs host practicals and only serve their listed departments."
        actions={
          <button className="btn btn-primary" onClick={() => openNew(tab)}>
            <Plus size={17} /> Add {tab === 'rooms' ? 'room' : 'lab'}
          </button>
        }
      />

      {/* Tabs */}
      <div className="rl-tabs">
        <button className={`rl-tab ${tab === 'rooms' ? 'active' : ''}`} onClick={() => setTab('rooms')}>
          <DoorOpen size={17} /> Theory Rooms
          <span className="rl-tab-count">{rooms.length}</span>
        </button>
        <button className={`rl-tab ${tab === 'labs' ? 'active' : ''}`} onClick={() => setTab('labs')}>
          <FlaskConical size={17} /> Labs
          <span className="rl-tab-count">{labs.length}</span>
        </button>
        <div className="rl-search">
          <Search size={15} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${tab === 'rooms' ? 'rooms' : 'labs'} (e.g. J212)`}
          />
          {search && <button className="rl-search-clear" onClick={() => setSearch('')} aria-label="Clear">×</button>}
        </div>
      </div>

      <div className="data-card">
        {loading ? (
          <Loader label="Loading rooms & labs…" minHeight={320} />
        ) : list.length === 0 ? (
          <EmptyState
            icon={tab === 'rooms' ? DoorOpen : FlaskConical}
            title={`No ${tab === 'rooms' ? 'rooms' : 'labs'} yet`}
            message={`Add your first ${tab === 'rooms' ? 'theory room' : 'lab'} to get started.`}
            action={<button className="btn btn-primary" onClick={() => openNew(tab)}><Plus size={16} /> Add {tab === 'rooms' ? 'room' : 'lab'}</button>}
          />
        ) : (
            <div className="data-scroll">
              <table className="data-table">
                <thead>
                  {tab === 'rooms' ? (
                    <tr>
                      <th>Room</th>
                      <th>Building</th>
                      <th style={{ textAlign: 'center' }}>Class Capacity</th>
                      <th style={{ textAlign: 'center' }}>Exam Capacity</th>
                      <th style={{ textAlign: 'right' }}>Actions</th>
                    </tr>
                  ) : (
                    <tr>
                      <th>Lab</th>
                      <th style={{ textAlign: 'center' }}>Class Capacity</th>
                      <th style={{ textAlign: 'center' }}>Exam Capacity</th>
                      <th>Departments served</th>
                      <th style={{ textAlign: 'right' }}>Actions</th>
                    </tr>
                  )}
                </thead>
                <tbody>
                  {list.map((item) => (
                    <tr key={item._id}>
                      <td><span className="cell-strong">{item.name}</span></td>
                      {tab === 'rooms' && <td className="muted">{item.building || '—'}</td>}
                      <td style={{ textAlign: 'center' }}>
                        <span className="cap-badge">{item.capacity}</span>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {item.examCapacity
                          ? <span className="cap-badge exam">{item.examCapacity}</span>
                          : <span className="faint">—</span>}
                      </td>
                      {tab === 'labs' && (
                        <td>
                          <div className="dept-pills">
                            {(item.departments || []).length === 0
                              ? <span className="faint">General</span>
                              : item.departments.map((d) => <span key={d} className="dept-pill">{d}</span>)}
                          </div>
                        </td>
                      )}
                      <td>
                        <div className="cell-actions">
                          <button className="row-action" onClick={() => openEdit(item)} aria-label="Edit"><Pencil size={15} /></button>
                          <button className="row-action danger" onClick={() => setToDelete(item)} aria-label="Delete"><Trash2 size={15} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>

      {/* Modal */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={`${editing ? 'Edit' : 'Add'} ${tab === 'rooms' ? 'room' : 'lab'}`}
        width={tab === 'labs' ? 560 : 480}
      >
        <form onSubmit={save}>
          <div className="form-grid">
            <div className="field field-full">
              <label>{tab === 'rooms' ? 'Room' : 'Lab'} name</label>
              <input
                className="input"
                placeholder={tab === 'rooms' ? 'I-301' : 'Software Lab 1'}
                value={form.name}
                onChange={(e) => setF('name', e.target.value)}
                autoFocus
              />
            </div>
            <div className="field">
              <label>Capacity</label>
              <input className="input" type="number" min="1" value={form.capacity} onChange={(e) => setF('capacity', parseInt(e.target.value, 10) || 0)} />
            </div>
            <div className="field">
              <label>Exam capacity <span className="faint">(students, optional)</span></label>
              <input className="input" type="number" min="1" placeholder="e.g. 42"
                value={form.examCapacity}
                onChange={(e) => setF('examCapacity', e.target.value === '' ? '' : (parseInt(e.target.value, 10) || 0))} />
            </div>
            {tab === 'rooms' ? (
              <div className="field">
                <label>Building <span className="faint">(optional)</span></label>
                <input className="input" placeholder="I Block" value={form.building} onChange={(e) => setF('building', e.target.value)} />
              </div>
            ) : null}
          </div>

          {tab === 'labs' && (
            <div className="field" style={{ marginTop: 16 }}>
              <label>Departments served <span className="faint">(none = general purpose)</span></label>
              <div className="chip-group" style={{ marginTop: 4 }}>
                {DEPARTMENTS.map((d) => (
                  <span
                    key={d}
                    className={`chip ${(form.departments || []).includes(d) ? 'on' : ''}`}
                    onClick={() => toggleDept(d)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && toggleDept(d)}
                  >
                    {d}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="form-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setModalOpen(false)} disabled={saving}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? <><span className="spinner" /> Saving…</> : editing ? 'Save changes' : `Add ${tab === 'rooms' ? 'room' : 'lab'}`}
            </button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={confirmDelete}
        loading={deleting}
        title={`Remove ${tab === 'rooms' ? 'room' : 'lab'}`}
        message={toDelete ? `Remove "${toDelete.name}"? The scheduler will no longer use this space.` : ''}
        confirmText={`Remove ${tab === 'rooms' ? 'room' : 'lab'}`}
      />
    </div>
  );
}
