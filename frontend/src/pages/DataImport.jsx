import { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Upload, FileSpreadsheet, CheckCircle2, AlertTriangle, Loader2,
  Database, Users, BookOpen, Layers, FileWarning, Trash2, GraduationCap, XCircle, Info, Table,
} from 'lucide-react';
import api, { errMsg } from '../api/client';
import { useToast } from '../context/ToastContext';
import { PageHeader } from '../components/ui';
import './dataimport.css';

export default function DataImport() {
  const toast = useToast();
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [replace, setReplace] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [report, setReport] = useState(null);       // column / row report (success or failure)
  const [failed, setFailed] = useState('');

  const pickFile = (f) => {
    if (!f) return;
    if (!/\.(xlsx|xls|csv)$/i.test(f.name)) {
      toast.error('Please choose an .xlsx, .xls or .csv file.');
      return;
    }
    setFile(f);
    setResult(null);
    setReport(null);
    setFailed('');
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    pickFile(e.dataTransfer.files?.[0]);
  };

  const upload = async () => {
    if (!file) { toast.error('Choose a dataset file first.'); return; }
    setUploading(true);
    setResult(null);
    setReport(null);
    setFailed('');
    try {
      const form = new FormData();
      form.append('dataset', file);
      form.append('replace', String(replace));
      const res = await api.post('/dataset/upload', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setResult(res.data);
      setReport(res.data.report || null);
      toast.success(`Imported ${res.data.coursesCreated} courses and ${res.data.teachersCreated} teachers.`);
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
    } catch (err) {
      const msg = errMsg(err, 'Dataset import failed.');
      toast.error(msg);
      setFailed(msg);
      setReport(err?.response?.data?.report || null);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow="Manage"
        title="Import Dataset"
        subtitle="Upload a course dataset (.xlsx) to load courses and teachers into the system. Use the same column format as the sample dataset — the data then drives every timetable and datesheet."
      />

      {/* Format help */}
      <motion.div className="di-format card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
        <div className="di-format-head">
          <FileSpreadsheet size={18} />
          <span>Accepted files</span>
        </div>
        <p className="di-format-note" style={{ marginTop: 0 }}>
          <strong>.xlsx, .xls or .csv</strong> — the report type is recognised from its column names (title rows above the header and extra sheets are fine).
          Common alternative names are accepted too, e.g. <span className="di-mono">Reg No</span> for Student ID or <span className="di-mono">Programme</span> for Academic Program.
          After every import you get a report of the columns that were read and the ones that are missing.
        </p>
        {[
          ['Student-wise registration report', ['Student ID', 'Student Name', 'Academic Program', 'Batch Intake', 'Courses with Names']],
          ['ERP class list', ['Code', 'Name', 'Academic Term', 'Primary Faculty', 'Enrolled Students', 'Program Batch']],
          ['Course-wise enrolment report', ['Course Code', 'Course Title', 'Credit Hours', 'Enrolled Students', 'Meta Details']],
          ['Timetable dataset', ['Code', 'Name', 'Class Section', 'Academic Term', 'Primary Faculty', 'Enrolled Students', 'Component', 'Program Batch', 'Credit Hours']],
        ].map(([label, cols]) => (
          <div key={label} style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 5 }}>{label}</div>
            <div className="di-format-cols">{cols.map((c) => <span className="di-col-chip" key={c}>{c}</span>)}</div>
          </div>
        ))}
        <p className="di-format-note">
          <strong>Primary Faculty</strong> may include the teacher's email and ID, e.g.
          <span className="di-mono"> name@abasynisb.edu.pk - CE-075 - Mr. Name</span> — these are imported automatically.
        </p>
      </motion.div>

      {/* Dropzone */}
      <motion.div
        className={`di-drop ${dragOver ? 'over' : ''} ${file ? 'has-file' : ''}`}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.05 }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          hidden
          onChange={(e) => pickFile(e.target.files?.[0])}
        />
        {file ? (
          <>
            <div className="di-drop-icon ok"><FileSpreadsheet size={30} /></div>
            <div className="di-drop-filename">{file.name}</div>
            <div className="di-drop-size">{(file.size / 1024).toFixed(0)} KB · click to change</div>
          </>
        ) : (
          <>
            <div className="di-drop-icon"><Upload size={30} /></div>
            <div className="di-drop-title">Drop your dataset here, or click to browse</div>
            <div className="di-drop-sub">.xlsx, .xls or .csv · up to 15 MB</div>
          </>
        )}
      </motion.div>

      {/* Replace toggle + action */}
      <div className="di-actions">
        <label className="di-replace">
          <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
          <span className="di-replace-box">{replace && <CheckCircle2 size={14} />}</span>
          <span className="di-replace-text">
            <strong>Replace all existing data</strong>
            <small>Wipes current courses & teachers before importing. Leave off to merge/add.</small>
          </span>
        </label>

        <button className="btn btn-primary di-upload-btn" onClick={upload} disabled={uploading || !file}>
          {uploading ? <><Loader2 size={17} className="spin" /> Importing…</> : <><Database size={17} /> Import dataset</>}
        </button>
      </div>

      {replace && (
        <div className="di-warning">
          <AlertTriangle size={16} />
          <span>Replace mode is on — all current courses and teachers will be deleted before import.</span>
        </div>
      )}

      {/* Result */}
      <AnimatePresence>
        {result && (
          <motion.div
            className="di-result card"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            <div className="di-result-head">
              <CheckCircle2 size={22} />
              <h3 className="font-display">Import complete</h3>
            </div>
            <div className="di-result-grid">
              <DiStat icon={BookOpen} value={result.coursesCreated} label="Courses added" />
              <DiStat icon={Users} value={result.teachersCreated} label="Teachers added" />
              <DiStat icon={Layers} value={result.autoSectioned} label="Auto-sectioned" />
              <DiStat icon={FileWarning} value={result.coursesSkipped} label="Skipped (duplicates)" />
            </div>
            {result.replaced && (
              <div className="di-result-note"><Trash2 size={14} /> Existing data was replaced.</div>
            )}
            <p className="di-result-foot">
              You can now generate a timetable or datesheet from this data.
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {failed && !result && (
        <div className="di-warning" style={{ marginTop: 18 }}>
          <XCircle size={16} />
          <span>{failed}</span>
        </div>
      )}
      {report && <ImportReport report={report} />}
    </div>
  );
}

/* What the import read and what is missing — shown after every upload. */
function ImportReport({ report }) {
  const box = { border: '1px solid var(--border, #e3e9e5)', borderRadius: 12, padding: '14px 16px', background: 'var(--surface, #fff)' };
  const chip = (bg, fg) => ({ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, padding: '4px 9px', borderRadius: 8, background: bg, color: fg, fontWeight: 600 });
  const h = { display: 'flex', alignItems: 'center', gap: 7, fontWeight: 800, fontSize: 14, marginBottom: 8 };

  // file not recognised: list the columns that were found on each sheet
  if (report.shape === 'unknown') {
    return (
      <div className="card" style={{ ...box, marginTop: 18 }}>
        <div style={h}><Table size={16} /> Columns found in the file</div>
        {(report.tried || []).map((s) => (
          <div key={s.sheet} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 12.5, color: 'var(--text-faint, #6c7b72)', marginBottom: 4 }}>Sheet “{s.sheet}”, header on row {s.headerRow}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {s.columns.length ? s.columns.map((c) => <span key={c} style={chip('#f1f3f2', '#3d4a43')}>{c}</span>) : <span style={{ fontSize: 12.5 }}>No column names.</span>}
            </div>
          </div>
        ))}
        <div style={{ fontSize: 12.5, color: 'var(--text-faint, #6c7b72)' }}>None of these match one of the accepted report types listed above.</div>
      </div>
    );
  }

  const cols = report.columns || { found: [], missing: [], ignored: [] };
  const rows = report.rows || { total: 0, used: 0, skipped: [], notes: [] };
  const d = report.data || {};
  const dataItems = [
    ['Students', d.students], ['Courses', d.courses], ['Course records (sections / components)', d.courseRecords],
    ['Teachers', d.teachers], ['Programs', d.programs], ['Batches', d.batches],
    ['Lab components', d.labs], ['Courses without a written paper', d.noExam], ['Courses not taught in a class slot', d.noTimetable],
  ].filter(([, v]) => v);
  const reqMissing = (cols.missing || []).filter((m) => m.required);
  const optMissing = (cols.missing || []).filter((m) => !m.required);

  return (
    <motion.div className="card" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} style={{ ...box, marginTop: 18, display: 'grid', gap: 14 }}>
      <div>
        <div style={{ ...h, fontSize: 15.5, marginBottom: 2 }}><Table size={17} /> Import report</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-faint, #6c7b72)' }}>
          Read as <strong>{report.shapeLabel}</strong> · sheet “{report.sheet}”{(report.sheets || []).length > 1 ? ` (of ${report.sheets.length})` : ''} · header on row {report.headerRow}
        </div>
      </div>

      {(report.warnings || []).length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          {report.warnings.map((w) => (
            <div key={w} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '9px 12px', borderRadius: 10, background: '#fdecea', color: '#8a1c1c', fontSize: 13 }}>
              <XCircle size={15} style={{ flexShrink: 0, marginTop: 2 }} /> <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      <div>
        <div style={h}><CheckCircle2 size={15} color="#0f5132" /> Data that came in</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {dataItems.length ? dataItems.map(([k, v]) => (
            <span key={k} style={chip('#e6f4ec', '#0f5132')}><strong>{Number(v).toLocaleString()}</strong>&nbsp;{k}</span>
          )) : <span style={{ fontSize: 13 }}>Nothing could be read.</span>}
        </div>
      </div>

      <div>
        <div style={h}><CheckCircle2 size={15} color="#0f5132" /> Columns read ({cols.found.length})</div>
        <div style={{ display: 'grid', gap: 5 }}>
          {cols.found.map((c) => (
            <div key={c.field} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <span style={chip('#e6f4ec', '#0f5132')}><CheckCircle2 size={12} /> {c.field}</span>
              {c.renamed && <span style={{ color: 'var(--text-faint, #6c7b72)' }}>from column “{c.column}”</span>}
              {c.emptyRows > 0 && (
                <span style={{ color: '#7a5b00' }}>· empty in {c.emptyRows.toLocaleString()} of {(c.filledRows + c.emptyRows).toLocaleString()} rows</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {(reqMissing.length > 0 || optMissing.length > 0) && (
        <div>
          <div style={h}><AlertTriangle size={15} color="#9c6500" /> Columns missing ({reqMissing.length + optMissing.length})</div>
          <div style={{ display: 'grid', gap: 7 }}>
            {[...reqMissing, ...optMissing].map((m) => (
              <div key={m.field} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13 }}>
                <span style={chip(m.required ? '#fdecea' : '#fff4d6', m.required ? '#8a1c1c' : '#7a5b00')}>
                  {m.required ? <XCircle size={12} /> : <AlertTriangle size={12} />} {m.field}{m.required ? ' (required)' : ''}
                </span>
                <span style={{ color: 'var(--text, #2b3530)', paddingTop: 3 }}>{m.impact}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {(cols.ignored || []).length > 0 && (
        <div>
          <div style={h}><Info size={15} /> Columns not used ({cols.ignored.length})</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {cols.ignored.map((c) => <span key={c} style={chip('#f1f3f2', '#3d4a43')}>{c}</span>)}
          </div>
        </div>
      )}

      <div>
        <div style={h}><FileSpreadsheet size={15} /> Rows</div>
        <div style={{ fontSize: 13, marginBottom: 6 }}>
          <strong>{rows.used.toLocaleString()}</strong> of {rows.total.toLocaleString()} rows imported
          {rows.total - rows.used > 0 ? <> · <strong style={{ color: '#8a1c1c' }}>{(rows.total - rows.used).toLocaleString()} skipped</strong></> : ''}
        </div>
        {[...(rows.skipped || []).map((s) => ({ ...s, kind: 'skip' })), ...(rows.notes || []).map((s) => ({ ...s, kind: 'note' }))].map((s) => (
          <div key={s.kind + s.reason} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, marginTop: 4 }}>
            {s.kind === 'skip' ? <XCircle size={13} color="#8a1c1c" style={{ marginTop: 2 }} /> : <Info size={13} color="#7a5b00" style={{ marginTop: 2 }} />}
            <span>
              <strong>{s.count.toLocaleString()}</strong> {s.kind === 'skip' ? 'skipped' : 'rows'} — {s.reason}
              {s.rows && s.rows.length > 0 && <span style={{ color: 'var(--text-faint, #6c7b72)' }}> (Excel rows {s.rows.join(', ')}{s.count > s.rows.length ? ', …' : ''})</span>}
            </span>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

function DiStat({ icon: Icon, value, label }) {
  return (
    <div className="di-stat">
      <Icon size={18} className="di-stat-icon" />
      <span className="di-stat-value">{value ?? 0}</span>
      <span className="di-stat-label">{label}</span>
    </div>
  );
}
