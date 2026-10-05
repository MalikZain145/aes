import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ShieldCheck, Zap, FileSpreadsheet, Eye, EyeOff, ArrowRight } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import './login.css';

const FEATURES = [
  { icon: ShieldCheck, title: 'Clash-free by construction', text: 'Seven hard constraints checked on every placement — teacher, room, lab, batch, capacity and slot type.' },
  { icon: Zap, title: 'Seconds, not weeks', text: 'A full university timetable across 19 programmes generates in moments, fresh from your live data.' },
  { icon: FileSpreadsheet, title: 'Timetables & datesheets', text: 'One engine produces weekly timetables and mid/final exam datesheets, ready as Excel and PDF.' },
];

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const submit = async (e) => {
    e.preventDefault();
    if (!username || !password) {
      toast.error('Enter both username and password.');
      return;
    }
    setLoading(true);
    const res = await login(username.trim(), password);
    setLoading(false);
    if (res.ok) {
      toast.success('Signed in. Welcome back.');
      navigate('/', { replace: true });
    } else {
      toast.error(res.error);
    }
  };

  return (
    <div className="login">
      {/* ── Left: narrative ── */}
      <div className="login-aside">
        <div className="login-aside-content">
          <div className="login-brand">
            <img src="/abasyn-white.png" alt="Abasyn" className="login-logo" />
            <div className="login-brand-divider" />
            <div className="login-brand-sub">Scheduler · Islamabad Campus</div>
          </div>

          <motion.h1
            className="login-headline font-display"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          >
            The timetable, solved.
          </motion.h1>
          <motion.p
            className="login-lede"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08, duration: 0.6 }}
          >
            Abasyn Scheduler turns a semester's worth of courses, teachers and rooms
            into a conflict-free schedule — and keeps every clash out by design.
          </motion.p>

          <div className="login-features">
            {FEATURES.map((f, i) => {
              const Icon = f.icon;
              return (
                <motion.div
                  key={f.title}
                  className="login-feature"
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.2 + i * 0.1, duration: 0.5 }}
                >
                  <div className="login-feature-icon"><Icon size={18} /></div>
                  <div>
                    <div className="login-feature-title">{f.title}</div>
                    <div className="login-feature-text">{f.text}</div>
                  </div>
                </motion.div>
              );
            })}
          </div>

          <div className="login-aside-foot">
            Built for Abasyn University · Smart Scheduling, Better Education
          </div>
        </div>
        <div className="login-aside-glow" />
      </div>

      {/* ── Right: form ── */}
      <div className="login-main">
        <motion.div
          className="login-card"
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="login-card-head">
            <img src="/abasyn-green.png" alt="Abasyn" className="login-card-logo" />
            <h2 className="font-display">Administrator sign in</h2>
            <p>Access is limited to the campus scheduling administrator.</p>
          </div>

          <form onSubmit={submit} className="login-form">
            <div className="field">
              <label htmlFor="username">Username</label>
              <input
                id="username"
                className="input"
                type="text"
                autoComplete="username"
                placeholder="admin"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
              />
            </div>

            <div className="field">
              <label htmlFor="password">Password</label>
              <div className="login-pw">
                <input
                  id="password"
                  className="input"
                  type={showPw ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="login-pw-toggle"
                  onClick={() => setShowPw((s) => !s)}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                >
                  {showPw ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </div>

            <button type="submit" className="btn btn-primary login-submit" disabled={loading}>
              {loading ? (
                <><span className="spinner" /> Signing in…</>
              ) : (
                <>Sign in <ArrowRight size={17} /></>
              )}
            </button>
          </form>

          <div className="login-hint">
            <ShieldCheck size={14} />
            <span>Only one administrator account exists. There is no public sign-up.</span>
          </div>
        </motion.div>

        <div className="login-version">Abasyn Scheduler · v1.0</div>
      </div>
    </div>
  );
}
