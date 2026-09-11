import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, GROUPS } from '../api.js';
import { useToast } from '../App.jsx';
import { t, plural } from '../i18n.jsx';

/** Newest registered release — the feed keeps them sorted by version. */
const latestRelease = (sw) => (sw.releases.length ? sw.releases[sw.releases.length - 1] : null);

/**
 * Software index: one row per software known from the release feed or from module links,
 * showing only its name and latest version. Everything about a software — its modules,
 * their manuals, its releases and their coverage — is on its own page.
 */
export default function SoftwareList() {
  const [rows, setRows] = useState(null);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();

  const load = () => api.software().then(setRows).catch((e) => toast(e.message, 'err'));
  useEffect(() => {
    load();
  }, []);

  const open = (sw) => navigate(`/software/${encodeURIComponent(sw.name)}`);
  const q = query.trim().toLowerCase();
  const visible =
    rows === null ? null : q ? rows.filter((r) => `${r.name} ${r.modules.map((m) => m.name).join(' ')}`.toLowerCase().includes(q)) : rows;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('Software')}</h1>
          {rows && <div className="muted small">{t('{n} software — open one for its modules, manuals and releases.', { n: rows.length })}</div>}
        </div>
        <div className="btn-row">
          <input
            type="search"
            className="search-input"
            placeholder={t('Search software or module…')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
            aria-label={t('Search software')}
          />
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            {t('+ New software')}
          </button>
        </div>
      </div>

      {creating && (
        <NewSoftwareModal
          onClose={() => setCreating(false)}
          onCreated={(r) => {
            setCreating(false);
            toast(
              r.ownModule
                ? t('{name} created with its own manual — opening the editor', { name: r.name })
                : r.modules.length
                  ? t('{name} created and linked to {modules}', { name: r.name, modules: r.modules.map((m) => m.name).join(', ') })
                  : t('{name} created', { name: r.name })
            );
            if (r.ownModule) navigate(`/modules/${r.ownModule.slug}/docs/${r.ownModule.key}/edit`);
            else load();
          }}
        />
      )}

      {rows === null ? (
        <div className="empty">{t('Loading…')}</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <p>{t('No software linked yet.')}</p>
          <p>
            {t('Link a module to a software (wizard step')} <em>{t('Relations')}</em>{t(", or the module's")} <em>{t('Software versions')}</em>{' '}
            {t('tab) — its software customer / technician manuals then appear here.')}
          </p>
        </div>
      ) : visible.length === 0 ? (
        <div className="empty"><p>{t('No software matches “{query}”.', { query: query.trim() })}</p></div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t('Software')}</th>
              <th>{t('Latest version')}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((sw) => {
              const rel = latestRelease(sw);
              return (
                <tr key={sw.name} className="row-link" onClick={() => open(sw)}>
                  <td>
                    <div className="module-cell">
                      <span className="module-name">{sw.name}</span>
                      {!sw.registered && (
                        <span className="module-sub">
                          <span className="badge badge-missing" title={t('Known only from module links — open it to register or merge it')}>
                            {t('not registered')}
                          </span>
                        </span>
                      )}
                    </div>
                  </td>
                  <td>
                    {rel ? <code>{rel.version}</code> : <span className="muted">{t('no releases')}</span>}
                    {sw.uncoveredCount > 0 && (
                      <>
                        {' '}
                        <span
                          className="orange-dot"
                          title={t('{releases} not yet covered by a doc version', { releases: plural(sw.uncoveredCount, 'manual-affecting release') })}
                        />
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function NewSoftwareModal({ onClose, onCreated }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const [manualAffecting, setManualAffecting] = useState(false);
  const [note, setNote] = useState('');
  const [modules, setModules] = useState([]);
  const [selected, setSelected] = useState([]);
  const [ownManual, setOwnManual] = useState(true);
  const [group, setGroup] = useState('SIM');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.modules().then(setModules).catch(() => setModules([]));
  }, []);
  async function create() {
    setBusy(true);
    try {
      onCreated(
        await api.createSoftware({
          name: name.trim(),
          version: version.trim() || undefined,
          manualAffecting,
          note,
          modules: selected.map((slug) => ({ slug })),
          ownManual: ownManual ? { group } : null,
        })
      );
    } catch (e) {
      toast(e.message, 'err');
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h2>{t('New software')}</h2>
          <span className="steps" />
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="form-grid">
            <label>
              {t('Software name')} <span className="req">*</span>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="2N Access Unit" />
            </label>
            <div className="pair">
              <label style={{ flex: 1 }}>
                {t('First version (optional)')}
                <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="v1.0.0" />
              </label>
              <label style={{ flex: 2 }}>
                {t('Note')}
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('optional')} />
              </label>
            </div>
            {version.trim() && (
              <label className="check">
                <input type="checkbox" checked={manualAffecting} onChange={(e) => setManualAffecting(e.target.checked)} />
                {t('first version is manual-affecting')}
              </label>
            )}
            <div className="pair">
              <label className="check" style={{ flex: 1 }}>
                <input type="checkbox" checked={ownManual} onChange={(e) => setOwnManual(e.target.checked)} />
                {t('Write its own manual — software customer + technician manuals in the editor, no hardware module')}
              </label>
              {ownManual && (
                <select value={group} onChange={(e) => setGroup(e.target.value)} title={t('Manual group')}>
                  {GROUPS.map(([id, label]) => (
                    <option key={id} value={id}>{t(label)}</option>
                  ))}
                </select>
              )}
            </div>
            <div className="field">
              <span className="field-label">{t('Link to modules (optional) — enables their software manuals; from-version = first version')}</span>
              <div className="picker-list" style={{ maxHeight: 220, overflow: 'auto' }}>
                {modules.map((m) => (
                  <label key={m.slug} className={`picker-item ${selected.includes(m.slug) ? 'on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={selected.includes(m.slug)}
                      onChange={() => setSelected(selected.includes(m.slug) ? selected.filter((s) => s !== m.slug) : [...selected, m.slug])}
                    />
                    <span className="picker-name">{m.name} {m.code && <code>{m.code}</code>}</span>
                    <span className="chip">{m.group}</span>
                  </label>
                ))}
                {modules.length === 0 && <div className="muted">{t('No modules yet.')}</div>}
              </div>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn btn-primary" disabled={!name.trim() || busy} onClick={create}>
            {busy ? t('Creating…') : t('Create software')}
          </button>
        </div>
      </div>
    </div>
  );
}
