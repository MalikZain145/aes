import { motion } from 'framer-motion';
import './wordmark.css';

/**
 * ABASYN / Scheduler wordmark — replaces the old shield logo.
 *  • static (default): plain wordmark for the login page.
 *  • animated: each word fills bottom → top (ABASYN in green, Scheduler in gold)
 *    over a faint outline, used by the BootScreen preloader.
 * tone="dark" for dark backgrounds, "light" for white cards.
 */
export default function Wordmark({ animated = false, tone = 'dark', size = 'md', tagline = false }) {
  const cls = `wm wm-${tone} wm-${size}`;
  const fill = (delay) => ({
    initial: { clipPath: 'inset(100% 0 0 0)' },
    animate: { clipPath: 'inset(0% 0 0 0)' },
    transition: { delay, duration: 1.4, ease: [0.4, 0, 0.2, 1] },
  });

  if (!animated) {
    return (
      <div className={cls} aria-label="Abasyn Scheduler">
        <div className="wm-word wm-abasyn"><span className="wm-solid">ABASYN</span></div>
        <div className="wm-word wm-sched"><span className="wm-solid">Scheduler</span></div>
        {tagline && <div className="wm-tagline">Smart Academic Scheduling System</div>}
      </div>
    );
  }

  return (
    <div className={cls} aria-label="Abasyn Scheduler">
      <div className="wm-word wm-abasyn">
        <span className="wm-ghost">ABASYN</span>
        <motion.span className="wm-solid wm-layer" {...fill(0.25)}>ABASYN</motion.span>
      </div>
      <div className="wm-word wm-sched">
        <span className="wm-ghost">Scheduler</span>
        <motion.span className="wm-solid wm-layer" {...fill(1.0)}>Scheduler</motion.span>
      </div>
      <motion.div
        className="wm-tagline"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 2.2, duration: 0.7, ease: 'easeOut' }}
      >
        Smart Academic Scheduling System
      </motion.div>
    </div>
  );
}
