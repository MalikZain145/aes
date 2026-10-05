import { useState, useEffect, useMemo, useRef, useLayoutEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Users, BookOpen, DoorOpen, CalendarRange, CalendarClock, ShieldAlert,
  UserPlus, DoorClosed, BookPlus, ArrowRight, TrendingUp, Search,
  ChevronLeft, ChevronRight, CheckCircle2, AlertTriangle,
} from 'lucide-react';
import api, { errMsg } from '../api/client';
import { useAuth } from '../context/AuthContext';
import AdmitCardStrip from '../components/AdmitCardStrip';
import { useToast } from '../context/ToastContext';
import { Loader } from '../components/ui';
import './dashboard.css';

const fadeUp = { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 } };
const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const sameDay = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export default function Dashboard() {
  const { admin } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [calDate, setCalDate] = useState(() => new Date());
  const [now, setNow] = useState(new Date());
  const [today, setToday] = useState(null);
  const [q, setQ] = useState('');
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [schedH, setSchedH] = useState(null);
  const [isDesktop, setIsDesktop] = useState(() => (typeof window !== 'undefined' ? window.innerWidth > 1024 : true));
  const calCardRef = useRef(null);

  useEffect(() => {
    api.get('/dashboard/summary')
      .then((res) => setData(res.data))
      .catch((err) => toast.error(errMsg(err, 'Could not load dashboard.')))
      .finally(() => setLoading(false));
    api.get('/dashboard/today')
      .then((res) => setToday(res.data))
      .catch(() => setToday({ hasTimetable: false, classes: [] }));
  }, []); // eslint-disable-line

  // keep the greeting / clock current without a reload
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(t);
  }, []);

  // track desktop vs stacked layout
  useEffect(() => {
    const onR = () => setIsDesktop(window.innerWidth > 1024);
    window.addEventListener('resize', onR);
    return () => window.removeEventListener('resize', onR);
  }, []);

  // match the schedule container's height to the calendar beside it
  useLayoutEffect(() => {
    const el = calCardRef.current;
    if (!el) return;
    const measure = () => setSchedH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [today]);

  const weekday = DAY_FULL[selectedDate.getDay()];
  const dayClasses = today?.byDay?.[weekday] || [];
  const todayClasses = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return dayClasses;
    return dayClasses.filter((c) =>
      [c.room, c.code, c.name, c.faculty, c.section].some((x) => String(x || '').toLowerCase().includes(s)));
  }, [dayClasses, q]);

  const counts = data?.counts || {};
  const comp = data?.composition || { lecture: 0, lab: 0, total: 0 };
  const lastTT = data?.lastTimetable;
  const clashCount = lastTT?.clashes?.total ?? 0;
  const clashFree = lastTT && lastTT.fullyClashFree !== false;

  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = admin?.displayName?.split(' ')[0] || 'Admin';

  const STATS = [
    { label: 'Total Courses', value: counts.courses ?? 0, icon: BookOpen, tone: 'green',
      trend: comp.total ? `${comp.lecture} lectures · ${comp.lab} labs` : 'No courses yet', trendTone: 'neutral' },
    { label: 'Faculty', value: counts.teachers ?? 0, icon: Users, tone: 'teal',
      trend: 'Registered & active', trendTone: 'ok' },
    { label: 'Rooms & Labs', value: counts.rooms ?? 0, icon: DoorOpen, tone: 'blue',
      trend: 'Available spaces', trendTone: 'info' },
    { label: 'Scheduling Clashes', value: lastTT ? clashCount : '—', icon: ShieldAlert, tone: clashFree ? 'green' : 'red',
      trend: !lastTT ? 'No timetable yet' : clashFree ? 'Clash-free' : `${clashCount} to resolve`,
      trendTone: !lastTT ? 'neutral' : clashFree ? 'ok' : 'warn' },
  ];

  const QUICK = [
    { label: 'Open Timetable', icon: CalendarRange, to: '/class-timetable', primary: true },
    { label: 'Mid-Term Datesheet', icon: CalendarClock, to: '/datesheets?type=mids' },
    { label: 'Final Datesheet', icon: CalendarClock, to: '/datesheets?type=finals' },
    { label: 'Add Faculty', icon: UserPlus, to: '/teachers?new=1' },
    { label: 'Add Room / Lab', icon: DoorClosed, to: '/rooms-labs?new=1' },
    { label: 'Add Course', icon: BookPlus, to: '/courses?new=1' },
  ];

  return (
    <div className="dash">
      {/* ── Header ── */}
      <motion.div className="dash-head" {...fadeUp} transition={{ duration: 0.45 }}>
        <div>
          <h1 className="dash-head-title">
            {greeting}, {firstName} <span className="dash-wave">👋</span>
          </h1>
          <p className="dash-head-sub">Here's what's happening across your campus schedule today.</p>
        </div>
        <div className="dash-head-actions">
          <button className="btn btn-ghost" onClick={() => navigate('/reports')}>View Reports</button>
          <button className="btn btn-primary" onClick={() => navigate('/class-timetable')}>
            <CalendarRange size={17} /> Open Timetable
          </button>
        </div>
      </motion.div>

      {/* ── Stat cards ── */}
      <div className="dash-stats">
        {STATS.map((s, i) => {
          const Icon = s.icon;
          return (
            <motion.div key={s.label} className={`dash-stat tone-${s.tone}`} {...fadeUp}
              transition={{ duration: 0.4, delay: 0.04 * i }}>
              <div className="dash-stat-top">
                <span className="dash-stat-ic"><Icon size={20} /></span>
                <span className={`dash-stat-chip chip-${s.trendTone}`}>
                  {s.trendTone === 'ok' && <TrendingUp size={12} />} {s.trend}
                </span>
              </div>
              <div className="dash-stat-value">
                {loading ? <span className="skeleton dash-stat-load" /> : s.value}
              </div>
              <div className="dash-stat-label">{s.label}</div>
            </motion.div>
          );
        })}
      </div>

      {/* ── Admit-card strip (read-only; Finance generates, admin downloads) ── */}
      <AdmitCardStrip />

      {/* ── Main grid ── */}
      <div className="dash-grid">
        {/* Left: schedule for the selected day (from the latest generated timetable) */}
        <motion.div className="card dash-schedule" {...fadeUp} transition={{ duration: 0.4, delay: 0.1 }}
          style={isDesktop && schedH ? { height: schedH } : undefined}>
          <div className="dash-card-head">
            <div>
              <h2 className="dash-card-title">{sameDay(selectedDate, now) ? "Today's Schedule" : 'Class Schedule'}</h2>
              <span className="dash-card-sub">
                {weekday}, {MONTHS[selectedDate.getMonth()]} {selectedDate.getDate()}
                {today?.hasTimetable ? ` · ${dayClasses.length} class${dayClasses.length === 1 ? '' : 'es'}` : ''}
              </span>
            </div>
            <button className="dash-link" onClick={() => navigate('/class-timetable')}>Full Timetable <ArrowRight size={14} /></button>
          </div>

          {today && today.hasTimetable && dayClasses.length > 0 && (
            <div className="dash-sched-search">
              <Search size={15} />
              <input placeholder="Search this day — room, course or teacher…" value={q} onChange={(e) => setQ(e.target.value)} />
              {q && <button className="dash-sched-clear" onClick={() => setQ('')}>Clear</button>}
            </div>
          )}

          {!today ? (
            <Loader label="Loading classes…" minHeight={220} />
          ) : !today.hasTimetable ? (
            <div className="dash-empty">
              <span className="dash-empty-ic"><CalendarClock size={26} /></span>
              <div className="dash-empty-title">No timetable published yet</div>
              <div className="dash-empty-sub">Once a timetable is generated and published from the Timetable page, the day's live class schedule appears here — pick any date on the calendar, and search by room, course or teacher.</div>
              <button className="btn btn-primary btn-sm" onClick={() => navigate('/class-timetable')}>
                <CalendarRange size={15} /> Open Timetable
              </button>
            </div>
          ) : dayClasses.length === 0 ? (
            <div className="dash-empty">
              <span className="dash-empty-ic"><CalendarClock size={26} /></span>
              <div className="dash-empty-title">No classes on {weekday}</div>
              <div className="dash-empty-sub">The timetable has no sessions scheduled for this day.</div>
            </div>
          ) : todayClasses.length === 0 ? (
            <div className="dash-empty">
              <span className="dash-empty-ic"><Search size={24} /></span>
              <div className="dash-empty-title">No matches for “{q}”</div>
            </div>
          ) : (
            <div className="dash-table-wrap">
              <table className="dash-table">
                <thead>
                  <tr><th>Time</th><th>Course</th><th>Section</th><th>Faculty</th><th>Room</th><th>Type</th><th>Clash</th></tr>
                </thead>
                <tbody>
                  {todayClasses.map((c, i) => (
                    <tr key={i} className={c.clashes?.length ? 'dash-row-clash' : ''}>
                      <td className="nowrap">{c.time}</td>
                      <td><span className="strong">{c.code}</span><br /><span className="dash-course-name">{c.name}</span></td>
                      <td>{c.section || '—'}</td>
                      <td>{c.faculty || '—'}</td>
                      <td className="strong">{c.room}</td>
                      <td><span className={`dash-type ${c.type === 'Lab' ? 'lab' : ''}`}>{c.type || '—'}</span></td>
                      <td>
                        {(c.clashes || []).map((k) => (
                          <span key={k} className={`dash-clash clash-${k.toLowerCase()}`}>{k}</span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </motion.div>

        {/* Right: Calendar — click a date to load that day's schedule */}
        <div className="dash-side">
          <motion.div className="card dash-cal" ref={calCardRef} {...fadeUp} transition={{ duration: 0.4, delay: 0.14 }}>
            <Calendar month={calDate} setMonth={setCalDate} selected={selectedDate} onSelect={setSelectedDate} />
          </motion.div>
        </div>
      </div>

      {/* ── Quick actions ── */}
      <motion.div className="card dash-quick" {...fadeUp} transition={{ duration: 0.4, delay: 0.2 }}>
        <div className="dash-card-head"><h2 className="dash-card-title">Quick Actions</h2></div>
        <div className="dash-quick-grid">
          {QUICK.map((qa) => {
            const Icon = qa.icon;
            return (
              <button key={qa.label} className={`dash-quick-btn ${qa.primary ? 'primary' : ''}`} onClick={() => navigate(qa.to)}>
                <span className="dash-quick-ic"><Icon size={19} /></span>
                <span>{qa.label}</span>
              </button>
            );
          })}
        </div>
      </motion.div>

      {/* ── Quick overview ── */}
      <div className="dash-overview">
        <OverviewCard title="Courses Overview" icon={BookOpen} total={counts.courses ?? 0} loading={loading}
          rows={[['Lectures', comp.lecture, 'ok'], ['Labs', comp.lab, 'info']]} />
        <OverviewCard title="Faculty Overview" icon={Users} total={counts.teachers ?? 0} loading={loading}
          rows={[['Active', counts.teachers ?? 0, 'ok'], ['On Leave', 0, 'warn']]} />
        <OverviewCard title="Rooms Overview" icon={DoorOpen} total={counts.rooms ?? 0} loading={loading}
          rows={[['Rooms & Labs', counts.rooms ?? 0, 'ok'], ['In Maintenance', 0, 'warn']]} />
        <OverviewCard title="Timetable Status" icon={clashFree ? CheckCircle2 : AlertTriangle}
          total={lastTT ? (clashFree ? '✓' : clashCount) : '—'} loading={loading} big={false}
          rows={[
            ['Status', lastTT ? (clashFree ? 'Clash-free' : 'Issues') : 'None', clashFree ? 'ok' : 'warn'],
            ['Generated', lastTT ? new Date(lastTT.createdAt).toLocaleDateString() : '—', 'info'],
          ]} />
      </div>
    </div>
  );
}

/* ── Quick-overview card ── */
function OverviewCard({ title, icon: Icon, total, rows, loading }) {
  return (
    <motion.div className="card dash-ov" {...fadeUp} transition={{ duration: 0.4 }}>
      <div className="dash-ov-head">
        <span className="dash-ov-ic"><Icon size={17} /></span>
        <span className="dash-ov-title">{title}</span>
      </div>
      <div className="dash-ov-total">{loading ? <span className="skeleton dash-stat-load" /> : total}</div>
      <div className="dash-ov-rows">
        {rows.map(([k, v, tone], i) => (
          <div className="dash-ov-row" key={i}>
            <span className="dash-ov-k"><span className={`dash-ov-dot dot-${tone}`} /> {k}</span>
            <span className="dash-ov-v">{v}</span>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

/* ── Month calendar — click a date to select it ── */
function Calendar({ month, setMonth, selected, onSelect }) {
  const today = new Date();
  const y = month.getFullYear(), m = month.getMonth();
  const first = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < first; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);

  const isToday = (d) => d && today.getDate() === d && today.getMonth() === m && today.getFullYear() === y;
  const isSel = (d) => d && selected && selected.getDate() === d && selected.getMonth() === m && selected.getFullYear() === y;

  return (
    <div className="cal">
      <div className="cal-head">
        <span className="cal-title">{MONTHS[m]} {y}</span>
        <div className="cal-nav">
          <button onClick={() => setMonth(new Date(y, m - 1, 1))} aria-label="Previous month"><ChevronLeft size={16} /></button>
          <button onClick={() => setMonth(new Date(y, m + 1, 1))} aria-label="Next month"><ChevronRight size={16} /></button>
        </div>
      </div>
      <div className="cal-grid cal-dow">{DAYS.map((d) => <span key={d} className="cal-dow-cell">{d}</span>)}</div>
      <div className="cal-grid">
        {cells.map((d, i) => (
          <button key={i} disabled={!d}
            className={`cal-cell ${d ? '' : 'empty'} ${isToday(d) ? 'today' : ''} ${isSel(d) ? 'selected' : ''}`}
            onClick={() => d && onSelect(new Date(y, m, d))}>
            {d || ''}
          </button>
        ))}
      </div>
      <button className="cal-today-btn" onClick={() => { const t = new Date(); setMonth(new Date(t.getFullYear(), t.getMonth(), 1)); onSelect(t); }}>
        Jump to today
      </button>
    </div>
  );
}
