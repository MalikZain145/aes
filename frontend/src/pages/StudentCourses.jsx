import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Search, Pencil, Trash2, Check, X, ChevronLeft, ChevronRight, GraduationCap, Loader2, Download, FileText } from 'lucide-react';
import api, { errMsg } from '../api/client';
import { downloadFile } from '../api/download';
import { useToast } from '../context/ToastContext';
import useDebounce from '../api/useDebounce';
import { PageHeader, ConfirmDialog, EmptyState, Loader } from '../components/ui';
import '../styles/table.css';

export default function StudentCourses() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');           // `${reg}|${code}` being saved
  const [search, setSearch] = useState('');
  const dSearch = useDebounce(search, 350);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [edit, setEdit] = useState(null);         // { reg, code, value }
  const [confirm, setConfirm] = useState(null);   // { reg, code }
  const [updated, setUpdated] = useState(null);   // { reg, id, files:[{label,filename}] } — freshly re-printed PDFs

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/exam/student-courses', { params: { search: dSearch, page, limit: 40 } });
      setRows(res.data.items || []); setPages(res.data.pages || 1); setTotal(res.data.total || 0);
    } catch (e) { toast.error(errMsg(e)); } finally { setLoading(false); }
  }, [dSearch, page]); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [dSearch]);

  const doSave = async (reg, code, newCode) => {
    const nc = String(newCode || '').trim().toUpperCase();
    if (!nc) { toast.error('Enter the new course code.'); return; }
    setBusy(`${reg}|${code}`);
    try {
      const res = await api.post(`/exam/student-courses/${encodeURIComponent(reg)}/course`, { action: 'edit', code, newCode: nc });
      setEdit(null);
      toast.success(res.data.note || `${code} → ${nc}${res.data.admitUpdated ? ' — admit card updated' : ''}.`);
      if (res.data.downloads) setUpdated({ reg, syncing: res.data.financeSyncing, ...res.data.downloads });
      else if (res.data.pdfStale) toast.info('Re-generate the admit-card PDFs to refresh the printed documents.');
      load();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(''); }
  };
  const doDelete = async () => {
    const { reg, code } = confirm; setConfirm(null); setBusy(`${reg}|${code}`);
    try {
      const res = await api.post(`/exam/student-courses/${encodeURIComponent(reg)}/course`, { action: 'delete', code });
      toast.success(res.data.note || `${code} removed${res.data.admitUpdated ? ' — admit card updated' : ''}.`);
      if (res.data.downloads) setUpdated({ reg, syncing: res.data.financeSyncing, ...res.data.downloads });
      else if (res.data.pdfStale) toast.info('Re-generate the admit-card PDFs to refresh the printed documents.');
      load();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(''); }
  };

  return (
    <div>
      <PageHeader eyebrow="Exam Cell" title="Student Courses" icon={GraduationCap}
        subtitle="Every student's registered courses (registration-number order). Edit or delete a course — the admit card & seating update for that student only." />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '12px 0', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
          <Search size={15} style={{ position: 'absolute', left: 10, top: 11, color: 'var(--text-faint)' }} />
          <input className="input" style={{ paddingLeft: 32 }} placeholder="Search reg no, name, program or course…"
            value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <span style={{ fontSize: 13, color: 'var(--text-faint)' }}>{total} students</span>
      </div>

      {updated && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', margin: '0 0 14px', padding: '10px 14px', borderRadius: 10, background: 'var(--surface-2,#eef8f1)', border: '1px solid var(--brass,#198754)' }}>
          <FileText size={16} color="#198754" />
          <span style={{ fontSize: 13.5 }}>
            <b>{updated.reg}</b>'s updated admit card is ready — Finance's per-student card, print and email now serve this version too. Only this student's seat changed; no one else was moved.
            {updated.syncing ? " Finance's full batch PDF and seating plan are refreshing in the background (~1 min)." : ''}
          </span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginLeft: 'auto' }}>
            {(updated.files || []).map((f) => (
              <button key={f.filename} className="btn btn-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                onClick={() => downloadFile(`/generate/files/${updated.id}/download/${encodeURIComponent(f.filename)}`, f.filename)}>
                <Download size={13} /> {f.label}
              </button>
            ))}
            <button className="icon-btn" title="Dismiss" onClick={() => setUpdated(null)}><X size={14} /></button>
          </div>
        </div>
      )}

      {loading ? <Loader /> : rows.length === 0 ? (
        <EmptyState title="No students" message="Import the registration report under Import Data." />
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th style={{ width: 90 }}>Reg No</th><th style={{ width: 170 }}>Name</th><th style={{ width: 150 }}>Program</th><th>Registered courses</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.studentId}>
                  <td style={{ fontWeight: 700 }}>{r.studentId}</td>
                  <td>{r.name || '—'}</td>
                  <td style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>{r.program || '—'}</td>
                  <td>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {(r.courses || []).map((c) => {
                        const code = c.code; const cname = c.name;
                        const isEditing = edit && edit.reg === r.studentId && edit.code === code;
                        const isBusy = busy === `${r.studentId}|${code}`;
                        if (isEditing) {
                          return (
                            <span key={code} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--surface-2,#f2f8f5)', border: '1px solid var(--brass,#a97142)', borderRadius: 8, padding: '2px 6px' }}>
                              <input autoFocus className="input" style={{ height: 26, width: 92, fontSize: 12 }}
                                placeholder="New code" value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value.toUpperCase() })}
                                onKeyDown={(e) => { if (e.key === 'Enter') doSave(r.studentId, code, edit.value); if (e.key === 'Escape') setEdit(null); }} />
                              <button className="icon-btn" title="Save (name attaches automatically)" disabled={isBusy} onClick={() => doSave(r.studentId, code, edit.value)}>
                                {isBusy ? <Loader2 size={13} className="spin" /> : <Check size={13} color="#198754" />}
                              </button>
                              <button className="icon-btn" title="Cancel" onClick={() => setEdit(null)}><X size={13} /></button>
                            </span>
                          );
                        }
                        return (
                          <span key={code} className="course-chip" title={cname} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'var(--surface-2,#f2f8f5)', border: '1px solid var(--border)', borderRadius: 8, padding: '3px 8px', fontSize: 12.5 }}>
                            <b>{code}</b>{cname ? <span style={{ color: 'var(--text-faint)' }}>— {cname}</span> : null}
                            <button className="icon-btn" title="Edit — type the new course code, its name attaches automatically" disabled={!!busy} onClick={() => setEdit({ reg: r.studentId, code, value: code })}><Pencil size={12} /></button>
                            <button className="icon-btn" title="Delete course" disabled={!!busy} onClick={() => setConfirm({ reg: r.studentId, code })}>
                              {isBusy ? <Loader2 size={12} className="spin" /> : <Trash2 size={12} color="#c53030" />}
                            </button>
                          </span>
                        );
                      })}
                      {(r.courses || []).length === 0 && <span style={{ color: 'var(--text-faint)', fontSize: 12.5 }}>— none —</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: 14 }}>
          <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft size={14} /> Prev</button>
          <span style={{ fontSize: 13 }}>Page {page} of {pages}</span>
          <button className="btn btn-ghost btn-sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next <ChevronRight size={14} /></button>
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title="Delete this course?"
          message={`Remove ${confirm.code} from student ${confirm.reg}? If admit cards exist and the paper hasn't been sat yet, that paper is removed from this student's admit card and their seat is freed.`}
          confirmLabel="Delete" danger onConfirm={doDelete} onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
}
