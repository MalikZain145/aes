import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, CornerDownLeft } from 'lucide-react';
import {
  LayoutDashboard, BookOpen, Users, DoorOpen, Upload, CalendarRange, CalendarClock,
  Contact, ShieldCheck, FileBarChart2, Info,
} from 'lucide-react';

/* Command index — extend freely; every entry is a quick jump. */
const COMMANDS = [
  { group: 'Pages', icon: LayoutDashboard, label: 'Dashboard', to: '/' },
  { group: 'Academics', icon: BookOpen, label: 'Courses', to: '/courses' },
  { group: 'Academics', icon: Users, label: 'Faculty / Teachers', to: '/teachers' },
  { group: 'Academics', icon: DoorOpen, label: 'Rooms & Labs', to: '/rooms-labs' },
  { group: 'Academics', icon: Upload, label: 'Import Data', to: '/import' },
  { group: 'Scheduling', icon: CalendarRange, label: 'Timetable', to: '/class-timetable' },
  { group: 'Scheduling', icon: CalendarClock, label: 'Date Sheets', to: '/datesheets' },
  { group: 'Scheduling', icon: Contact, label: 'Admit Cards & Seating', to: '/admit-cards' },
  { group: 'Scheduling', icon: ShieldCheck, label: 'Constraints', to: '/constraints' },
  { group: 'Insights', icon: FileBarChart2, label: 'Reports & Analytics', to: '/reports' },
  { group: 'Insights', icon: FileBarChart2, label: 'Clash Report', to: '/reports?filter=clash_report' },
  { group: 'Insights', icon: Info, label: 'About', to: '/about' },
];

export default function GlobalSearch({ open, onClose }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 40);
    }
  }, [open]);

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return COMMANDS;
    return COMMANDS.filter((c) => c.label.toLowerCase().includes(s) || c.group.toLowerCase().includes(s));
  }, [q]);

  useEffect(() => { setActive(0); }, [q]);

  const choose = (item) => {
    if (!item) return;
    navigate(item.to);
    onClose();
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(results[active]); }
    else if (e.key === 'Escape') { onClose(); }
  };

  let lastGroup = null;

  return (
    <AnimatePresence>
      {open && (
        <div className="cmd-root">
          <motion.div className="cmd-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.div
            className="cmd-panel"
            initial={{ opacity: 0, y: -14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 340, damping: 30 }}
            role="dialog" aria-modal="true"
          >
            <div className="cmd-input-row">
              <Search size={18} className="cmd-input-ic" />
              <input
                ref={inputRef}
                className="cmd-input"
                placeholder="Search pages, courses, faculty, rooms…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onKeyDown}
              />
              <kbd className="cmd-esc">ESC</kbd>
            </div>

            <div className="cmd-results">
              {results.length === 0 && <div className="cmd-empty">No matches for “{q}”.</div>}
              {results.map((r, i) => {
                const showGroup = r.group !== lastGroup;
                lastGroup = r.group;
                const Icon = r.icon;
                return (
                  <div key={i}>
                    {showGroup && <div className="cmd-group">{r.group}</div>}
                    <button
                      className={`cmd-item ${i === active ? 'active' : ''}`}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => choose(r)}
                    >
                      <Icon size={16} className="cmd-item-ic" />
                      <span className="cmd-item-label">{r.label}</span>
                      {i === active && <CornerDownLeft size={14} className="cmd-item-enter" />}
                    </button>
                  </div>
                );
              })}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
