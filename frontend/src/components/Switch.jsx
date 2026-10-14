/* Switch — accessible on/off toggle (role="switch"). */
export default function Switch({ checked, onChange, disabled = false, label, title, size = 'md', busy = false }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!checked}
      aria-label={label}
      title={title || label}
      disabled={disabled || busy}
      className={`sw sw-${size} ${checked ? 'on' : ''} ${busy ? 'busy' : ''}`}
      onClick={() => !disabled && !busy && onChange && onChange(!checked)}
    >
      <span className="sw-knob" />
    </button>
  );
}
