import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, CATEGORIES, MANUAL_TYPES, moduleType, timeAgo, hardwareModules } from '../api.js';
import Wizard from '../components/Wizard.jsx';
import { useToast } from '../App.jsx';
import { t, plural } from '../i18n.jsx';

const catLabel = (c) => (CATEGORIES.find(([k]) => k === c) || [null, c])[1];

/** One pill per manual type the module maintains: "Customer · A1.0 draft r2", coloured by status. */
export function ManualPills({ manuals, onOpen }) {
  const have = MANUAL_TYPES.filter((mt) => manuals && manuals[mt.id]);
  if (!have.length) return <span className="manual-pill mp-missing"><span className="mp-type">{t('no manual yet')}</span></span>;
  return (
    <span className="manual-pills">
      {have.map((mt) => {
        const m = manuals[mt.id];
        return (
          <span
            key={mt.id}
            className={`manual-pill mp-${m.status}`}
            title={`${t(mt.label)}: ${m.label}${m.released ? t(' · released {version}', { version: m.released }) : ''}${m.fat ? t(' · FAT checklist') : ''}`}
            onClick={onOpen ? (e) => { e.stopPropagation(); onOpen(mt.id, m); } : undefined}
          >
            <span className="mp-type">{t(mt.short)}</span>
            <span className="mp-ver">{m.label}</span>
          </span>
        );
      })}
    </span>
  );
}

