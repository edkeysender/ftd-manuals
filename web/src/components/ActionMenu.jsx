import React, { useEffect, useRef, useState } from 'react';
import { t } from '../i18n.jsx';

/**
 * A button that opens a short menu of actions: the "···" overflow on a manual's row, or a labelled
 * one such as the manual page's Export. Items are { label, hint?, onClick | href, download?,
 * disabled?, danger?, count? } — an href opens in a new tab, or downloads when `download` is set.
 *
 * The menu is fixed-positioned from the button's rect (a table clips overflow for its rounded
 * corners, so an absolute menu on the last row would be cut off); it flips upward near the bottom.
 */
export default function ActionMenu({ items, label = '···', title = t('More actions'), className = 'btn btn-sm', disabled = false }) {
  const [pos, setPos] = useState(null);
  const open = !!pos;
  const ref = useRef(null);
  const btnRef = useRef(null);
  const place = () => {
    const r = btnRef.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const up = below < 220 && r.top > below;
    setPos(up ? { right: window.innerWidth - r.right, top: 'auto', bottom: window.innerHeight - r.top + 6 } : { right: window.innerWidth - r.right, top: r.bottom + 6 });
  };
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setPos(null); };
    const esc = (e) => { if (e.key === 'Escape') setPos(null); };
    const away = () => setPos(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', away, true);
    window.addEventListener('resize', away);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', away, true);
      window.removeEventListener('resize', away);
    };
  }, [open]);
  const text = (it) => (
    <span className="cm-text">
      <strong>{it.label}{it.count > 0 && <span className="count-pill" style={{ marginLeft: 6 }}>{it.count}</span>}</strong>
      {it.hint && <span className="muted small">{it.hint}</span>}
    </span>
  );
  return (
    <div className={`create-manual action-menu-wrap ${label === '···' ? 'is-overflow' : ''}`} ref={ref}>
      <button ref={btnRef} className={className} title={title} disabled={disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => (open ? setPos(null) : place())}>
        {label}
        {label !== '···' && <span className="menu-caret" aria-hidden="true">▾</span>}
      </button>
      {open && (
        <div className="create-manual-menu action-menu" role="menu" style={{ position: 'fixed', ...pos }}>
          {items.map((it) => it.href ? (
            <a
              key={it.label}
              className="cm-item"
              role="menuitem"
              href={it.href}
              {...(it.download ? { download: typeof it.download === 'string' ? it.download : '' } : { target: '_blank', rel: 'noreferrer' })}
              title={it.hint || ''}
              onClick={() => setPos(null)}
            >
              {text(it)}
            </a>
          ) : (
            <button
              key={it.label}
              className={`cm-item ${it.danger ? 'danger' : ''}`}
              role="menuitem"
              disabled={!!it.disabled}
              title={it.hint || ''}
              onClick={() => { setPos(null); it.onClick(); }}
            >
              {text(it)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
