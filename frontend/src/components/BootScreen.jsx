import { motion } from 'framer-motion';
import Wordmark from './Wordmark';
import './boot.css';

/**
 * Preloader: "ABASYN" and "Scheduler" appear as outlines and fill bottom → top
 * over 5 s (green, then gold), glow, the tagline rises in, then the whole
 * screen fades out smoothly (exit animation, driven by AnimatePresence in App).
 */
export default function BootScreen() {
  return (
    <motion.div
      className="boot"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, filter: 'blur(6px)', scale: 1.03 }}
      transition={{ duration: 0.9, ease: [0.4, 0, 0.2, 1] }}
    >
      <motion.div
        className="boot-inner"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      >
        <Wordmark animated tone="dark" size="lg" />
      </motion.div>
    </motion.div>
  );
}
