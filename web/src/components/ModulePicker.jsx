import React, { useState } from 'react';
import StatusBadge from './StatusBadge.jsx';
import { manualType, isOwnSoftware } from '../api.js';
import { t } from '../i18n.jsx';

/**
 * Ordered module selection for a manual: tick modules on the left, the
 * chapter order is shown on the right — drag a chapter to its place, or use the up/down controls. `manual` is the
 * manual type being assembled — each module shows the status of that type.
 */
export default function ModulePicker({ modules, selected, onChange, manual = 'customer' }) {
  // A software documented on its own has only software manuals, and those compile as extra chapters
  // of the module they belong to — never as a chapter of their own. It is not a chapter to pick.
  modules = modules.filter((m) => !isOwnSoftware(m) || selected.includes(m.slug));
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
  // Drag a chapter onto another: it takes that place and the rest close up.
  const [dragging, setDragging] = useState(null);
  const [over, setOver] = useState(null);
  const drop = (to) => {
    const from = dragging;
    setDragging(null);
    setOver(null);
    if (from === null || from === to) return;
    const next = [...selected];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
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
            <li
              key={slug}
              draggable
              className={`${dragging === i ? 'dragging' : ''} ${over === i && dragging !== i ? 'drop-target' : ''}`}
              title={t('Drag to reorder')}
              onDragStart={(e) => {
                setDragging(i);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(i);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                drop(i);
              }}
            >
              <span className="drag-handle" aria-hidden>⋮⋮</span>
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
