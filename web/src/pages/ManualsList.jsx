import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, GROUPS, MANUAL_TYPES, manualType, timeAgo } from '../api.js';
import ModulePicker from '../components/ModulePicker.jsx';
import { useToast } from '../App.jsx';
import { t, plural } from '../i18n.jsx';

export default function ManualsList() {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();

  const load = () => api.manuals().then(setRows).catch((e) => toast(e.message, 'err'));
  useEffect(() => {
    load();
  }, []);

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('Manuals')}</h1>
        <button className="btn" onClick={() => setImporting(true)}>
          {t('Import config')}
        </button>
        <button className="btn btn-primary" onClick={() => setOpen(true)}>
          {t('+ Create manual')}
        </button>
      </div>

      {rows === null ? (
        <div className="empty">{t('Loading…')}</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <p>{t('No manuals yet.')}</p>
          <p>
            <strong>{t('+ Create manual')}</strong>{' '}
            {t("assembles one big manual from the modules you select — each module becomes a chapter with its sections 1–7. Pick the audience: a customer manual compiles the modules' customer manuals, a technician manual their technician manuals.")}
          </p>
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t('Manual')}</th>
              <th>{t('Group')}</th>
              <th>{t('Type')}</th>
              <th>{t('Modules')}</th>
              <th>{t('Readiness')}</th>
              <th>{t('Updated')}</th>
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
                  <span className={`manual-kind ${manualType(m.manual).kind}`}>{t(manualType(m.manual).kind)}</span>{' '}
                  {t(manualType(m.manual).short)}
                </td>
                <td>
                  {m.modules.length} <span className="muted">· {m.moduleNames.join(', ')}</span>
                </td>
                <td>
                  {m.modules.length === 0 ? (
                    <span className="muted">{t('empty')}</span>
                  ) : m.unreleased === 0 ? (
                    <span className="badge badge-released">{t('All released')}</span>
                  ) : (
                    <span className="badge badge-in-review">{t('{n} unreleased', { n: m.unreleased })}</span>
                  )}
                </td>
                <td className="muted">{timeAgo(m.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {importing && (
        <ImportConfig
          onClose={() => setImporting(false)}
          onImported={(r) => {
            setImporting(false);
            toast(t('{n} manuals imported', { n: r.manuals.length }));
            load();
          }}
        />
      )}

      {open && (
        <CreateManual
          onClose={() => setOpen(false)}
          onCreated={(m) => {
            setOpen(false);
            toast(t('Manual "{name}" created with {count}', { name: m.name, count: plural(m.modules.length, 'module') }));
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
          <h2>{t('Create manual')}</h2>
          <span className="steps" />
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="form-grid">
            <div className="pair">
              <label style={{ width: 130 }}>
                {t('Short code')}
                <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="FCOM" />
              </label>
              <label style={{ flex: 1 }}>
                {t('Manual name')} <span className="req">*</span>
                <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Flight Crew Operating Manual')} />
              </label>
              <label>
                {t('Group')}
                <select value={group} onChange={(e) => setGroup(e.target.value)}>
                  <option value="">{t('— none —')}</option>
                  {GROUPS.map(([k, l]) => (
                    <option key={k} value={k}>{t(l)}</option>
                  ))}
                </select>
              </label>
              <label>
                {t('Type')}
                <select value={manual} onChange={(e) => setManual(e.target.value)} title={t('Which manual of each module is compiled into this document')}>
                  {MANUAL_TYPES.map((mt) => (
                    <option key={mt.id} value={mt.id}>{t(mt.label)}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="field">
              <span className="field-label">{t('Modules — pick and order the chapters ({type} of each)', { type: t(manualType(manual).label).toLowerCase() })}</span>
              <ModulePicker modules={modules} selected={selected} onChange={setSelected} manual={manual} />
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <span className="hint">{t('Released {type} versions are used; modules without one are included from their latest draft and flagged.', { type: t(manualType(manual).label).toLowerCase() })}</span>
          <button className="btn btn-primary" disabled={!name.trim() || busy} onClick={create}>
            {busy ? t('Creating…') : t('Create manual')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Import a simulator configuration file. The file describes what a customer's simulator is
 * built from, split into a "simulator" and an "ios" section; each section becomes one manual
 * (group SIM and IOS). Modules are named by slug or by name.
 */
function ImportConfig({ onClose, onImported }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);

  let parsed = null;
  let parseError = '';
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      parseError = e.message;
    }
  }
  const sections = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? ['simulator', 'ios'].filter((k) => parsed[k])
    : [];
  const countOf = (k) => {
    const body = parsed[k];
    const mods = Array.isArray(body) ? body : body && body.modules;
    return Array.isArray(mods) ? mods.length : 0;
  };

  async function pick(file) {
    if (!file) return;
    setFileName(file.name);
    setText(await file.text());
  }

  async function run() {
    setBusy(true);
    try {
      onImported(await api.importManuals(parsed, replace));
    } catch (e) {
      toast(e.message, 'err');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide">
        <div className="modal-head">
          <h2>{t('Import manual from config')}</h2>
          <span className="steps" />
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="form-grid">
            <div className="field">
              <span className="field-label">{t('Configuration file (.json)')}</span>
              <input type="file" accept="application/json,.json" onChange={(e) => pick(e.target.files[0])} />
              {fileName && <span className="hint">{fileName}</span>}
            </div>
            <div className="field">
              <span className="field-label">{t('Or paste the configuration')}</span>
              <textarea
                rows={10}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={"{\\n  \"name\": \"Acme B737\",\\n  \"manual\": \"customer\",\\n  \"simulator\": {\\n    \"code\": \"B737-SIM\",\\n    \"modules\": [\"starting-panel\", \"jump-seats\"]\\n  },\\n  \"ios\": {\\n    \"code\": \"B737-IOS\",\\n    \"modules\": [\"ios-station\"]\\n  }\\n}"}
                spellCheck={false}
              />
            </div>
            {parseError && <p className="form-err">{t('Not valid JSON: {msg}', { msg: parseError })}</p>}
            {parsed && !sections.length && <p className="form-err">{t('The file has no "simulator" or "ios" section.')}</p>}
            {sections.length > 0 && (
              <div className="field">
                <span className="field-label">{t('What will be imported')}</span>
                <ul className="plain-list">
                  {sections.map((k) => (
                    <li key={k}>
                      <span className="chip">{k === 'ios' ? 'IOS' : 'SIM'}</span>{' '}
                      {plural(countOf(k), 'module')}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <label className="check">
              <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
              {t('Replace the chapters of manuals that already exist')}
            </label>
          </div>
        </div>
        <div className="modal-foot">
          <span className="hint">
            {t('Each section becomes one manual: "simulator" in group SIM, "ios" in group IOS. Modules are named by slug or by name and must already exist.')}
          </span>
          <button className="btn btn-primary" disabled={!sections.length || busy} onClick={run}>
            {busy ? t('Importing…') : t('Import')}
          </button>
        </div>
      </div>
    </div>
  );
}
