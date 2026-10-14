import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/*
 * ScrollX — a horizontal "slider" for anything wider than the screen (tables,
 * timetables, timelines). The page itself never scrolls sideways; the content
 * slides inside this box instead.
 *   • a small → arrow shows while there is more content to the right
 *   • once you slide right, a ← arrow appears; at the very end the → disappears
 *   • works with touch swipe, trackpad, mouse wheel and the arrow buttons
 * Drop-in replacement for a scroll wrapper <div>: all props go to the inner div.
 */
export default function ScrollX({ className = '', style, children, ...rest }) {
  const ref = useRef(null);
  const [state, setState] = useState({ left: false, right: false, tall: false });

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const left = el.scrollLeft > 4;
    const right = max > 4 && el.scrollLeft < max - 4;
    const tall = el.clientHeight > 420;
    setState((s) => (s.left === left && s.right === right && s.tall === tall ? s : { left, right, tall }));
  }, []);

  // Measure after mount, then only when something really changes (size, content,
  // scroll). Never on every render — a measure → setState → render cycle on each
  // commit can loop forever when a table re-renders while scrolled.
  useLayoutEffect(() => { update(); }, [update]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    let raf = 0;
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(update); };
    el.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    let ro;
    let mo;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(schedule);
      ro.observe(el);
      if (el.firstElementChild) ro.observe(el.firstElementChild);
    }
    if (typeof MutationObserver !== 'undefined') {
      mo = new MutationObserver(() => {
        if (ro && el.firstElementChild) ro.observe(el.firstElementChild);
        schedule();
      });
      mo.observe(el, { childList: true, subtree: true });
    }
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (ro) ro.disconnect();
      if (mo) mo.disconnect();
    };
  }, [update]);

  const slide = (dir) => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.8), behavior: 'smooth' });
  };

  return (
    <div className={`sx ${state.left ? 'sx-l' : ''} ${state.right ? 'sx-r' : ''} ${state.tall ? 'sx-tall' : ''}`}>
      <div ref={ref} className={`sx-track ${className}`} style={style} {...rest}>
        {children}
      </div>
      {state.left && (
        <button type="button" className="sx-arrow sx-arrow-left" onClick={() => slide(-1)} aria-label="Scroll left" tabIndex={-1}>
          <ChevronLeft size={18} />
        </button>
      )}
      {state.right && (
        <button type="button" className="sx-arrow sx-arrow-right" onClick={() => slide(1)} aria-label="Scroll right" tabIndex={-1}>
          <ChevronRight size={18} />
        </button>
      )}
    </div>
  );
}
