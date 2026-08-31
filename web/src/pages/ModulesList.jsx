import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, CATEGORIES, MANUAL_TYPES, timeAgo } from '../api.js';
import Wizard from '../components/Wizard.jsx';
import { useToast } from '../App.jsx';

const catLabel = (c) => (CATEGORIES.find(([k]) => k === c) || [null, c])[1];

/** One pill per manual type the module maintains: "Customer · A1.0 draft r2", coloured by status. */
export function ManualPills({ manuals, onOpen }) {
  const have = MANUAL_TYPES.filter((t) => manuals && manuals[t.id]);
  if (!have.length) return <span className="manual-pill mp-missing"><span className="mp-type">no manual yet</span></span>;
  return (
    <span className="manual-pills">
      {have.map((t) => {
        const m = manuals[t.id];
        return (
          <span
            key={t.id}
            className={`manual-pill mp-${m.status}`}
            title={`${t.label}: ${m.label}${m.released ? ` · released ${m.released}` : ''}${m.fat ? ' · FAT checklist' : ''}`}
            onClick={onOpen ? (e) => { e.stopPropagation(); onOpen(t.id, m); } : undefined}
          >
            <span className="mp-type">{t.short}</span>
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

  const q = query.trim().toLowerCase();
  const visible = rows === null ? null : q ? rows.filter((m) => `${m.name} ${m.code || ''}`.toLowerCase().includes(q)) : rows;

  const load = () => api.modules().then(setRows).catch((e) => toast(e.message, 'err'));
  useEffect(() => {
    load();
  }, []);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Modules</h1>
        <div className="btn-row">
          <input
            type="search"
            className="search-input"
            placeholder="Search modules by name…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
            aria-label="Search modules by name"
          />
          <button className="btn btn-primary" onClick={() => setWizardOpen(true)}>
            + New module doc
          </button>
        </div>
      </div>

      {rows === null ? (
        <div className="empty">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <p>No modules yet.</p>
          <p>
            Create the first one with <strong>+ New module doc</strong> — it starts a draft branch and a doc version
            A1.0 r1 for each manual you pick (customer, technician, and the same split for the linked software).
          </p>
        </div>
      ) : visible.length === 0 ? (
        <div className="empty">
          <p>No modules match “{query.trim()}”.</p>
        </div>
      ) : (
        <table className="table modules-table">
          <thead>
            <tr>
              <th>Module</th>
              <th>Manual group</th>
              <th>Hardware</th>
              <th>Software relation</th>
              <th>Manuals</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((m) => (
              <tr key={m.slug} className="row-link" onClick={() => navigate(`/modules/${m.slug}`)}>
                <td>
                  <div className="module-cell">
                    <span className="module-name">
                      {m.name}
                      {m.needsDoc && (
                        <span
                          className="orange-dot"
                          title="A linked software released a manual-affecting version with no doc linked yet"
                        />
                      )}
                    </span>
                    <span className="module-sub">
                      {m.code && <code>{m.code}</code>} {catLabel(m.category)}
                    </span>
                  </div>
                </td>
                <td>
                  <span className="chip">{m.group}</span>
                </td>
                <td className={m.hardware?.length ? '' : 'muted'} title={(m.hardware || []).map((h) => `${h.name}: ${h.type === 'ftd' ? `FTD.aero ${h.version || 'v1'}` : `COTS ${[h.manufacturer, h.model].filter(Boolean).join(' ')}`}`).join('\n')}>
                  {m.hardware?.length > 1 ? (
                    <span className="hw-cell">
                      {m.hardware.map((h) => (
                        <span key={h.id || h.name} className="chip">{h.name}</span>
                      ))}
                    </span>
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
      )}

      {wizardOpen && (
        <Wizard
          onClose={() => setWizardOpen(false)}
          onCreated={(created) => {
            setWizardOpen(false);
            toast(
              created.docs?.length > 1
                ? `${created.docs.length} drafts created: ${created.docs.map((d) => d.key).join(', ')}`
                : `Draft created: branch ${created.branch}, doc ${created.key || created.version} r1`
            );
            if (created.aiNote) toast(created.aiNote, 'err');
            navigate(`/modules/${created.slug}`);
          }}
        />
      )}
    </div>
  );
}
