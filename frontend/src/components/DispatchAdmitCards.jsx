import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Mail, Upload, Loader2, CheckCircle2, AlertTriangle, Printer, FileSpreadsheet,
  ShieldCheck, X,
} from 'lucide-react';
import api, { errMsg } from '../api/client';
import { useToast } from '../context/ToastContext';
import './dispatch.css';

/**
 * Finance → fee-gated admit-card email dispatch.
 * Upload the fee-paid list; each PAID student is emailed just their own admit
 * card (extracted from the latest batch). Unpaid students are skipped; anyone
 * who could not be emailed is listed in a printable failure report.
 */
export default function DispatchAdmitCards() {
  const toast = useToast();
  const [batches, setBatches] = useState([]);
  const [batchId, setBatchId] = useState('');
  const [smtp, setSmtp] = useState(true);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const fileRef = useRef(null);

  const load = async () => {
    try {
      const res = await api.get('/finance/batches');
      setBatches(res.data.items || []);
      setSmtp(res.data.smtpConfigured);
      if (res.data.items?.length) setBatchId(res.data.items[0].id);
    } catch { /* silent */ }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  const dispatch = async () => {
    if (!file) return toast.error('Choose the fee-paid list first.');
    setBusy(true); setResult(null);
    try {
      const form = new FormData();
      form.append('feeList', file);
      if (batchId) form.append('batchId', batchId);
      const res = await api.post('/finance/dispatch', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      setResult(res.data);
      if (res.data.devMode) toast.success(`${res.data.dispatched} card(s) prepared (dev mode — not emailed yet).`);
      else toast.success(`Admit cards emailed — ${res.data.dispatched} sent${res.data.failedCount ? `, ${res.data.failedCount} failed` : ''}.`);
    } catch (err) {
      toast.error(errMsg(err, 'Dispatch failed.'));
    } finally { setBusy(false); }
  };

  const printFailures = () => {
    if (!result?.failed?.length) return;
    const rows = result.failed.map((f, i) => `<tr><td>${i + 1}</td><td>${f.regNo || ''}</td><td>${f.name || ''}</td><td>${f.dept || ''}</td><td>${f.email || '—'}</td><td>${f.reason || ''}</td></tr>`).join('');
    const w = window.open('', '_blank');
    w.document.write(`<html><head><title>Admit Cards — Failure Report</title>
      <style>body{font-family:Segoe UI,Arial,sans-serif;color:#12261c;padding:24px}
      h1{font-size:17px;margin:0}h2{font-size:13px;color:#198754;font-weight:600;margin:2px 0 2px}
      p{color:#842029;font-weight:600;margin:14px 0 8px}
      table{width:100%;border-collapse:collapse;font-size:12px}th{background:#0f5132;color:#fff;text-align:left;padding:7px 9px}
      td{border:1px solid #cbd5e0;padding:6px 9px}tr:nth-child(even) td{background:#f2f8f5}</style></head>
      <body><h1>Abasyn University Islamabad Campus</h1><h2>Abasyn University Examination System</h2>
      <p>Admit Cards failed to dispatch to the following students:</p>
      <table><thead><tr><th>#</th><th>Reg No</th><th>Name</th><th>Department</th><th>Email</th><th>Reason</th></tr></thead>
      <tbody>${rows}</tbody></table>
      <p style="color:#5c6b63;font-weight:400;margin-top:16px;font-size:11px">Generated ${new Date().toLocaleString()}</p>
      </body></html>`);
    w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
  };

  return (
    <div className="dsp card">
      <div className="dsp-head">
        <div className="dsp-head-ic"><Mail size={20} /></div>
        <div>
          <h3 className="font-display">Email admit cards (fee-gated)</h3>
          <p>Upload the fee-paid list — each paid student is emailed only their own admit card. Unpaid students are skipped.</p>
        </div>
      </div>

      {!smtp && (
        <div className="dsp-dev"><AlertTriangle size={14} /> Mail server not configured yet — running in <b>dev mode</b>: emails are saved to disk, not actually sent. Set the SMTP details to send for real.</div>
      )}

      {batches.length === 0 ? (
        <div className="dsp-empty"><FileSpreadsheet size={16} /> No admit-card batch found yet. Generate admit cards above first, then dispatch.</div>
      ) : (
        <>
          <div className="dsp-row">
            <label className="dsp-label">Admit-card batch</label>
            <select className="input" value={batchId} onChange={(e) => setBatchId(e.target.value)}>
              {batches.map((b) => (
                <option key={b.id} value={b.id}>{b.title} · {b.students} students · {new Date(b.createdAt).toLocaleDateString()}</option>
              ))}
            </select>
          </div>

          <div className="dsp-row">
            <label className="dsp-label">Fee-paid list <span className="dsp-hint">(.xlsx / .xls / .csv — must have a Registration Number column; Email column optional)</span></label>
            <div className="dsp-file">
              <button className="btn btn-soft" onClick={() => fileRef.current?.click()} disabled={busy}>
                <Upload size={15} /> {file ? 'Change file' : 'Choose fee-paid list'}
              </button>
              {file && <span className="dsp-fname"><FileSpreadsheet size={14} /> {file.name} <button className="dsp-x" onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ''; }}><X size={13} /></button></span>}
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => setFile(e.target.files?.[0] || null)} />
            </div>
          </div>

          <button className="btn btn-primary dsp-go" onClick={dispatch} disabled={busy || !file}>
            {busy ? <><Loader2 size={16} className="spin" /> Dispatching…</> : <><Mail size={16} /> Email now</>}
          </button>
        </>
      )}

      <AnimatePresence>
        {result && (
          <motion.div className="dsp-result" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <div className="dsp-stats">
              <div className="dsp-stat ok"><b>{result.dispatched}</b><span>emailed now</span></div>
              {result.alreadyEmailed > 0 && <div className="dsp-stat"><b>{result.alreadyEmailed}</b><span>already emailed</span></div>}
              <div className={`dsp-stat ${result.failedCount ? 'warn' : ''}`}><b>{result.failedCount}</b><span>failed</span></div>
              <div className="dsp-stat"><b>{result.skippedUnpaid}</b><span>unpaid · skipped</span></div>
              <div className="dsp-stat"><b>{result.total}</b><span>in batch</span></div>
            </div>
            {result.devMode && <div className="dsp-dev"><ShieldCheck size={14} /> Dev mode: the {result.dispatched} card(s) were prepared and logged but not actually emailed (no SMTP configured).</div>}

            {result.failedCount > 0 ? (
              <div className="dsp-fail">
                <div className="dsp-fail-head">
                  <span><AlertTriangle size={15} /> Admit Cards failed to dispatch to the following students:</span>
                  <button className="btn btn-ghost btn-sm" onClick={printFailures}><Printer size={14} /> Print report</button>
                </div>
                <div className="dsp-tablewrap">
                  <table className="dsp-table">
                    <thead><tr><th>#</th><th>Reg No</th><th>Name</th><th>Department</th><th>Email</th><th>Reason</th></tr></thead>
                    <tbody>
                      {result.failed.map((f, i) => (
                        <tr key={i}><td>{i + 1}</td><td className="dsp-mono">{f.regNo}</td><td>{f.name || '—'}</td><td>{f.dept || '—'}</td><td>{f.email || '—'}</td><td className="dsp-reason">{f.reason}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="dsp-allok"><CheckCircle2 size={16} /> Admit cards has been dispatched successfully to all paid students.</div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
