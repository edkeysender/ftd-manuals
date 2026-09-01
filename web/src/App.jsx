import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { api, timeAgo } from './api.js';
import ModulesList from './pages/ModulesList.jsx';
import ModuleDetail from './pages/ModuleDetail.jsx';
import Editor from './pages/Editor.jsx';
import Settings from './pages/Settings.jsx';
import ManualsList from './pages/ManualsList.jsx';
import ManualView from './pages/ManualView.jsx';
import SoftwareList from './pages/SoftwareList.jsx';
import { t, plural, useLocale, LanguageSwitch } from './i18n.jsx';

const ToastContext = createContext(() => {});
export const useToast = () => useContext(ToastContext);

export default function App() {
  const [toasts, setToasts] = useState([]);
  const [status, setStatus] = useState(null);
  const location = useLocation();

  const toast = useCallback((message, kind = 'ok') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  useEffect(() => {
    api.status().then(setStatus).catch(() => {});
  }, [location]);

  const isEditor = /\/(edit|review)$/.test(location.pathname);
  const { locale } = useLocale();

  return (
    <ToastContext.Provider value={toast}>
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
          <LanguageSwitch />
        </header>
        {/* key: remount the page on a language switch so every string re-renders */}
        <main className={isEditor ? 'main-editor' : 'main'} key={locale}>
          <Routes>
            <Route path="/" element={<ModulesList />} />
            <Route path="/modules/:slug" element={<ModuleDetail />} />
            <Route path="/modules/:slug/docs/:version/edit" element={<Editor />} />
            <Route path="/modules/:slug/docs/:version/review" element={<Editor review />} />
            <Route path="/software" element={<SoftwareList />} />
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
    </ToastContext.Provider>
  );
}
