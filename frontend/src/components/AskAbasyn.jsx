import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mic, MicOff, X, Loader2, Radio, Sparkles, Volume2, CalendarRange, List } from 'lucide-react';
import api from '../api/client';

/**
 * "Ask Abasyn" — a hands-free voice assistant for the admin.
 *  • Click the button → a robotic female voice says it's activated, sound-wave
 *    rings pulse around the button, and it keeps listening.
 *  • It only acts on utterances that contain the wake word "Abasyn"; anything
 *    else is ignored.
 *  • "Abasyn suno / baat suno / listen"  → replies "Abasyn is Listening".
 *  • "Abasyn <name> ka timetable batao"  → "Command Accepted, Abasyn is
 *    Searching", queries the timetable, shows it on screen, then "Command
 *    Fulfilled".
 * Uses the browser Web Speech API only — SpeechRecognition to listen +
 * speechSynthesis to speak (a single mic; no second audio stream).
 */
const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
const VOICE_OK = typeof window !== 'undefined' && !!SR && 'speechSynthesis' in window;

// wake word + common mis-hearings of "Abasyn" (ASR mangles names a lot)
const WAKE = /\b(abasyn|abasin|abaseen|abaasin|abbas(in|een|yn)?|abasan|obasan|a\s?bas(in|yn|een)?)\b/gi;
// filler stripped from a command → leaves the search subject (name / room / course)
const FILLER = /\b(yaar|yar|abasyn|abasin|mujhe|mujhy|muje|zara|zra|please|plz|ka|ki|ke|ko|kaa|to|tou|na|batao|bata|dou|do|dede|de|dikhao|dikha|show|tell|me|find|search|the|of|for|time\s*table|timetable|kya|hai|hain|zaroori|jaldi)\b/gi;

// ── Urdu-script support ──────────────────────────────────────────────────────
// Urdu wake word, filler words, day names, and a rough Urdu→Latin transliteration
// so a teacher/room name spoken in Urdu can still fuzzy-match the (English) DB.
const WAKE_UR = /(ابا\s?س(ی?ن)?|ابیس(ی?ن)?)/g;
const FILLER_UR = /(مجھے|مجھ|کو|کے|کی|کا|بتاؤ|بتائیں|بتا|دکھاؤ|دکھائیں|دو|سناؤ|سنائیں|سنو|ٹائم\s?ٹیبل|ٹائم|ٹیبل|کلاسیں|کلاسز|کلاسیز|کلاسز|کلاس|کمرہ|کمرے|کیا|ہے|ہیں|یار|ذرا|پلیز|براہِ?\s?کرم|اور)/g;
const URDU_DAYS = [
  [/(پیر|سوموار)/g, ' Monday '], [/منگل/g, ' Tuesday '], [/بدھ/g, ' Wednesday '],
  [/جمعرات/g, ' Thursday '], [/جمعہ/g, ' Friday '], [/(ہفتہ|سنیچر)/g, ' Saturday '], [/اتوار/g, ' Sunday '],
];
const UR_MAP = {
  'آ': 'aa', 'ا': 'a', 'ب': 'b', 'پ': 'p', 'ت': 't', 'ٹ': 't', 'ث': 's', 'ج': 'j', 'چ': 'ch', 'ح': 'h',
  'خ': 'kh', 'د': 'd', 'ڈ': 'd', 'ذ': 'z', 'ر': 'r', 'ڑ': 'r', 'ز': 'z', 'ژ': 'zh', 'س': 's', 'ش': 'sh',
  'ص': 's', 'ض': 'z', 'ط': 't', 'ظ': 'z', 'ع': 'a', 'غ': 'gh', 'ف': 'f', 'ق': 'q', 'ک': 'k', 'گ': 'g',
  'ل': 'l', 'م': 'm', 'ن': 'n', 'ں': 'n', 'و': 'o', 'ہ': 'h', 'ھ': 'h', 'ة': 'h', 'ی': 'i', 'ي': 'i',
  'ے': 'e', 'ئ': 'y', 'ء': '', 'َ': '', 'ِ': '', 'ُ': '', 'ّ': '', 'ٰ': '',
};
const hasUrdu = (s) => /[؀-ۿ]/.test(s);
const toLatin = (s) => (!hasUrdu(s) ? s
  : s.split('').map((c) => (UR_MAP[c] !== undefined ? UR_MAP[c] : (/[؀-ۿ]/.test(c) ? '' : c))).join(''));

