import React, { useEffect, useState } from 'react';
import { api, devicePanelUrl, readFileAsBase64 } from '../api.js';
import { useToast } from '../App.jsx';
import { t, plural } from '../i18n.jsx';
import { panelOrder, panelName } from './SchematicViewer.jsx';

const CATEGORIES = ['switch', 'router', 'pc', 'audio-interface', 'power-strip', 'headset', 'display', 'panel', 'other'];
const DIRECTIONS = ['in', 'out', 'bidir'];
const SIDES = ['left', 'right', 'top', 'bottom'];

export default function LibraryCard() {
  const toast = useToast();
  const [lib, setLib] = useState(null);
  const [hardware, setHardware] = useState([]);
  const [editing, setEditing] = useState(null); // template or {} for new
  const [rulesOpen, setRulesOpen] = useState(false);
  const load = () => api.library().then(setLib).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); api.hardware().then(setHardware).catch(() => {}); }, []);
  if (!lib) return null;
  async function remove(d) {
    if (!window.confirm(t('Remove device template {name}?', { name: d.name }))) return;
    try { await api.deleteDeviceTemplate(d.id); load(); } catch (e) { toast(e.message, 'err'); }
  }
  async function promote(d) {
    const name = window.prompt(t('Module name'), d.name);
    if (!name) return;
    try { const r = await api.promoteDevice(d.id, { name }); toast(t('Module {slug} created with its schematic', { slug: r.slug })); load(); } catch (e) { toast(e.message, 'err'); }
  }
  return (
    <section className="settings-card">
      <h2>{t('Device library')}</h2>
      <p className="muted">{t('Devices a schematic places — what each one is and which ports it has. Connector and cable kinds decide which ports a cable may join.')}</p>
      <table className="table">
        <thead><tr><th>{t('Device')}</th><th>{t('Category')}</th><th>{t('Ports')}</th><th>{t('Catalog item')}</th><th></th></tr></thead>
        <tbody>
          {lib.devices.map((d) => (
            <tr key={d.id}>
              <td><strong>{d.name}</strong><div className="small muted">{[d.manufacturer, d.model].filter(Boolean).join(' ')} · {d.id}</div></td>
              <td>{d.category}</td>
              <td title={d.ports.map((p) => `${p.label} (${p.connector}, ${p.direction})`).join('\n')}>{plural(d.ports.length, 'port')}</td>
              <td>{d.hardwareId ? hardware.find((h) => h.id === d.hardwareId)?.name || d.hardwareId : '—'}{(d.panels?.front || d.panels?.rear) && <div className="panel-thumbs">{['front', 'rear'].filter((s) => d.panels[s]).map((s) => <img key={s} src={devicePanelUrl(d.id, s, d.panels[s])} alt={s} title={s === 'front' ? t('Front') : t('Rear')} />)}</div>}</td>
              <td className="btn-row">
                <button className="btn btn-sm" onClick={() => setEditing(d)}>{t('Edit')}</button>
                <button className="btn btn-sm" onClick={() => promote(d)} title={t('Create a module of its own from this device')}>{t('Promote to module')}</button>
                <button className="btn btn-sm btn-danger" onClick={() => remove(d)}>{t('Remove')}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="btn-row">
        <button className="btn btn-primary" onClick={() => setEditing({})}>{t('+ Add device')}</button>
        <button className="btn" onClick={() => setRulesOpen((o) => !o)}>{rulesOpen ? t('Hide connector rules') : t('Connector rules…')}</button>
      </div>
      {rulesOpen && <RulesEditor lib={lib} onSaved={load} />}
      {editing && <TemplateEditor lib={lib} hardware={hardware} template={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </section>
  );
}

function TemplateEditor({ lib, hardware, template, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !template.id;
  const [form, setForm] = useState({ name: template.name || '', category: template.category || 'other', manufacturer: template.manufacturer || '', model: template.model || '', heightU: template.heightU ?? 1, sizeMm: { w: template.sizeMm?.w ?? '', h: template.sizeMm?.h ?? '', d: template.sizeMm?.d ?? '' }, hardwareId: template.hardwareId || '', notes: template.notes || '', ports: template.ports?.length ? template.ports.map((p) => ({ ...p })) : [{ id: '', label: '', connector: lib.connectors[0].id, direction: 'bidir', side: 'right' }] });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setPort = (i, k, v) => setForm((f) => ({ ...f, ports: f.ports.map((p, k2) => (k2 === i ? { ...p, [k]: v } : p)) }));
  const addPort = () => setForm((f) => ({ ...f, ports: [...f.ports, { id: '', label: '', connector: lib.connectors[0].id, direction: 'bidir', side: 'right' }] }));
  const dropPort = (i) => setForm((f) => ({ ...f, ports: f.ports.filter((_, k) => k !== i) }));
  async function save() {
    setBusy(true);
    try {
      const body = { ...form, heightU: Number(form.heightU), sizeMm: form.sizeMm, hardwareId: form.hardwareId || null, ports: form.ports.filter((p) => p.label.trim() || p.id.trim()) };
      if (isNew) await api.createDeviceTemplate(body); else await api.updateDeviceTemplate(template.id, body);
      onSaved();
    } catch (e) { toast(e.message, 'err'); setBusy(false); }
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>{isNew ? t('New device template') : t('Edit device template')}</h2></div>
        <div className="modal-body">
          <div className="pair">
            <label style={{ flex: 2 }}>{t('Name')}<input autoFocus value={form.name} onChange={set('name')} /></label>
            <label>{t('Category')}<select value={form.category} onChange={set('category')}>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
          </div>
          <div className="pair">
            <label>{t('Manufacturer')}<input value={form.manufacturer} onChange={set('manufacturer')} /></label>
            <label>{t('Model')}<input value={form.model} onChange={set('model')} /></label>
            <label style={{ flex: 0.5 }}>{t('Height (U)')}<input type="number" min="0" step="1" value={form.heightU} onChange={set('heightU')} /></label>
          </div>
          {/* the physical size: what has to fit into a rack of a given depth */}
          <div className="pair size-mm">
            <label>{t('Width (mm)')}<input type="number" min="1" value={form.sizeMm.w} onChange={(e) => setForm((f) => ({ ...f, sizeMm: { ...f.sizeMm, w: e.target.value } }))} /></label>
            <label>{t('Height (mm)')}<input type="number" min="1" value={form.sizeMm.h} onChange={(e) => setForm((f) => ({ ...f, sizeMm: { ...f.sizeMm, h: e.target.value } }))} /></label>
            <label>{t('Depth (mm)')}<input type="number" min="1" value={form.sizeMm.d} onChange={(e) => setForm((f) => ({ ...f, sizeMm: { ...f.sizeMm, d: e.target.value } }))} placeholder={t('e.g. 468')} /></label>
          </div>
          <label>{t('Hardware catalog item')}
            <select value={form.hardwareId} onChange={set('hardwareId')}>
              <option value="">{t('— none —')}</option>
              {hardware.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </label>
          <div className="field">
            <span className="field-label">{t('Ports')}</span>
            <table className="table ports-edit">
              <thead><tr><th>{t('Id')}</th><th>{t('Label')}</th><th>{t('Connector')}</th><th>{t('Direction')}</th><th>{t('Side')}</th><th></th></tr></thead>
              <tbody>
                {form.ports.map((p, i) => (
                  <tr key={i}>
                    <td><input value={p.id} placeholder={t('auto')} onChange={(e) => setPort(i, 'id', e.target.value)} /></td>
                    <td><input value={p.label} onChange={(e) => setPort(i, 'label', e.target.value)} /></td>
                    <td><select value={p.connector} onChange={(e) => setPort(i, 'connector', e.target.value)}>{lib.connectors.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></td>
                    <td><select value={p.direction} onChange={(e) => setPort(i, 'direction', e.target.value)}>{DIRECTIONS.map((d) => <option key={d} value={d}>{d}</option>)}</select></td>
                    <td><select value={p.side} onChange={(e) => setPort(i, 'side', e.target.value)}>{SIDES.map((s) => <option key={s} value={s}>{s}</option>)}</select></td>
                    <td><button className="btn-icon" onClick={() => dropPort(i)}>×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn btn-sm" onClick={addPort}>{t('+ Port')}</button>
          </div>
          <label>{t('Notes')}<input value={form.notes} onChange={set('notes')} /></label>
          {!isNew && <PanelPictures template={template} onChanged={onSaved} />}
          {isNew && <p className="hint">{t('Save the template first, then add pictures of its front and rear.')}</p>}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn btn-primary" disabled={busy || !form.name.trim()} onClick={save}>{busy ? t('Saving…') : t('Save')}</button>
        </div>
      </div>
    </div>
  );
}

/** The two faces of a device: a picture each (SVG or a photo), shown on the device card in the schematic. */
function PanelPictures({ template, onChanged }) {
  const toast = useToast();
  const [panels, setPanels] = useState(template.panels || {});
  const [busy, setBusy] = useState('');
  async function upload(side, file) {
    if (!file) return;
    setBusy(side);
    try {
      const t = await api.uploadDevicePanel(template.id, side, await readFileAsBase64(file));
      setPanels(t.panels || {});
      onChanged?.();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(''); }
  }
  async function remove(side) {
    setBusy(side);
    try { const t = await api.deleteDevicePanel(template.id, side); setPanels(t.panels || {}); onChanged?.(); } catch (e) { toast(e.message, 'err'); } finally { setBusy(''); }
  }
  const [extra, setExtra] = useState('');
  const slots = ['front', 'rear', ...Object.keys(panels).filter((s) => s !== 'front' && s !== 'rear')];
  return (
    <div className="field">
      <span className="field-label">{t('What it looks like')}</span>
      <div className="pair" style={{ marginBottom: 6 }}>
        <input value={extra} placeholder={t('Extra picture name, e.g. mainboard-io, gpu-io')} onChange={(e) => setExtra(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} />
        <label className="btn btn-sm">{t('Add named picture…')}<input type="file" accept="image/*,.svg" hidden disabled={!extra.trim()} onChange={(e) => { upload(extra.trim(), e.target.files?.[0]); setExtra(''); }} /></label>
      </div>
      <div className="panel-grid">
        {slots.map((side) => (
          <div key={side} className="panel-slot">
            <div className="small muted">{panelName(side)}</div>
            {panels[side] ? <img src={devicePanelUrl(template.id, side, `${panels[side]}-${Date.now()}`)} alt={side} /> : <div className="panel-empty">{t('No picture')}</div>}
            <div className="btn-row">
              <label className="btn btn-sm">{busy === side ? t('Saving…') : panels[side] ? t('Replace…') : t('Add picture…')}<input type="file" accept="image/*,.svg" hidden onChange={(e) => upload(side, e.target.files?.[0])} /></label>
              {panels[side] && <button className="btn btn-sm btn-danger" onClick={() => remove(side)}>{t('Remove')}</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Connector and cable kinds as JSON — a short list the technician edits once, so a form would be more than it is worth in this phase. */
function RulesEditor({ lib, onSaved }) {
  const toast = useToast();
  const [text, setText] = useState(() => JSON.stringify({ connectors: lib.connectors, cables: lib.cables }, null, 2));
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await api.saveConnectors(JSON.parse(text)); toast(t('Connector rules saved')); onSaved(); } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  }
  return (
    <div className="rules-editor">
      <p className="hint">{t('connectors: [{id, label, color}] · cables: [{id, label, joins: [[connectorA, connectorB], …], style: {color, width, dash}}]. Every join must name existing connectors.')}</p>
      <textarea className="guidelines-edit" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? t('Saving…') : t('Save connector rules')}</button>
    </div>
  );
}
