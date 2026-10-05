import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mail, Upload, Loader2, CheckCircle2, AlertTriangle, Users, GraduationCap, FileSpreadsheet, X } from 'lucide-react';
import api, { errMsg } from '../api/client';
import { useToast } from '../context/ToastContext';
import './dispatch.css';

/**
 * Exam Cell → email each student & teacher their OWN timetable (their courses
 * only). Repeat clicks are incremental — already-emailed recipients are skipped,
 * so only the still-missing ones are sent.
 */
export default function DispatchTimetables() {
  const toast = useToast();
  const [st, setSt] = useState(null);
  const [kind, setKind] = useState('both');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const fileRef = useRef(null);

  const load = async () => { try { setSt((await api.get('/timetable-email/status')).data); } catch { /* silent */ } };
  useEffect(() => { load(); }, []); // eslint-disable-line

  const dispatch = async () => {
    setBusy(true); setResult(null);
    try {
      const form = new FormData();
      form.append('kind', kind);
      if (file) form.append('studentList', file);
      const res = await api.post('/timetable-email/dispatch', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      setResult(res.data);
      const sent = (res.data.teachers?.sent || 0) + (res.data.students?.sent || 0);
      if (res.data.devMode) toast.info?.(`${sent} timetable(s) prepared — dev mode, not emailed yet.`) || toast.success(`${sent} prepared (dev mode — not sent).`);
      else toast.success(`Timetables emailed — ${sent} sent.`);
    } catch (err) { toast.error(errMsg(err, 'Timetable email failed.')); }
    finally { setBusy(false); }
  };

  const Group = ({ label, icon: Icon, g }) => g && (
    <div className="dsp-grp">
      <div className="dsp-grp-h"><Icon size={15} /> {label} <span className="dsp-grp-total">{g.total} total</span></div>
      <div className="dsp-stats">
        <div className="dsp-stat ok"><b>{g.sent}</b><span>emailed now</span></div>
        {g.alreadyEmailed > 0 && <div className="dsp-stat"><b>{g.alreadyEmailed}</b><span>already emailed</span></div>}
        {g.noEmail > 0 && <div className="dsp-stat warn"><b>{g.noEmail}</b><span>no email</span></div>}
        {g.noClasses > 0 && <div className="dsp-stat"><b>{g.noClasses}</b><span>no classes</span></div>}
        {g.failedCount > 0 && <div className="dsp-stat warn"><b>{g.failedCount}</b><span>failed</span></div>}
      </div>
    </div>
  );

  return (
    <div className="dsp card">
      <div className="dsp-head">
        <div className="dsp-head-ic"><Mail size={20} /></div>
        <div>
          <h3 className="font-display">Email personal timetables</h3>
          <p>Send every student and teacher only their own timetable. Clicking again sends only to those not emailed yet.</p>
        </div>
      </div>

      {st && !st.smtpConfigured && (
        <div className="dsp-dev"><AlertTriangle size={14} /> Mail server not configured — running in <b>dev mode</b> (emails saved to disk, not sent).</div>
      )}

      {st && !st.hasTimetable ? (
        <div className="dsp-empty"><FileSpreadsheet size={16} /> No timetable found. Generate a timetable first, then email it.</div>
      ) : (
        <>
          <div className="dsp-row">
            <div className="dsp-util-stats" style={{ display: 'flex', gap: 18, fontSize: 13, color: 'var(--text-soft)' }}>
              <span><b style={{ color: 'var(--ink-700)' }}>{st?.teachers ?? '—'}</b> teachers</span>
              <span><b style={{ color: 'var(--ink-700)' }}>{st?.students ?? '—'}</b> students</span>
            </div>
          </div>

          <div className="dsp-row">
            <label className="dsp-label">Send to</label>
            <div className="dsp-seg">
              {[['both', 'Students & Teachers'], ['teachers', 'Teachers only'], ['students', 'Students only']].map(([k, l]) => (
                <button key={k} className={`dsp-seg-btn ${kind === k ? 'active' : ''}`} onClick={() => setKind(k)}>{l}</button>
              ))}
            </div>
          </div>

          {kind !== 'teachers' && (
            <div className="dsp-row">
              <label className="dsp-label">Student email list <span className="dsp-hint">(optional — .xlsx/.csv with Registration Number + Email; else emails come from student accounts)</span></label>
              <div className="dsp-file">
                <button className="btn btn-soft" onClick={() => fileRef.current?.click()} disabled={busy}>
                  <Upload size={15} /> {file ? 'Change file' : 'Choose email list'}
                </button>
                {file && <span className="dsp-fname"><FileSpreadsheet size={14} /> {file.name} <button className="dsp-x" onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ''; }}><X size={13} /></button></span>}
                <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => setFile(e.target.files?.[0] || null)} />
              </div>
            </div>
          )}

          <button className="btn btn-primary dsp-go" onClick={dispatch} disabled={busy}>
            {busy ? <><Loader2 size={16} className="spin" /> Emailing…</> : <><Mail size={16} /> Email now</>}
          </button>
        </>
      )}

      <AnimatePresence>
        {result && (
          <motion.div className="dsp-result" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            {result.devMode && <div className="dsp-dev"><CheckCircle2 size={14} /> Dev mode: prepared &amp; logged but not actually emailed (no SMTP configured).</div>}
            <Group label="Teachers" icon={Users} g={result.teachers} />
            <Group label="Students" icon={GraduationCap} g={result.students} />
            <div className="dsp-allok"><CheckCircle2 size={16} /> Done. Re-run "Email now" any time — only recipients not yet emailed will receive it.</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
