import { motion } from 'framer-motion';
import './wordmark.css';

/**
 * ABASYN / Scheduler wordmark — replaces the old shield logo.
 *  • static (default): plain wordmark for the login page.
 *  • animated (preloader): the words appear as faint outlines, colour fills
 *    them bottom → top over 5 s (ABASYN green, then Scheduler gold), the filled
 *    words glow, and the tagline rises in underneath.
 * tone="dark" for dark backgrounds, "light" for white cards.
 */
const FILL_END = 5.0; // seconds — when both words are completely filled

export default function Wordmark({ animated = false, tone = 'dark', size = 'md', tagline = false }) {
  const cls = `wm wm-${tone} wm-${size}`;

  if (!animated) {
    return (
      <div className={cls} aria-label="Abasyn Scheduler">
        <div className="wm-word wm-abasyn"><span className="wm-solid">ABASYN</span></div>
        <div className="wm-word wm-sched"><span className="wm-solid">Scheduler</span></div>
        {tagline && <div className="wm-tagline">Smart Academic Scheduling System</div>}
      </div>
    );
  }

  const fill = (delay, duration) => ({
    initial: { clipPath: 'inset(100% 0 0 0)' },
    animate: { clipPath: 'inset(0% 0 0 0)' },
    transition: { delay, duration, ease: [0.45, 0, 0.25, 1] },
  });

  return (
    <div className={cls} aria-label="Abasyn Scheduler">
      {/* words appear, fill, then glow */}
      <motion.div
        className="wm-words"
        initial={{ opacity: 0, filter: 'drop-shadow(0 0 0px rgba(79,227,176,0))' }}
        animate={{
          opacity: 1,
          filter: [
            'drop-shadow(0 0 0px rgba(79,227,176,0))',
            'drop-shadow(0 0 0px rgba(79,227,176,0))',
            'drop-shadow(0 0 22px rgba(79,227,176,0.85))',
            'drop-shadow(0 0 12px rgba(224,177,78,0.55))',
          ],
        }}
        transition={{
          opacity: { duration: 0.6, ease: 'easeOut' },
          filter: { duration: FILL_END + 1.4, times: [0, FILL_END / (FILL_END + 1.4), (FILL_END + 0.6) / (FILL_END + 1.4), 1], ease: 'easeInOut' },
        }}
      >
        <div className="wm-word wm-abasyn">
          <span className="wm-ghost">ABASYN</span>
          <motion.span className="wm-solid wm-layer" {...fill(0.4, 2.8)}>ABASYN</motion.span>
        </div>
        <div className="wm-word wm-sched">
          <span className="wm-ghost">Scheduler</span>
          <motion.span className="wm-solid wm-layer" {...fill(2.6, FILL_END - 2.6)}>Scheduler</motion.span>
        </div>
        {/* shine sweeps up once the fill is complete */}
        <motion.span
          className="wm-shine"
          initial={{ y: 60, opacity: 0 }}
          animate={{ y: -90, opacity: [0, 0.6, 0] }}
          transition={{ delay: FILL_END, duration: 1.2, ease: 'easeInOut' }}
        />
      </motion.div>
      <motion.div
        className="wm-tagline"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: FILL_END + 0.3, duration: 0.7, ease: 'easeOut' }}
      >
        Smart Academic Scheduling System
      </motion.div>
    </div>
  );
}
