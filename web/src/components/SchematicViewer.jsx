import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, schematicSvgUrl } from '../api.js';
import { fitView, zoomAt, centerOn } from './schematicView.js';
import { t, locale } from '../i18n.jsx';

const SELECTABLE = '.sch-device[data-id], .sch-block[data-id], .sch-cable[data-id]';
const kindOf = (el) => (el.classList.contains('sch-cable') ? 'cable' : el.classList.contains('sch-block') ? 'block' : 'device');
const endOf = (e) => (e.block ? { kind: 'block', id: e.block, port: e.port } : { kind: 'device', id: e.device, port: e.port });

/**
 * The drawing you can roam: the server's SVG inline, panned by dragging, zoomed with the wheel about
 * the cursor, with a device, block or cable selected by a click — highlighted with everything it is
 * connected to, and described in the card beside it. No editing here: that is the Phase 2 canvas.
 */
export default function SchematicViewer({ owner, data, v = 0, location = '' }) {
  const { state, schedule, view: scope } = data; // `scope` = one location's ids when the panel filters by rack
  const [svg, setSvg] = useState('');
  const [size, setSize] = useState({ w: 1, h: 1 });
  const [view, setView] = useState({ x: 0, y: 0, z: 1 });
  const [selected, setSelected] = useState(null); // { kind, id }
  const [query, setQuery] = useState('');
  const [lib, setLib] = useState(null);
  const boxRef = useRef(null);
  const contentRef = useRef(null);
  const drag = useRef(null);

  useEffect(() => { api.library().then(setLib).catch(() => {}); }, []);
  useEffect(() => {
    let alive = true;
    fetch(schematicSvgUrl(owner, { lang: locale(), v, location })).then((r) => r.text()).then((text) => {
      if (!alive) return;
      const m = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(text);
      const s = { w: m ? +m[1] : 1000, h: m ? +m[2] : 600 };
      setSvg(text);
      setSize(s);
      const box = boxRef.current?.getBoundingClientRect();
      if (box) setView(fitView(s, { w: box.width, h: box.height }));
    });
    return () => { alive = false; };
  }, [owner, v, location]);
  useEffect(() => { setSelected(null); }, [location]);

  const boxSize = () => {
    const b = boxRef.current.getBoundingClientRect();
    return { w: b.width, h: b.height };
  };
  const fit = () => setView(fitView(size, boxSize()));
  const zoomBy = (f) => {
    const b = boxSize();
    setView((vw) => zoomAt(vw, f, b.w / 2, b.h / 2));
  };

  // wheel zoom about the cursor (a native listener: React's onWheel is passive and cannot preventDefault)
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      // one wheel notch (~100 px) is a 1.5× step; a trackpad's small deltas scale the same way;
      // deltaMode 1 reports lines instead of pixels, so scale those up first
      const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
      setView((vw) => zoomAt(vw, Math.exp(-dy * 0.004), e.clientX - r.left, e.clientY - r.top));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, target: e.target };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    if (d.moved) setView((vw) => ({ ...vw, x: d.vx + dx, y: d.vy + dy }));
  };
  const onPointerUp = (e) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    const hit = d.target.closest ? d.target.closest(SELECTABLE) : null;
    setSelected(hit ? { kind: kindOf(hit), id: hit.getAttribute('data-id') } : null);
  };
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') setSelected(null); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);

  // highlight: the selection, and what it is connected to
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    root.querySelectorAll('.sel, .sel-end').forEach((el) => el.classList.remove('sel', 'sel-end'));
    if (!selected) return;
    const find = (kind, id) => root.querySelector(`.sch-${kind === 'cable' ? 'cable' : kind === 'block' ? 'block' : 'device'}[data-id="${CSS.escape(id)}"]`);
    find(selected.kind, selected.id)?.classList.add('sel');
    if (selected.kind === 'cable') {
      const c = state.cables.find((x) => x.id === selected.id);
      for (const end of c ? [endOf(c.from), endOf(c.to)] : []) find(end.kind, end.id)?.classList.add('sel-end');
    } else {
      for (const c of state.cables) {
        const ends = [endOf(c.from), endOf(c.to)];
        if (ends.some((en) => en.kind === selected.kind && en.id === selected.id)) {
          find('cable', c.id)?.classList.add('sel-end');
          for (const en of ends) if (!(en.kind === selected.kind && en.id === selected.id)) find(en.kind, en.id)?.classList.add('sel-end');
        }
      }
    }
  }, [selected, svg, state]);

  const centerSelected = useCallback((sel = selected, z) => {
    const root = contentRef.current;
    if (!root || !sel) return;
    const el = root.querySelector(`.sch-${sel.kind}[data-id="${CSS.escape(sel.id)}"]`);
    if (!el) return;
    const bb = el.getBBox();
    setView((vw) => centerOn(vw, boxSize(), { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 }, z ?? Math.max(vw.z, 0.9)));
  }, [selected]);

  const go = (sel) => { setSelected(sel); setTimeout(() => centerSelected(sel), 0); };

  // search over devices, blocks and cables
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out = [];
    const shown = scope ? new Set([...scope.deviceIds, ...scope.blockIds, ...scope.partnerIds, ...scope.cableIds]) : null;
    const keep = (id) => !shown || shown.has(id);
    for (const d of state.devices) if (!keep(d.id)) continue; else if (`${d.label} ${d.id} ${d.notes || ''}`.toLowerCase().includes(q)) out.push({ kind: 'device', id: d.id, label: d.label });
    for (const b of state.blocks) if (keep(b.id) && `${b.module} ${b.id}`.toLowerCase().includes(q)) out.push({ kind: 'block', id: b.id, label: b.module });
    for (const c of state.cables) if (keep(c.id) && `${c.label} ${c.id}`.toLowerCase().includes(q)) out.push({ kind: 'cable', id: c.id, label: c.label || c.id });
    return out.slice(0, 15);
  }, [query, state]);

  return (
    <div className="sch-viewer">
      <div className="sch-toolbar">
        <input className="sch-search" value={query} placeholder={t('Find a device or cable…')} onChange={(e) => setQuery(e.target.value)} />
        <div className="btn-row">
          <button className="btn btn-sm" onClick={() => zoomBy(1 / 1.6)} title={t('Zoom out')}>−</button>
          <button className="btn btn-sm" onClick={() => zoomBy(1.6)} title={t('Zoom in')}>+</button>
          <button className="btn btn-sm" onClick={fit}>{t('Fit')}</button>
          <button className="btn btn-sm" onClick={() => setView((vw) => centerOn(vw, boxSize(), { x: size.w / 2, y: size.h / 2 }, 1))}>100%</button>
          {selected && <button className="btn btn-sm" onClick={() => centerSelected()}>{t('Centre on selection')}</button>}
        </div>
        <span className="hint">{t('Scroll to zoom, drag to pan, click a device or cable to select it, Esc to clear.')}</span>
      </div>
      <div className="sch-stage">
        <div ref={boxRef} className="sch-viewport" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => (drag.current = null)}>
          <div ref={contentRef} className="sch-content" style={{ width: size.w, height: size.h, transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }} dangerouslySetInnerHTML={{ __html: svg }} />
          {!svg && <div className="empty">{t('Loading…')}</div>}
          <div className="sch-zoom-badge">{Math.round(view.z * 100)}%</div>
        </div>
        {(selected || items.length > 0) && (
          <aside className="sch-side">
            {items.length > 0 && (
              <div className="sch-results">
                <div className="field-label">{t('Matches')}</div>
                {items.map((it) => (
                  <button key={`${it.kind}:${it.id}`} className="sch-result" onClick={() => { setQuery(''); go(it); }}>
                    <span className={`chip sch-kind-${it.kind}`}>{t(it.kind)}</span> {it.label}
                  </button>
                ))}
              </div>
            )}
            {selected && <Details selected={selected} state={state} schedule={schedule} lib={lib} onGo={go} onClose={() => setSelected(null)} />}
          </aside>
        )}
      </div>
    </div>
  );
}

