import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mic, MicOff, X, Loader2, Radio, Sparkles, Volume2, VolumeX, List, Send, CalendarRange } from 'lucide-react';
import api from '../api/client';

/**
 * "Ask Abasyn" — voice + text assistant for the Exam Cell.
 *
 *  • Opening it starts listening at once (no wake word needed while it is open).
 *  • Listening is continuous and self-healing: the recognizer restarts itself after
 *    silence, network blips or Chrome's 60-second cut-off; a watchdog re-arms it.
 *  • Every guess the speech engine makes (up to 5) goes to the server, which picks the
 *    one it understands best — English, Roman Urdu or Urdu script, spoken numbers
 *    ("nine eight four one", "char sau teen"), spelled codes ("see es 313").
 *  • Answers come from the live exam data (duties, papers, seats, rooms, sections, fee)
 *    and are SPOKEN back — in Urdu with an Urdu voice when one is installed.
 *  • You can also type a question.
 */
const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
const HAS_TTS = typeof window !== 'undefined' && 'speechSynthesis' in window;
const HEAR_OK = !!SR;

const hasUrdu = (s) => /[؀-ۿ]/.test(s || '');
// local commands (handled in the browser)
const RE_STOP = /^(stop|ruk jao|ruko|bas|band karo|chup|خاموش|بس|رکو|بند کرو)\b/i;
const RE_NAV = /(kholo|khol\s?do|\bopen\b|jao|chalo|le chalo|navigate|کھولو|جاؤ|چلو)/i;
const NAV = [
  [/(registration|student course|کورس رجسٹریشن)/i, '/student-courses', 'Student Courses'],
  [/(faculty|teacher|teachers|اساتذہ|استاد|ٹیچر)/i, '/teachers', 'Faculty'],
  [/(room|rooms|lab|labs|کمرہ|کمرے|لیب)/i, '/rooms-labs', 'Rooms and Labs'],
  [/(course|courses|کورس)/i, '/courses', 'Courses'],
  [/(date\s*sheet|datesheet|ڈیٹ\s*شیٹ)/i, '/datesheets', 'Date Sheets'],
  [/(admit|seating|ایڈمٹ)/i, '/dashboard', 'Admit Cards'],
  [/(dashboard|home|ڈیش\s*بورڈ)/i, '/dashboard', 'Dashboard'],
  [/(report|reports|رپورٹ)/i, '/reports', 'Reports'],
  [/(student|students|طلبہ|اسٹوڈنٹ)/i, '/people', 'People'],
];

/** best female voice for a language ('ur' → Urdu, else English) */
function pickVoice(want) {
  const vs = (HAS_TTS && window.speechSynthesis.getVoices()) || [];
  if (want === 'ur') {
    return vs.find((v) => /^ur/i.test(v.lang) && /female|uzma|gul/i.test(v.name))
      || vs.find((v) => /^ur/i.test(v.lang)) || null;
  }
  return vs.find((v) => /en-(IN|GB|US)/i.test(v.lang) && /(female|zira|aria|jenny|neerja|sonia|libby|heera|samantha|google uk english female)/i.test(v.name))
    || vs.find((v) => /^en-IN/i.test(v.lang)) || vs.find((v) => /^en/i.test(v.lang)) || null;
}
/** split long answers into short sentences (Chrome stops long utterances after ~15 s) */
function chunks(text) {
  return String(text || '').split(/(?<=[.;؛۔!?])\s+/).map((s) => s.trim()).filter(Boolean)
    .flatMap((s) => (s.length > 180 ? s.split(/,\s+|،\s*/).map((x) => x.trim()).filter(Boolean) : [s]));
}

