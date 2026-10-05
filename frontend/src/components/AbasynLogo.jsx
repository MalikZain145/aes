/**
 * AbasynLogo — the Abasyn Scheduler emblem as a self-contained inline SVG.
 *
 * A crest/shield holding a campus building with a central clock tower, an open
 * book, and a calendar-with-check (scheduling). Drawn with currentColor so it
 * inherits the surrounding text colour (white on the navy-green sidebar, deep
 * green on light surfaces). Scales cleanly from a 28px nav mark to a 160px
 * splash logo.
 *
 * If you drop your exact PNG at /public/abasyn-logo.png, pass `src` (the
 * BootScreen / Sidebar will use it and fall back to this SVG automatically).
 */
export default function AbasynLogo({ size = 48, className = '', title = 'Abasyn Scheduler' }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 120 138"
      fill="none"
      role="img"
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Shield body */}
      <path
        d="M60 4 L112 22 V64 C112 94 91 118 60 134 C29 118 8 94 8 64 V22 Z"
        fill="currentColor"
      />
      {/* Inner hairline crest */}
      <path
        d="M60 13 L104 28 V64 C104 89 86 109 60 123 C34 109 16 89 16 64 V28 Z"
        fill="none"
        stroke="var(--crest-bg, #fbfaf6)"
        strokeWidth="2.4"
        opacity="0.55"
      />

      {/* Everything below is the "cut-out" in the crest colour */}
      <g fill="var(--crest-bg, #fbfaf6)">
        {/* ── Clock tower ── */}
        <path d="M60 24 L71 35 H49 Z" />                {/* roof */}
        <rect x="52" y="35" width="16" height="26" rx="1.5" />
        <circle cx="60" cy="45" r="5.4" fill="currentColor" />
        <rect x="59" y="41" width="2" height="5" rx="1" />   {/* clock hand */}
        <rect x="59" y="44" width="4.5" height="2" rx="1" /> {/* clock hand */}

        {/* ── Left wing ── */}
        <path d="M24 47 H50 V61 H24 Z" />
        {/* ── Right wing ── */}
        <path d="M70 47 H96 V61 H70 Z" />
      </g>
      {/* column gaps (crest colour lines carved back to shield colour) */}
      <g fill="currentColor">
        <rect x="28" y="49" width="2.5" height="12" />
        <rect x="34" y="49" width="2.5" height="12" />
        <rect x="40" y="49" width="2.5" height="12" />
        <rect x="79.5" y="49" width="2.5" height="12" />
        <rect x="85.5" y="49" width="2.5" height="12" />
        <rect x="91.5" y="49" width="2.5" height="12" />
      </g>

      {/* ── Open book ── */}
      <g fill="var(--crest-bg, #fbfaf6)">
        <path d="M60 66 C50 60 35 60 22 64 L22 82 C35 78 50 78 60 84 Z" />
        <path d="M60 66 C70 60 85 60 98 64 L98 82 C85 78 70 78 60 84 Z" />
      </g>

      {/* ── Calendar + check ── */}
      <g>
        <rect x="42" y="90" width="36" height="30" rx="4" fill="var(--crest-bg, #fbfaf6)" />
        <rect x="42" y="90" width="36" height="9" rx="4" fill="currentColor" opacity="0.9" />
        <rect x="49" y="86" width="3.5" height="8" rx="1.75" fill="var(--crest-bg, #fbfaf6)" />
        <rect x="67.5" y="86" width="3.5" height="8" rx="1.75" fill="var(--crest-bg, #fbfaf6)" />
        {/* grid dots */}
        <g fill="currentColor">
          <rect x="47" y="103" width="4" height="4" rx="1" />
          <rect x="54" y="103" width="4" height="4" rx="1" />
          <rect x="61" y="103" width="4" height="4" rx="1" />
          <rect x="47" y="110" width="4" height="4" rx="1" />
          <rect x="54" y="110" width="4" height="4" rx="1" />
        </g>
        {/* check badge */}
        <circle cx="72" cy="112" r="10" fill="currentColor" stroke="var(--crest-bg, #fbfaf6)" strokeWidth="2.4" />
        <path d="M67.5 112 l3 3 l5.5 -6" fill="none" stroke="var(--crest-bg, #fbfaf6)"
              strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}
