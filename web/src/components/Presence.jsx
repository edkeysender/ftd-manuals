import React, { useEffect, useRef, useState } from 'react';
import { t } from '../i18n.jsx';

/** One id per browser tab, so the same person in two tabs shows as two. */
const TAB = (() => {
  try {
    return crypto.randomUUID();
  } catch {
    return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
})();
const BEAT_MS = 15000;

const post = (path, body, keepalive = false) =>
  fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive, credentials: 'same-origin' });

/**
 * Say that this tab has `item` open (as edit / review / view) and learn who else has it open.
 * A heartbeat every 15 s, again at once when the mode changes or the tab comes back into view;
 * leaving the page tells the server straight away.
 */
export function usePresence(item, mode) {
  const [others, setOthers] = useState([]);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    if (!item) return undefined;
    let alive = true;
    const beat = async () => {
      try {
        const r = await post('/api/presence', { item, tab: TAB, mode: modeRef.current });
        if (r.ok && alive) setOthers((await r.json()).others || []);
      } catch {
        /* offline for a moment — the next beat tries again */
      }
    };
    beat();
    const timer = setInterval(beat, BEAT_MS);
    const onVisible = () => document.visibilityState === 'visible' && beat();
    document.addEventListener('visibilitychange', onVisible);
    const onLeave = () => post('/api/presence/leave', { item, tab: TAB }, true).catch(() => {});
    window.addEventListener('pagehide', onLeave);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pagehide', onLeave);
      onLeave();
      setOthers([]);
    };
  }, [item]);
  // a change of mode (opening the editor, starting a review) is told at once
  useEffect(() => {
    if (!item) return;
    post('/api/presence', { item, tab: TAB, mode })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setOthers(j.others || []))
      .catch(() => {});
  }, [item, mode]);
  return others;
}

const MODE_LABEL = { edit: 'editing', review: 'reviewing', view: 'viewing' };

/**
 * Who else is on this item. When someone else is editing what this tab edits, it is a warning:
 * the last one to save wins, so two people should not change the same text at once.
 */
export function PresenceBar({ others, mode, what = 'doc' }) {
  if (!others?.length) return null;
  const editors = others.filter((o) => o.mode === 'edit');
  const clash = mode === 'edit' && editors.length > 0;
  const name = (o) => (o.self ? t('you, in another tab') : o.name);
  return (
    <div className={`presence-bar${clash ? ' clash' : ''}`} role="status">
      {clash ? (
        <span className="presence-warn">
          {t(what === 'manual' ? '{names} is also editing this manual — what you save overwrites each other. Agree who edits first.' : '{names} is also editing this doc — what you save overwrites each other. Agree who edits first.', {
            names: editors.map(name).join(', '),
          })}
        </span>
      ) : (
        <span className="presence-label">{t('Also here:')}</span>
      )}
      {others.map((o) => (
        <span key={`${o.id}:${o.mode}:${o.self ? 1 : 0}`} className={`presence-chip m-${o.mode}`} title={o.email}>
          <span className="presence-dot" />
          {name(o)} · {t(MODE_LABEL[o.mode] || 'viewing')}
        </span>
      ))}
    </div>
  );
}
