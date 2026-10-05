import { useState, useRef, useEffect, useMemo } from 'react';
import { ChevronDown, Search, Check } from 'lucide-react';

/**
 * A styled dropdown: a pill button that expands a compact, scrollable panel below
 * (max-height so it never grows too tall — long lists scroll). Built-in search.
 * Drop-in replacement for a native <select> used for filters like "All programs".
 *
 * Props: value, onChange(value), options (["A","B"] or [{value,label}]),
 *        allLabel (the "show all" row + default button text), placeholder, width.
 */
export default function FancySelect({ value, onChange, options = [], allLabel = 'All', placeholder, width, searchThreshold = 8, clearable = true, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  const inputRef = useRef(null);

  const opts = useMemo(() => options.map((o) => (typeof o === 'string' || typeof o === 'number' ? { value: String(o), label: String(o) } : o)), [options]);
  const selected = opts.find((o) => o.value === value) || null;
  const filtered = useMemo(() => (!q ? opts : opts.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()))), [opts, q]);
  const showSearch = opts.length >= searchThreshold;

  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setQ(''); } };
    const onEsc = (e) => { if (e.key === 'Escape') { setOpen(false); setQ(''); } };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onEsc); };
  }, []);
  useEffect(() => { if (open && showSearch) setTimeout(() => inputRef.current?.focus(), 30); }, [open, showSearch]);

  const pick = (v) => { onChange(v); setOpen(false); setQ(''); };

  return (
    <div ref={ref} style={{ position: 'relative', width: width || 'auto', minWidth: 200 }}>
      <button type="button" disabled={disabled} onClick={() => !disabled && setOpen((o) => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8, cursor: disabled ? 'not-allowed' : 'pointer',
          padding: '8px 12px', borderRadius: 10, fontSize: 13.5, textAlign: 'left', opacity: disabled ? 0.55 : 1,
          background: 'var(--surface, #fff)', color: 'var(--text, #12261c)',
          border: `1px solid ${open ? 'var(--brand-600, #198754)' : 'var(--border, #d7e0db)'}`,
          boxShadow: open ? '0 0 0 3px rgba(25,135,84,.12)' : 'none', transition: 'border-color .12s, box-shadow .12s',
        }}>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: selected ? 'var(--text)' : 'var(--text-faint,#5c6b63)' }}>
          {selected ? selected.label : (placeholder || allLabel)}
        </span>
        <ChevronDown size={16} style={{ color: 'var(--text-faint,#5c6b63)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s', flexShrink: 0 }} />
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 60,
          background: 'var(--surface, #fff)', border: '1px solid var(--border, #d7e0db)', borderRadius: 10,
          boxShadow: '0 10px 30px rgba(0,0,0,.14)', overflow: 'hidden',
        }}>
          {showSearch && (
            <div style={{ position: 'relative', padding: 8, borderBottom: '1px solid var(--border-soft,#eef2f0)', background: 'var(--surface-2,#f7faf8)' }}>
              <Search size={14} style={{ position: 'absolute', left: 17, top: 17, color: 'var(--text-faint)' }} />
              <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…"
                style={{ width: '100%', padding: '7px 10px 7px 30px', borderRadius: 8, border: '1px solid var(--border,#d7e0db)', fontSize: 13, background: 'var(--surface,#fff)', color: 'var(--text)' }} />
            </div>
          )}
          <div style={{ maxHeight: 240, overflowY: 'auto', padding: 4 }}>
            {clearable && <Row label={allLabel} active={!value} onClick={() => pick('')} muted />}
            {filtered.map((o) => <Row key={o.value} label={o.label} active={o.value === value} disabled={o.disabled} onClick={() => (o.disabled ? null : pick(o.value))} />)}
            {filtered.length === 0 && <div style={{ padding: '10px 12px', fontSize: 12.5, color: 'var(--text-faint)' }}>No matches</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, active, onClick, muted, disabled }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 8, cursor: disabled ? 'not-allowed' : 'pointer', textAlign: 'left',
        padding: '8px 10px', borderRadius: 7, fontSize: 13, border: 'none', opacity: disabled ? 0.45 : 1,
        background: active ? 'var(--brand-50, #e7f5ec)' : 'transparent',
        color: active ? 'var(--brand-700, #146c43)' : (muted ? 'var(--text-faint,#5c6b63)' : 'var(--text,#12261c)'),
        fontWeight: active ? 700 : 500,
      }}
      onMouseEnter={(e) => { if (!active && !disabled) e.currentTarget.style.background = 'var(--surface-2,#f2f7f4)'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {active && <Check size={14} style={{ flexShrink: 0 }} />}
    </button>
  );
}
