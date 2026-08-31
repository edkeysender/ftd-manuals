import React from 'react';
import StatusBadge from './StatusBadge.jsx';
import { manualType } from '../api.js';
import { t } from '../i18n.jsx';

/**
 * Ordered module selection for a manual: tick modules on the left, the
 * chapter order is shown on the right with up/down controls. `manual` is the
 * manual type being assembled — each module shows the status of that type.
 */
export default function ModulePicker({ modules, selected, onChange, manual = 'customer' }) {
  const typeStatus = (m) => (m.manuals && m.manuals[manual] ? m.manuals[manual].status : 'missing');
  const typeLabel = t(manualType(manual).label).toLowerCase();
  const toggle = (slug) =>
    onChange(selected.includes(slug) ? selected.filter((s) => s !== slug) : [...selected, slug]);
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= selected.length) return;
    const next = [...selected];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const bySlug = Object.fromEntries(modules.map((m) => [m.slug, m]));

  return (
    <div className="picker">
      <div className="picker-col">
        <div className="picker-title">{t('Available modules')}</div>
        <div className="picker-list">
          {modules.map((m) => (
            <label key={m.slug} className={`picker-item ${selected.includes(m.slug) ? 'on' : ''}`}>
              <input type="checkbox" checked={selected.includes(m.slug)} onChange={() => toggle(m.slug)} />
              <span className="picker-name">
                {m.name} {m.code && <code>{m.code}</code>}
              </span>
              <span className="chip">{m.group}</span>
              <StatusBadge status={typeStatus(m)} />
            </label>
          ))}
          {modules.length === 0 && <div className="muted">{t('No modules yet.')}</div>}
        </div>
      </div>
      <div className="picker-col">
        <div className="picker-title">{t('Chapters ({n})', { n: selected.length })}</div>
        <ol className="picker-order">
          {selected.map((slug, i) => (
            <li key={slug}>
              <span className="picker-name">{bySlug[slug]?.name || slug}</span>
              {bySlug[slug] && typeStatus(bySlug[slug]) === 'missing' && (
                <span className="hint" title={t('This module has no {manual} — the chapter will be flagged as missing', { manual: typeLabel })}>{t('no {manual}', { manual: typeLabel })}</span>
              )}
              {bySlug[slug] && typeStatus(bySlug[slug]) !== 'missing' && typeStatus(bySlug[slug]) !== 'released' && !bySlug[slug].manuals?.[manual]?.released && (
                <span className="hint" title={t('No released {manual} — the latest draft will be used and flagged', { manual: typeLabel })}>{t('draft')}</span>
              )}
              <span className="picker-btns">
                <button className="btn-icon" title={t('Move up')} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button className="btn-icon" title={t('Move down')} disabled={i === selected.length - 1} onClick={() => move(i, 1)}>↓</button>
                <button className="btn-icon" title={t('Remove')} onClick={() => toggle(slug)}>✕</button>
              </span>
            </li>
          ))}
          {selected.length === 0 && <li className="muted">{t('Tick modules to add chapters.')}</li>}
        </ol>
      </div>
    </div>
  );
}
