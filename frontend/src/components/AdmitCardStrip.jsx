import { useState, useEffect, useRef, useMemo } from 'react';
import {
  Contact, LayoutGrid, ClipboardList, UserCheck, Download, Clock, Tag, Loader2, Printer,
  Search, X, Eye, BookOpen, Users, DoorOpen, CalendarDays, FileSpreadsheet, Layers, CheckCircle2,
} from 'lucide-react';
import api from '../api/client';
import { downloadFile } from '../api/download';
import useDebounce from '../api/useDebounce';
import './admitCardStrip.css';

/* Admit-card strip for the ADMIN dashboard. Finance generates + emails the cards;
   this surfaces the latest batch's documents, and a COURSE SEARCH: type a course
   code → that course's identification sheets, admit cards, invigilation and
   seating plan, filtered from the issued batch (click to download, eye to view). */
function docMeta(label = '') {
  const l = label.toLowerCase();
  if (l.includes('seating')) return { icon: LayoutGrid, name: 'Seating Plan' };
  if (l.includes('identif')) return { icon: ClipboardList, name: 'Identification Sheets' };
  if (l.includes('invigil')) return { icon: UserCheck, name: 'Invigilation Roster' };
  return { icon: Contact, name: 'Admit Cards' };
}

const COURSE_DOCS = [
  { key: 'idsheets', name: 'Identification Sheets', icon: ClipboardList },
  { key: 'cards', name: 'Admit Cards', icon: Contact },
  { key: 'invigilation', name: 'Invigilation', icon: UserCheck },
  { key: 'seating', name: 'Seating Plan', icon: LayoutGrid },
];

const fmt = (d) => new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });

function openInline(url) {
  const base = (api.defaults.baseURL || '/api').replace(/\/$/, '');
  const token = localStorage.getItem('abasyn_token') || '';
  const sep = url.includes('?') ? '&' : '?';
  window.open(`${base}${url}${token ? `${sep}token=${encodeURIComponent(token)}` : ''}`, '_blank', 'noopener');
}

