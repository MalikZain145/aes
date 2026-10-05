import { useMemo } from 'react';
import { motion } from 'framer-motion';
import AbasynLogo from './AbasynLogo';
import './boot.css';

/* deterministic pseudo-random so every render assembles the same way */
function rand(seed) {
  const x = Math.sin(seed * 99.13) * 10000;
  return x - Math.floor(x);
}

const WORD = 'Abasyn Scheduler';

/**
 * Preloader: the Abasyn shield fills from a faint outline to solid (bottom→top),
 * then the words "Abasyn Scheduler" fly in from random directions and settle
 * into place — a small brand moment on every cold start.
 */
export default function BootScreen() {
  const letters = useMemo(
    () =>
      WORD.split('').map((ch, i) => ({
        ch,
        dx: (rand(i + 1) - 0.5) * 220,
        dy: (rand(i + 7) - 0.5) * 160,
        rot: (rand(i + 3) - 0.5) * 80,
      })),
    []
  );

  return (
    <motion.div
      className="boot"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5, ease: 'easeInOut' }}
    >
      <div className="boot-inner">
        {/* ── Logo with rising fill ── */}
        <motion.div
          className="boot-logo"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        >
          <span className="boot-logo-base">
            <AbasynLogo size={132} />
          </span>
          <motion.span
            className="boot-logo-fill"
            initial={{ clipPath: 'inset(100% 0 0 0)' }}
            animate={{ clipPath: 'inset(0% 0 0 0)' }}
            transition={{ duration: 1.9, ease: [0.4, 0, 0.2, 1] }}
          >
            <AbasynLogo size={132} />
          </motion.span>
          {/* sweeping shine as it fills */}
          <motion.span
            className="boot-logo-shine"
            initial={{ y: 132, opacity: 0 }}
            animate={{ y: -20, opacity: [0, 0.7, 0] }}
            transition={{ duration: 1.9, ease: 'easeInOut' }}
          />
        </motion.div>

        {/* ── Assembling wordmark ── */}
        <div className="boot-word" aria-label={WORD}>
          {letters.map((l, i) => (
            <motion.span
              key={i}
              className={`boot-letter ${l.ch === ' ' ? 'boot-space' : ''}`}
              initial={{ x: l.dx, y: l.dy, rotate: l.rot, opacity: 0 }}
              animate={{ x: 0, y: 0, rotate: 0, opacity: 1 }}
              transition={{
                delay: 1.1 + i * 0.045,
                duration: 0.7,
                ease: [0.16, 1, 0.3, 1],
              }}
            >
              {l.ch === ' ' ? ' ' : l.ch}
            </motion.span>
          ))}
        </div>

        <motion.div
          className="boot-tagline"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 2.0, duration: 0.6 }}
        >
          Smart Academic Scheduling
        </motion.div>

        <div className="boot-dots">
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="boot-dot"
              initial={{ opacity: 0.25, scale: 0.85 }}
              animate={{ opacity: [0.25, 1, 0.25], scale: [0.85, 1, 0.85] }}
              transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.18, ease: 'easeInOut' }}
            />
          ))}
        </div>
      </div>
    </motion.div>
  );
}
