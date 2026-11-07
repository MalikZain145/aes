import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  Layers, FolderArchive, Download, ChevronRight, CalendarClock, FileText, Folder, Archive, ClipboardCheck,
} from 'lucide-react';
import api, { errMsg } from '../api/client';
import { downloadFile } from '../api/download';
import { useToast } from '../context/ToastContext';
import { PageHeader, Loader, EmptyState } from '../components/ui';

const kb = (n) => (n ? `${(n / 1024).toFixed(0)} KB` : '');
const mb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : kb(n));
const FOLDER_ORDER = ['Date Sheets', 'Admit Cards', 'Seating Plans', 'Identification Sheets', 'Invigilation Roster', 'Analysis Reports', 'Admit Card Updates'];
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

export default function PreviousSemesters() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [terms, setTerms] = useState([]);
  const [openTerm, setOpenTerm] = useState(null);
  const [folders, setFolders] = useState(null);
  const [busy, setBusy] = useState('');
  const [exams, setExams] = useState([]);      // [{ term, exams: [...] }]

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [res, ex] = await Promise.all([api.get('/archive/terms'), api.get('/archive/exams').catch(() => ({ data: { terms: [] } }))]);
      setTerms(res.data.terms || []);
      setExams(ex.data.terms || []);
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

  // one archived exam → ZIP (fetched as a file so the server builds it once)
  const downloadExam = async (x) => {
    setBusy(`ex-${x.id}`);
    try {
      const r = await api.get(`/archive/exams/${x.id}/download`, { responseType: 'blob', timeout: 900000 });
      const cd = r.headers['content-disposition'] || '';
      const m = cd.match(/filename="?([^";]+)"?/i);
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a'); a.href = url; a.download = m ? m[1] : 'Exam_Archive.zip';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      let msg = 'Could not download the exam ZIP.';
      try { const j = JSON.parse(await err.response.data.text()); if (j.error) msg = j.error; } catch { /* not JSON */ }
      toast.error(msg);
    } finally { setBusy(''); }
  };
  const archiveNow = async () => {
    setBusy('run');
    try {
      const r = await api.post('/archive/exams/run', {}, { timeout: 900000 });
      const c = r.data.created || [];
      if (c.length) toast.success(`Archived ${c.length} exam${c.length > 1 ? 's' : ''}: ${c.map((x) => `${x.label} (${x.term})`).join(', ')}`);
      else toast.success('Nothing new to archive — every finished exam is already in the archive.');
      await load();
    } catch (err) { toast.error(errMsg(err, 'Could not archive the exams.')); }
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

      {/* ── Archived examinations ── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
          <Archive size={20} color="#0f5132" />
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontWeight: 800, fontSize: 15 }}>Archived examinations</div>
            <div style={{ fontSize: 12, color: 'var(--text-faint,#6c7b72)', marginTop: 2 }}>
              Each conducted exam (mids or finals, including an exam held again in the same semester) is kept here with its date sheets,
              admit cards, seating plans, identification sheets, invigilation roster and attendance. It is archived automatically
              when the next datesheet or admit cards are generated, and when a new term is opened.
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={archiveNow} disabled={busy === 'run'}
            title="Archive every exam whose last paper is over and that is not in the archive yet. Nothing in the live system is changed.">
            <ClipboardCheck size={15} /> {busy === 'run' ? 'Archiving…' : 'Archive conducted exams'}
          </button>
        </div>
        {!exams.length ? (
          <div style={{ fontSize: 13, color: 'var(--text-faint,#6c7b72)', padding: '6px 2px' }}>No exam archived yet.</div>
        ) : (
          <div style={{ display: 'grid', gap: 14 }}>
            {exams.map((g) => (
              <div key={g.term}>
                <div style={{ fontWeight: 800, fontSize: 13, color: '#0f5132', margin: '4px 0 6px', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <FolderArchive size={15} /> {g.term}
                </div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {g.exams.map((x) => (
                    <div key={x.id} style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', padding: '10px 12px',
                      border: '1px solid var(--border,#e5ece8)', borderRadius: 10, background: 'var(--surface-2,#f6fbf8)' }}>
                      <div style={{ flex: 1, minWidth: 220 }}>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>
                          {x.label}
                          {x.round > 1 && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#fff3cd', color: '#664d03' }}>Held again · #{x.round}</span>}
                          {!x.complete && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#e2e3e5', color: '#41464b' }}>Archived before it ended</span>}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-faint,#6c7b72)', marginTop: 2 }}>
                          {(x.stats.students || 0).toLocaleString()} students · {(x.stats.sittings || 0).toLocaleString()} student-papers · {x.stats.papers || 0} papers
                          · {x.stats.files || 0} files{x.stats.sizeBytes ? ` (${mb(x.stats.sizeBytes)})` : ''} · archived {fmtDate(x.createdAt)}
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                          {FOLDER_ORDER.filter((f) => x.folders[f]).concat(['Attendance', 'Records']).map((f) => (
                            <span key={f} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, padding: '2px 8px', borderRadius: 6, background: 'var(--surface,#fff)', border: '1px solid var(--border,#e5ece8)' }}>
                              <Folder size={11} /> {f}{x.folders[f] ? ` (${x.folders[f]})` : ''}
                            </span>
                          ))}
                        </div>
                      </div>
                      <button className="btn btn-primary btn-sm" onClick={() => downloadExam(x)} disabled={busy === `ex-${x.id}`}>
                        <Download size={15} /> {busy === `ex-${x.id}` ? 'Preparing ZIP…' : 'Download ZIP'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

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
