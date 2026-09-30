import React, { useEffect, useMemo, useState } from 'react';
import { api, hardwareModules } from '../api.js';
import { t } from '../i18n.jsx';

/**
 * Pick the module a cross-reference points at. The body stores <a data-module="slug">words</a>;
 * the manual build turns it into "(chapter N, p. X)" for the manual it is printed in.
 */
export default function XrefPicker({ onPick, onClose }) {
  const [modules, setModules] = useState(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    api.modules().then((list) => setModules(hardwareModules(list)), () => setModules([]));
  }, []);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (modules || []).filter((m) => !needle || `${m.name} ${m.code || ''} ${m.slug}`.toLowerCase().includes(needle));
  }, [modules, q]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h2>{t('Cross-reference')}</h2>
          <span className="steps" />
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p className="hint">
            {t('The manual prints it with the chapter and page of that module — in every manual that carries it.')}
          </p>
          <input className="xref-search" autoFocus placeholder={t('Search modules')} value={q} onChange={(e) => setQ(e.target.value)} />
          <ul className="xref-list">
            {modules === null && <li className="muted">{t('Loading…')}</li>}
            {shown.map((m) => (
              <li key={m.slug}>
                <button className="xref-pick" onClick={() => onPick(m)}>
                  {m.code && <span className="manual-code">{m.code}</span>} {m.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
