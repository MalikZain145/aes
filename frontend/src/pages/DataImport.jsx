import { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Upload, FileSpreadsheet, CheckCircle2, AlertTriangle, Loader2,
  Database, Users, BookOpen, Layers, FileWarning, Trash2, GraduationCap,
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

  const pickFile = (f) => {
    if (!f) return;
    if (!/\.(xlsx|xls)$/i.test(f.name)) {
      toast.error('Please choose an .xlsx or .xls file.');
      return;
    }
    setFile(f);
    setResult(null);
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
    try {
      const form = new FormData();
      form.append('dataset', file);
      form.append('replace', String(replace));
      const res = await api.post('/dataset/upload', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setResult(res.data);
      toast.success(`Imported ${res.data.coursesCreated} courses and ${res.data.teachersCreated} teachers.`);
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
    } catch (err) {
      toast.error(errMsg(err, 'Dataset import failed.'));
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
          <span>Expected columns</span>
        </div>
        <div className="di-format-cols">
          {['Code', 'Name', 'Class Section', 'Academic Term', 'Primary Faculty', 'Enrolled Students', 'Component', 'Program Batch', 'Credit Hours'].map((c) => (
            <span className="di-col-chip" key={c}>{c}</span>
          ))}
        </div>
        <p className="di-format-note">
          <strong>Primary Faculty</strong> may include the teacher's email and ID, e.g.
          <span className="di-mono"> name@abasynisb.edu.pk - CE-075 - Mr. Name</span> — these are imported automatically.
          Classes over 50 students are auto-split into sections.
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
          accept=".xlsx,.xls"
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
            <div className="di-drop-sub">.xlsx or .xls · up to 15 MB</div>
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
    </div>
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
