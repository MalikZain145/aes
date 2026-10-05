import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  CalendarRange, Sparkles, CheckCircle2, AlertTriangle, FileSpreadsheet,
  FileText, Download, Loader2, ShieldCheck, Layers, Users, GraduationCap,
  TriangleAlert, RefreshCw, Gauge, Lightbulb,
} from 'lucide-react';
import api, { errMsg } from '../api/client';
import { useToast } from '../context/ToastContext';
import { PageHeader, EmptyState } from '../components/ui';
import { downloadFile } from '../api/download';
import './generate.css';

const STEPS = [
  'Exporting live data from the database',
  'Building constraint model (teachers, rooms, labs)',
  'Placing lectures into theory slots',
  'Placing labs into lab slots',
  'Verifying all hard constraints',
  'Writing Excel & PDF outputs',
];

export default function Timetable() {
  const toast = useToast();
  const [generating, setGenerating] = useState(false);
  const [level, setLevel] = useState('ug');   // ug = undergrad Mon-Fri; pg = MS Sat/Sun
  const [step, setStep] = useState(0);
  const [result, setResult] = useState(null);
  const [lastRecord, setLastRecord] = useState(null);
  const [busyFile, setBusyFile] = useState(null);

  // Load the most recent timetable so the page isn't empty on return
  const loadLast = useCallback(async (lvl) => {
    try {
      const res = await api.get('/generate/files', { params: { kind: 'timetable' } });
      const items = res.data.items || [];
      // BS (ug) and MS (pg) timetables coexist — show the newest one for the
      // selected level. Older records (before meta.level existed) are treated as ug.
      const match = items.find((x) => (x.meta?.level || 'ug') === lvl);
      const r = match || null;
      setLastRecord(r);
      if (r) {
        setResult({
          fullyClashFree: r.meta?.fullyClashFree,
          accuracy: r.meta?.accuracy,
          clashes: r.summary,
          stats: r.meta,
          capacityAdvisor: r.meta?.capacityAdvisor,
          record: r,
        });
      } else {
        setResult(null);
      }
    } catch { /* ignore */ }
  }, []);

  // Reload whenever the BS/MS switch changes so the view follows the toggle.
  useEffect(() => { loadLast(level); }, [loadLast, level]);

  // Animate the step ticker while generating
  useEffect(() => {
    if (!generating) return;
    setStep(0);
    const id = setInterval(() => {
      setStep((s) => (s < STEPS.length - 1 ? s + 1 : s));
    }, 1400);
    return () => clearInterval(id);
  }, [generating]);

  const generate = async () => {
    setGenerating(true);
    setResult(null);
    try {
      const res = await api.post('/generate/timetable', { level }, { timeout: 30 * 60 * 1000 });
      setResult({ ...res.data.summary, record: res.data.record });
      setLastRecord(res.data.record);
      if (res.data.summary.fullyClashFree) {
        toast.success('Timetable generated — completely clash-free.');
      } else {
        toast.warning(`Timetable generated with ${res.data.summary.clashes?.total ?? 0} issue(s).`);
      }
    } catch (err) {
      toast.error(errMsg(err, 'Timetable generation failed.'));
    } finally {
      setGenerating(false);
    }
  };

  const handleDownload = async (file) => {
    const rec = result?.record || lastRecord;
    if (!rec) return;
    setBusyFile(file.filename);
    try {
      await downloadFile(`/generate/files/${rec._id}/download/${encodeURIComponent(file.filename)}`, file.filename);
    } catch (err) {
      toast.error(errMsg(err, 'Could not download the file.'));
    } finally {
      setBusyFile(null);
    }
  };

  const clashes = result?.clashes || {};
  const stats = result?.stats || {};
  const files = (result?.record || lastRecord)?.files || [];
  const clashFree = result?.fullyClashFree;

  return (
    <div>
      <PageHeader
        eyebrow="Generate"
        title="Weekly Timetable"
        subtitle="Generate a conflict-free weekly timetable from your current courses, teachers, rooms and labs. Every run uses the latest data."
      />

      {/* Generate panel */}
      <motion.div className="gen-hero" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45 }}>
        <div className="gen-hero-left">
          <div className="gen-hero-icon"><CalendarRange size={26} /></div>
          <div>
            <h2 className="gen-hero-title font-display">Ready to build your schedule</h2>
            <p className="gen-hero-text">
              The solver checks seven hard constraints on every placement and reports any
              capacity issues it finds. Generation usually takes under a minute.
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-end' }}>
          {/* Undergraduate (Mon–Fri) vs MS / Postgraduate (Sat–Sun only) */}
          <div style={{ display: 'inline-flex', border: '1px solid rgba(255,255,255,.35)', borderRadius: 10, overflow: 'hidden' }}>
            {[['ug', 'Undergraduate'], ['pg', 'MS (Sat/Sun)']].map(([v, lbl]) => (
              <button key={v} type="button" onClick={() => setLevel(v)} disabled={generating}
                style={{ border: 'none', cursor: 'pointer', padding: '7px 14px', fontSize: 12.5, fontWeight: 800,
                  background: level === v ? '#fff' : 'transparent', color: level === v ? '#0f3d2e' : '#eaf3ee' }}>
                {lbl}
              </button>
            ))}
          </div>
          <button className={`btn btn-brass gen-hero-btn ${generating ? 'is-generating' : ''}`} onClick={generate} disabled={generating}>
            {generating
              ? <span className="gen-btn-label"><Loader2 size={18} className="spin" /> Generating…</span>
              : <><Sparkles size={18} /> Generate {level === 'pg' ? 'MS Timetable' : 'Timetable'}</>}
          </button>
        </div>
      </motion.div>

      {/* Generating progress */}
      <AnimatePresence>
        {generating && (
          <motion.div
            className="gen-progress card"
            initial={{ opacity: 0, height: 0, marginTop: 0 }}
            animate={{ opacity: 1, height: 'auto', marginTop: 20 }}
            exit={{ opacity: 0, height: 0, marginTop: 0 }}
          >
            <div className="gen-progress-head">
              <Loader2 size={18} className="spin" />
              <span>Working through the schedule…</span>
            </div>
            <div className="gen-steps">
              {STEPS.map((s, i) => (
                <div key={i} className={`gen-step ${i < step ? 'done' : ''} ${i === step ? 'active' : ''}`}>
                  <div className="gen-step-dot">
                    {i < step ? <CheckCircle2 size={15} /> : i === step ? <Loader2 size={13} className="spin" /> : null}
                  </div>
                  <span>{s}</span>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Results */}
      <AnimatePresence>
        {result && !generating && (
          <motion.div
            className="gen-results"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45 }}
          >
            {/* Status banner */}
            <div className={`gen-status ${clashFree ? 'ok' : 'warn'}`}>
              <div className="gen-status-icon">
                {clashFree ? <CheckCircle2 size={28} /> : <AlertTriangle size={28} />}
              </div>
              <div className="gen-status-text">
                <h3 className="font-display">
                  {clashFree ? 'Completely clash-free schedule' : 'Schedule generated with notes'}
                </h3>
                <p>
                  {clashFree
                    ? 'No teacher, room, lab, batch, capacity or slot conflicts were found. The timetable is ready to publish.'
                    : `The solver placed every session but flagged ${clashes.total ?? 0} hard-constraint issue(s). See the breakdown below.`}
                </p>
              </div>
              {result?.accuracy != null && (
                <div className="gen-accuracy">
                  <span className="gen-accuracy-num">{result.accuracy}%</span>
                  <span className="gen-accuracy-lbl">accuracy</span>
                </div>
              )}
            </div>

            {/* Clash metrics */}
            <div className="gen-metrics">
              <Metric icon={Users} label="Teacher clashes" value={clashes.teacher ?? 0} good={!clashes.teacher} />
              <Metric icon={CalendarRange} label="Room clashes" value={clashes.room ?? 0} good={!clashes.room} />
              <Metric icon={Layers} label="Lab clashes" value={clashes.lab ?? 0} good={!clashes.lab} />
              <Metric icon={ShieldCheck} label="Capacity violations" value={clashes.capacity ?? 0} good={!clashes.capacity} />
            </div>

            {/* Placement stats */}
            <div className="gen-stats card">
              <div className="gen-stats-head">
                <h3 className="font-display">Placement summary</h3>
                <button className="gen-regen" onClick={generate}><RefreshCw size={14} /> Regenerate</button>
              </div>
              <div className="gen-stats-grid">
                <Stat icon={CalendarRange} value={stats.theorySessions ?? '—'} label="Theory sessions" />
                <Stat icon={Layers} value={stats.labSessions ?? '—'} label="Lab sessions" />
                <Stat icon={GraduationCap} value={stats.programs ?? '—'} label="Programmes" />
                <Stat icon={Users} value={stats.splitGroups ?? '—'} label="Lab groups split" />
              </div>

              {/* Auto-split positive note */}
              {stats.splitGroups > 0 && (
                <div className="gen-split-note">
                  <Layers size={18} />
                  <div>
                    <strong>{stats.splitGroups} large lab session(s) were auto-split into smaller groups.</strong>
                    <span>
                      {' '}Sections bigger than the largest available lab are divided into
                      equal groups (each in its own lab and time slot), so every student
                      gets a seat without overcrowding.
                    </span>
                  </div>
                </div>
              )}

              {/* Lab overflow honest note */}
              {stats.labOverflows > 0 && (
                <div className="gen-overflow">
                  <TriangleAlert size={18} />
                  <div>
                    <strong>{stats.labOverflows} lab session(s) slightly exceed their room's capacity.</strong>
                    <span>
                      {' '}These are placed conflict-free, but a few more students are enrolled
                      than the largest matching lab holds — a physical resource limit, not a
                      scheduling error. Adding one larger lab for those departments resolves it.
                    </span>
                  </div>
                </div>
              )}
              {stats.labUnplaced > 0 && (
                <div className="gen-overflow err">
                  <TriangleAlert size={18} />
                  <div><strong>{stats.labUnplaced} lab session(s) could not be placed.</strong><span> The batch's weekly schedule is full — these belong to a programme with more lab courses than the available labs and slots can hold. Adding lab capacity or reducing that batch's lab load resolves it.</span></div>
                </div>
              )}
            </div>

            {/* Capacity Advisor */}
            {result.capacityAdvisor && (
              <div className="gen-advisor card">
                <h3 className="font-display gen-advisor-title"><Gauge size={17} /> Capacity Advisor</h3>
                <div className="gen-advisor-bars">
                  {[['Room utilization', result.capacityAdvisor.theory], ['Lab utilization', result.capacityAdvisor.lab]].map(([lbl, m]) => (
                    <div className="gen-advisor-bar" key={lbl}>
                      <div className="gen-advisor-bar-top">
                        <span>{lbl}</span>
                        <span className="gen-advisor-pct">{m.utilizationPct}%</span>
                      </div>
                      <div className="gen-advisor-track">
                        <div className={`gen-advisor-fill ${m.utilizationPct >= 90 ? 'high' : m.utilizationPct >= 70 ? 'mid' : 'low'}`}
                          style={{ width: `${Math.min(100, m.utilizationPct)}%` }} />
                      </div>
                      <div className="gen-advisor-barsub">{m.placed}/{m.demand} placed{m.unplaced ? ` · ${m.unplaced} unplaced` : ''}</div>
                    </div>
                  ))}
                </div>

                {result.capacityAdvisor.bottleneckDepartments?.length > 0 && (
                  <div className="gen-advisor-bottle">
                    <div className="gen-advisor-sub">Lab bottlenecks (demand vs eligible-lab capacity / week)</div>
                    {result.capacityAdvisor.bottleneckDepartments.slice(0, 6).map((b) => (
                      <div className="gen-advisor-row" key={b.department}>
                        <span className="gen-advisor-dept">{b.department.toUpperCase()}</span>
                        <span className="gen-advisor-meta">demand {b.labDemand} · cap {b.labCapacity} · {b.unplaced} unplaced</span>
                        {b.boundBy === 'teachers' ? <span className="gen-advisor-add teacher">teacher-bound</span>
                          : b.boundBy === 'both' ? <span className="gen-advisor-add teacher">+{b.labsToAdd} lab &amp; staff</span>
                          : b.boundBy === 'scheduling' ? <span className="gen-advisor-add sched">batch overlap</span>
                          : b.labsToAdd > 0 && <span className="gen-advisor-add">+{b.labsToAdd} lab</span>}
                      </div>
                    ))}
                  </div>
                )}

                {result.capacityAdvisor.recommendations?.length > 0 && (
                  <div className="gen-advisor-recs">
                    <div className="gen-advisor-sub"><Lightbulb size={13} /> Recommendations</div>
                    <ul>{result.capacityAdvisor.recommendations.map((r, i) => <li key={i}>{r}</li>)}</ul>
                  </div>
                )}
              </div>
            )}

            {/* Downloads */}
            {files.length > 0 && (
              <div className="gen-files card">
                <h3 className="font-display gen-files-title">Download outputs</h3>
                <div className="gen-files-list">
                  {files.map((f) => (
                    <button key={f.filename} className="gen-file" onClick={() => handleDownload(f)} disabled={busyFile === f.filename}>
                      <div className={`gen-file-icon ${f.format}`}>
                        {f.format === 'xlsx' ? <FileSpreadsheet size={20} /> : f.format === 'pdf' ? <FileText size={20} /> : <FileText size={20} />}
                      </div>
                      <div className="gen-file-text">
                        <span className="gen-file-label">{f.label}</span>
                        <span className="gen-file-size">{formatBytes(f.sizeBytes)}</span>
                      </div>
                      {busyFile === f.filename ? <Loader2 size={17} className="spin gen-file-dl" /> : <Download size={17} className="gen-file-dl" />}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {!result && !generating && (
        <div className="card" style={{ marginTop: 20 }}>
          <EmptyState
            icon={CalendarRange}
            title="No timetable generated yet"
            message="Click Generate Timetable above to build your first conflict-free schedule."
          />
        </div>
      )}

    </div>
  );
}

function Metric({ icon: Icon, label, value, good }) {
  return (
    <div className={`gen-metric ${good ? 'good' : 'bad'}`}>
      <div className="gen-metric-icon"><Icon size={18} /></div>
      <div className="gen-metric-body">
        <span className="gen-metric-value">{value}</span>
        <span className="gen-metric-label">{label}</span>
      </div>
      {good && <CheckCircle2 size={16} className="gen-metric-check" />}
    </div>
  );
}

function Stat({ icon: Icon, value, label }) {
  return (
    <div className="gen-stat">
      <Icon size={18} className="gen-stat-icon" />
      <span className="gen-stat-value">{value}</span>
      <span className="gen-stat-label">{label}</span>
    </div>
  );
}

function formatBytes(b) {
  if (!b) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}
