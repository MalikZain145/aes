import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FileBarChart2, FileSpreadsheet, FileText, Download, Trash2, Eye,
  CalendarRange, CalendarClock, ShieldAlert, Loader2, X, CheckCircle2, AlertTriangle, Contact,
} from 'lucide-react';
import api, { errMsg } from '../api/client';
import { useToast } from '../context/ToastContext';
import { PageHeader, EmptyState, ConfirmDialog, Modal } from '../components/ui';
import { downloadFile } from '../api/download';
import './reports.css';

const FILTERS = [
  { key: '', label: 'All' },
  { key: 'timetable', label: 'Timetables' },
  { key: 'datesheet', label: 'Date Sheets' },
  { key: 'admit_cards', label: 'Admit Cards' },
  { key: 'clash_report', label: 'Clash Reports' },
];

const KIND_META = {
  timetable: { icon: CalendarRange, label: 'Timetable', tone: 'green' },
  datesheet: { icon: CalendarClock, label: 'Date Sheet', tone: 'brass' },
  admit_cards: { icon: Contact, label: 'Admit Cards', tone: 'green' },
  clash_report: { icon: ShieldAlert, label: 'Clash Report', tone: 'blue' },
};

export default function Reports() {
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [toDelete, setToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const [preview, setPreview] = useState(null);
  const [previewText, setPreviewText] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const clearAll = async () => {
    setClearing(true);
    try {
      const res = await api.delete('/generate/files');
      toast.success(`Cleared ${res.data.deleted} item(s). You can generate fresh now.`);
      setConfirmClear(false);
      load();
    } catch (err) {
      toast.error(errMsg(err, 'Could not clear.'));
    } finally {
      setClearing(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/generate/files', { params: { kind: filter } });
      setItems(res.data.items || []);
    } catch (err) {
      toast.error(errMsg(err, 'Could not load reports.'));
    } finally {
      setLoading(false);
    }
  }, [filter]); // eslint-disable-line

  useEffect(() => { load(); }, [load]);

  const handleDownload = async (record, file) => {
    setBusy(`${record._id}:${file.filename}`);
    try {
      await downloadFile(`/generate/files/${record._id}/download/${encodeURIComponent(file.filename)}`, file.filename);
    } catch (err) {
      toast.error(errMsg(err, 'Could not download the file.'));
    } finally {
      setBusy(null);
    }
  };

  const openPreview = async (record, file) => {
    setPreview({ record, file });
    setPreviewLoading(true);
    setPreviewText('');
    try {
      const res = await api.get(`/generate/files/${record._id}/preview/${encodeURIComponent(file.filename)}`);
      setPreviewText(res.data.content);
    } catch (err) {
      toast.error(errMsg(err, 'Could not load the preview.'));
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await api.delete(`/generate/files/${toDelete._id}`);
      toast.success('Report deleted.');
      setToDelete(null);
      load();
    } catch (err) {
      toast.error(errMsg(err, 'Could not delete the report.'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow="Review"
        title="Reports"
        subtitle="Every timetable, datesheet, admit-card set and clash report you've generated. Download the files or preview clash reports inline."
        actions={items.length > 0 && (
          <button className="btn btn-ghost" onClick={() => setConfirmClear(true)}>
            <Trash2 size={16} /> Clear all
          </button>
        )}
      />

      {/* Filter pills */}
      <div className="rep-filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`rep-filter ${filter === f.key ? 'active' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="rep-grid">
          {[1, 2, 3, 4].map((i) => <div key={i} className="skeleton rep-skel" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={FileBarChart2}
            title="No reports yet"
            message="Generate a timetable or datesheet and it will show up here."
          />
        </div>
      ) : (
        <div className="rep-grid">
          <AnimatePresence>
            {items.map((r) => {
              const meta = KIND_META[r.kind] || KIND_META.timetable;
              const Icon = meta.icon;
              const isClashFree = r.meta?.fullyClashFree;
              return (
                <motion.div
                  key={r._id}
                  className="rep-card"
                  layout
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ duration: 0.3 }}
                >
                  <div className="rep-card-head">
                    <div className={`rep-card-icon ${meta.tone}`}><Icon size={20} /></div>
                    <div className="rep-card-titles">
                      <span className="rep-card-kind">{meta.label}</span>
                      <span className="rep-card-date">{new Date(r.createdAt).toLocaleString()}</span>
                    </div>
                    <button className="rep-card-del" onClick={() => setToDelete(r)} aria-label="Delete"><Trash2 size={15} /></button>
                  </div>

                  <div className="rep-card-title">{r.title}</div>

                  {/* Status / summary line */}
                  {r.kind === 'timetable' && (
                    <div className={`rep-card-status ${isClashFree ? 'ok' : 'warn'}`}>
                      {isClashFree ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                      {isClashFree ? 'Clash-free' : `${r.summary?.total ?? 0} issue(s)`}
                      {r.meta?.theorySessions != null && (
                        <span className="rep-card-status-extra">· {r.meta.theorySessions + (r.meta.labSessions || 0)} sessions</span>
                      )}
                    </div>
                  )}
                  {r.kind === 'datesheet' && (
                    <div className="rep-card-status neutral">
                      <CalendarClock size={14} /> {r.summary?.courses ?? 0} papers · {r.summary?.days ?? 0} days
                    </div>
                  )}
                  {r.kind === 'admit_cards' && (
                    <div className={`rep-card-status ${r.summary?.seatsShort ? 'warn' : 'ok'}`}>
                      {r.summary?.seatsShort ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}
                      {r.summary?.admitCards ?? 0} cards · {r.summary?.sessions ?? 0} sessions
                      {r.summary?.seatsShort ? ` · ${r.summary.seatsShort} seats short` : ''}
                    </div>
                  )}
                  {r.kind === 'clash_report' && (
                    <div className={`rep-card-status ${isClashFree ? 'ok' : 'warn'}`}>
                      {isClashFree ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                      {isClashFree ? 'No conflicts found' : 'Conflicts detected'}
                    </div>
                  )}

                  {/* File actions */}
                  <div className="rep-card-files">
                    {r.files.map((f) => (
                      <div className="rep-file-row" key={f.filename}>
                        <div className="rep-file-info">
                          <span className={`rep-file-badge ${f.format}`}>
                            {f.format === 'xlsx' ? <FileSpreadsheet size={13} /> : <FileText size={13} />}
                            {f.format.toUpperCase()}
                          </span>
                          <span className="rep-file-label">{f.label}</span>
                        </div>
                        <div className="rep-file-actions">
                          {f.format === 'txt' && (
                            <button className="rep-file-btn" onClick={() => openPreview(r, f)} title="Preview"><Eye size={15} /></button>
                          )}
                          <button
                            className="rep-file-btn"
                            onClick={() => handleDownload(r, f)}
                            disabled={busy === `${r._id}:${f.filename}`}
                            title="Download"
                          >
                            {busy === `${r._id}:${f.filename}` ? <Loader2 size={15} className="spin" /> : <Download size={15} />}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      {/* Preview modal */}
      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview?.record?.title || 'Report preview'} width={760}>
        {previewLoading ? (
          <div className="rep-preview-loading"><Loader2 size={22} className="spin" /> Loading report…</div>
        ) : (
          <pre className="rep-preview">{previewText}</pre>
        )}
        {!previewLoading && preview && (
          <div className="form-actions">
            <button className="btn btn-primary" onClick={() => handleDownload(preview.record, preview.file)}>
              <Download size={16} /> Download full report
            </button>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={confirmDelete}
        loading={deleting}
        title="Delete report"
        message={toDelete ? `Delete "${toDelete.title}"? The generated files will be removed from disk.` : ''}
        confirmText="Delete report"
      />

      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={clearAll}
        loading={clearing}
        title="Clear all generated items"
        message="Delete ALL timetables, datesheets, admit cards and clash reports (and their QR records) so you can start fresh? This cannot be undone."
        confirmText="Clear everything"
      />
    </div>
  );
}
