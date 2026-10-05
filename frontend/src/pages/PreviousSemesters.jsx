import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  Layers, FolderArchive, Download, ChevronRight, CalendarClock, FileText, Folder,
} from 'lucide-react';
import api, { errMsg } from '../api/client';
import { downloadFile } from '../api/download';
import { useToast } from '../context/ToastContext';
import { PageHeader, Loader, EmptyState } from '../components/ui';

const kb = (n) => (n ? `${(n / 1024).toFixed(0)} KB` : '');
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

export default function PreviousSemesters() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [terms, setTerms] = useState([]);
  const [openTerm, setOpenTerm] = useState(null);
  const [folders, setFolders] = useState(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/archive/terms');
      setTerms(res.data.terms || []);
    } catch (err) { toast.error(errMsg(err, 'Could not load previous semesters.')); }
    finally { setLoading(false); }
  }, [toast]);
  useEffect(() => { load(); }, [load]);

  const openFolders = async (term) => {
    if (openTerm === term) { setOpenTerm(null); setFolders(null); return; }
    setOpenTerm(term); setFolders(null); setBusy(`open-${term}`);
    try {
      const res = await api.get('/archive/files', { params: { term } });
      setFolders(res.data.folders || {});
    } catch (err) { toast.error(errMsg(err, 'Could not open the semester record.')); }
    finally { setBusy(''); }
  };

  const downloadZip = async (term) => {
    setBusy(`dl-${term}`);
    try {
      await downloadFile(`/archive/download?term=${encodeURIComponent(term)}`, `${term.replace(/[^A-Za-z0-9]+/g, '_')}_Record.zip`);
    } catch (err) { toast.error(errMsg(err, 'Could not download the ZIP.')); }
    finally { setBusy(''); }
  };

  if (loading) return <div style={{ padding: 40 }}><Loader label="Loading previous semesters…" /></div>;

  return (
    <div>
      <PageHeader
        eyebrow="Archive"
        title="Previous Semesters"
        subtitle="When you open a new academic term, the finishing term's whole record — date sheets, admit cards, seating plans, reports and timetables — is archived here. Open a semester to browse its folders, or download the entire semester as one ZIP."
      />

      {!terms.length ? (
        <div className="card"><EmptyState icon={Layers} title="No archived semesters yet"
          message="The moment you create a new term (People & Assignments → Terms), the current term's generated record moves here automatically." /></div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {terms.map((t) => {
            const open = openTerm === t.term;
            return (
              <motion.div key={t.term} className="card" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', cursor: 'pointer' }} onClick={() => openFolders(t.term)}>
                  <ChevronRight size={18} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: '.15s' }} />
                  <FolderArchive size={22} color="#0f5132" />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 800, fontSize: 15 }}>{t.term}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-faint,#6c7b72)', marginTop: 2 }}>
                      {t.records} record{t.records !== 1 ? 's' : ''} · {t.files} file{t.files !== 1 ? 's' : ''}
                      {t.latest ? ` · last generated ${fmtDate(t.latest)}` : ''}
                    </div>
                  </div>
                  <button className="btn btn-primary btn-sm" onClick={(e) => { e.stopPropagation(); downloadZip(t.term); }} disabled={busy === `dl-${t.term}`}>
                    <Download size={15} /> {busy === `dl-${t.term}` ? 'Zipping…' : 'Download ZIP'}
                  </button>
                </div>

                {open && (
                  <div style={{ borderTop: '1px solid var(--border,#e5ece8)', padding: 14, background: 'var(--surface-2,#f6fbf8)' }}>
                    {folders === null ? (
                      <Loader label="Opening…" />
                    ) : Object.keys(folders).length === 0 ? (
                      <div style={{ fontSize: 13, color: 'var(--text-faint)' }}>No files in this semester.</div>
                    ) : (
                      <div style={{ display: 'grid', gap: 12 }}>
                        {Object.entries(folders).map(([folder, recs]) => (
                          <div key={folder}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 800, fontSize: 13, color: '#0f5132', marginBottom: 6 }}>
                              <Folder size={15} /> {folder} <span style={{ color: 'var(--text-faint)', fontWeight: 500 }}>({recs.length})</span>
                            </div>
                            <div style={{ display: 'grid', gap: 4, paddingLeft: 20 }}>
                              {recs.map((r) => (
                                <div key={r.id} style={{ fontSize: 12.5 }}>
                                  <div style={{ fontWeight: 600 }}>{r.title}</div>
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, color: 'var(--text-faint,#6c7b72)', marginTop: 1 }}>
                                    {r.files.map((f, i) => (
                                      <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                                        <FileText size={11} /> {f.label || f.filename} {f.sizeBytes ? `· ${kb(f.sizeBytes)}` : ''}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-faint)', marginTop: 4 }}>
                          <CalendarClock size={13} /> Download the whole semester as one ZIP (folders kept intact).
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}
