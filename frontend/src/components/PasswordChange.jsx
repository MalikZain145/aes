import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ShieldCheck, Eye, EyeOff, Lock, KeyRound, CheckCircle2, Circle, Loader2, LogOut, X } from 'lucide-react';
import api, { errMsg } from '../api/client';
import { useAuth } from '../context/AuthContext';
import './passwordChange.css';

/*
 * Password change screen.
 *   forced  → the account signed in with a default password (student123,
 *             faculty123, finance123, admin123). Blocking: no close button, Esc and
 *             clicking outside do nothing; the only other way out is Sign out.
 *   normal  → "Change password" from the profile menu (current password needed).
 * After a successful change the user is told to sign in with the new password
 * from now on, and the session continues with the fresh token.
 */
const DEFAULTS = ['student123', 'faculty123', 'finance123', 'admin123'];

export default function PasswordChange({ forced = false, onClose }) {
  const { admin, applySession, logout } = useAuth();
  const [current, setCurrent] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const firstRef = useRef(null);

  useEffect(() => { setTimeout(() => firstRef.current?.focus(), 60); }, []);
  // Esc closes only the optional dialog, never the forced one
  useEffect(() => {
    if (forced) return undefined;
    const k = (e) => { if (e.key === 'Escape' && !busy) onClose?.(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [forced, busy, onClose]);

  const ids = [admin?.username, admin?.regNo].map((x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '')).filter((x) => x.length >= 4);
  const flat = pw.toLowerCase().replace(/[^a-z0-9]/g, '');
  const rules = useMemo(() => [
    { ok: pw.length >= 8, text: 'At least 8 characters' },
    { ok: /[A-Za-z]/.test(pw) && /[0-9]/.test(pw), text: 'Letters and numbers' },
    { ok: pw.length > 0 && !DEFAULTS.includes(pw.toLowerCase()) && !ids.some((id) => flat.includes(id)), text: 'Not a default password or your username' },
    { ok: pw.length > 0 && pw === pw2, text: 'Both passwords match' },
  ], [pw, pw2, flat]); // eslint-disable-line react-hooks/exhaustive-deps
  const score = [pw.length >= 8, /[a-z]/.test(pw) && /[A-Z]/.test(pw), /[0-9]/.test(pw), /[^A-Za-z0-9]/.test(pw), pw.length >= 12].filter(Boolean).length;
  const strength = !pw ? '' : score <= 2 ? 'weak' : score === 3 ? 'fair' : score === 4 ? 'good' : 'strong';
  const valid = rules.every((r) => r.ok) && (forced || current.length > 0);

  const submit = async (e) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true); setError('');
    try {
      const r = await api.post('/auth/change-password', { currentPassword: forced ? undefined : current, newPassword: pw, confirmPassword: pw2 });
      applySession(r.data.token, r.data.user);
      setDone(true);
    } catch (err) {
      setError(errMsg(err, 'Could not change the password.'));
    } finally { setBusy(false); }
  };

  return (
    <motion.div className="pwc-overlay" role="dialog" aria-modal="true" aria-labelledby="pwc-title"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onMouseDown={(e) => { if (!forced && !busy && e.target === e.currentTarget && !done) onClose?.(); }}>
      <motion.div className="pwc-card" initial={{ y: 18, scale: 0.97 }} animate={{ y: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 24 }}>
        {!forced && !done && (
          <button type="button" className="pwc-x" onClick={onClose} aria-label="Close" disabled={busy}><X size={18} /></button>
        )}
        <AnimatePresence mode="wait">
          {!done ? (
            <motion.form key="form" onSubmit={submit} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, x: -20 }} noValidate>
              <div className="pwc-badge"><ShieldCheck size={26} /></div>
              <h2 id="pwc-title" className="pwc-title font-display">{forced ? 'Set your own password' : 'Change password'}</h2>
              <p className="pwc-sub">
                {forced
                  ? <>You signed in with a <b>default password</b>. For the security of your account, choose a new password before you continue.</>
                  : <>Enter your current password, then choose a new one.</>}
              </p>

              {!forced && (
                <label className="pwc-field">
                  <span>Current password</span>
                  <div className="pwc-input">
                    <Lock size={16} />
                    <input ref={firstRef} type={show ? 'text' : 'password'} value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
                  </div>
                </label>
              )}

              <label className="pwc-field">
                <span>New password</span>
                <div className="pwc-input">
                  <KeyRound size={16} />
                  <input ref={forced ? firstRef : undefined} type={show ? 'text' : 'password'} value={pw} onChange={(e) => setPw(e.target.value)}
                    autoComplete="new-password" maxLength={72} placeholder="At least 8 characters" />
                  <button type="button" className="pwc-eye" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide passwords' : 'Show passwords'}>
                    {show ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                {strength && (
                  <div className={`pwc-meter ${strength}`}>
                    <i /><i /><i /><i /><em>{strength}</em>
                  </div>
                )}
              </label>

              <label className="pwc-field">
                <span>Confirm new password</span>
                <div className="pwc-input">
                  <KeyRound size={16} />
                  <input type={show ? 'text' : 'password'} value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" maxLength={72} placeholder="Type it again" />
                </div>
              </label>

              <ul className="pwc-rules">
                {rules.map((r) => (
                  <li key={r.text} className={r.ok ? 'ok' : ''}>{r.ok ? <CheckCircle2 size={14} /> : <Circle size={14} />} {r.text}</li>
                ))}
              </ul>

              {error && <div className="pwc-error" role="alert">{error}</div>}

              <button type="submit" className="btn btn-primary pwc-submit" disabled={!valid || busy}>
                {busy ? <Loader2 size={16} className="spin" /> : <ShieldCheck size={16} />} {forced ? 'Save password & continue' : 'Change password'}
              </button>
              {forced && (
                <button type="button" className="pwc-logout" onClick={logout} disabled={busy}><LogOut size={14} /> Sign out instead</button>
              )}
            </motion.form>
          ) : (
            <motion.div key="done" className="pwc-done" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }}>
              <motion.div className="pwc-done-ic" initial={{ scale: 0.5 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 14 }}>
                <CheckCircle2 size={44} />
              </motion.div>
              <h2 className="pwc-title font-display">Password updated</h2>
              <p className="pwc-sub">
                <b>You will sign in with this new password every time from now on.</b><br />
                Keep it private — never share it with anyone. All your other sessions have been signed out.
              </p>
              <button type="button" className="btn btn-primary pwc-submit" onClick={() => onClose?.()}>Continue</button>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}
