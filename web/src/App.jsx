import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { api, timeAgo } from './api.js';
import ModulesList from './pages/ModulesList.jsx';
import ModuleDetail from './pages/ModuleDetail.jsx';
import Editor from './pages/Editor.jsx';
import Settings from './pages/Settings.jsx';
import ManualsList from './pages/ManualsList.jsx';
import ManualView from './pages/ManualView.jsx';

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

  const isEditor = /\/edit$/.test(location.pathname);

  return (
    <ToastContext.Provider value={toast}>
      <div className={`shell ${isEditor ? 'shell-editor' : ''}`}>
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark">FTD</span>
            <span className="brand-name">Documentation Console</span>
          </div>
          <nav>
            <NavLink to="/" end>
              Modules
            </NavLink>
            <NavLink to="/manuals">Manuals</NavLink>
            <NavLink to="/settings">Settings</NavLink>
          </nav>
          <div className="sync-state">
            {status ? (
              <>
                <span className="sync-dot" />
                {status.repo} · {status.branch} ·{' '}
                {status.lastCommit ? timeAgo(status.lastCommit.date) : 'empty'}
                {status.drafts > 0 && <span className="sync-drafts">{status.drafts} draft{status.drafts > 1 ? 's' : ''}</span>}
              </>
            ) : (
              'connecting…'
            )}
          </div>
        </header>
        <main className={isEditor ? 'main-editor' : 'main'}>
          <Routes>
            <Route path="/" element={<ModulesList />} />
            <Route path="/modules/:slug" element={<ModuleDetail />} />
            <Route path="/modules/:slug/docs/:version/edit" element={<Editor />} />
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
