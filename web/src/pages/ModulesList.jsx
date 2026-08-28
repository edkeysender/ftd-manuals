import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, CATEGORIES, timeAgo } from '../api.js';
import StatusBadge from '../components/StatusBadge.jsx';
import Wizard from '../components/Wizard.jsx';
import { useToast } from '../App.jsx';

const catLabel = (c) => (CATEGORIES.find(([k]) => k === c) || [null, c])[1];

export default function ModulesList() {
  const [rows, setRows] = useState(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();

  const load = () => api.modules().then(setRows).catch((e) => toast(e.message, 'err'));
  useEffect(() => {
    load();
  }, []);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Modules</h1>
        <button className="btn btn-primary" onClick={() => setWizardOpen(true)}>
          + New module doc
        </button>
      </div>

      {rows === null ? (
        <div className="empty">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <p>No modules yet.</p>
          <p>
            Create the first one with <strong>+ New module doc</strong> — it starts a draft branch and a doc
            version A1.0 r1.
          </p>
        </div>
      ) : (
        <table className="table modules-table">
          <thead>
            <tr>
              <th>Module</th>
              <th>Manual group</th>
              <th>Hardware</th>
              <th>Software relation</th>
              <th>Latest doc</th>
              <th>Status</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
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
                <td>{m.hardwareLabel}</td>
                <td className={m.softwares.length ? '' : 'muted'}>{m.softwareLabel}</td>
                <td>{m.latestDoc || <span className="muted">—</span>}</td>
                <td>
                  <StatusBadge status={m.status} />
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
            toast(`Draft created: branch ${created.branch}, doc ${created.version} r1`);
            if (created.aiNote) toast(created.aiNote, 'err');
            navigate(`/modules/${created.slug}`);
          }}
        />
      )}
    </div>
  );
}