export default function ModulesList() {
  const [rows, setRows] = useState(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const toast = useToast();

  // Picking several modules to set their category in one go.
  const [picked, setPicked] = useState([]);
  const [bulkCat, setBulkCat] = useState(CATEGORIES[0][0]);
  const [applying, setApplying] = useState(false);
  const toggle = (slug) => setPicked((p) => (p.includes(slug) ? p.filter((x) => x !== slug) : [...p, slug]));

  const q = query.trim().toLowerCase();
  // An own-software module is a software documented on its own, not a part of the simulator:
  // it belongs to the Software page, and listing it here would offer hardware it does not have.
  const listed = rows === null ? null : hardwareModules(rows);
  const visible =
    listed === null ? null : q ? listed.filter((m) => `${m.name} ${m.code || ''}`.toLowerCase().includes(q)) : listed;

  /** Set the picked modules to one category — each is its own commit; the toast says what happened. */
  async function applyCategory() {
    setApplying(true);
    try {
      const r = await api.setModulesCategory(picked, bulkCat);
      const label = t((CATEGORIES.find(([id]) => id === bulkCat) || [, bulkCat])[1]);
      toast(
        r.failed.length
          ? t('{n} set to {category}; {failed} could not be changed', { n: r.updated.length, category: label, failed: r.failed.map((f) => f.slug).join(', ') })
          : t('{n} set to {category}', { n: r.updated.length, category: label })
        , r.failed.length ? 'err' : undefined
      );
      setPicked([]);
      await load();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setApplying(false);
    }
  }

  const load = () => api.modules().then(setRows).catch((e) => toast(e.message, 'err'));
  useEffect(() => {
    load();
  }, []);

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('Modules')}</h1>
        <div className="btn-row">
          <input
            type="search"
            className="search-input"
            placeholder={t('Search modules by name…')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
            aria-label={t('Search modules by name')}
          />
          <button className="btn btn-primary" onClick={() => setWizardOpen(true)}>
            {t('+ New module doc')}
          </button>
        </div>
      </div>

      {rows === null ? (
        <div className="empty">{t('Loading…')}</div>
      ) : listed.length === 0 ? (
        <div className="empty">
          <p>{t('No modules yet.')}</p>
          <p>
            {t('Create the first one with {button} — it starts a draft branch and a doc version A1.0 r1 for each manual you pick (customer, technician, and the same split for the linked software).')
              .split('{button}')
              .map((part, i, arr) => (
                <React.Fragment key={i}>
                  {part}
                  {i < arr.length - 1 && <strong>{t('+ New module doc')}</strong>}
                </React.Fragment>
              ))}
          </p>
        </div>
      ) : visible.length === 0 ? (
        <div className="empty">
          <p>{t('No modules match “{query}”.', { query: query.trim() })}</p>
        </div>
      ) : (
        <>
        {picked.length > 0 && (
          <div className="bulk-bar">
            <span>{t('{n} selected', { n: picked.length })}</span>
            <select value={bulkCat} onChange={(e) => setBulkCat(e.target.value)}>
              {CATEGORIES.map(([id, label]) => (
                <option key={id} value={id}>{t(label)}</option>
              ))}
            </select>
            <button className="btn btn-primary btn-sm" disabled={applying} onClick={applyCategory}>
              {applying ? t('Applying…') : t('Set category')}
            </button>
            <button className="btn btn-sm" onClick={() => setPicked([])}>{t('Clear')}</button>
          </div>
        )}
        <table className="table modules-table">
          <thead>
            <tr>
              <th className="pick-col">
                <input
                  type="checkbox"
                  title={t('Select every module shown')}
                  checked={visible.length > 0 && picked.length === visible.length}
                  onChange={(e) => setPicked(e.target.checked ? visible.map((m) => m.slug) : [])}
                />
              </th>
              <th>{t('Module')}</th>
              <th>{t('Type')}</th>
              <th>{t('Parts')}</th>
              <th>{t('Software relation')}</th>
              <th>{t('Manuals')}</th>
              <th>{t('Updated')}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((m) => (
              <tr key={m.slug} className="row-link" onClick={() => navigate(`/modules/${m.slug}`)}>
                <td className="pick-col" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={picked.includes(m.slug)} onChange={() => toggle(m.slug)} />
                </td>
                <td>
                  <div className="module-cell">
                    <span className="module-name">
                      {m.name}
                      {m.needsDoc && (
                        <span
                          className="orange-dot"
                          title={t('A linked software released a manual-affecting version with no doc linked yet')}
                        />
                      )}
                    </span>
                    <span className="module-sub">
                      {m.code && <code>{m.code}</code>} {t(catLabel(m.category))}
                    </span>
                  </div>
                </td>
                <td>{m.type ? t(moduleType(m.type)?.label || m.type) : <span className="muted">—</span>}</td>
                <td className={m.hardware?.length ? '' : 'muted'} title={(m.hardware || []).map((h) => `${h.name}: ${h.type === 'ftd' ? `FTD.aero ${h.version || 'v1'}` : `COTS ${[h.manufacturer, h.model].filter(Boolean).join(' ')}`}`).join('\n')}>
                  {m.hardware?.length > 1 ? (
                    <>
                      <span className="hw-cell hw-cell-clamp">
                        {m.hardware.map((h) => (
                          <span key={h.id || h.name} className="chip">{h.name}</span>
                        ))}
                      </span>
                      <span className="muted small">{plural(m.hardware.length, 'part')}</span>
                    </>
                  ) : (
                    m.hardwareLabel
                  )}
                </td>
                <td className={m.softwares.length ? '' : 'muted'}>{m.softwareLabel}</td>
                <td>
                  <ManualPills manuals={m.manuals} />
                </td>
                <td className="muted">{timeAgo(m.updated)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </>
      )}

      {wizardOpen && (
        <Wizard
          onClose={() => setWizardOpen(false)}
          onCreated={(created) => {
            setWizardOpen(false);
            toast(
              created.docs?.length > 1
                ? t('{drafts} created: {keys}', { drafts: plural(created.docs.length, 'draft'), keys: created.docs.map((d) => d.key).join(', ') })
                : t('Draft created: branch {branch}, doc {key} r1', { branch: created.branch, key: created.key || created.version })
            );
            if (created.aiNote) toast(created.aiNote, 'err');
            navigate(`/modules/${created.slug}`);
          }}
        />
      )}
    </div>
  );
}