/** What the selected thing is and what hangs on it. */
function Details({ selected, state, schedule, lib, onGo, onClose }) {
  const locName = (id) => state.locations.find((l) => l.id === id)?.label || id || '';
  const nameOf = (end) => (end.block ? state.blocks.find((b) => b.id === end.block)?.module || end.block : state.devices.find((d) => d.id === end.device)?.label || end.device);
  const row = (c) => schedule.find((s) => s.id === c.id) || {};
  if (selected.kind === 'cable') {
    const c = state.cables.find((x) => x.id === selected.id);
    if (!c) return null;
    const s = row(c);
    return (
      <div className="sch-card">
        <div className="sch-card-head"><strong>{c.label || c.id}</strong><button className="btn-icon" onClick={onClose}>×</button></div>
        <div className="small muted">{t('Cable')} · {s.kindLabel || c.kind}{c.length != null ? ` · ${c.length} m` : ''}</div>
        <table className="table sch-table"><tbody>
          <tr><th>{t('From')}</th><td><button className="link" onClick={() => onGo(endOf(c.from))}>{nameOf(c.from)}</button> · {s.fromPort || c.from.port}</td></tr>
          <tr><th>{t('To')}</th><td><button className="link" onClick={() => onGo(endOf(c.to))}>{nameOf(c.to)}</button> · {s.toPort || c.to.port}</td></tr>
          {c.notes && <tr><th>{t('Notes')}</th><td>{c.notes}</td></tr>}
        </tbody></table>
      </div>
    );
  }
  const isBlock = selected.kind === 'block';
  const d = isBlock ? state.blocks.find((b) => b.id === selected.id) : state.devices.find((x) => x.id === selected.id);
  if (!d) return null;
  const tpl = !isBlock && lib ? lib.devices.find((x) => x.id === d.template) : null;
  const mine = (end) => (isBlock ? end.block === d.id : end.device === d.id);
  const links = state.cables.filter((c) => mine(c.from) || mine(c.to)).map((c) => {
    const here = mine(c.from) ? c.from : c.to;
    const other = mine(c.from) ? c.to : c.from;
    const s = row(c);
    return { c, port: here.port, portLabel: mine(c.from) ? s.fromPort : s.toPort, other, otherLabel: nameOf(other), otherPort: mine(c.from) ? s.toPort : s.fromPort, kind: s.kindLabel || c.kind };
  });
  const ports = tpl ? tpl.ports : [];
  const used = new Map(links.map((l) => [l.port, l]));
  return (
    <div className="sch-card">
      <div className="sch-card-head"><strong>{isBlock ? d.module : d.label}</strong><button className="btn-icon" onClick={onClose}>×</button></div>
      <div className="small muted">
        {isBlock ? t('Module block') : tpl ? `${tpl.name}${tpl.manufacturer || tpl.model ? ` · ${[tpl.manufacturer, tpl.model].filter(Boolean).join(' ')}` : ''}` : d.template}
        {d.location ? ` · ${locName(d.location)}` : ''}{d.rack?.u ? ` · ${d.rack.u} U` : ''}
      </div>
      {d.notes && <p className="small">{d.notes}</p>}
      {tpl?.notes && <p className="small muted">{tpl.notes}</p>}
      <div className="field-label">{t('Connections')} ({links.length})</div>
      {ports.length > 0 ? (
        <table className="table sch-table">
          <thead><tr><th>{t('Port')}</th><th>{t('Connected to')}</th></tr></thead>
          <tbody>
            {ports.map((p) => {
              const l = used.get(p.id);
              return (
                <tr key={p.id} className={l ? '' : 'sch-free'}>
                  <td>{p.label} <span className="muted small">{p.connector}</span></td>
                  <td>{l ? <><button className="link" onClick={() => onGo(endOf(l.other))}>{l.otherLabel}</button> · {l.otherPort} <span className="muted small">({l.kind}, <button className="link" onClick={() => onGo({ kind: 'cable', id: l.c.id })}>{l.c.label || l.c.id}</button>)</span></> : <span className="muted">{t('free')}</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <ul className="sch-links">
          {links.map((l) => <li key={l.c.id}>{l.portLabel || l.port} → <button className="link" onClick={() => onGo(endOf(l.other))}>{l.otherLabel}</button> · {l.otherPort} <span className="muted small">({l.c.label || l.c.id})</span></li>)}
          {links.length === 0 && <li className="muted">{t('Nothing connected')}</li>}
        </ul>
      )}
    </div>
  );
}
