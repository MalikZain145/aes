import { useState, useEffect } from 'react';
import { Contact, LayoutGrid, ClipboardList, UserCheck, Download, Clock, Tag, Loader2, Printer } from 'lucide-react';
import api from '../api/client';
import { downloadFile } from '../api/download';

/* Read-only admit-card strip for the ADMIN dashboard. Finance generates + emails
   the cards; this simply surfaces the latest batch's 4 documents to download.
   Admin never generates from here. Hidden until a batch exists. */
function docMeta(label = '') {
  const l = label.toLowerCase();
  if (l.includes('seating')) return { icon: LayoutGrid, name: 'Seating Plan' };
  if (l.includes('identif')) return { icon: ClipboardList, name: 'Identification Sheets' };
  if (l.includes('invigil')) return { icon: UserCheck, name: 'Invigilation Roster' };
  return { icon: Contact, name: 'Admit Cards' };
}

// A batch's cohort: prefer the stored meta.cohort, else derive from level/title.
const batchCohort = (b) => {
  const c = (b?.meta?.cohort || '').toLowerCase();
  if (c === 'bs' || c === 'btech' || c === 'pg') return c;
  const s = `${b?.meta?.programLevel || ''} ${b?.title || ''}`.toLowerCase();
  if (/post|mphil|\bms\b|master/.test(s)) return 'pg';
  if (/b\.?\s*tech|engineering tech|\btech\b/.test(s)) return 'btech';
  return 'bs';
};

export default function AdmitCardStrip() {
  const [batches, setBatches] = useState([]);
  const [level, setLevel] = useState('bs');   // bs | btech | pg
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api.get('/generate/files', { params: { kind: 'admit_cards' } })
      .then((res) => { if (alive) setBatches(res.data.items || []); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!batches.length) return null;   // nothing generated yet → hide the strip

  // Newest batch of the selected cohort; fall back to any batch if none of it.
  const rec = batches.find((b) => batchCohort(b) === level) || batches[0];
  if (!rec) return null;
  const recLevel = batchCohort(rec);

  const download = async (f) => {
    setBusy(true);
    try { await downloadFile(`/generate/files/${rec._id}/download/${encodeURIComponent(f.filename)}`, f.filename); }
    catch { /* ignore */ }
    finally { setBusy(false); }
  };

  // Question-Paper-Envelope tags PDF (all papers) — open for printing / saving.
  const tags = async (print) => {
    setBusy(true);
    try {
      const res = await api.get('/generate/tags', { params: { batchId: rec._id }, responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      if (print) {
        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
        iframe.src = url;
        iframe.onload = () => { try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch { window.open(url, '_blank'); } };
        document.body.appendChild(iframe);
        setTimeout(() => { URL.revokeObjectURL(url); iframe.remove(); }, 60000);
      } else {
        const a = document.createElement('a'); a.href = url; a.download = 'QuestionPaperTags.pdf'; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      }
    } catch (e) {
      const msg = e?.response?.data?.error || 'Could not generate tags.';
      // blob error bodies need reading
      try { if (e?.response?.data instanceof Blob) { const t = await e.response.data.text(); const j = JSON.parse(t); alert(j.error || msg); return; } } catch { /**/ }
      alert(msg);
    } finally { setBusy(false); }
  };

  return (
    <div className="dash-card card" style={{ marginBottom: 18 }}>
      <div className="dash-card-head" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Contact size={18} style={{ color: 'var(--brand-600,#198754)' }} />
        <h2 className="dash-card-title" style={{ margin: 0 }}>Admit Cards</h2>
        {/* BS / B.Tech / MS switch — each cohort has its own admit-card batch */}
        <div style={{ display: 'inline-flex', border: '1px solid var(--border,#d7e2db)', borderRadius: 8, overflow: 'hidden' }}>
          {[['bs', 'BS'], ['btech', 'B.Tech'], ['pg', 'MS']].map(([val, lbl]) => (
            <button key={val} onClick={() => setLevel(val)} type="button"
              style={{
                border: 'none', cursor: 'pointer', padding: '4px 12px', fontSize: 12, fontWeight: 800,
                background: level === val ? 'var(--brand-600,#198754)' : 'transparent',
                color: level === val ? '#fff' : 'var(--text-faint,#6c7b72)',
              }}>{lbl}</button>
          ))}
        </div>
        {recLevel !== level && (
          <span style={{ fontSize: 11.5, color: '#b45309', fontWeight: 700 }}>
            No {level === 'pg' ? 'MS' : level === 'btech' ? 'B.Tech' : 'BS'} batch yet — showing {recLevel === 'pg' ? 'MS' : recLevel === 'btech' ? 'B.Tech' : 'BS'}
          </span>
        )}
        <span style={{ fontSize: 12, color: 'var(--text-faint)', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Clock size={12} /> Generated {new Date(rec.createdAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-faint)' }}>
          {rec.summary?.admitCards ?? '—'} cards · generated by Finance
        </span>
      </div>
      <div style={{ padding: '4px 14px 14px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {(rec.files || []).map((f) => {
          const m = docMeta(f.label); const Icon = m.icon;
          return (
            <button key={f.filename} className="btn btn-ghost" onClick={() => download(f)} disabled={busy}
              style={{ justifyContent: 'flex-start', gap: 8 }}>
              <Icon size={15} /> {m.name} <Download size={13} style={{ marginLeft: 'auto', opacity: .6 }} />
            </button>
          );
        })}
      </div>
      {/* Question-Paper-Envelope tags — print all, or save the PDF */}
      <div style={{ padding: '0 14px 14px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12.5, color: 'var(--text-faint)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Tag size={14} /> Question-paper envelope tags:
        </span>
        <button className="btn btn-primary btn-sm" onClick={() => tags(true)} disabled={busy}>
          {busy ? <Loader2 size={14} className="spin" /> : <Printer size={14} />} Print Tags
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => tags(false)} disabled={busy}>
          <Download size={14} /> Save Tags PDF
        </button>
      </div>
    </div>
  );
}
