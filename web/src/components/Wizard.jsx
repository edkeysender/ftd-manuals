import React, { useEffect, useMemo, useState } from 'react';
import { api, CATEGORIES, GROUPS, MODULE_TYPES, moduleType } from '../api.js';
import { useToast } from '../App.jsx';
import { t } from '../i18n.jsx';

/** Preview of the doc codes the chosen type will draft: <CODE>-TECH-HW … */
const docCodes = (code, typeId) => {
  const base = (code.trim() || '{KOD}').toUpperCase();
  return (moduleType(typeId)?.manuals || []).map(
    (m) => `${base}-${m.includes('technician') ? 'TECH' : 'USER'}-${m.startsWith('software') ? 'SW' : 'HW'}`
  );
};

/**
 * New module — one compact form. The module type decides which manuals are
 * drafted (as A1.0 r1 drafts, blank templates, FAT checklist on the technician
 * manual); parts become catalog items: a trailing version = made in-house,
 * no version = bought.
 */
export default function Wizard({ onClose, onCreated }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [category, setCategory] = useState('cockpit-hardware');
  const [group, setGroup] = useState('SIM');
  const [type, setType] = useState('own-module');
  const [software, setSoftware] = useState('');
  const [softwareList, setSoftwareList] = useState([]);
  const [parts, setParts] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.software().then((rows) => setSoftwareList(rows.map((r) => r.name))).catch(() => setSoftwareList([]));
  }, []);

  const mtype = moduleType(type);
  const codes = useMemo(() => docCodes(code, type), [code, type]);

  async function create() {
    setBusy(true);
    try {
      const created = await api.createModule({
        name: name.trim(),
        code: code.trim() || null,
        category,
        group,
        type,
        software: software || null,
        parts,
        checklist: { mode: 'template' },
        start: { mode: 'blank' },
      });
      onCreated(created);
    } catch (e) {
      toast(e.message, 'err');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wizard-compact">
        <div className="modal-head">
          <div>
            <h2>{t('New module')}</h2>
            <span className="muted small">{t('the type generates the required manuals as drafts')}</span>
          </div>
          <span className="steps" />
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="form-rows">
            <label className="form-row">
              <span>{t('Name')}</span>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="form-row">
              <span>{t('Code')}</span>
              <input className="code-input" value={code} placeholder={t('e.g. IHS')} onChange={(e) => setCode(e.target.value.toUpperCase())} />
            </label>
            <label className="form-row">
              <span>{t('Category')}</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                {CATEGORIES.map(([k, l]) => (
                  <option key={k} value={k}>{t(l)}</option>
                ))}
              </select>
            </label>
            <label className="form-row">
              <span>{t('Group')}</span>
              <select value={group} onChange={(e) => setGroup(e.target.value)}>
                {GROUPS.map(([k]) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
            </label>
            <div className="form-row">
              <span>{t('Type')}</span>
              <div className="type-cards">
                {MODULE_TYPES.map((mt) => (
                  <button
                    key={mt.id}
                    type="button"
                    className={`type-card ${type === mt.id ? 'selected' : ''}`}
                    onClick={() => setType(mt.id)}
                  >
                    <strong>{t(mt.label)}</strong>
                    <span>{t(mt.desc)}</span>
                  </button>
                ))}
              </div>
            </div>
            <label className="form-row">
              <span>{t('Software')}</span>
              <select value={software} onChange={(e) => setSoftware(e.target.value)}>
                <option value="">{t('— none —')}</option>
                {softwareList.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            {mtype?.needsSoftware && !software && (
              <div className="form-row">
                <span />
                <span className="hint">{t('No software selected — one named after the module will be created on the Software page and linked.')}</span>
              </div>
            )}
            <label className="form-row">
              <span>{t('Parts')}</span>
              <textarea
                rows={3}
                value={parts}
                placeholder={t('one per line, version at the end: Płyta czołowa v1')}
                onChange={(e) => setParts(e.target.value)}
              />
            </label>
            <div className="form-row">
              <span />
              <span className="hint">
                {t('A trailing version marks a part made by FTD; without one it is a bought part (e.g. an encoder). Parts join the shared catalog.')}{' '}
                {type === 'third-party-kit' && !parts.trim() && t('Left empty, the bought device itself becomes the single part (e.g. the smoke detector).')}
              </span>
            </div>
          </div>

          <div className="will-create">
            {t('Will create:')}{' '}
            {codes.map((c) => (
              <code key={c}>{c}</code>
            ))}
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={create}>
            {busy ? t('Creating…') : t('Create')}
          </button>
        </div>
      </div>
    </div>
  );
}
