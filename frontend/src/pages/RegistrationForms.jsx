import { useState, useEffect } from 'react';
import { Download, Loader2, Inbox, RefreshCw, FileText, FileStack } from 'lucide-react';
import api, { errMsg } from '../api/client';
import { useToast } from '../context/ToastContext';
import { PageHeader, EmptyState } from '../components/ui';

/**
 * Admin → "New Registration Forms". Shows every registration form by workflow
 * status; the HoD-approved ones can be downloaded as a single per-form PDF or a
 * per-batch sequential PDF (one student per page) for the Exam Cell.
 */
const FILTERS = [
  { key: 'approved', label: 'Approved' },
  { key: 'with_advisor', label: 'With advisor' },
  { key: 'with_hod', label: 'With HoD' },
  { key: 'returned_to_student', label: 'Returned' },
];

// Open an authenticated PDF endpoint (blob) in a new tab.
async function openPdf(url, toast) {
  try {
    const r = await api.get(url, { responseType: 'blob' });
    const blobUrl = URL.createObjectURL(new Blob([r.data], { type: 'application/pdf' }));
    window.open(blobUrl, '_blank');
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  } catch (err) {
    let msg = 'Could not open the PDF.';
    try { msg = JSON.parse(await err.response.data.text()).error || msg; } catch { /* keep */ }
    toast.error(msg);
  }
}

export default function RegistrationForms() {
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({});
  const [byBatch, setByBatch] = useState({});
  const [status, setStatus] = useState('approved');
  const [loading, setLoading] = useState(true);

  const load = async (st = status) => {
    setLoading(true);
    try {
      const [res, sum] = await Promise.all([
        api.get('/registrations', { params: { status: st } }),
        api.get('/registrations/summary'),
      ]);
      setItems(res.data.items || []);
      setCounts(sum.data.counts || {});
      setByBatch(sum.data.approvedByBatch || {});
    } catch (err) { toast.error(errMsg(err, 'Could not load registration forms.')); }
    finally { setLoading(false); }
  };
  useEffect(() => { load('approved'); }, []); // eslint-disable-line
  const pick = (st) => { setStatus(st); load(st); };

  const batches = Object.entries(byBatch);

  return (
    <div>
      <PageHeader
        eyebrow="Registrations"
        title="New Registration Forms"
        subtitle="Course-registration and add/drop forms flowing through the advisor and Head of Department. Approved forms can be downloaded for the Exam Cell."
        actions={<button className="btn btn-ghost" onClick={() => load()}><RefreshCw size={15} /> Refresh</button>}
      />

      {/* status filter chips */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {FILTERS.map((f) => (
          <button key={f.key} onClick={() => pick(f.key)} className={status === f.key ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm'}>
            {f.label}
            <span style={{ marginLeft: 6, opacity: 0.85, fontWeight: 700 }}>{counts[f.key] ?? 0}</span>
          </button>
        ))}
      </div>

      {/* per-batch PDF (approved only) */}
      {status === 'approved' && batches.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12 }}>
            <FileStack size={17} style={{ color: 'var(--brand-600)' }} />
            <h3 style={{ margin: 0, fontSize: 14 }}>Download approved forms — one PDF per batch</h3>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-ghost btn-sm" onClick={() => openPdf('/registrations/pdf', toast)}><Download size={14} /> All approved ({counts.approved || 0})</button>
            {batches.map(([b, n]) => (
              <button key={b} className="btn btn-ghost btn-sm" onClick={() => openPdf(`/registrations/pdf?batch=${encodeURIComponent(b)}`, toast)}>
                <Download size={14} /> {b} ({n})
              </button>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-faint)' }}><Loader2 size={22} className="spin" /> Loading…</div>
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState icon={Inbox} title="No forms in this stage"
            message="As students submit forms and advisors and HoDs act on them, they'll appear here under the matching status." />
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table className="vw-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  {['Reg No', 'Name', 'Batch', 'Semester', 'Courses', 'Advisor', 'HoD', 'Updated', ''].map((h) => (
                    <th key={h} style={{ background: 'var(--ink-700)', color: 'var(--on-dark)', textAlign: 'left', padding: '9px 11px', fontSize: 11.5, fontWeight: 700 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((f) => (
                  <tr key={f._id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 11px', fontFamily: 'ui-monospace,Menlo,monospace', fontWeight: 700, color: 'var(--ink-700)' }}>{f.regNo}</td>
                    <td style={{ padding: '8px 11px' }}>{f.name || '—'}</td>
                    <td style={{ padding: '8px 11px' }}>{f.batch || '—'}</td>
                    <td style={{ padding: '8px 11px' }}>{f.semester || '—'}</td>
                    <td style={{ padding: '8px 11px' }}>{(f.courses || []).length}</td>
                    <td style={{ padding: '8px 11px' }}>{f.advisorName || '—'}</td>
                    <td style={{ padding: '8px 11px' }}>{f.hodName || '—'}</td>
                    <td style={{ padding: '8px 11px', color: 'var(--text-faint)' }}>{new Date(f.approvedAt || f.updatedAt).toLocaleDateString()}</td>
                    <td style={{ padding: '8px 11px' }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => openPdf(`/registrations/${f._id}/pdf`, toast)}><FileText size={14} /> PDF</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
