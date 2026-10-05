import { useEffect, useRef, useState } from 'react';
import { Upload, Play, Loader2, CheckCircle2, AlertTriangle, XCircle, FileSpreadsheet, Trash2, FileBarChart2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import api, { errMsg } from '../api/client';
import { useToast } from '../context/ToastContext';
import { PageHeader } from '../components/ui';
import './examPipeline.css';

/**
 * One-click Exam Engine: upload the exam-office reports (any shape — student-wise,
 * class-wise, timetable, rooms), and the server builds BS · B.Tech · MS datesheets
 * on their fixed slots, ONE clash-free seating, admit cards, identification sheets
 * and the invigilation roster — then an independent audit must pass before anything
 * is published to Reports.
 */
const COHORTS = [
  { key: 'bs', label: 'BS (Undergraduate)' },
  { key: 'btech', label: 'B.Tech / BSc Eng. Tech' },
  { key: 'pg', label: 'MS / MPhil / PhD' },
];

export default function ExamPipeline() {
  const toast = useToast();
  const fileRef = useRef(null);
  const [files, setFiles] = useState([]);
  const [form, setForm] = useState({
    examType: 'finals', startDate: '', numDays: 7, maxPapersPerDay: 1,
    roomTurnoverMin: 30, timetable: false, updateExisting: false,
    sharedPaperPolicy: 'independent',
  });
  const [cohortDays, setCohortDays] = useState({ bs: '', btech: '', pg: '' });
  const [cohorts, setCohorts] = useState({ bs: true, btech: true, pg: true });
  const [job, setJob] = useState(null);
  const [starting, setStarting] = useState(false);
  const timer = useRef(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const addFiles = (list) => {
    const ok = [...list].filter((f) => /\.(xlsx|xls|csv)$/i.test(f.name));
    if (ok.length < list.length) toast.error('Only .xlsx, .xls or .csv files are accepted.');
    setFiles((prev) => [...prev, ...ok].slice(0, 10));
  };

  const poll = (id) => {
    clearInterval(timer.current);
    timer.current = setInterval(async () => {
      try {
        const { data } = await api.get(`/exam-pipeline/jobs/${id}`);
        setJob(data);
        if (data.status !== 'running') {
          clearInterval(timer.current);
          if (data.status === 'done') toast.success('Exam engine finished — audit CLEAN. Files are in Reports.');
          else if (data.status === 'audit_failed') toast.error('Audit found violations — nothing was published. See the audit report.');
          else toast.error(data.error || 'Exam engine failed.');
        }
      } catch (e) { /* transient */ }
    }, 2500);
  };
  useEffect(() => () => clearInterval(timer.current), []);

  const start = async () => {
    if (!form.startDate) { toast.error('Pick the first exam date.'); return; }
    setStarting(true);
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append('files', f));
      Object.entries(form).forEach(([k, v]) => fd.append(k, String(v)));
      const cs = {};
      Object.entries(cohortDays).forEach(([k, v]) => { if (Number(v) > 0) cs[k] = { num_days: Number(v) }; });
      fd.append('cohortSettings', JSON.stringify(cs));
      fd.append('cohorts', JSON.stringify(Object.keys(cohorts).filter((k) => cohorts[k])));
      const { data } = await api.post('/exam-pipeline/run', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setJob({ id: data.jobId, status: 'running', stage: 'queued', log: [] });
      poll(data.jobId);
    } catch (err) {
      toast.error(errMsg(err, 'Could not start the exam engine.'));
    } finally { setStarting(false); }
  };

  const running = job && job.status === 'running';
  const audit = job?.result?.audit;

  return (
    <div className="ep">
      <PageHeader
        eyebrow="Scheduling"
        title="Exam Engine"
        subtitle="Upload the registration reports and generate everything in one run: BS, B.Tech and MS datesheets (fixed slots), clash-free seating, admit cards, identification sheets and the invigilation roster — verified by an independent audit before publishing."
      />

      <div className="ep-grid">
        <section className="card ep-card">
          <h3><FileSpreadsheet size={16} /> Reports</h3>
          <div
            className="ep-drop"
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
          >
            <Upload size={20} />
            <span>Drop files or click — student-wise registration (required), class-wise enrolment, timetable dataset, rooms list</span>
            <input ref={fileRef} type="file" multiple accept=".xls,.xlsx,.csv" hidden onChange={(e) => addFiles(e.target.files)} />
          </div>
          {files.length > 0 && (
            <ul className="ep-files">
              {files.map((f, i) => (
                <li key={i}><span>{f.name}</span>
                  <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} title="Remove"><Trash2 size={14} /></button>
                </li>
              ))}
            </ul>
          )}
          <p className="ep-note">No file? The run uses the registrations already in the database. Uploaded data is ADDED to the database; existing records are left unchanged
            {' '}<label className="ep-inline"><input type="checkbox" checked={form.updateExisting} onChange={set('updateExisting')} /> refresh changed student registrations</label></p>
        </section>

        <section className="card ep-card">
          <h3>Exam window</h3>
          <div className="ep-fields">
            <label>Exam<select value={form.examType} onChange={set('examType')}><option value="finals">Final-Term</option><option value="mids">Mid-Term</option></select></label>
            <label>First exam date<input type="date" value={form.startDate} onChange={set('startDate')} /></label>
            <label>Exam days<input type="number" min="1" max="30" value={form.numDays} onChange={set('numDays')} /></label>
            <label>Papers per student per day<select value={form.maxPapersPerDay} onChange={set('maxPapersPerDay')}><option value="1">1 (2 only if unavoidable)</option><option value="2">up to 2</option></select></label>
            <label>Room turnover gap (min)<input type="number" min="0" max="120" value={form.roomTurnoverMin} onChange={set('roomTurnoverMin')} /></label>
            <label>Shared gen-ed papers<select value={form.sharedPaperPolicy} onChange={set('sharedPaperPolicy')}>
              <option value="independent">Each program its own paper/time</option>
              <option value="same_time">Same paper → same date & time</option>
            </select></label>
          </div>
          <div className="ep-cohorts">
            {COHORTS.map((c) => (
              <div key={c.key} className="ep-cohort">
                <label className="ep-inline"><input type="checkbox" checked={cohorts[c.key]} onChange={(e) => setCohorts({ ...cohorts, [c.key]: e.target.checked })} /> {c.label}</label>
                <input type="number" min="1" placeholder={`days (${form.numDays})`} value={cohortDays[c.key]}
                  onChange={(e) => setCohortDays({ ...cohortDays, [c.key]: e.target.value })} />
              </div>
            ))}
          </div>
          <label className="ep-inline"><input type="checkbox" checked={form.timetable} onChange={set('timetable')} /> Also build the weekly class timetable (needs class-wise + student-wise reports)</label>
          <button type="button" className="btn btn-primary ep-run" disabled={starting || running} onClick={start}>
            {running || starting ? <Loader2 size={16} className="spin" /> : <Play size={16} />} {running ? 'Running…' : 'Run exam engine'}
          </button>
        </section>
      </div>

      {job && (
        <section className="card ep-card ep-status">
          <h3>
            {job.status === 'running' && <Loader2 size={16} className="spin" />}
            {job.status === 'done' && <CheckCircle2 size={16} color="#198754" />}
            {job.status === 'audit_failed' && <AlertTriangle size={16} color="#b45309" />}
            {job.status === 'failed' && <XCircle size={16} color="#b02a37" />}
            {' '}{job.status === 'running' ? `Running — ${job.stage}` : job.status === 'done' ? 'Done — audit clean' : job.status === 'audit_failed' ? 'Audit failed — nothing published' : 'Failed'}
          </h3>
          {job.result?.datesheets && (
            <table className="ep-table">
              <thead><tr><th>Cohort</th><th>Papers</th><th>Days</th><th>Student clashes</th><th>Students with 2 papers/day</th></tr></thead>
              <tbody>
                {Object.entries(job.result.datesheets).map(([k, d]) => (
                  <tr key={k}><td>{COHORTS.find((c) => c.key === k)?.label || k}</td><td>{d.total_units}</td><td>{d.total_days}</td>
                    <td className={d.student_clashes ? 'bad' : 'ok'}>{d.student_clashes}</td><td>{d.students_two_same_day}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {audit && (
            <div className="ep-audit">
              <strong>Audit:</strong> {audit.clean ? 'all hard rules satisfied' : Object.entries(audit.hard_counts || {}).map(([k, v]) => `${k}: ${v}`).join(' · ')}
              {Object.keys(audit.soft_counts || {}).length > 0 && (
                <div className="ep-soft">Notes: {Object.entries(audit.soft_counts).map(([k, v]) => `${k}: ${v}`).join(' · ')}</div>
              )}
            </div>
          )}
          {job.records?.length > 0 && (
            <p><Link to="/reports"><FileBarChart2 size={14} /> Open Reports</Link> — {job.records.length} file set(s) recorded.</p>
          )}
          <pre className="ep-log">{(job.log || []).join('\n')}</pre>
        </section>
      )}
    </div>
  );
}
