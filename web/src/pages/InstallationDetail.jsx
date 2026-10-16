import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import SchematicPanel from '../components/SchematicPanel.jsx';
import { useToast, useAuth } from '../App.jsx';
import { t } from '../i18n.jsx';

export default function InstallationDetail() {
  const { slug } = useParams();
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();
  const { canEdit, isAdmin } = useAuth();
  const load = useCallback(() => api.installation(slug).then(setData).catch((e) => toast(e.message, 'err')), [slug]);
  useEffect(() => { load(); }, [load]);
  if (!data) return <div className="page"><div className="empty">{t('Loading…')}</div></div>;
  const { installation, manuals } = data;
  async function remove() {
    if (!window.confirm(t('Delete this installation and its schematic? This cannot be undone.'))) return;
    try { await api.deleteInstallation(slug); navigate('/installations'); } catch (e) { toast(e.message, 'err'); }
  }
  return (
    <div className="page page-wide">
      <div className="crumbs"><Link to="/installations">{t('Installations')}</Link> / {installation.name}</div>
      <div className="page-head">
        <div>
          <h1>{installation.name}</h1>
          <div className="muted">
            {[installation.device, installation.serialNumber && `${t('S/N')} ${installation.serialNumber}`, installation.operator].filter(Boolean).join(' · ') || t('No device, serial number or operator yet')}
          </div>
          {manuals.length > 0 && <div className="small">{t('Printed by')}: {manuals.map((m, i) => <span key={m.slug}>{i ? ', ' : ''}<Link to={`/manuals/${m.slug}`}>{m.name}</Link></span>)}</div>}
        </div>
        {canEdit && (
          <div className="btn-row">
            <button className="btn" onClick={() => setEditing(true)}>{t('Edit')}</button>
            {isAdmin && <button className="btn btn-danger" onClick={remove}>{t('Delete')}</button>}
          </div>
        )}
      </div>
      <SchematicPanel owner={`inst:${slug}`} canEdit={canEdit} isAdmin={isAdmin} onChanged={load} />
      {editing && <EditInstallation installation={installation} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} />}
    </div>
  );
}

function EditInstallation({ installation, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: installation.name, device: installation.device || '', serialNumber: installation.serialNumber || '', operator: installation.operator || '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  async function save() {
    setBusy(true);
    try { await api.updateInstallation(installation.slug, form); onSaved(); } catch (e) { toast(e.message, 'err'); setBusy(false); }
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>{t('Edit installation')}</h2></div>
        <div className="modal-body">
          <label>{t('Name')}<input value={form.name} onChange={set('name')} /></label>
          <label>{t('Device')}<input value={form.device} onChange={set('device')} /></label>
          <div className="pair">
            <label>{t('Serial number')}<input value={form.serialNumber} onChange={set('serialNumber')} /></label>
            <label>{t('Operator')}<input value={form.operator} onChange={set('operator')} /></label>
          </div>
          <p className="hint">{t('Manuals linked to this installation print these on their cover.')}</p>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn btn-primary" disabled={busy || !form.name.trim()} onClick={save}>{busy ? t('Saving…') : t('Save')}</button>
        </div>
      </div>
    </div>
  );
}
