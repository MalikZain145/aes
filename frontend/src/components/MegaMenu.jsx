import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight } from 'lucide-react';

/**
 * Generic, config-driven mega dropdown.
 *
 * props:
 *   open      : boolean
 *   onClose   : () => void
 *   align     : 'left' | 'right' | 'center'  (which edge to anchor under the trigger)
 *   width     : panel width in px
 *   columns   : [{ title, sub, items: [{ icon, label, desc, to?, onClick? }] }]
 *   footer    : optional { icon, title, desc, action: { label, to?, onClick? } }
 */
export default function MegaMenu({ open, onClose, align = 'left', width = 720, columns = [], footer }) {
  const navigate = useNavigate();
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  const go = (item) => {
    if (item.onClick) item.onClick();
    else if (item.to) navigate(item.to);
    onClose();
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={ref}
          className={`mega mega-${align}`}
          style={{ width }}
          initial={{ opacity: 0, y: 8, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.985 }}
          transition={{ duration: 0.16, ease: 'easeOut' }}
          role="menu"
        >
          <span className="mega-pointer" aria-hidden />
          <div className="mega-cols">
            {columns.map((col, ci) => (
              <div className="mega-col" key={ci}>
                <div className="mega-col-head">
                  <span className="mega-col-title">{col.title}</span>
                  {col.sub && <span className="mega-col-sub">{col.sub}</span>}
                </div>
                <div className="mega-list">
                  {col.items.map((it, ii) => {
                    const Icon = it.icon;
                    return (
                      <button className="mega-item" key={ii} onClick={() => go(it)} role="menuitem">
                        <span className="mega-item-ic">{Icon && <Icon size={17} />}</span>
                        <span className="mega-item-text">
                          <span className="mega-item-label">{it.label}</span>
                          {it.desc && <span className="mega-item-desc">{it.desc}</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {footer && (
            <div className="mega-footer">
              <span className="mega-footer-ic">{footer.icon && <footer.icon size={20} />}</span>
              <div className="mega-footer-text">
                <span className="mega-footer-title">{footer.title}</span>
                <span className="mega-footer-desc">{footer.desc}</span>
              </div>
              <button
                className="mega-footer-btn"
                onClick={() => go(footer.action)}
              >
                {footer.action.label} <ArrowRight size={15} />
              </button>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