export default function AskAbasyn() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState('idle');   // idle | listening | thinking | speaking | result | error | denied
  const [heard, setHeard] = useState('');
  const [interim, setInterim] = useState('');
  const [answer, setAnswer] = useState('');
  const [answerUr, setAnswerUr] = useState('');
  const [result, setResult] = useState(null);
  const [suggest, setSuggest] = useState([]);
  const [typed, setTyped] = useState('');
  const [muted, setMuted] = useState(() => { try { return localStorage.getItem('aa_mute') === '1'; } catch { return false; } });
  const [lang, setLang] = useState(() => {
    try { const v = localStorage.getItem('aa_lang'); return v === 'ur-PK' ? 'ur-PK' : 'en-IN'; } catch { return 'en-IN'; }
  });
  const navigate = useNavigate();

  const recRef = useRef(null);
  const activeRef = useRef(false);
  const runningRef = useRef(false);   // recognizer is live
  const busyRef = useRef(false);      // thinking / speaking → don't listen (never hears itself)
  const langRef = useRef(lang);
  const mutedRef = useRef(muted);
  const backoffRef = useRef(250);
  const lastAskRef = useRef({ text: '', at: 0 });
  useEffect(() => { langRef.current = lang; }, [lang]);
  useEffect(() => { mutedRef.current = muted; }, [muted]);

  useEffect(() => {   // voices load async in Chrome / Edge
    if (!HAS_TTS) return undefined;
    const load = () => window.speechSynthesis.getVoices();
    load();
    window.speechSynthesis.addEventListener?.('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', load);
  }, []);

  const startRef = useRef(() => {});
  const askRef = useRef(async () => {});

  // ── speaking ───────────────────────────────────────────────────────────────
  const speak = useCallback((text, langCode) => new Promise((resolve) => {
    if (!HAS_TTS || mutedRef.current || !text) { resolve(); return; }
    const synth = window.speechSynthesis;
    try { synth.cancel(); } catch { /**/ }
    const want = langCode === 'ur' ? 'ur' : 'en';
    const voice = pickVoice(want);
    if (want === 'ur' && !voice) { resolve('no-ur'); return; }   // caller falls back to English
    const parts = chunks(text);
    let i = 0; let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const next = () => {
      if (i >= parts.length || !activeRef.current && !open) { finish(); return; }
      const u = new SpeechSynthesisUtterance(parts[i++]);
      if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = want === 'ur' ? 'ur-PK' : 'en-IN';
      u.rate = want === 'ur' ? 0.95 : 1.0; u.pitch = 1.05;
      u.onend = next; u.onerror = next;
      synth.speak(u);
    };
    setTimeout(next, 60);
    setTimeout(finish, 45000);   // never hang
  }), [open]);

  const say = useCallback(async (en, ur, preferUr) => {
    busyRef.current = true; setStatus('speaking');
    try { recRef.current && recRef.current.abort(); } catch { /**/ }
    if (preferUr && ur) { const r = await speak(ur, 'ur'); if (r === 'no-ur') await speak(en, 'en'); } else await speak(en, 'en');
    busyRef.current = false;
    if (activeRef.current) { setStatus('listening'); startRef.current(); } else setStatus('result');
  }, [speak]);

  // ── one question → answer ─────────────────────────────────────────────────
  askRef.current = async (text, alternatives = []) => {
    const q = String(text || '').trim();
    if (!q) return;
    // the same final result twice within 2 s (Chrome repeats) → ignore
    if (lastAskRef.current.text === q && Date.now() - lastAskRef.current.at < 2000) return;
    lastAskRef.current = { text: q, at: Date.now() };
    const urduWanted = langRef.current === 'ur-PK' || hasUrdu(q);

    if (RE_STOP.test(q)) {
      try { window.speechSynthesis.cancel(); } catch { /**/ }
      setHeard(q); setAnswer('Stopped.'); setAnswerUr('رک گئی۔'); return;
    }
    if (RE_NAV.test(q)) {
      const hit = NAV.find(([re]) => re.test(q));
      if (hit) {
        setHeard(q); setResult(null); setSuggest([]);
        setAnswer(`Opening ${hit[2]}.`); setAnswerUr(`${hit[2]} کھول رہی ہوں۔`);
        try { navigate(hit[1]); } catch { /**/ }
        await say(`Opening ${hit[2]}.`, `${hit[2]} کھول رہی ہوں۔`, urduWanted);
        return;
      }
    }

    busyRef.current = true; setStatus('thinking');
    try { recRef.current && recRef.current.abort(); } catch { /**/ }
    setHeard(q); setInterim(''); setAnswer(''); setAnswerUr(''); setResult(null); setSuggest([]);
    let data = null;
    try {
      const r = await api.post('/assistant/ask', { text: q, alternatives, lang: urduWanted ? 'ur' : 'en' });
      data = r.data;
    } catch { data = null; }
    // timetable questions still work while a timetable exists
    if (data && !data.intent) {
      try {
        const s = await api.post('/search', { query: q });
        if (s.data && s.data.results && s.data.results.type !== 'overview') {
          data = { intent: 'timetable', answer: s.data.answer, answerUr: s.data.answer, result: { type: 'timetable', raw: s.data.results } };
        }
      } catch { /* keep the assistant's own reply */ }
    }
    if (!data) {
      setStatus('error');
      setAnswer('Sorry, the server did not answer. Please try again.'); setAnswerUr('معاف کیجیے، سرور سے جواب نہیں آیا۔ دوبارہ کوشش کریں۔');
      await say('Sorry, the server did not answer. Please try again.', 'معاف کیجیے، سرور سے جواب نہیں آیا۔ دوبارہ کوشش کریں۔', urduWanted);
      return;
    }
    setAnswer(data.answer || ''); setAnswerUr(data.answerUr || ''); setResult(data.result || null); setSuggest(data.suggestions || []);
    setStatus('result');
    await say(data.answer, data.answerUr, urduWanted);
  };

  // ── listening (continuous, self-healing) ──────────────────────────────────
  startRef.current = () => {
    if (!SR || runningRef.current || busyRef.current || !activeRef.current) return;
    const rec = new SR();
    rec.lang = langRef.current;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 5;
    rec.onstart = () => { runningRef.current = true; backoffRef.current = 250; setStatus((s) => (s === 'thinking' || s === 'speaking' ? s : 'listening')); };
    rec.onresult = (e) => {
      let live = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) {
          const alts = [];
          for (let k = 0; k < res.length; k++) { const s = (res[k].transcript || '').trim(); if (s) alts.push(s); }
          if (alts.length && alts[0].replace(/[^\p{L}\p{N}]/gu, '').length >= 2) askRef.current(alts[0], alts.slice(1));
        } else live += res[0].transcript;
      }
      setInterim(live.trim());
    };
    rec.onerror = (ev) => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed' || ev.error === 'audio-capture') {
        activeRef.current = false; setActive(false); setStatus('denied');
      } else if (ev.error === 'network') {
        backoffRef.current = Math.min(4000, backoffRef.current * 2);
      }
    };
    rec.onend = () => {
      runningRef.current = false;
      if (activeRef.current && !busyRef.current) setTimeout(() => startRef.current(), backoffRef.current);
    };
    recRef.current = rec;
    try { rec.start(); } catch { runningRef.current = false; }
  };

  // watchdog: if the recognizer silently died, bring it back
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => { if (activeRef.current && !busyRef.current && !runningRef.current) startRef.current(); }, 3000);
    return () => clearInterval(id);
  }, [active]);

  const activate = useCallback(async () => {
    setOpen(true);
    if (!HEAR_OK) { setStatus('result'); return; }
    // ask for the mic once with echo-cancel / noise-suppression (clearer input on laptops)
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      s.getTracks().forEach((t) => t.stop());
    } catch (e) {
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) { setStatus('denied'); return; }
    }
    activeRef.current = true; setActive(true);
    setHeard(''); setInterim(''); setAnswer(''); setAnswerUr(''); setResult(null); setSuggest([]);
    const ur = langRef.current === 'ur-PK';
    await say('Abasyn assistant is ready. Ask me about duties, papers, seats or rooms.',
      'اباسین اسسٹنٹ حاضر ہے۔ ڈیوٹی، پرچوں، سیٹ یا کمروں کے بارے میں پوچھیں۔', ur);
  }, [say]);

  const deactivate = useCallback(() => {
    activeRef.current = false; busyRef.current = false; setActive(false); setStatus('idle'); setInterim('');
    try { recRef.current && recRef.current.abort(); } catch { /**/ }
    try { window.speechSynthesis.cancel(); } catch { /**/ }
  }, []);

  const switchLang = useCallback((next) => {
    setLang(next); langRef.current = next;
    try { localStorage.setItem('aa_lang', next); } catch { /**/ }
    try { recRef.current && recRef.current.abort(); } catch { /**/ }   // restarts in the new language
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((m) => { const v = !m; try { localStorage.setItem('aa_mute', v ? '1' : '0'); } catch { /**/ } if (v) { try { window.speechSynthesis.cancel(); } catch { /**/ } } return v; });
  }, []);

  useEffect(() => () => deactivate(), [deactivate]);

  const submitTyped = (e) => { e.preventDefault(); const t = typed.trim(); if (!t) return; setTyped(''); lastAskRef.current = { text: '', at: 0 }; askRef.current(t, []); };
  const urMode = lang === 'ur-PK';
  const shownAnswer = urMode ? (answerUr || answer) : answer;

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
        .aa-panel{position:fixed;right:22px;bottom:92px;z-index:1300;width:min(460px,calc(100vw - 32px));
          background:var(--surface,#fff);border:1px solid var(--border,#e3e9e6);border-radius:18px;overflow:hidden;
          box-shadow:0 24px 60px rgba(15,38,28,.28);display:flex;flex-direction:column;max-height:min(78vh,700px)}
        .aa-seg{display:inline-flex;border:1px solid var(--border,#dbe5e0);border-radius:9px;overflow:hidden}
        .aa-seg button{border:none;background:transparent;padding:5px 12px;font-size:12px;font-weight:700;cursor:pointer;color:var(--text-faint,#6b7a72)}
        .aa-seg button.on{background:#198754;color:#fff}
        .aa-bars{display:inline-flex;gap:3px;align-items:flex-end;height:16px}
        .aa-bars i{width:3px;height:100%;background:#198754;border-radius:2px;transform-origin:bottom;animation:aa-bar 1s ease-in-out infinite}
        .aa-bars i:nth-child(2){animation-delay:.15s}.aa-bars i:nth-child(3){animation-delay:.3s}.aa-bars i:nth-child(4){animation-delay:.45s}
        .aa-input{display:flex;gap:8px;margin-top:12px}
        .aa-input input{flex:1;min-width:0;border:1px solid var(--border,#dbe5e0);border-radius:10px;padding:8px 11px;font-size:13px;background:var(--surface,#fff);color:var(--text)}
        .aa-chip{border:1px solid #c9e9d6;background:#f1faf4;color:#0f5b3a;border-radius:999px;padding:4px 10px;font-size:12px;cursor:pointer}
        .aa-tbl{width:100%;border-collapse:collapse;font-size:12px}
        .aa-tbl th{background:var(--ink-700,#12261c);color:#fff;text-align:left;padding:6px 8px;font-weight:700;position:sticky;top:0}
        .aa-tbl td{padding:6px 8px;border-top:1px solid var(--border-soft,#eef2f0);vertical-align:top}
      `}</style>

      <div className="aa-dock">
        {active && (<><span className="aa-ring" /><span className="aa-ring r2" /><span className="aa-ring r3" /></>)}
        <button className={`aa-fab ${active ? 'on' : ''}`} title="Ask Abasyn — voice assistant"
          onClick={() => { if (active) deactivate(); else activate(); }}>
          {active ? <Mic size={24} /> : <Sparkles size={24} />}
        </button>
        {!open && <span className="aa-tip">Ask Abasyn</span>}
      </div>

      {open && (
        <div className="aa-panel">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', background: 'linear-gradient(135deg,#0f3d2e,#198754)', color: '#fff' }}>
            <span style={{ width: 34, height: 34, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'rgba(255,255,255,.16)' }}><Sparkles size={18} /></span>
            <div style={{ lineHeight: 1.15 }}>
              <div style={{ fontWeight: 800, fontSize: 15 }}>Abasyn Voice Assistant</div>
              <div style={{ fontSize: 11.5, opacity: .9 }}>{active ? 'Listening — just speak' : 'Tap the mic, or type below'}</div>
            </div>
            <button onClick={toggleMute} title={muted ? 'Voice replies off' : 'Voice replies on'}
              style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer' }}>
              {muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
            </button>
            <button onClick={() => { deactivate(); setOpen(false); }} title="Close" style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer' }}>
              <X size={20} />
            </button>
          </div>

          <div style={{ padding: 16, overflowY: 'auto' }}>
            {status === 'denied' && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, color: '#c53030', background: '#fdeaea', border: '1px solid #f5c2c2', borderRadius: 12, padding: '10px 12px', marginBottom: 12 }}>
                <MicOff size={17} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>Microphone is blocked. Click the <b>lock / mic icon</b> in the address bar → allow the microphone, then tap the mic again. You can still type below.</span>
              </div>
            )}
            {!HEAR_OK && (
              <div style={{ fontSize: 13, color: '#9a5b00', background: '#fff6e5', border: '1px solid #f3dcae', borderRadius: 12, padding: '10px 12px', marginBottom: 12 }}>
                Voice input needs Google Chrome or Microsoft Edge. You can still type your question below.
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-faint)' }}>Speak in</span>
              <div className="aa-seg">
                <button className={!urMode ? 'on' : ''} onClick={() => switchLang('en-IN')}>English / Roman Urdu</button>
                <button className={urMode ? 'on' : ''} onClick={() => switchLang('ur-PK')} style={{ fontSize: 14 }}>اردو</button>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 13px', borderRadius: 12, background: 'var(--surface-2,#f1f6f3)', marginBottom: 12 }}>
              {status === 'thinking' ? <Loader2 size={17} className="spin" style={{ color: '#198754' }} />
                : status === 'listening' ? <span className="aa-bars"><i /><i /><i /><i /></span>
                : status === 'speaking' ? <Volume2 size={17} style={{ color: '#198754' }} />
                : status === 'result' ? <CalendarRange size={17} style={{ color: '#198754' }} />
                : <Radio size={17} style={{ color: '#8a978f' }} />}
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                {status === 'listening' && (urMode ? 'سن رہی ہوں… بولیں' : 'Listening… speak now')}
                {status === 'thinking' && (urMode ? 'سمجھ رہی ہوں…' : 'Understanding…')}
                {status === 'speaking' && (urMode ? 'جواب دے رہی ہوں…' : 'Answering…')}
                {status === 'result' && (urMode ? 'جواب حاضر ہے۔' : 'Here is the answer.')}
                {status === 'error' && 'Something went wrong.'}
                {(status === 'idle' || status === 'denied') && (urMode ? 'مائیک بند ہے' : 'Mic is off')}
              </span>
            </div>

            {interim && <div style={{ fontSize: 12.5, color: 'var(--brand-600,#198754)', marginBottom: 8, fontStyle: 'italic' }} dir="auto">…{interim}</div>}
            {heard && <div style={{ fontSize: 12.5, color: 'var(--text-faint)', marginBottom: 10 }} dir="auto"><b>You said:</b> “{heard}”</div>}
            {shownAnswer && (
              <div dir={urMode && answerUr ? 'rtl' : 'ltr'} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: urMode ? 14.5 : 13.5, lineHeight: 1.6, color: 'var(--text)', background: '#e7f5ec', border: '1px solid #c9e9d6', borderRadius: 12, padding: '10px 12px', marginBottom: 12 }}>
                <Volume2 size={16} style={{ color: '#198754', flexShrink: 0, marginTop: 3 }} /> <span>{shownAnswer}</span>
              </div>
            )}
            {suggest.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>Did you mean:</span>
                {suggest.map((s) => <button key={s} className="aa-chip" onClick={() => { lastAskRef.current = { text: '', at: 0 }; askRef.current(`${s} ${/duty|ڈیوٹی/i.test(heard) ? 'ki duty' : ''}`.trim(), []); }}>{s}</button>)}
              </div>
            )}

            <ResultView result={result} />

            <form className="aa-input" onSubmit={submitTyped}>
              <input value={typed} onChange={(e) => setTyped(e.target.value)} dir="auto"
                placeholder={urMode ? 'یہاں لکھیں… مثلاً: عقصہ اشفاق کی ڈیوٹی' : 'Type… e.g. “CS313 ka paper kab hai”'} />
              <button className="btn btn-primary btn-sm" type="submit" title="Ask"><Send size={14} /></button>
            </form>

            <div style={{ marginTop: 12, display: 'flex', gap: 10 }}>
              {active
                ? <button className="btn btn-ghost btn-sm" onClick={deactivate}><MicOff size={14} /> Stop listening</button>
                : <button className="btn btn-primary btn-sm" onClick={activate} disabled={!HEAR_OK}><Mic size={14} /> Start listening</button>}
            </div>

            <p style={{ marginTop: 12, fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.7 }} dir={urMode ? 'rtl' : 'ltr'}>
              {urMode
                ? <>مثالیں: <i>عقصہ اشفاق کی ڈیوٹی</i> · <i>سی ایس تین سو تیرہ کا پرچہ کب ہے</i> · <i>نو آٹھ چار ایک کی سیٹ</i> · <i>تین نومبر کے پرچے</i> · <i>ایم جی چار سو تین سیکشن بی کس کا ہے</i></>
                : <>Try: <i>“Aqsa Ashfaq ki duty”</i> · <i>“CS313 ka paper kab hai”</i> · <i>“9841 ki seat”</i> · <i>“room J-214, 3 November”</i> · <i>“3 November ke papers”</i> · <i>“MG403 section B ka teacher”</i> · <i>“kitne students”</i> · <i>“datesheet kholo”</i></>}
            </p>
          </div>
        </div>
      )}
    </>
  );
}

const COLS = {
  duties: [['day', 'Date'], ['slot', 'Time'], ['room', 'Room'], ['students', 'Students'], ['with', 'With']],
  teacher_courses: [['code', 'Course'], ['name', 'Title'], ['day', 'Paper date'], ['slot', 'Time']],
  student: [['code', 'Paper'], ['day', 'Date'], ['slot', 'Time'], ['room', 'Room'], ['seat', 'Seat']],
  course: [['day', 'Date'], ['slot', 'Time'], ['room', 'Room'], ['section', 'Sec'], ['students', 'Students'], ['teacher', 'Teacher']],
  room: [['day', 'Date'], ['slot', 'Time'], ['students', 'Students'], ['papers', 'Papers'], ['invigilators', 'Invigilators']],
  date: [['slot', 'Time'], ['code', 'Course'], ['name', 'Title'], ['cohort', 'Prog.'], ['students', 'Students']],
};

function ResultView({ result }) {
  if (!result) return null;
  if (result.type === 'timetable') return <TimetableView result={result.raw} />;
  const cols = COLS[result.type];
  if (!cols) return null;
  const rows = result.rows || [];
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', background: 'var(--ink-700,#12261c)', color: '#fff', fontWeight: 700, fontSize: 13 }}>
        <List size={15} /> <span>{result.title}</span>
        <span style={{ marginLeft: 'auto', opacity: .85, fontWeight: 600, fontSize: 12 }}>{rows.length}</span>
      </div>
      {result.subtitle && <div style={{ padding: '6px 12px', fontSize: 12, color: 'var(--text-faint)', background: 'var(--surface-2,#f4f7f5)' }}>{result.subtitle}</div>}
      {rows.length === 0
        ? <div style={{ padding: 12, fontSize: 13, color: 'var(--text-faint)' }}>Nothing to show.</div>
        : (
          <div style={{ maxHeight: 280, overflow: 'auto' }}>
            <table className="aa-tbl">
              <thead><tr>{cols.map(([, h]) => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>
                {rows.slice(0, 300).map((r, i) => (
                  <tr key={i}>{cols.map(([k]) => <td key={k}>{Array.isArray(r[k]) ? r[k].join(', ') : (r[k] ?? '')}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

/* the older timetable search result (still used while a class timetable exists) */
function TimetableView({ result }) {
  if (!result) return null;
  const title = result.teacher || result.room || result.program || (result.code ? `${result.code}${result.name ? ' — ' + result.name : ''}` : (result.day || ''));
  const groups = result.days || result.rooms || null;
  if (!groups) return null;
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
      {title && <div style={{ padding: '9px 13px', background: 'var(--ink-700,#12261c)', color: '#fff', fontWeight: 700, fontSize: 13 }}>{title}</div>}
      {groups.map((g, i) => (
        <div key={i} style={{ borderTop: i ? '1px solid var(--border)' : 'none' }}>
          <div style={{ padding: '7px 13px', fontSize: 11.5, fontWeight: 800, color: 'var(--brand-600,#198754)', textTransform: 'uppercase', background: 'var(--surface-2,#f4f7f5)' }}>{g.day || g.room}</div>
          {(g.sessions || []).map((s, j) => (
            <div key={j} style={{ display: 'flex', gap: 10, padding: '7px 13px', fontSize: 12.5, borderTop: j ? '1px solid var(--border-soft,#eef2f0)' : 'none' }}>
              <span style={{ fontFamily: 'ui-monospace,Menlo,monospace', fontWeight: 700, minWidth: 62 }}>{s.slot}</span>
              <span style={{ flex: 1 }}><b>{s.code}</b>{s.section ? ` (${s.section})` : ''} — {s.name}<span style={{ color: 'var(--text-faint)' }}>{'  ·  '}{s.room}</span></span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
