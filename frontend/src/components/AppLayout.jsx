import { useState, useEffect, useRef, useMemo } from 'react';
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Menu, X, Search, Bell, CalendarDays, LogOut, ChevronDown, PanelLeftClose,
  PanelLeft, Settings, User as UserIcon, CheckCheck, ChevronLeft, ChevronRight, Loader2,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import api, { errMsg } from '../api/client';
import { useToast } from '../context/ToastContext';
import AbasynLogo from './AbasynLogo';
import MegaMenu from './MegaMenu';
import GlobalSearch from './GlobalSearch';
import CustomReportBuilder from './CustomReportBuilder';
import AskAbasyn from './AskAbasyn';
import { Modal } from './ui';
import { SIDEBAR, SIDEBAR_BY_ROLE, ROLE_LABEL, MENUS, DOWNLOADS } from './navConfig';
import './layout.css';

const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const READ_KEY = 'abasyn_notif_read';

function dotFor(level) {
  if (level === 'success') return 'ok';
  if (level === 'error' || level === 'warning') return 'warn';
  return 'info';
}
function timeAgo(date) {
  const s = Math.floor((Date.now() - new Date(date)) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); return `${d}d ago`;
}

export default function AppLayout() {
  const { admin, logout, updateProfile } = useAuth();
  const toast = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  // Only the admin (Exam Cell) gets the green sidebar and the record search;
  // finance, faculty and students use a clean sidebar-less layout.
  const isAdmin = admin?.role === 'admin';

  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('abasyn_sidebar') === 'collapsed');
  const [menu, setMenu] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [calOpen, setCalOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);

  const [notifs, setNotifs] = useState([]);
  const [lastRead, setLastRead] = useState(() => Number(localStorage.getItem(READ_KEY) || 0));
  const [now, setNow] = useState(new Date());
  const [calMonth, setCalMonth] = useState(() => new Date());

  const [editOpen, setEditOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const notifRef = useRef(null);
  const profileRef = useRef(null);
  const calRef = useRef(null);

  /* persist collapse */
  useEffect(() => { localStorage.setItem('abasyn_sidebar', collapsed ? 'collapsed' : 'expanded'); }, [collapsed]);

  /* close overlays on route change */
  useEffect(() => {
    setMobileOpen(false); setMenu(null); setNotifOpen(false); setProfileOpen(false); setCalOpen(false);
  }, [location.pathname, location.search]);

  /* lock scroll for mobile drawer */
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [mobileOpen]);

  /* Ctrl/Cmd+K — admin only (record search is an admin feature) */
  useEffect(() => {
    if (!isAdmin) return undefined;
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen((s) => !s); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isAdmin]);

  /* report builder from Downloads footer */
  useEffect(() => {
    const open = () => setBuilderOpen(true);
    window.addEventListener('abasyn:report-builder', open);
    return () => window.removeEventListener('abasyn:report-builder', open);
  }, []);

  /* click outside for small popovers */
  useEffect(() => {
    const onDown = (e) => {
      if (notifRef.current && !notifRef.current.contains(e.target)) setNotifOpen(false);
      if (profileRef.current && !profileRef.current.contains(e.target)) setProfileOpen(false);
      if (calRef.current && !calRef.current.contains(e.target)) setCalOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  /* live clock (for the calendar popover) */
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000 * 30);
    return () => clearInterval(t);
  }, []);

  /* Notifications are scoped to the signed-in role by the backend: admin sees
     every module's activity; finance, faculty and students each see only their
     own. Admin's operational events never leak to the other roles. */
  const loadNotifs = () => {
    api.get('/notifications')
      .then((res) => setNotifs((res.data.items || []).slice(0, 15)))
      .catch(() => { /* ignore */ });
  };
  useEffect(() => {
    loadNotifs();
    const t = setInterval(loadNotifs, 60000);
    return () => clearInterval(t);
  }, []);

  const unread = useMemo(
    () => notifs.filter((n) => new Date(n.createdAt).getTime() > lastRead).length,
    [notifs, lastRead]
  );
  const markAllRead = () => {
    const t = Date.now();
    localStorage.setItem(READ_KEY, String(t));
    setLastRead(t);
  };

  const initials = (admin?.displayName || 'Admin')
    .split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const toggleMenu = (name) => setMenu((m) => (m === name ? null : name));
  // Admit cards (and their exam documents) live in the Finance portal now, so
  // the admin top bar no longer carries an "Exams" tab.
  const NAV_TABS = ['Academics', 'Scheduling'];

  const openEdit = () => { setNameDraft(admin?.displayName || ''); setEditOpen(true); setProfileOpen(false); };
  const saveName = async () => {
    const name = nameDraft.trim();
    if (!name) { toast.error('Name cannot be empty.'); return; }
    setSaving(true);
    const r = await updateProfile(name);
    setSaving(false);
    if (r.ok) { toast.success('Profile updated.'); setEditOpen(false); }
    else toast.error(r.error || 'Could not update profile.');
  };

  /* calendar cells */
  const cells = useMemo(() => {
    const y = calMonth.getFullYear(), m = calMonth.getMonth();
    const first = new Date(y, m, 1).getDay();
    const days = new Date(y, m + 1, 0).getDate();
    const arr = [];
    for (let i = 0; i < first; i++) arr.push(null);
    for (let d = 1; d <= days; d++) arr.push(d);
    return arr;
  }, [calMonth]);
  const isToday = (d) => {
    const t = new Date();
    return d && d === t.getDate() && calMonth.getMonth() === t.getMonth() && calMonth.getFullYear() === t.getFullYear();
  };

  return (
    <div className={`layout ${collapsed ? 'is-collapsed' : ''} ${isAdmin ? '' : 'no-sidebar'}`}>
      {/* ══ Sidebar (admin only) ══ */}
      {isAdmin && (
      <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-top">
          <button className="sidebar-brand" onClick={() => navigate('/')}>
            <span className="sidebar-logo"><AbasynLogo size={34} /></span>
            <span className="sidebar-brand-text">
              <span className="sidebar-brand-name">ABASYN</span>
              <span className="sidebar-brand-sub">Scheduler</span>
            </span>
          </button>
          <button className="sidebar-close" onClick={() => setMobileOpen(false)} aria-label="Close menu"><X size={20} /></button>
        </div>

        <nav className="sidebar-nav">
          {(SIDEBAR_BY_ROLE[admin?.role] || SIDEBAR).map((item, i) => {
            if (item.section) return <div key={`s-${i}`} className="sidebar-section">{item.section}</div>;
            const Icon = item.icon;
            return (
              <NavLink key={item.to} to={item.to} end={item.end} title={item.label}
                className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                <Icon size={19} className="sidebar-link-icon" />
                <span className="sidebar-link-label">{item.label}</span>
              </NavLink>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <div className="sidebar-campus">
            <span className="sidebar-campus-ic"><AbasynLogo size={26} /></span>
            <div className="sidebar-campus-text">
              <span className="sidebar-campus-name">Abasyn University</span>
              <span className="sidebar-campus-sub">Islamabad Campus</span>
            </div>
          </div>
          <div className="sidebar-copy">© {new Date().getFullYear()} Abasyn University · All rights reserved</div>
        </div>
      </aside>
      )}

      <AnimatePresence>
        {isAdmin && mobileOpen && (
          <motion.div className="sidebar-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setMobileOpen(false)} />
        )}
      </AnimatePresence>

      {/* ══ Main ══ */}
      <div className="main">
        <header className="topbar">
          <div className="topbar-left">
            {isAdmin && (
              <>
                <button className="topbar-icon-btn topbar-collapse" onClick={() => setCollapsed((c) => !c)} aria-label="Toggle sidebar">
                  {collapsed ? <PanelLeft size={19} /> : <PanelLeftClose size={19} />}
                </button>
                <button className="topbar-menu" onClick={() => setMobileOpen(true)} aria-label="Open menu"><Menu size={22} /></button>
                <button className="topbar-search" onClick={() => setSearchOpen(true)}>
                  <Search size={17} />
                  <span className="topbar-search-ph">Search…</span>
                  <kbd className="topbar-search-kbd">Ctrl K</kbd>
                </button>
              </>
            )}
            {!isAdmin && (
              <button className="topbar-brand-mini" onClick={() => navigate('/')}>
                <AbasynLogo size={30} />
                <span className="topbar-brand-mini-text">
                  <span className="topbar-brand-mini-name">ABASYN</span>
                  <span className="topbar-brand-mini-sub">{ROLE_LABEL[admin?.role] || 'Portal'}</span>
                </span>
              </button>
            )}
          </div>

          <nav className="topbar-nav">
            {admin?.role === 'admin' && NAV_TABS.map((name) => (
              <div className="topbar-nav-item" key={name}>
                <button className={`topbar-nav-btn ${menu === name ? 'open' : ''}`} onClick={() => toggleMenu(name)}>
                  {name} <ChevronDown size={15} className="topbar-nav-chev" />
                </button>
                <MegaMenu open={menu === name} onClose={() => setMenu(null)} align="center" width={MENUS[name].width} columns={MENUS[name].columns} />
              </div>
            ))}
            {admin?.role === 'admin' && (
              <div className="topbar-nav-item">
                <button className={`topbar-nav-btn topbar-nav-accent ${menu === 'Downloads' ? 'open' : ''}`} onClick={() => toggleMenu('Downloads')}>
                  Downloads <ChevronDown size={15} className="topbar-nav-chev" />
                </button>
                <MegaMenu open={menu === 'Downloads'} onClose={() => setMenu(null)} align="right" width={DOWNLOADS.width} columns={DOWNLOADS.columns} footer={DOWNLOADS.footer} />
              </div>
            )}
          </nav>

          <div className="topbar-right">
            {/* calendar */}
            <div className="topbar-pop" ref={calRef}>
              <button className="topbar-icon-btn" title="Calendar" onClick={() => { setCalMonth(new Date()); setCalOpen((o) => !o); }}>
                <CalendarDays size={19} />
              </button>
              <AnimatePresence>
                {calOpen && (
                  <motion.div className="pop-card pop-cal" initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 6, scale: 0.98 }} transition={{ duration: 0.16 }}>
                    <div className="pop-cal-now">
                      <span className="pop-cal-date">{now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
                      <span className="pop-cal-time">{now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    <div className="cal">
                      <div className="cal-head">
                        <span className="cal-title">{MONTHS[calMonth.getMonth()]} {calMonth.getFullYear()}</span>
                        <div className="cal-nav">
                          <button onClick={() => setCalMonth(new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1))}><ChevronLeft size={16} /></button>
                          <button onClick={() => setCalMonth(new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1))}><ChevronRight size={16} /></button>
                        </div>
                      </div>
                      <div className="cal-grid cal-dow">{DAY_LABELS.map((d) => <span key={d} className="cal-dow-cell">{d}</span>)}</div>
                      <div className="cal-grid">
                        {cells.map((d, i) => <span key={i} className={`cal-cell ${d ? '' : 'empty'} ${isToday(d) ? 'today' : ''}`}>{d || ''}</span>)}
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* notifications */}
            <div className="topbar-pop" ref={notifRef}>
              <button className="topbar-icon-btn" onClick={() => { setNotifOpen((o) => !o); loadNotifs(); }} aria-label="Notifications">
                <Bell size={19} />
                {unread > 0 && <span className="topbar-badge">{unread > 9 ? '9+' : unread}</span>}
              </button>
              <AnimatePresence>
                {notifOpen && (
                  <motion.div className="pop-card pop-notif" initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 6, scale: 0.98 }} transition={{ duration: 0.16 }}>
                    <div className="pop-head">
                      <span>Notifications {unread > 0 && <span className="pop-head-count">{unread}</span>}</span>
                      <button className="pop-head-action" onClick={markAllRead} disabled={unread === 0}><CheckCheck size={14} /> Mark all read</button>
                    </div>
                    <div className="pop-list">
                      {notifs.length === 0 ? (
                        <div className="pop-empty">No activity yet.</div>
                      ) : notifs.map((n, i) => {
                        const isUnread = new Date(n.createdAt).getTime() > lastRead;
                        return (
                          <div className={`pop-notif-item ${isUnread ? 'unread' : ''}`} key={n._id || i}>
                            <span className={`pop-dot pop-dot-${dotFor(n.level)}`} />
                            <div className="pop-notif-text">
                              <span className="pop-notif-title">{n.message}</span>
                            </div>
                            <span className="pop-notif-time">{timeAgo(n.createdAt)}</span>
                          </div>
                        );
                      })}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* profile */}
            <div className="topbar-pop" ref={profileRef}>
              <button className="topbar-user" onClick={() => setProfileOpen((o) => !o)}>
                <span className="topbar-avatar">{initials}</span>
                <span className="topbar-user-text">
                  <span className="topbar-user-name">{admin?.displayName || 'Administrator'}</span>
                  <span className="topbar-user-role">{ROLE_LABEL[admin?.role] || 'User'}</span>
                </span>
                <ChevronDown size={15} className="topbar-user-chev" />
              </button>
              <AnimatePresence>
                {profileOpen && (
                  <motion.div className="pop-card pop-profile" initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 6, scale: 0.98 }} transition={{ duration: 0.16 }}>
                    <div className="pop-profile-head">
                      <span className="topbar-avatar lg">{initials}</span>
                      <div>
                        <div className="pop-profile-name">{admin?.displayName || 'Administrator'}</div>
                        <div className="pop-profile-mail">{ROLE_LABEL[admin?.role] || 'User'} · {admin?.username || ''}</div>
                      </div>
                    </div>
                    <button className="pop-row" onClick={openEdit}><UserIcon size={16} /> Edit profile name</button>
                    <button className="pop-row" onClick={() => { setProfileOpen(false); navigate('/constraints'); }}><Settings size={16} /> Settings</button>
                    <div className="pop-divider" />
                    <button className="pop-row pop-row-danger" onClick={logout}><LogOut size={16} /> Sign out</button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </header>

        <main className="content"><Outlet /></main>
      </div>

      {isAdmin && <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />}
      {isAdmin && <AskAbasyn />}
      <CustomReportBuilder open={builderOpen} onClose={() => setBuilderOpen(false)} />

      {/* profile edit modal */}
      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Edit profile" width={420}>
        <div className="field" style={{ marginBottom: 18 }}>
          <label>Display name</label>
          <input className="input" value={nameDraft} maxLength={60} autoFocus
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveName(); }}
            placeholder="Your name" />
          <span className="faint" style={{ fontSize: 12, marginTop: 6 }}>This replaces the name shown across the app. Your role stays “{ROLE_LABEL[admin?.role] || 'User'}”.</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button className="btn btn-ghost" onClick={() => setEditOpen(false)} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={saveName} disabled={saving}>
            {saving ? <><Loader2 size={16} className="spin" /> Saving…</> : 'Save'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
