import React from 'react';
import StatusBadge from './StatusBadge.jsx';

/**
 * Ordered module selection for a manual: tick modules on the left, the
 * chapter order is shown on the right with up/down controls.
 */
export default function ModulePicker({ modules, selected, onChange }) {
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
        <div className="picker-title">Available modules</div>
        <div className="picker-list">
          {modules.map((m) => (
            <label key={m.slug} className={`picker-item ${selected.includes(m.slug) ? 'on' : ''}`}>
              <input type="checkbox" checked={selected.includes(m.slug)} onChange={() => toggle(m.slug)} />
              <span className="picker-name">
                {m.name} {m.code && <code>{m.code}</code>}
              </span>
              <span className="chip">{m.group}</span>
              <StatusBadge status={m.status} />
            </label>
          ))}
          {modules.length === 0 && <div className="muted">No modules yet.</div>}
        </div>
      </div>
      <div className="picker-col">
        <div className="picker-title">Chapters ({selected.length})</div>
        <ol className="picker-order">
          {selected.map((slug, i) => (
            <li key={slug}>
              <span className="picker-name">{bySlug[slug]?.name || slug}</span>
              {bySlug[slug] && bySlug[slug].status !== 'released' && (
                <span className="hint" title="No released doc — the latest draft will be used and flagged">draft</span>
              )}
              <span className="picker-btns">
                <button className="btn-icon" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button className="btn-icon" title="Move down" disabled={i === selected.length - 1} onClick={() => move(i, 1)}>↓</button>
                <button className="btn-icon" title="Remove" onClick={() => toggle(slug)}>✕</button>
              </span>
            </li>
          ))}
          {selected.length === 0 && <li className="muted">Tick modules to add chapters.</li>}
        </ol>
      </div>
    </div>
  );
}
