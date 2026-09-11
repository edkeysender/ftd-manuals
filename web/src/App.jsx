import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { api, onUnauthorized, timeAgo } from './api.js';
import ModulesList from './pages/ModulesList.jsx';
import ModuleDetail from './pages/ModuleDetail.jsx';
import Editor from './pages/Editor.jsx';
import Settings from './pages/Settings.jsx';
import ManualsList from './pages/ManualsList.jsx';
import ManualView from './pages/ManualView.jsx';
import SoftwareList from './pages/SoftwareList.jsx';
import SoftwareDetail from './pages/SoftwareDetail.jsx';
import PartsList from './pages/PartsList.jsx';
import Login from './pages/Login.jsx';
import { t, plural, useLocale, LanguageSwitch } from './i18n.jsx';

/* UI theme: decided by the inline script in web/index.html (stored choice, else the OS preference)
   before the first paint — here we only read what it stamped on <html>. Documents stay print-white. */
const initTheme = () => document.documentElement.dataset.theme || 'light';

function ThemeSwitch() {
  const [theme, setTheme] = useState(initTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem('ftd-theme', next);
    } catch {}
    setTheme(next);
  };
  return (
    <button className="ui-theme" onClick={toggle} title={theme === 'dark' ? t('Switch to light mode') : t('Switch to dark mode')}>
      {theme === 'dark' ? '☀' : '🌙'}
    </button>
  );
}

const ToastContext = createContext(() => {});
export const useToast = () => useContext(ToastContext);

const AuthContext = createContext({ user: null, isAdmin: false, canEdit: false, logout: () => {} });
/** The signed-in user: {user, isAdmin, canEdit, logout}. Deleting is admin-only (isAdmin); viewers are read-only (canEdit false). */
export const useAuth = () => useContext(AuthContext);

export const ROLE_LABELS = { admin: 'Administrator', moderator: 'Moderator', viewer: 'Viewer' };

export default function App() {
  const [toasts, setToasts] = useState([]);
  const [status, setStatus] = useState(null);
  const [user, setUser] = useState(undefined); // undefined = session still being checked
  const location = useLocation();

  const toast = useCallback((message, kind = 'ok') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  useEffect(() => {
    onUnauthorized(() => setUser(null)); // any 401 later (expired session) brings the login page back
    api.me().then((r) => setUser(r.user)).catch(() => setUser(null));
  }, []);

  useEffect(() => {
    if (user) api.status().then(setStatus).catch(() => {});
  }, [location, user]);

  const logout = useCallback(async () => {
    await api.logout().catch(() => {});
    setStatus(null);
    setUser(null);
  }, []);

  const isEditor = /\/(edit|review)$/.test(location.pathname);
  const { locale } = useLocale();

  if (user === undefined) return <div className="login-screen" lang={locale}><span className="muted">{t('connecting…')}</span></div>;
  if (!user) return <div lang={locale} key={locale}><Login onLogin={setUser} /></div>;

  return (
    <ToastContext.Provider value={toast}>
      <AuthContext.Provider value={{ user, isAdmin: user.role === 'admin', canEdit: user.role !== 'viewer', logout }}>
        <div className={`shell ${isEditor ? 'shell-editor' : ''}`} lang={locale}>
          <header className="topbar">
            <div className="brand">
              <span className="brand-mark">FTD</span>
              <span className="brand-name">{t('Documentation Console')}</span>
            </div>
            <nav>
              <NavLink to="/manuals">{t('Manuals')}</NavLink>
              <NavLink to="/" end>
                {t('Modules')}
              </NavLink>
              <NavLink to="/parts">{t('Parts')}</NavLink>
              <NavLink to="/software">{t('Software')}</NavLink>
            </nav>
            <div className="sync-state">
              {status ? (
                <>
                  <span className="sync-dot" />
                  {status.repo} · {status.branch} ·{' '}
                  {status.lastCommit ? timeAgo(status.lastCommit.date) : t('empty')}
                  {status.drafts > 0 && <span className="sync-drafts">{plural(status.drafts, 'draft')}</span>}
                </>
              ) : (
                t('connecting…')
              )}
            </div>
            <nav className="topbar-tools">
              <NavLink to="/settings">{t('Settings')}</NavLink>
            </nav>
            <div className="user-chip" title={`${user.email} · ${t(ROLE_LABELS[user.role] || user.role)}`}>
              <span className="user-name">{user.name}</span>
              <button className="user-signout" onClick={logout}>
                {t('Sign out')}
              </button>
            </div>
            <ThemeSwitch />
            <LanguageSwitch />
          </header>
          {/* key: remount the page on a language switch so every string re-renders */}
          <main className={isEditor ? 'main-editor' : 'main'} key={locale}>
            <Routes>
              <Route path="/" element={<ModulesList />} />
              <Route path="/modules/:slug" element={<ModuleDetail />} />
              <Route path="/modules/:slug/docs/:version/edit" element={<Editor />} />
              <Route path="/modules/:slug/docs/:version/review" element={<Editor review />} />
              <Route path="/parts" element={<PartsList />} />
              <Route path="/software" element={<SoftwareList />} />
              <Route path="/software/:name" element={<SoftwareDetail />} />
              <Route path="/manuals" element={<ManualsList />} />
              <Route path="/manuals/:slug" element={<ManualView />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </main>
          <div className="toasts">
            {toasts.map((t) => (
              <div key={t.id} className={`toast toast-${t.kind}`}>
                {t.message}
              </div>
            ))}
          </div>
        </div>
      </AuthContext.Provider>
    </ToastContext.Provider>
  );
}
