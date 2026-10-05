import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api, { errMsg } from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [admin, setAdmin] = useState(() => {
    const raw = localStorage.getItem('abasyn_admin');
    return raw ? JSON.parse(raw) : null;
  });
  const [booting, setBooting] = useState(true);

  // Validate stored token on load. We enforce a minimum display time for the
  // preloader so it plays smoothly instead of flashing for a split second.
  useEffect(() => {
    const MIN_BOOT_MS = 3800; // preloader plays the logo-fill + wordmark assembly, then exits
    const startedAt = Date.now();
    const finish = () => {
      const elapsed = Date.now() - startedAt;
      const wait = Math.max(0, MIN_BOOT_MS - elapsed);
      setTimeout(() => setBooting(false), wait);
    };

    const token = localStorage.getItem('abasyn_token');
    if (!token) {
      finish();
      return;
    }
    api
      .get('/auth/me')
      .then((res) => {
        setAdmin(res.data.admin);
        localStorage.setItem('abasyn_admin', JSON.stringify(res.data.admin));
      })
      .catch(() => {
        localStorage.removeItem('abasyn_token');
        localStorage.removeItem('abasyn_admin');
        setAdmin(null);
      })
      .finally(finish);
  }, []);

  const login = useCallback(async (username, password) => {
    try {
      const res = await api.post('/auth/login', { username, password });
      localStorage.setItem('abasyn_token', res.data.token);
      localStorage.setItem('abasyn_admin', JSON.stringify(res.data.admin));
      setAdmin(res.data.admin);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err, 'Could not sign in.') };
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('abasyn_token');
    localStorage.removeItem('abasyn_admin');
    setAdmin(null);
  }, []);

  // Admin edits their own display name.
  const updateProfile = useCallback(async (displayName) => {
    try {
      const res = await api.patch('/auth/me', { displayName });
      const next = res.data.admin;
      setAdmin((prev) => {
        const merged = { ...(prev || {}), ...next };
        localStorage.setItem('abasyn_admin', JSON.stringify(merged));
        return merged;
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err, 'Could not update profile.') };
    }
  }, []);

  return (
    <AuthContext.Provider value={{
      admin, user: admin, role: admin?.role || null,
      booting, login, logout, updateProfile,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
