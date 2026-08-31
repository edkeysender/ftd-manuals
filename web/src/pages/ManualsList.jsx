import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, GROUPS, MANUAL_TYPES, manualType, timeAgo } from '../api.js';
import ModulePicker from '../components/ModulePicker.jsx';
import { useToast } from '../App.jsx';

export default function ManualsList() {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();

  const load = () => api.manuals().then(setRows).catch((e) => toast(e.message, 'err'));
  useEffect(() => {
    load();
  }, []);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Manuals</h1>
        <button className="btn btn-primary" onClick={() => setOpen(true)}>
          + Create manual
        </button>
      </div>

      {rows === null ? (
        <div className="empty">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <p>No manuals yet.</p>
          <p>
            <strong>+ Create manual</strong> assembles one big manual from the modules you select — each module
            becomes a chapter with its sections 1–7. Pick the audience: a customer manual compiles the modules'
            customer manuals, a technician manual their technician manuals.
          </p>
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Manual</th>
              <th>Group</th>
              <th>Type</th>
              <th>Modules</th>
              <th>Readiness</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.slug} className="row-link" onClick={() => navigate(`/manuals/${m.slug}`)}>
                <td>
                  <div className="module-cell">
                    <span className="module-name">
                      {m.code && <code>{m.code}</code>} {m.name}
                    </span>
                    <span className="module-sub">{m.slug}</span>
                  </div>
                </td>
                <td>{m.group ? <span className="chip">{m.group}</span> : <span className="muted">—</span>}</td>
                <td>
                  <span className={`manual-kind ${manualType(m.manual).kind}`}>{manualType(m.manual).kind}</span>{' '}
                  {manualType(m.manual).short}
                </td>
                <td>
                  {m.modules.length} <span className="muted">· {m.moduleNames.join(', ')}</span>
                </td>
                <td>
                  {m.modules.length === 0 ? (
                    <span className="muted">empty</span>
                  ) : m.unreleased === 0 ? (
                    <span className="badge badge-released">All released</span>
                  ) : (
                    <span className="badge badge-in-review">{m.unreleased} unreleased</span>
                  )}
                </td>
                <td className="muted">{timeAgo(m.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {open && (
        <CreateManual
          onClose={() => setOpen(false)}
          onCreated={(m) => {
            setOpen(false);
            toast(`Manual "${m.name}" created with ${m.modules.length} module${m.modules.length === 1 ? '' : 's'}`);
            navigate(`/manuals/${m.slug}`);
          }}
        />
      )}
    </div>
  );
}

function CreateManual({ onClose, onCreated }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [group, setGroup] = useState('');
  const [manual, setManual] = useState('customer');
  const [modules, setModules] = useState([]);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.modules().then(setModules).catch((e) => toast(e.message, 'err'));
  }, []);

  async function create() {
    setBusy(true);
    try {
      onCreated(await api.createManual({ name: name.trim(), code: code.trim() || null, group: group || null, manual, modules: selected }));
    } catch (e) {
      toast(e.message, 'err');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide">
        <div className="modal-head">
          <h2>Create manual</h2>
          <span className="steps" />
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="form-grid">
            <div className="pair">
              <label style={{ width: 130 }}>
                Short code
                <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="FCOM" />
              </label>
              <label style={{ flex: 1 }}>
                Manual name <span className="req">*</span>
                <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Flight Crew Operating Manual" />
              </label>
              <label>
                Group
                <select value={group} onChange={(e) => setGroup(e.target.value)}>
                  <option value="">— none —</option>
                  {GROUPS.map(([k, l]) => (
                    <option key={k} value={k}>{l}</option>
                  ))}
                </select>
              </label>
              <label>
                Type
                <select value={manual} onChange={(e) => setManual(e.target.value)} title="Which manual of each module is compiled into this document">
                  {MANUAL_TYPES.map((t) => (
                    <option key={t.id} value={t.id}>{t.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="field">
              <span className="field-label">Modules — pick and order the chapters ({manualType(manual).label.toLowerCase()} of each)</span>
              <ModulePicker modules={modules} selected={selected} onChange={setSelected} manual={manual} />
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <span className="hint">Released {manualType(manual).label.toLowerCase()} versions are used; modules without one are included from their latest draft and flagged.</span>
          <button className="btn btn-primary" disabled={!name.trim() || busy} onClick={create}>
            {busy ? 'Creating…' : 'Create manual'}
          </button>
        </div>
      </div>
    </div>
  );
}
