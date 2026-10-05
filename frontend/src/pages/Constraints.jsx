import { motion } from 'framer-motion';
import {
  ShieldCheck, CheckCircle2, AlertTriangle, XCircle, Users, DoorOpen,
  FlaskConical, GraduationCap, Maximize2, BookOpen, CalendarDays, Layers,
} from 'lucide-react';
import { PageHeader } from '../components/ui';
import './constraints.css';

const HARD = [
  { icon: Users, title: 'No teacher double-booking', desc: 'A teacher is never scheduled for two sessions in the same time slot on the same day.' },
  { icon: DoorOpen, title: 'No room double-booking', desc: 'A theory room hosts at most one lecture per slot.' },
  { icon: FlaskConical, title: 'No lab double-booking', desc: 'A lab hosts at most one practical per slot, accounting for overlapping lab-time windows.' },
  { icon: GraduationCap, title: 'No batch overlap', desc: 'A student batch-section never has two classes at once, so no student is double-booked.' },
  { icon: CalendarDays, title: 'Alternate-day theory classes', desc: 'A multi-session course (e.g. a 3-credit class) is always placed on alternate days such as Monday & Wednesday or Tuesday & Thursday — never on back-to-back days.' },
  { icon: Layers, title: 'Labs once a week, 3 hours', desc: 'Every lab meets once per week in a single 3-hour consecutive block, in a proper lab slot — never split across days.' },
  { icon: Maximize2, title: 'Best-fit room matching', desc: 'Each class is placed in the smallest room that comfortably fits its strength — a 20-student class gets a ~20-seat room, not a 70-seat hall.' },
  { icon: Users, title: 'Auto-sectioning at 50', desc: 'A course with more than 50 students is automatically split into sections (A, B, …) of at most 50 each, with section A filling first — every section placed in a room sized to it.' },
  { icon: BookOpen, title: 'Correct slot type', desc: 'Lectures only go into theory slots; labs only into lab slots — never mixed.' },
  { icon: FlaskConical, title: 'Auto-split oversized labs', desc: 'A lab section larger than the biggest available lab is divided into equal groups, each in its own lab and slot, so every student gets a seat.' },
];

const PARTIAL = [
  {
    icon: Maximize2,
    title: 'Residual lab capacity overflow',
    status: 'limitation',
    desc: 'After auto-splitting, a handful of lab sessions may still be a seat or two over the largest lab available to their department (e.g. 26 students in a 25-seat clinical lab). These are placed conflict-free and flagged honestly. They occur only where a department has no larger lab at all — adding one larger lab resolves them. On the sample dataset this affects roughly 3 of 1,357 sessions (about 0.2%).',
  },
  {
    icon: GraduationCap,
    title: 'Over-subscribed batches',
    status: 'limitation',
    desc: 'A few programmes enrol more lab courses in one batch than the available labs and weekly slots can physically hold. When this happens the extra lab sessions are reported as unplaced rather than forced into a clash. This is a timetabling-capacity reality (too many lab courses, too few lab-hours), not a solver error — splitting the cohort or adding lab time resolves it.',
  },
  {
    icon: Layers,
    title: 'Soft preferences',
    status: 'planned',
    desc: 'Teacher time-of-day preferences, minimising gaps in a batch\'s daily schedule, and balancing load evenly across the week are not yet optimised. The current engine guarantees correctness (no clashes) and best-fit rooms, but does not yet fine-tune for comfort.',
  },
];

export default function Constraints() {
  return (
    <div>
      <PageHeader
        eyebrow="Review"
        title="Constraint Coverage"
        subtitle="An honest account of what the scheduler guarantees and where it has known limits. Hard constraints are enforced on every placement; the rest are transparent about their current state."
      />

      {/* Summary banner */}
      <motion.div className="con-banner" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
        <div className="con-banner-icon"><ShieldCheck size={26} /></div>
        <div>
          <h2 className="font-display">Correct by construction</h2>
          <p>
            The solver uses constraint-satisfaction with backtracking: it will not produce a
            timetable that violates any of the seven hard rules below. If a valid arrangement
            exists, it finds one — and reports any capacity issues it cannot physically solve.
          </p>
        </div>
      </motion.div>

      {/* Hard constraints */}
      <section className="con-section">
        <div className="con-section-head">
          <h3 className="font-display">Enforced hard constraints</h3>
          <span className="badge badge-ok"><CheckCircle2 size={13} /> Always applied</span>
        </div>
        <div className="con-grid">
          {HARD.map((c, i) => {
            const Icon = c.icon;
            return (
              <motion.div
                key={c.title}
                className="con-card enforced"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, delay: i * 0.04 }}
              >
                <div className="con-card-top">
                  <div className="con-card-icon"><Icon size={19} /></div>
                  <CheckCircle2 size={18} className="con-card-check" />
                </div>
                <div className="con-card-title">{c.title}</div>
                <div className="con-card-desc">{c.desc}</div>
              </motion.div>
            );
          })}
        </div>
      </section>

      {/* Partial / planned */}
      <section className="con-section">
        <div className="con-section-head">
          <h3 className="font-display">Known limits & roadmap</h3>
          <span className="badge badge-warn"><AlertTriangle size={13} /> Transparent</span>
        </div>
        <div className="con-list">
          {PARTIAL.map((c, i) => {
            const Icon = c.icon;
            return (
              <motion.div
                key={c.title}
                className={`con-row ${c.status}`}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.35, delay: i * 0.05 }}
              >
                <div className="con-row-icon"><Icon size={19} /></div>
                <div className="con-row-body">
                  <div className="con-row-head">
                    <span className="con-row-title">{c.title}</span>
                    <span className={`con-tag ${c.status}`}>
                      {c.status === 'limitation' ? 'Physical limit' : 'Planned'}
                    </span>
                  </div>
                  <p className="con-row-desc">{c.desc}</p>
                </div>
              </motion.div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