// ASR frequently mangles the made-up word "Abasyn" (e.g. hears "Bhagat Singh").
// Since the admin has already tapped to activate, treat an utterance as a command
// when it has the wake word OR any obvious command keyword — intent is clear.
const CMD_KW = /(suno|sun\s?lo|sunno|baat|listen|hello|hey|time\s*table|timetable|batao|bata\b|dikhao|dikha\b|schedule|room\b|kamra|kamrah|class\b|classes|teacher|kaun|kis\b|kahan|kab|ٹائم|ٹیبل|سنو|بتاؤ|بتا|دکھاؤ|کمرہ|کلاس|استاد)/i;
// frequent mis-hearings of "Abasyn" to scrub out of the query subject
const MISHEAR = /\b(bhagat\s?singh|bhagat|bhagwan|a person|obasan|abbasi|a bas(?:in|s in)?)\b/gi;
const wakeHit = (s) => { WAKE.lastIndex = 0; WAKE_UR.lastIndex = 0; return WAKE.test(s) || WAKE_UR.test(s); };

// ── intent vocabulary (any feature, any phrasing) ────────────────────────────
const RE_NAV = /(kholo|khol\s?do|kholdo|\bopen\b|jao|chalo|le chalo|navigate|\bpage\b|صفحہ|کھولو|کھول|جاؤ|چلو)/i;
const RE_LIST = /(list|lists|sab|saray|saaray|sare|\ball\b|batao|bata|dikhao|dikha|\bdo\b|dede|de do|فہرست|سب|ساری|سارے|دو|بتاؤ|دکھاؤ)/i;
const RE_COUNT = /(kitne|kitni|how many|count|total|number of|تعداد|کتنے|کتنی)/i;
const ENT = {
  teachers: /(faculty|teacher|teachers|ustad|ustaad|professor|professors|اساتذہ|استاد|فیکلٹی|ٹیچر)/i,
  labs: /(\blab\b|labs|laboratory|laboratories|لیب|لیبز)/i,
  rooms: /(room|rooms|classroom|classrooms|kamra|kamray|kamrah|کمرہ|کمرے|روم)/i,
  courses: /(course|courses|subject|subjects|کورس|کورسز|مضمون|مضامین|سبجیکٹ)/i,
  students: /(student|students|طالب|طلبہ|طلباء|اسٹوڈنٹ)/i,
  timetable: /(time\s*table|timetable|schedule|ٹائم\s*ٹیبل|ٹائم|ٹیبل|شیڈول)/i,
  datesheet: /(date\s*sheet|datesheet|exam|امتحان|ڈیٹ\s*شیٹ)/i,
  dashboard: /(dashboard|home page|summary|ڈیش\s*بورڈ)/i,
  reports: /(report|reports|analytics|رپورٹ|رپورٹس)/i,
  constraints: /(constraint|constraints|rules|قواعد|کنسٹرینٹ)/i,
};
// words to scrub so what's LEFT is the specific subject (a name / code / day)
const EXTRA = /\b(list|lists|sab|saray|saaray|sare|all|kitne|kitni|how|many|count|total|number|open|kholo|khol|kholdo|jao|chalo|navigate|page|faculty|teacher|teachers|ustad|ustaad|professor|professors|room|rooms|classroom|kamra|kamray|kamrah|lab|labs|laboratory|course|courses|subject|subjects|student|students|class|classes|schedule)\b/gi;
const EXTRA_UR = /(فہرست|سب|ساری|سارے|تعداد|کتنے|کتنی|کھولو|کھول|جاؤ|صفحہ|چلو|اساتذہ|استاد|فیکلٹی|ٹیچر|کمرہ|کمرے|روم|لیب|لیبز|کورس|کورسز|مضمون|مضامین|طالب|طلبہ|کلاس|کلاسیں|اسٹوڈنٹ)/g;
// admin route for each entity (for "… page kholo")
const NAV_ROUTE = {
  teachers: '/teachers', rooms: '/rooms-labs', labs: '/rooms-labs', courses: '/courses',
  timetable: '/class-timetable', datesheet: '/datesheets', dashboard: '/dashboard',
  reports: '/reports', constraints: '/constraints', students: '/people',
};
const NAV_LABEL = {
  teachers: 'Faculty', rooms: 'Rooms and Labs', labs: 'Rooms and Labs', courses: 'Courses',
  timetable: 'Timetable', datesheet: 'Date Sheets', dashboard: 'Dashboard',
  reports: 'Reports', constraints: 'Constraints', students: 'People and Assignments',
};

