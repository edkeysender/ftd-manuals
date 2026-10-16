import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, timeAgo } from '../api.js';
import { useToast, useAuth } from '../App.jsx';
import { t } from '../i18n.jsx';

export default function InstallationsList() {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();
  const { canEdit } = useAuth();
  const load = () => api.installations().then(setRows).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); }, []);
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('Installations')}</h1>
        {canEdit && <button className="btn btn-primary" onClick={() => setOpen(true)}>{t('+ New installation')}</button>}
      </div>
      {rows === null ? <div className="empty">{t('Loading…')}</div> : rows.length === 0 ? (
        <div className="empty">
          <p>{t('No installations yet.')}</p>
          <p>{t('An installation is one simulator delivery: its racks, instructor station and cockpit, the modules placed in them and the cables between them. Assembled manuals print its wiring and take the device, serial number and operator from it.')}</p>
        </div>
      ) : (
        <table className="table">
          <thead><tr><th>{t('Installation')}</th><th>{t('Device')}</th><th>{t('Serial number')}</th><th>{t('Operator')}</th><th>{t('Schematic')}</th><th>{t('Updated')}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.slug} className="row-link" onClick={() => navigate(`/installations/${r.slug}`)}>
                <td><strong>{r.name}</strong></td><td>{r.device || '—'}</td><td>{r.serialNumber || '—'}</td><td>{r.operator || '—'}</td>
                <td>{r.schematic ? <><span className={`badge badge-${r.schematic.hotfix ? 'in-review' : r.schematic.status}`}>{r.schematic.hotfix ? t('Hotfix') : t(r.schematic.status)}</span> {r.schematic.version}</> : '—'}</td>
                <td className="muted">{timeAgo(r.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && <NewInstallation onClose={() => setOpen(false)} onCreated={(rec) => { setOpen(false); navigate(`/installations/${rec.slug}`); }} />}
    </div>
  );
}

function NewInstallation({ onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', device: '', serialNumber: '', operator: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  async function create() {
    setBusy(true);
    try { onCreated(await api.createInstallation(form)); } catch (e) { toast(e.message, 'err'); setBusy(false); }
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>{t('New installation')}</h2></div>
        <div className="modal-body">
          <label>{t('Name')}<input autoFocus value={form.name} onChange={set('name')} placeholder={t('e.g. B737 NG FTD #001')} /></label>
          <label>{t('Device')}<input value={form.device} onChange={set('device')} placeholder={t('e.g. B737-800 FNPT II MCC')} /></label>
          <div className="pair">
            <label>{t('Serial number')}<input value={form.serialNumber} onChange={set('serialNumber')} /></label>
            <label>{t('Operator')}<input value={form.operator} onChange={set('operator')} placeholder={t('Training organisation')} /></label>
          </div>
          <p className="hint">{t('It starts with three locations: Rack 1, Instructor station, Cockpit. Add more in the chat.')}</p>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn btn-primary" disabled={busy || !form.name.trim()} onClick={create}>{busy ? t('Creating…') : t('Create')}</button>
        </div>
      </div>
    </div>
  );
}