export default function AdmitCardStrip() {
  const [batches, setBatches] = useState([]);
  const [busy, setBusy] = useState(false);

  // course search
  const [q, setQ] = useState('');
  const dq = useDebounce(q, 250);
  const [sugs, setSugs] = useState([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [hi, setHi] = useState(0);
  const [course, setCourse] = useState(null);      // selected course summary
  const [courseErr, setCourseErr] = useState('');
  const [loadingCourse, setLoadingCourse] = useState(false);
  const [docBusy, setDocBusy] = useState('');
  const boxRef = useRef(null);

  useEffect(() => {
    let alive = true;
    api.get('/generate/files', { params: { kind: 'admit_cards' } })
      .then((res) => { if (alive) setBatches(res.data.items || []); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    const term = dq.trim();
    if (!term) { setSugs([]); return undefined; }
    setSearching(true);
    api.get('/generate/admit-course/search', { params: { q: term } })
      .then((res) => { if (alive) { setSugs(res.data.items || []); setHi(0); } })
      .catch(() => { if (alive) setSugs([]); })
      .finally(() => { if (alive) setSearching(false); });
    return () => { alive = false; };
  }, [dq]);

  useEffect(() => {
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const rec = batches[0];
  const files = useMemo(() => (rec?.files || []), [rec]);
  const [secBusy, setSecBusy] = useState(false);
  const [secMsg, setSecMsg] = useState('');
  const [sectionsAt, setSectionsAt] = useState(null);
  useEffect(() => { setSectionsAt(rec?.meta?.sectionsAppliedAt || null); }, [rec]);
  if (!rec) return null;   // nothing generated yet → hide the strip

  const pick = async (code) => {
    const c = String(code || '').trim();
    if (!c) return;
    setOpen(false);
    setQ(c.toUpperCase());
    setLoadingCourse(true);
    setCourseErr('');
    try {
      const res = await api.get(`/generate/admit-course/${encodeURIComponent(c)}`);
      setCourse(res.data);
    } catch (e) {
      setCourse(null);
      setCourseErr(e?.response?.data?.error || 'Could not open that course.');
    } finally {
      setLoadingCourse(false);
    }
  };

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, sugs.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(open && sugs[hi] ? sugs[hi].code : q); }
    else if (e.key === 'Escape') setOpen(false);
  };

  const clear = () => { setQ(''); setSugs([]); setCourse(null); setCourseErr(''); };

  const docUrl = (key) => `/generate/admit-course/${encodeURIComponent(course.code)}/pdf/${key}?batchId=${course.batch.id}`;
  const downloadDoc = async (d) => {
    setDocBusy(d.key);
    try { await downloadFile(`${docUrl(d.key)}&download=1&v=${Date.now()}`, `${course.code}_${d.name.replace(/\s+/g, '')}.pdf`); }
    finally { setTimeout(() => setDocBusy(''), 1200); }
  };

  const xlsx = async (url, name, key) => {
    setDocBusy(key);
    try { await downloadFile(`${url}${url.includes('?') ? '&' : '?'}v=${Date.now()}`, name); }
    finally { setTimeout(() => setDocBusy(''), 1200); }
  };

  const download = async (f) => {
    setBusy(true);
    try { await downloadFile(`/generate/files/${rec._id}/download/${encodeURIComponent(f.filename)}?v=${Date.now()}`, f.filename); }
    catch { /* ignore */ }
    finally { setBusy(false); }
  };

  // Question-Paper-Envelope tags PDF (all papers) — open for printing / saving.
  const applySections = async () => {
    setSecBusy(true); setSecMsg('');
    try {
      const res = await api.post(`/generate/admit-cards/${rec._id}/sections`, {}, { timeout: 0 });
      setSectionsAt(new Date().toISOString());
      setSecMsg(`${res.data.courses} multi-section courses · ${res.data.moved} seats re-ordered · download the PDFs again.`);
    } catch (e) {
      setSecMsg(e?.response?.data?.error || 'Could not apply sections.');
    } finally { setSecBusy(false); }
  };

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
      try { if (e?.response?.data instanceof Blob) { const t = await e.response.data.text(); const j = JSON.parse(t); alert(j.error || msg); return; } } catch { /**/ }
      alert(msg);
    } finally { setBusy(false); }
  };

  return (
    <div className="dash-card card acs" style={{ marginBottom: 18 }}>
      <div className="acs-head">
        <div className="acs-title">
          <Contact size={18} />
          <h2 className="dash-card-title">Admit Cards</h2>
        </div>
        <span className="acs-stamp"><Clock size={12} /> Generated {fmt(rec.createdAt)}</span>
        <span className="acs-count">{rec.summary?.admitCards ?? '—'} cards · generated by Finance</span>
      </div>

      {/* ── course search ── */}
      <div className="acs-search" ref={boxRef}>
        <div className="acs-search-box">
          <Search size={17} />
          <input
            value={q}
            onChange={(e) => { setQ(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKey}
            placeholder="Search a course code — e.g. CS114 — for its ID sheets, admit cards, invigilation & seating"
            aria-label="Search course code"
            autoComplete="off"
            spellCheck={false}
          />
          {searching && <Loader2 size={15} className="spin" />}
          {q && <button type="button" className="acs-clear" onClick={clear} aria-label="Clear"><X size={15} /></button>}
        </div>
        {open && q.trim() && (
          <div className="acs-sugs" role="listbox">
            {!searching && sugs.length === 0 && <div className="acs-sug-empty">No course in the admit cards matches “{q.trim()}”.</div>}
            {sugs.map((s, i) => (
              <button type="button" key={s.code} role="option" aria-selected={i === hi}
                className={`acs-sug ${i === hi ? 'hi' : ''}`} onMouseEnter={() => setHi(i)} onClick={() => pick(s.code)}>
                <span className="acs-sug-code">{s.code}</span>
                <span className="acs-sug-name">{s.title || '—'}</span>
                <span className="acs-sug-meta">{s.students} students · {s.rooms.length} room{s.rooms.length === 1 ? '' : 's'}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {loadingCourse && <div className="acs-course-loading"><Loader2 size={16} className="spin" /> Opening {q.toUpperCase()}…</div>}
      {courseErr && !loadingCourse && <div className="acs-course-err">{courseErr}</div>}
      {course && !loadingCourse && (
        <div className="acs-course">
          <div className="acs-course-head">
            <div className="acs-course-name">
              <BookOpen size={16} />
              <b>{course.code}</b>
              {course.title && <span>{course.title}</span>}
            </div>
            <div className="acs-course-facts">
              <span><Users size={13} /> {course.students} students</span>
              <span><DoorOpen size={13} /> {course.rooms.join(', ')}</span>
              {course.sittings.map((s) => (
                <span key={`${s.date}${s.slot}`}><CalendarDays size={13} /> {s.day ? `${s.day.slice(0, 3)}, ` : ''}{s.date} · {s.slot}</span>
              ))}
              {course.unpaid > 0 && <span className="warn">{course.unpaid} fee unpaid</span>}
            </div>
            {course.invigilators?.length > 0 && (
              <div className="acs-course-inv"><UserCheck size={13} /> {course.invigilators.join(' · ')}</div>
            )}
          </div>
          <div className="acs-course-docs">
            {COURSE_DOCS.map((d) => {
              const Icon = d.icon;
              return (
                <div key={d.key} className="acs-doc">
                  <button type="button" className="acs-doc-main" onClick={() => downloadDoc(d)} disabled={docBusy === d.key}
                    title={`Download ${d.name} of ${course.code}`}>
                    <span className="acs-doc-ic"><Icon size={17} /></span>
                    <span className="acs-doc-txt"><b>{d.name}</b><small>{course.code} · PDF</small></span>
                    {docBusy === d.key ? <Loader2 size={15} className="spin" /> : <Download size={15} className="acs-doc-dl" />}
                  </button>
                  <button type="button" className="acs-doc-eye" onClick={() => openInline(docUrl(d.key))} aria-label={`View ${d.name}`} title="View">
                    <Eye size={15} />
                  </button>
                </div>
              );
            })}
            <div className="acs-doc">
              <button type="button" className="acs-doc-main" onClick={() => xlsx(`/generate/admit-course/${encodeURIComponent(course.code)}/xlsx?batchId=${course.batch.id}`, `${course.code}_Invigilation.xlsx`, 'xl')}
                disabled={docBusy === 'xl'} title={`Editable Excel of ${course.code}'s invigilation`}>
                <span className="acs-doc-ic xl"><FileSpreadsheet size={17} /></span>
                <span className="acs-doc-txt"><b>Invigilation (Excel)</b><small>{course.code} · editable .xlsx</small></span>
                {docBusy === 'xl' ? <Loader2 size={15} className="spin" /> : <Download size={15} className="acs-doc-dl" />}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── full batch documents ── */}
      <div className="acs-section-label">All programs — full documents</div>
      <div className="acs-files">
        {files.map((f) => {
          const m = docMeta(f.label); const Icon = m.icon;
          return (
            <button key={f.filename} className="btn btn-ghost" onClick={() => download(f)} disabled={busy}
              style={{ justifyContent: 'flex-start', gap: 8 }}>
              <Icon size={15} /> {m.name} <Download size={13} style={{ marginLeft: 'auto', opacity: .6 }} />
            </button>
          );
        })}
        <button className="btn btn-ghost" onClick={() => xlsx(`/generate/invigilation-xlsx?batchId=${rec._id}`, 'Invigilation_Roster.xlsx', 'all')} disabled={busy || docBusy === 'all'}
          style={{ justifyContent: 'flex-start', gap: 8 }} title="Editable Excel of the whole invigilation roster">
          <FileSpreadsheet size={15} /> Invigilation (Excel) <Download size={13} style={{ marginLeft: 'auto', opacity: .6 }} />
        </button>
      </div>
      {/* Question-Paper-Envelope tags — print all, or save the PDF */}
      <div className="acs-tags">
        <span><Tag size={14} /> Question-paper envelope tags:</span>
        <button className="btn btn-primary btn-sm" onClick={() => tags(true)} disabled={busy}>
          {busy ? <Loader2 size={14} className="spin" /> : <Printer size={14} />} Print Tags
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => tags(false)} disabled={busy}>
          <Download size={14} /> Save Tags PDF
        </button>
      </div>
      {/* Sections kept apart: A seated first, then B, then C — re-print the issued batch */}
      <div className="acs-tags">
        <span><Layers size={14} /> Sections (A → B → C):</span>
        {sectionsAt
          ? <span className="acs-sec-ok"><CheckCircle2 size={13} /> applied {fmt(sectionsAt)}</span>
          : <span className="acs-sec-warn">not applied to these PDFs yet</span>}
        <button className="btn btn-ghost btn-sm" onClick={applySections} disabled={secBusy || busy}
          title="Re-order each multi-section course A → B → C and re-print the admit cards, seating plan, ID sheets and invigilation (takes a few minutes)">
          {secBusy ? <><Loader2 size={14} className="spin" /> Re-printing… (few minutes)</> : <><Layers size={14} /> {sectionsAt ? 'Re-apply sections' : 'Apply sections now'}</>}
        </button>
        {secMsg && <span className="acs-sec-msg">{secMsg}</span>}
      </div>
    </div>
  );
}
