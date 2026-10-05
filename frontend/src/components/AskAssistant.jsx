import { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  MessageCircleQuestion, X, Send, Loader2, Sparkles, DoorOpen, User, BookOpen,
  CalendarClock, CalendarRange, Info, Search,
} from 'lucide-react';
import api, { errMsg } from '../api/client';
import FancySelect from './FancySelect';
import './askassistant.css';

const SUGGESTIONS = ['J212', 'Room 212 Monday', 'CS313', 'Friday classes', 'Auditorium'];

export default function AskAssistant() {
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState([]);
  const [years, setYears] = useState([]);
  const [semesters, setSemesters] = useState([]);
  const [kind, setKind] = useState('timetable');
  const [year, setYear] = useState('');
  const [semester, setSemester] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bodyRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    api.get('/search/sources').then((r) => {
      setSources(r.data.sources || []);
      setYears(r.data.years || []);
      setSemesters(r.data.semesters || []);
    }).catch(() => {});
  }, [open]);

  const filtered = useMemo(() => sources.filter((s) => (
    (!kind || s.kind === kind)
    && (!year || String(s.year) === String(year))
    && (!semester || s.semester === semester)
  )), [sources, kind, year, semester]);

  useEffect(() => {
    if (filtered.length && !filtered.some((s) => s.id === sourceId)) setSourceId(filtered[0].id);
    if (!filtered.length) setSourceId('');
  }, [filtered]); // eslint-disable-line

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages, loading]);

  const ask = async (text) => {
    const q = (text ?? input).trim();
    if (!q) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', text: q }]);
    setLoading(true);
    try {
      const r = await api.post('/search', { sourceId: sourceId || undefined, kind, query: q });
      setMessages((m) => [...m, { role: 'bot', data: r.data }]);
    } catch (err) {
      setMessages((m) => [...m, { role: 'bot', data: { answer: errMsg(err, 'Search failed.'), results: null } }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {/* Floating button */}
      <button className={`aa-fab ${open ? 'hidden' : ''}`} onClick={() => setOpen(true)} aria-label="Ask Abasyn Scheduler">
        <MessageCircleQuestion size={22} />
        <span>Ask Abasyn Scheduler</span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className="aa-panel"
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.98 }}
            transition={{ duration: 0.22 }}
          >
            {/* Header */}
            <div className="aa-head">
              <div className="aa-head-title">
                <Sparkles size={16} />
                <div>
                  <div className="aa-head-name">Ask Abasyn Scheduler</div>
                  <div className="aa-head-sub">Search timetables &amp; datesheets</div>
                </div>
              </div>
              <button className="aa-close" onClick={() => setOpen(false)} aria-label="Close"><X size={18} /></button>
            </div>

            {/* Filters */}
            <div className="aa-filters">
              <div className="aa-seg">
                <button className={kind === 'timetable' ? 'on' : ''} onClick={() => setKind('timetable')}>
                  <CalendarRange size={13} /> Timetable
                </button>
                <button className={kind === 'datesheet' ? 'on' : ''} onClick={() => setKind('datesheet')}>
                  <CalendarClock size={13} /> Date Sheet
                </button>
              </div>
              <div className="aa-filter-row" style={{ display: 'flex', gap: 8 }}>
                <FancySelect value={year} onChange={setYear} options={years} allLabel="All years" width="100%" />
                <FancySelect value={semester} onChange={setSemester} options={semesters} allLabel="All terms" width="100%" />
              </div>
              <div style={{ marginTop: 8 }}>
                <FancySelect value={sourceId} onChange={setSourceId} clearable={false} width="100%"
                  placeholder={`No ${kind === 'datesheet' ? 'datesheets' : 'timetables'} found`}
                  options={filtered.map((s) => ({ value: s.id, label: `${s.title}${s.searchable ? '' : ' (not searchable)'}` }))} />
              </div>
            </div>

            {/* Messages */}
            <div className="aa-body" ref={bodyRef}>
              {messages.length === 0 && (
                <div className="aa-empty">
                  <Search size={26} />
                  <p>Ask about any room, teacher, course, or day.</p>
                  <div className="aa-suggest">
                    {SUGGESTIONS.map((s) => (
                      <button key={s} onClick={() => ask(s)}>{s}</button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((m, i) => (
                m.role === 'user'
                  ? <div key={i} className="aa-msg user">{m.text}</div>
                  : <BotMessage key={i} data={m.data} />
              ))}
              {loading && <div className="aa-msg bot loading"><Loader2 size={14} className="spin" /> Searching…</div>}
            </div>

            {/* Input */}
            <div className="aa-input">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && ask()}
                placeholder='e.g. "J212", "CS313", "Friday classes"'
              />
              <button onClick={() => ask()} disabled={loading || !input.trim()} aria-label="Send">
                <Send size={16} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function BotMessage({ data }) {
  const r = data.results;
  return (
    <div className="aa-msg bot">
      <div className="aa-answer">{data.answer}</div>
      {(data.corrections || []).map((c, i) => (
        <div key={i} className="aa-correction"><Info size={12} /> {c}</div>
      ))}
      {r && <ResultView r={r} />}
    </div>
  );
}

function SlotRow({ s, hide = {} }) {
  return (
    <tr>
      <td className="aa-time">{s.slot}</td>
      {!hide.course && (
        <td><b>{s.code}</b>{s.section ? ` (${s.section})` : ''}<div className="aa-cname">{s.name}</div></td>
      )}
      {!hide.teacher && <td>{s.teacher && s.teacher !== 'TBA' ? s.teacher : '—'}</td>}
      {!hide.room && <td>{s.room}</td>}
      {!hide.cap && <td className="aa-cap">{s.enrolled}/{s.cap}</td>}
    </tr>
  );
}

function DayTable({ day, sessions, hide }) {
  return (
    <div className="aa-daygrp">
      <div className="aa-dayname">{day}</div>
      <table className="aa-table">
        <tbody>{sessions.map((s, i) => <SlotRow key={i} s={s} hide={hide} />)}</tbody>
      </table>
    </div>
  );
}

function ResultView({ r }) {
  if (r.type === 'room_schedule' || r.type === 'teacher_schedule'
      || r.type === 'course_schedule' || r.type === 'program_schedule') {
    const hide = {
      room: r.type === 'room_schedule',
      teacher: r.type === 'teacher_schedule',
    };
    if (!r.days || r.days.length === 0) return null;
    return (
      <div className="aa-result">
        {r.type === 'room_schedule' && <div className="aa-rhead"><DoorOpen size={14} /> Room {r.room}</div>}
        {r.type === 'teacher_schedule' && <div className="aa-rhead"><User size={14} /> {r.teacher}</div>}
        {r.type === 'course_schedule' && <div className="aa-rhead"><BookOpen size={14} /> {r.code} — {r.name}</div>}
        {r.days.map((d) => <DayTable key={d.day} day={d.day} sessions={d.sessions} hide={hide} />)}
      </div>
    );
  }
  if (r.type === 'day_schedule') {
    return (
      <div className="aa-result">
        {r.rooms.map((rm) => (
          <div key={rm.room} className="aa-daygrp">
            <div className="aa-dayname"><DoorOpen size={12} /> {rm.room}</div>
            <table className="aa-table">
              <tbody>{rm.sessions.map((s, i) => <SlotRow key={i} s={s} hide={{ room: true }} />)}</tbody>
            </table>
          </div>
        ))}
      </div>
    );
  }
  if (r.type === 'exam') {
    const c = r.course;
    return (
      <div className="aa-result">
        <div className="aa-examcard">
          <div className="aa-examcode">{c.code}</div>
          <div className="aa-examname">{c.name}</div>
          <div className="aa-examline"><CalendarClock size={13} /> {c.day}, {c.date_disp || c.date} · {c.slot}</div>
        </div>
      </div>
    );
  }
  if (r.type === 'exam_day') {
    return (
      <div className="aa-result">
        <div className="aa-rhead"><CalendarClock size={14} /> {r.date}</div>
        <table className="aa-table">
          <tbody>
            {r.courses.map((c, i) => (
              <tr key={i}><td className="aa-time">{c.slot}</td><td><b>{c.code}</b><div className="aa-cname">{c.name}</div></td></tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (r.type === 'overview' || r.type === 'datesheet_overview') {
    return null;
  }
  return null;
}
