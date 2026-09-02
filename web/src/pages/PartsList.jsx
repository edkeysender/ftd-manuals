import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useToast, useAuth } from '../App.jsx';
import { HardwareForm, hwDetail } from '../components/HardwarePicker.jsx';
import { t, plural } from '../i18n.jsx';

/**
 * The shared parts catalog: every part a module is built from — made by FTD
 * (versioned) or bought (manufacturer/model) — and which modules use it.
 * Editing a record changes it for every module that uses it.
 */
export default function PartsList() {
  const toast = useToast();
  const { canEdit, isAdmin } = useAuth();
  const [rows, setRows] = useState(null);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(null); // catalog id being edited
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => api.hardware().then(setRows).catch((e) => toast(e.message, 'err'));
  useEffect(() => {
    load();
  }, []);

  const q = query.trim().toLowerCase();
  const visible =
    rows === null
      ? null
      : q
        ? rows.filter((h) =>
            [h.name, h.manufacturer, h.model, h.notes, ...(h.usedBy || []).map((m) => m.name)].filter(Boolean).some((s) => s.toLowerCase().includes(q))
          )
        : rows;

  async function run(fn, okMsg) {
    setBusy(true);
    try {
      await fn();
      if (okMsg) toast(okMsg);
      setEditing(null);
      setCreating(false);
      await load();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  function remove(h) {
    if (!confirm(t('Delete part "{name}" from the catalog?', { name: h.name }))) return;
    run(() => api.deleteHardware(h.id), t('{name} deleted', { name: h.name }));
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('Parts')}</h1>
          <p className="muted">
            {t('The shared catalog every module builds from — parts made by FTD (versioned) and bought parts. Editing a record changes it for every module that uses it.')}
          </p>
        </div>
        <div className="btn-row">
          <input
            type="search"
            className="search-input"
            placeholder={t('Search parts, makers, modules…')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
            aria-label={t('Search parts')}
          />
          {canEdit && (
            <button className="btn btn-primary" onClick={() => { setCreating(true); setEditing(null); }}>
              {t('+ New part')}
            </button>
          )}
        </div>
      </div>

      {creating && (
        <div className="settings-card" style={{ marginBottom: 16 }}>
          <h2>{t('New part')}</h2>
          <HardwareForm
            submitLabel={t('Add to catalog')}
            onCancel={() => setCreating(false)}
            onSubmit={(item) => run(() => api.createHardware(item), t('{name} added to the catalog', { name: item.name }))}
          />
        </div>
      )}

      {visible === null ? (
        <div className="empty">{t('Loading…')}</div>
      ) : visible.length === 0 ? (
        <div className="empty">
          <p>{q ? t('No parts match “{query}”.', { query: query.trim() }) : t('No parts yet — they are created with modules (the Parts field) or with + New part.')}</p>
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t('Part')}</th>
              <th>{t('Kind')}</th>
              <th>{t('Notes')}</th>
              <th>{t('Used by')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((h) => (
              <React.Fragment key={h.id}>
                <tr>
                  <td>
                    <strong>{h.name}</strong>
                  </td>
                  <td>
                    {h.type === 'ftd' ? (
                      <span className="chip chip-hw" title={t('Made by FTD — versioned')}>
                        {t('Made by FTD')} · {h.version || 'v1'}
                      </span>
                    ) : (
                      <span className="chip" title={t('Bought (COTS)')}>
                        {t('Bought')}{[h.manufacturer, h.model].filter(Boolean).length ? ` · ${[h.manufacturer, h.model].filter(Boolean).join(' ')}` : ''}
                      </span>
                    )}
                  </td>
                  <td className="muted">{h.notes || '—'}</td>
                  <td>
                    {(h.usedBy || []).length ? (
                      <span className="hw-cell">
                        {h.usedBy.map((m) => (
                          <Link key={m.slug} to={`/modules/${m.slug}`} className="chip" onClick={(e) => e.stopPropagation()}>
                            {m.name}
                          </Link>
                        ))}
                      </span>
                    ) : (
                      <span className="muted">{t('not attached to any module')}</span>
                    )}
                  </td>
                  <td className="btn-row">
                    {canEdit && (
                      <button className="btn btn-sm" disabled={busy} onClick={() => { setEditing(editing === h.id ? null : h.id); setCreating(false); }}>
                        {editing === h.id ? t('Close') : t('Edit')}
                      </button>
                    )}
                    {isAdmin && (
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={busy || (h.usedBy || []).length > 0}
                        title={(h.usedBy || []).length ? t('Unassign it from every module first') : ''}
                        onClick={() => remove(h)}
                      >
                        {t('Delete')}
                      </button>
                    )}
                  </td>
                </tr>
                {editing === h.id && (
                  <tr>
                    <td colSpan={5}>
                      <HardwareForm
                        initial={h}
                        submitLabel={t('Save record')}
                        onCancel={() => setEditing(null)}
                        onSubmit={(item) => run(() => api.updateHardware(h.id, item), t('{name} updated for {count}', { name: item.name || h.name, count: plural((h.usedBy || []).length, 'module') }))}
                      />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