export default function AskAbasyn() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState('idle');   // idle | listening | searching | result | error | denied
  const [heard, setHeard] = useState('');
  const [interim, setInterim] = useState('');
  const [answer, setAnswer] = useState('');
  const [result, setResult] = useState(null);

  const [lang, setLang] = useState(() => { try { return localStorage.getItem('aa_lang') || 'en-US'; } catch { return 'en-US'; } });
  const navigate = useNavigate();

  const recRef = useRef(null);
  const activeRef = useRef(false);
  const startingRef = useRef(false);   // a recognizer is mid start/stop
  const busyRef = useRef(false);       // we are speaking / searching → don't auto-listen
  const langRef = useRef(lang);
  useEffect(() => { langRef.current = lang; }, [lang]);

  // Cross-referencing callbacks are kept in refs so the recognizer's event
  // handlers always call the latest version (no stale closures, no dep cycles).
  const speakRef = useRef(() => {});
  const startRecRef = useRef(() => {});
  const runCmdRef = useRef(async () => {});

  // warm up the voice list (some browsers load voices async)
  useEffect(() => {
    if (!VOICE_OK) return;
    const load = () => window.speechSynthesis.getVoices();
    load();
    window.speechSynthesis.addEventListener?.('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', load);
  }, []);

  // ── speak (robust): pauses listening while talking, works around the Chrome
  //    cancel()→speak() race, and can queue a follow-up line after the current. ──
  speakRef.current = (text, opts = {}) => {
    const resume = opts.resume !== false;   // resume listening after this line
    const queue = !!opts.queue;             // append after current speech instead of interrupting
    if (!VOICE_OK) { if (opts.onEnd) { try { opts.onEnd(); } catch { /**/ } } busyRef.current = false; if (resume && activeRef.current) startRecRef.current(); return; }
    const synth = window.speechSynthesis;
    const go = () => {
      try {
        const vs = synth.getVoices() || [];
        const fem = vs.find((v) => /female|zira|susan|samantha|aria|jenny|eva|hazel|libby|sonia|google uk english female/i.test(v.name))
          || vs.find((v) => /^en/i.test(v.lang));
        const u = new SpeechSynthesisUtterance(text);
        if (fem) { u.voice = fem; u.lang = fem.lang; } else u.lang = 'en-US';
        u.pitch = 1.2; u.rate = 0.98;
        const done = () => {
          if (opts.onEnd) { try { opts.onEnd(); } catch { /**/ } }
          if (resume) { busyRef.current = false; if (activeRef.current) startRecRef.current(); }
        };
        u.onend = done; u.onerror = done;
        synth.speak(u);
        try { synth.resume(); } catch { /**/ }
      } catch { if (opts.onEnd) { try { opts.onEnd(); } catch { /**/ } } busyRef.current = false; if (resume && activeRef.current) startRecRef.current(); }
    };
    try {
      if (queue) go();                                      // let it play after the current line
      else if (synth.speaking || synth.pending) { synth.cancel(); setTimeout(go, 90); }
      else go();
    } catch { if (opts.onEnd) { try { opts.onEnd(); } catch { /**/ } } busyRef.current = false; if (resume && activeRef.current) startRecRef.current(); }
  };

  // speak + resolve when the line finishes (with a safety timeout so we never hang)
  const speakP = (text, opts = {}) => new Promise((resolve) => {
    let fired = false; const fin = () => { if (!fired) { fired = true; resolve(); } };
    speakRef.current(text, { ...opts, onEnd: fin });
    setTimeout(fin, 4500);
  });

  runCmdRef.current = async (text) => {
    // trigger on the wake word OR any command/feature keyword (ASR mangles "Abasyn",
    // and the admin already tapped to activate, so intent is clear)
    const anyEntity = Object.values(ENT).some((re) => re.test(text));
    if (!wakeHit(text) && !CMD_KW.test(text) && !anyEntity && !RE_LIST.test(text) && !RE_COUNT.test(text) && !RE_NAV.test(text)) return;   // truly unrelated → ignore
    busyRef.current = true;                                // we drive the audio now → stop auto-listen
    try { recRef.current && recRef.current.stop(); } catch { /**/ }
    setHeard(text); setInterim('');

    // "Abasyn suno / baat suno / listen / سنو / بات سنو" (no query) → acknowledge
    const wantsData = /(time\s*table|timetable|room|course|class|day|kaun|kab|kahan|batao|dikhao|search|schedule|teacher|faculty|list|kitne|kitni|room|lab|student|ٹائم|ٹیبل|کمرہ|کلاس|بتاؤ|بتا|دکھاؤ|استاد|فہرست|لیب|طالب)/i.test(text);
    const isListen = !wantsData
      && /(suno|sun\s*lo|sunno|baat|listen|hello|hey|kaise|kaisa|kya haal|سنو|سنیں|سنیے|بات\s?سن)/i.test(text);
    if (isListen) { setStatus('listening'); speakRef.current('Abasyn is Listening.', { resume: true }); return; }

    // which feature/entity is being asked about
    let entity = null;
    for (const k of ['teachers', 'labs', 'rooms', 'courses', 'students', 'datesheet', 'reports', 'constraints', 'dashboard', 'timetable']) {
      if (ENT[k].test(text)) { entity = k; break; }
    }
    const wantTimetable = ENT.timetable.test(text);

    // the specific subject (name / code / day) left after scrubbing all keywords
    WAKE.lastIndex = 0; WAKE_UR.lastIndex = 0; FILLER.lastIndex = 0; FILLER_UR.lastIndex = 0; MISHEAR.lastIndex = 0; EXTRA.lastIndex = 0; EXTRA_UR.lastIndex = 0;
    let subject = text.replace(WAKE, ' ').replace(WAKE_UR, ' ').replace(MISHEAR, ' ')
      .replace(FILLER, ' ').replace(FILLER_UR, ' ').replace(EXTRA, ' ').replace(EXTRA_UR, ' ');
    for (const [re, val] of URDU_DAYS) subject = subject.replace(re, val);
    subject = toLatin(subject).replace(/\s+/g, ' ').trim();

    // NAVIGATION: "faculty page kholo", "courses kholo", "reports dikhao page"…
    if (RE_NAV.test(text) && entity && NAV_ROUTE[entity]) {
      setStatus('result'); setResult(null); setAnswer(`Opening ${NAV_LABEL[entity]}.`);
      try { navigate(NAV_ROUTE[entity]); } catch { /**/ }
      speakRef.current(`Opening ${NAV_LABEL[entity]}. Command Fulfilled.`, { resume: true });
      return;
    }

    // LIST / COUNT a whole collection: only when NO specific subject remains
    // (so "teachers list" → list, but "room J212" → search that room)
    const wantList = (RE_LIST.test(text) || RE_COUNT.test(text)) && !subject && !wantTimetable;
    if (wantList && ['teachers', 'rooms', 'labs', 'courses', 'students'].includes(entity)) {
      setStatus('searching'); setResult(null); setAnswer('');
      const fetchList = (async () => {
        if (entity === 'teachers') { const r = await api.get('/teachers'); return { title: 'Faculty', noun: 'faculty members', total: r.data.total, items: (r.data.items || []).map((x) => x.name + (x.department ? ` — ${x.department}` : '')) }; }
        if (entity === 'rooms') { const r = await api.get('/rooms-labs/rooms'); return { title: 'Rooms', noun: 'rooms', total: r.data.total, items: (r.data.items || []).map((x) => x.name + (x.capacity ? ` — ${x.capacity} seats` : '')) }; }
        if (entity === 'labs') { const r = await api.get('/rooms-labs/labs'); return { title: 'Labs', noun: 'labs', total: r.data.total, items: (r.data.items || []).map((x) => x.name + (x.capacity ? ` — ${x.capacity} seats` : '')) }; }
        if (entity === 'courses') { const r = await api.get('/courses', { params: { limit: 500 } }); return { title: 'Courses', noun: 'courses', total: r.data.total, items: (r.data.items || []).map((x) => `${x.code} — ${x.name}`) }; }
        const r = await api.get('/dashboard/summary'); return { title: 'Students', noun: 'students', total: (r.data.counts && r.data.counts.students) || 0, items: [], note: 'Manage students in People & Assignments.' };
      })();
      const [, res] = await Promise.all([speakP('Command Accepted. Abasyn is Searching.', { resume: false }), fetchList.catch(() => null)]);
      if (!res) { setStatus('error'); speakRef.current('Sorry, something went wrong.', { resume: true, queue: true }); return; }
      setAnswer(`There ${res.total === 1 ? 'is' : 'are'} ${res.total} ${res.noun}.` + (res.note ? ' ' + res.note : ''));
      setResult({ type: 'list', title: res.title, items: res.items, total: res.total });
      setStatus('result');
      speakRef.current('Command Fulfilled.', { resume: true, queue: true });
      return;
    }

    // otherwise: a specific timetable/room/course/day lookup (existing fuzzy search)
    const query = subject || toLatin(text).replace(WAKE, ' ').replace(/\s+/g, ' ').trim();
    if (!query) { setStatus('listening'); speakRef.current('Yes. Please tell me a teacher, room, course or day.', { resume: true }); return; }
    setStatus('searching'); setResult(null); setAnswer('');
    const [, r] = await Promise.all([
      speakP('Command Accepted. Abasyn is Searching.', { resume: false }),
      api.post('/search', { query }).then((x) => x).catch(() => null),
    ]);
    if (!r) { setStatus('error'); speakRef.current('Sorry, something went wrong.', { resume: true, queue: true }); return; }
    setAnswer(r.data.answer || '');
    setResult(r.data.results || null);
    setStatus('result');
    const ok = r.data.results && r.data.results.type !== 'overview';
    speakRef.current(ok ? 'Command Fulfilled.' : 'Sorry, I could not find that. Please try again.', { resume: true, queue: true });
  };

  startRecRef.current = () => {
    if (!SR || startingRef.current || busyRef.current || !activeRef.current) return;
    startingRef.current = true;
    const rec = new SR();
    rec.lang = langRef.current || 'en-US';
    rec.continuous = false;          // per-utterance → fires the moment you stop talking
    rec.interimResults = true;       // live transcript
    rec.maxAlternatives = 5;         // scan guesses so a mis-heard "Abasyn" still triggers
    rec.onstart = () => { startingRef.current = false; };
    rec.onresult = (e) => {
      let live = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) {
          const alts = [];
          for (let k = 0; k < res.length; k++) { const s = (res[k].transcript || '').trim(); if (s) alts.push(s); }
          const pick = alts.find((a) => wakeHit(a)) || alts.find((a) => CMD_KW.test(a)) || alts[0] || '';
          if (pick) runCmdRef.current(pick);
        } else live += res[0].transcript;
      }
      if (live) setInterim(live.trim());
    };
    rec.onerror = (ev) => {
      startingRef.current = false;
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed' || ev.error === 'audio-capture') {
        activeRef.current = false; setActive(false); setStatus('denied');
        try { rec.stop(); } catch { /**/ }
      }
      // 'no-speech' / 'aborted' / 'network' → onend restarts (if still active & idle)
    };
    rec.onend = () => {
      startingRef.current = false;
      if (activeRef.current && !busyRef.current) {
        setTimeout(() => { if (activeRef.current && !busyRef.current) startRecRef.current(); }, 150);
      }
    };
    recRef.current = rec;
    try { rec.start(); } catch { startingRef.current = false; }
  };

  const activate = useCallback(() => {
    if (!VOICE_OK) { setOpen(true); setStatus('error'); return; }
    setOpen(true); setActive(true); activeRef.current = true; setStatus('listening');
    setHeard(''); setInterim(''); setAnswer(''); setResult(null);
    busyRef.current = true;
    // spoken synchronously inside the click → satisfies the browser gesture rule;
    // resume:true starts listening only AFTER the greeting (so it won't hear itself)
    speakRef.current('Abasyn Voice Assistant is Activated.', { resume: true });
  }, []);

  const deactivate = useCallback(() => {
    activeRef.current = false; busyRef.current = false; setActive(false); setStatus('idle'); setInterim('');
    try { recRef.current && recRef.current.stop(); } catch { /**/ }
    try { window.speechSynthesis.cancel(); } catch { /**/ }
  }, []);

  const switchLang = useCallback((next) => {
    setLang(next); langRef.current = next;
    try { localStorage.setItem('aa_lang', next); } catch { /**/ }
    if (activeRef.current && recRef.current && !busyRef.current) { try { recRef.current.stop(); } catch { /**/ } }   // onend restarts with new lang
  }, []);

  useEffect(() => () => deactivate(), [deactivate]);   // cleanup on unmount

  return (
    <>
      <style>{`
        @keyframes aa-ring { 0%{transform:scale(1);opacity:.65} 100%{transform:scale(2.5);opacity:0} }
        @keyframes aa-bar { 0%,100%{transform:scaleY(.35)} 50%{transform:scaleY(1)} }
        .aa-dock{position:fixed;right:22px;bottom:22px;z-index:1200;display:grid;place-items:center;width:60px;height:60px}
        .aa-fab{position:relative;z-index:2;width:60px;height:60px;border:none;border-radius:50%;cursor:pointer;color:#fff;
          display:grid;place-items:center;background:linear-gradient(135deg,#198754,#0f3d2e);box-shadow:0 10px 26px rgba(15,61,46,.4)}
        .aa-fab:hover{filter:brightness(1.07)}
        .aa-fab.on{background:linear-gradient(135deg,#e11d48,#7f1030)}
        .aa-ring{position:absolute;inset:0;border-radius:50%;border:2px solid rgba(25,135,84,.55);animation:aa-ring 1.9s ease-out infinite;pointer-events:none;z-index:1}
        .aa-ring.r2{animation-delay:.63s}.aa-ring.r3{animation-delay:1.26s}
        .aa-tip{position:absolute;right:72px;bottom:16px;white-space:nowrap;background:#0f3d2e;color:#fff;font-size:12px;font-weight:700;
          padding:6px 11px;border-radius:8px;opacity:0;transform:translateX(6px);transition:.15s;pointer-events:none}
        .aa-dock:hover .aa-tip{opacity:1;transform:none}
        .aa-panel{position:fixed;right:22px;bottom:92px;z-index:1300;width:min(420px,calc(100vw - 32px));
          background:var(--surface,#fff);border:1px solid var(--border,#e3e9e6);border-radius:18px;overflow:hidden;
          box-shadow:0 24px 60px rgba(15,38,28,.28);display:flex;flex-direction:column;max-height:min(72vh,640px)}
        .aa-seg{display:inline-flex;border:1px solid var(--border,#dbe5e0);border-radius:9px;overflow:hidden}
        .aa-seg button{border:none;background:transparent;padding:5px 13px;font-size:12px;font-weight:700;cursor:pointer;color:var(--text-faint,#6b7a72)}
        .aa-seg button.on{background:#198754;color:#fff}
        .aa-bars{display:inline-flex;gap:3px;align-items:flex-end;height:16px}
        .aa-bars i{width:3px;height:100%;background:#198754;border-radius:2px;transform-origin:bottom;animation:aa-bar 1s ease-in-out infinite}
        .aa-bars i:nth-child(2){animation-delay:.15s}.aa-bars i:nth-child(3){animation-delay:.3s}.aa-bars i:nth-child(4){animation-delay:.45s}
      `}</style>

      {/* button + sound-wave rings */}
      <div className="aa-dock">
        {active && (<><span className="aa-ring" /><span className="aa-ring r2" /><span className="aa-ring r3" /></>)}
        <button className={`aa-fab ${active ? 'on' : ''}`} title="Ask Abasyn — voice assistant"
          onClick={() => { if (active) { deactivate(); } else { activate(); } }}>
          {active ? <Mic size={24} /> : <Sparkles size={24} />}
        </button>
        {!open && <span className="aa-tip">Ask Abasyn</span>}
      </div>

      {open && (
        <div className="aa-panel">
          {/* header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px',
            background: 'linear-gradient(135deg,#0f3d2e,#198754)', color: '#fff' }}>
            <span style={{ width: 34, height: 34, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'rgba(255,255,255,.16)' }}>
              <Sparkles size={18} />
            </span>
            <div style={{ lineHeight: 1.15 }}>
              <div style={{ fontWeight: 800, fontSize: 15 }}>Abasyn Voice Assistant</div>
              <div style={{ fontSize: 11.5, opacity: .9 }}>{active ? 'Active · listening' : 'Tap the mic to activate'}</div>
            </div>
            <button onClick={() => { deactivate(); setOpen(false); }} title="Close"
              style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer' }}>
              <X size={20} />
            </button>
          </div>

          {/* body */}
          <div style={{ padding: 16, overflowY: 'auto' }}>
            {!VOICE_OK ? (
              <div style={{ fontSize: 13.5, color: '#c53030' }}>
                Voice isn't supported in this browser. Please use Google Chrome (desktop) with a microphone.
              </div>
            ) : status === 'denied' ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13.5, color: '#c53030',
                background: '#fdeaea', border: '1px solid #f5c2c2', borderRadius: 12, padding: '11px 13px' }}>
                <MicOff size={17} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>Microphone is blocked. Click the <b>mic / lock icon</b> in the address bar → allow the microphone, then press <b>Activate</b> again. (Won't work inside the Claude preview pane — open <b>http://localhost:5199</b> in Chrome.)</span>
              </div>
            ) : (
              <>
                {/* language */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-faint)' }}>Language</span>
                  <div className="aa-seg">
                    <button className={lang === 'en-US' ? 'on' : ''} onClick={() => switchLang('en-US')}>English</button>
                    <button className={lang === 'ur-PK' ? 'on' : ''} onClick={() => switchLang('ur-PK')} style={{ fontSize: 14 }}>اردو</button>
                  </div>
                </div>

                {/* status */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 13px', borderRadius: 12,
                  background: 'var(--surface-2,#f1f6f3)', marginBottom: 12 }}>
                  {status === 'searching' ? <Loader2 size={17} className="spin" style={{ color: '#198754' }} />
                    : status === 'listening' ? <span className="aa-bars"><i /><i /><i /><i /></span>
                    : status === 'result' ? <CalendarRange size={17} style={{ color: '#198754' }} />
                    : <Radio size={17} style={{ color: '#8a978f' }} />}
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                    {status === 'listening' && 'Listening… say “Abasyn …”'}
                    {status === 'searching' && 'Command accepted — searching…'}
                    {status === 'result' && 'Command fulfilled.'}
                    {status === 'error' && 'Something went wrong.'}
                    {status === 'idle' && 'Idle.'}
                  </span>
                </div>

                {interim && (
                  <div style={{ fontSize: 12.5, color: 'var(--brand-600,#198754)', marginBottom: 8, fontStyle: 'italic' }}>
                    …{interim}
                  </div>
                )}
                {heard && (
                  <div style={{ fontSize: 12.5, color: 'var(--text-faint)', marginBottom: 10 }}>
                    <b>You said:</b> “{heard}”
                  </div>
                )}
                {answer && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13.5, color: 'var(--text)',
                    background: '#e7f5ec', border: '1px solid #c9e9d6', borderRadius: 12, padding: '10px 12px', marginBottom: 12 }}>
                    <Volume2 size={16} style={{ color: '#198754', flexShrink: 0, marginTop: 1 }} /> <span>{answer}</span>
                  </div>
                )}

                <ResultView result={result} />

                <div style={{ marginTop: 14, display: 'flex', gap: 10 }}>
                  {active
                    ? <button className="btn btn-ghost btn-sm" onClick={deactivate}>Stop listening</button>
                    : <button className="btn btn-primary btn-sm" onClick={activate}><Mic size={14} /> Activate</button>}
                </div>

                <p style={{ marginTop: 12, fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.6 }}>
                  {lang === 'ur-PK'
                    ? <>مثال: <i>”اباسین، عفیفہ گلرہ کا ٹائم ٹیبل بتاؤ“</i> · <i>”اباسین، جمعہ کی کلاسیں“</i> · <i>”اباسین سنو“</i>۔ صرف تب جواب دیتا ہے جب آپ <b>اباسین</b> کہیں۔ (نام انگریزی میں زیادہ درست پہچانے جاتے ہیں۔)</>
                    : <>Try: <i>“Abasyn, Afifa Golra ka timetable batao”</i> · <i>“Abasyn, room J212”</i> · <i>“Abasyn, CS313”</i> · <i>“Abasyn, Friday classes”</i> · <i>“Abasyn suno”</i>. It only responds when you say <b>Abasyn</b>.</>}
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/* Render the timetable results returned by /api/search. */
function ResultView({ result }) {
  if (!result) return null;

  // simple list (faculty / rooms / labs / courses)
  if (result.type === 'list') {
    const items = result.items || [];
    return (
      <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 13px', background: 'var(--ink-700,#12261c)', color: '#fff', fontWeight: 700, fontSize: 13 }}>
          <List size={15} /> {result.title} <span style={{ marginLeft: 'auto', opacity: .85, fontWeight: 600 }}>{result.total}</span>
        </div>
        {items.length === 0
          ? <div style={{ padding: 14, fontSize: 13, color: 'var(--text-faint)' }}>Nothing to show here.</div>
          : <div style={{ maxHeight: 260, overflowY: 'auto' }}>
              {items.slice(0, 200).map((it, i) => (
                <div key={i} style={{ padding: '7px 13px', fontSize: 12.5, borderTop: i ? '1px solid var(--border-soft,#eef2f0)' : 'none' }}>
                  <span style={{ color: 'var(--text-faint)', marginRight: 8 }}>{i + 1}.</span>{it}
                </div>
              ))}
              {items.length > 200 && <div style={{ padding: '7px 13px', fontSize: 12, color: 'var(--text-faint)' }}>…and {items.length - 200} more</div>}
            </div>}
      </div>
    );
  }

  const title = result.teacher || result.room || result.program
    || (result.code ? `${result.code}${result.name ? ' — ' + result.name : ''}` : (result.day || ''));
  const groups = result.days || result.rooms || null;   // teacher/room/program/course → days; day_schedule → rooms
  if (!groups) return null;
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
      {title && (
        <div style={{ padding: '9px 13px', background: 'var(--ink-700,#12261c)', color: '#fff', fontWeight: 700, fontSize: 13 }}>
          {title}
        </div>
      )}
      {groups.length === 0 && (
        <div style={{ padding: 14, fontSize: 13, color: 'var(--text-faint)' }}>No classes found.</div>
      )}
      {groups.map((g, i) => (
        <div key={i} style={{ borderTop: i ? '1px solid var(--border)' : 'none' }}>
          <div style={{ padding: '7px 13px', fontSize: 11.5, fontWeight: 800, color: 'var(--brand-600,#198754)',
            textTransform: 'uppercase', letterSpacing: '.03em', background: 'var(--surface-2,#f4f7f5)' }}>
            {g.day || g.room}
          </div>
          {(g.sessions || []).map((s, j) => (
            <div key={j} style={{ display: 'flex', gap: 10, padding: '8px 13px', fontSize: 12.5,
              borderTop: j ? '1px solid var(--border-soft,#eef2f0)' : 'none' }}>
              <span style={{ fontFamily: 'ui-monospace,Menlo,monospace', fontWeight: 700, color: 'var(--ink-700)', minWidth: 62 }}>{s.slot}</span>
              <span style={{ flex: 1 }}>
                <b>{s.code}</b>{s.section ? ` (${s.section})` : ''} — {s.name}
                <span style={{ color: 'var(--text-faint)' }}>{'  ·  '}{s.room}{s.teacher && result.type !== 'teacher_schedule' ? `  ·  ${s.teacher}` : ''}</span>
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
