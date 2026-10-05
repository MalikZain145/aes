import { motion } from 'framer-motion';
import {
  CalendarRange, Database, Cpu, FileCheck2, Workflow, Sparkles,
  ArrowRight, GraduationCap, Github, Zap,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/ui';
import './about.css';

const FLOW = [
  { icon: Database, title: 'Your live data', desc: 'Courses, teachers, rooms and labs are stored in MongoDB and edited from this dashboard.' },
  { icon: Cpu, title: 'Constraint solver', desc: 'A Python CSP engine models every rule and searches for a conflict-free arrangement using backtracking.' },
  { icon: FileCheck2, title: 'Verified output', desc: 'Each result is checked against all hard constraints, then exported to Excel and PDF with a clash report.' },
];

const HOW = [
  { q: 'What problem does it solve?', a: 'University timetabling is NP-hard — the number of possible schedules explodes with every course, room and teacher. Doing it by hand takes weeks and still produces clashes. Abasyn Scheduler does it in seconds, guaranteeing no teacher, room, lab or batch conflicts.' },
  { q: 'How does the engine work?', a: 'It treats scheduling as a Constraint Satisfaction Problem. Each session is a variable; its possible (day, slot, room) combinations are its domain. The solver assigns sessions one by one using a best-fit-decreasing order, backtracking whenever a placement would violate a hard constraint, until every session is placed.' },
  { q: 'What about exam datesheets?', a: 'The same live course data feeds a separate datesheet generator. It spreads papers across exam days — 1.5-hour slots for mid-terms, 2-hour slots for finals — ensuring no batch sits two exams at once, and exports a clean PDF.' },
  { q: 'Is the data always current?', a: 'Yes. Every generation reads straight from the database at the moment you click generate, so adding a room or removing a course is reflected immediately in the next timetable.' },
];

export default function About() {
  const navigate = useNavigate();

  return (
    <div>
      <PageHeader eyebrow="About" title="About Abasyn Scheduler" />

      {/* Hero */}
      <motion.div className="ab-hero" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
        <div className="ab-hero-content">
          <div className="ab-hero-badge"><GraduationCap size={15} /> Abasyn University Islamabad Campus</div>
          <h1 className="ab-hero-title font-display">Scheduling, solved intelligently.</h1>
          <p className="ab-hero-text">
            Abasyn Scheduler is a smart academic scheduling system that turns a semester's
            worth of courses, faculty and rooms into a conflict-free weekly timetable — and
            generates mid-term and final-term exam datesheets from the same data. Built to
            replace weeks of manual effort with a result you can trust in seconds.
          </p>
          <div className="ab-hero-actions">
            <button className="btn btn-brass" onClick={() => navigate('/class-timetable')}>
              <Sparkles size={17} /> Generate a timetable
            </button>
            <button className="btn btn-ghost" onClick={() => navigate('/constraints')}>
              View constraints <ArrowRight size={16} />
            </button>
          </div>
        </div>
        <div className="ab-hero-art" aria-hidden><CalendarRange size={130} strokeWidth={1} /></div>
      </motion.div>

      {/* Flow */}
      <section className="ab-section">
        <h2 className="ab-section-title font-display">How it works</h2>
        <div className="ab-flow">
          {FLOW.map((f, i) => {
            const Icon = f.icon;
            return (
              <div className="ab-flow-wrap" key={f.title}>
                <motion.div
                  className="ab-flow-card"
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: i * 0.1 }}
                >
                  <div className="ab-flow-icon"><Icon size={24} /></div>
                  <div className="ab-flow-step">Step {i + 1}</div>
                  <div className="ab-flow-title">{f.title}</div>
                  <div className="ab-flow-desc">{f.desc}</div>
                </motion.div>
                {i < FLOW.length - 1 && <div className="ab-flow-arrow"><ArrowRight size={20} /></div>}
              </div>
            );
          })}
        </div>
      </section>

      {/* Stats strip */}
      <motion.div className="ab-stats" initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ duration: 0.4 }}>
        <div className="ab-stat">
          <Zap size={20} />
          <div><span className="ab-stat-num">Seconds</span><span className="ab-stat-lbl">to generate</span></div>
        </div>
        <div className="ab-stat">
          <FileCheck2 size={20} />
          <div><span className="ab-stat-num">7</span><span className="ab-stat-lbl">hard constraints</span></div>
        </div>
        <div className="ab-stat">
          <Workflow size={20} />
          <div><span className="ab-stat-num">2-in-1</span><span className="ab-stat-lbl">timetable + datesheet</span></div>
        </div>
        <div className="ab-stat">
          <Database size={20} />
          <div><span className="ab-stat-num">Live</span><span className="ab-stat-lbl">database-driven</span></div>
        </div>
      </motion.div>

      {/* FAQ / How */}
      <section className="ab-section">
        <h2 className="ab-section-title font-display">Under the hood</h2>
        <div className="ab-faq">
          {HOW.map((h, i) => (
            <motion.div
              key={h.q}
              className="ab-faq-item"
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.35, delay: i * 0.05 }}
            >
              <div className="ab-faq-q">{h.q}</div>
              <div className="ab-faq-a">{h.a}</div>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Footer note */}
      <div className="ab-foot">
        <div className="ab-foot-brand">
          <img src="/abasyn-green.png" alt="Abasyn" className="ab-foot-logo" />
          <div>
            <div className="ab-foot-name font-display">Scheduler</div>
            <div className="ab-foot-tag">Smart Scheduling, Better Education</div>
          </div>
        </div>
        <div className="ab-foot-meta">Version 1.0 · Built for Abasyn University</div>
      </div>
    </div>
  );
}
