import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, schematicSvgUrl, devicePanelUrl, cableLabelsUrl } from '../api.js';
import { fitView, zoomAt, centerOn } from './schematicView.js';
import { cableKindsFor, portOf, cableAt, compatibleTargets, rackMap } from './schematicLib.js';
import { useToast } from '../App.jsx';
import { t, locale } from '../i18n.jsx';

/** Picture names on the card: the two faces first, then the extras in the order they were added. */
export const panelOrder = (panels) => ['front', 'rear'].filter((s) => panels?.[s]).concat(Object.keys(panels || {}).filter((s) => s !== 'front' && s !== 'rear'));
export const panelName = (s) => (s === 'front' ? t('Front') : s === 'rear' ? t('Rear') : s === 'mainboard-io' ? t('Mainboard rear I/O') : s === 'gpu-io' ? t('Graphics card outputs') : s.replace(/-/g, ' '));
const SELECTABLE = '.sch-device[data-id], .sch-block[data-id], .sch-cable[data-id]';
const kindOf = (el) => (el.classList.contains('sch-cable') ? 'cable' : el.classList.contains('sch-block') ? 'block' : 'device');
const endOf = (e) => (e.block ? { kind: 'block', id: e.block, port: e.port } : { kind: 'device', id: e.device, port: e.port });

/**
 * The drawing you can roam: the server's SVG inline, panned by dragging, zoomed with the wheel about
 * the cursor, with a device, block or cable selected by a click — highlighted with everything it is
 * connected to, and described in the card beside it. No editing here: that is the Phase 2 canvas.
 */
export default function SchematicViewer({ owner, data, v = 0, location = '', canEdit = false, onChanged }) {
  const { state, schedule, view: scope } = data; // `scope` = one location's ids when the panel filters by rack
  const editable = canEdit && data.editable;
  const toast = useToast();
  const [face, setFace] = useState('front'); // which face of the selected rack the strip shows
  const [showRack, setShowRack] = useState(() => { try { return localStorage.getItem('ftd-sch-rackmap') !== 'off'; } catch { return true; } });
  const toggleRack = () => setShowRack((v) => { try { localStorage.setItem('ftd-sch-rackmap', v ? 'off' : 'on'); } catch {} return !v; });
  const [lightbox, setLightbox] = useState(null); // { src, caption } — a panel picture shown large
  const [connecting, setConnecting] = useState(null); // { from: {device, port}, to?: {device, port} } → ConnectDialog
  const [wire, setWire] = useState(null); // a wire being dragged from a port: { from, x1, y1, x2, y2 }
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

  // a port under the pointer: its device id and port id, or null
  const portAt = (el) => {
    const g = el?.closest ? el.closest('.sch-port') : null;
    const dev = g?.closest('.sch-device[data-id]');
    return g && dev ? { device: dev.getAttribute('data-id'), port: g.getAttribute('data-port') } : null;
  };
  const toContent = (clientX, clientY) => {
    const r = boxRef.current.getBoundingClientRect();
    return { x: (clientX - r.left - view.x) / view.z, y: (clientY - r.top - view.y) / view.z };
  };
  const markTargets = (from) => {
    const root = contentRef.current;
    root?.querySelectorAll('.sch-port-ok').forEach((el) => el.classList.remove('sch-port-ok'));
    if (!from || !lib) return;
    for (const tgt of compatibleTargets(lib, state, from.device, from.port)) {
      root?.querySelector(`.sch-device[data-id="${CSS.escape(tgt.device)}"] .sch-port[data-port="${CSS.escape(tgt.port)}"]`)?.classList.add('sch-port-ok');
    }
  };
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    const from = editable ? portAt(e.target) : null;
    if (from) {
      // dragging a wire out of a port, not panning
      const p = toContent(e.clientX, e.clientY);
      drag.current = { wire: true, from };
      setWire({ from, x1: p.x, y1: p.y, x2: p.x, y2: p.y });
      markTargets(from);
    } else {
      drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, target: e.target };
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    if (d.wire) {
      const p = toContent(e.clientX, e.clientY);
      setWire((w) => (w ? { ...w, x2: p.x, y2: p.y } : w));
      return;
    }
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    if (d.moved) setView((vw) => ({ ...vw, x: d.vx + dx, y: d.vy + dy }));
  };
  const onPointerUp = (e) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.wire) {
      setWire(null);
      markTargets(null);
      const to = portAt(document.elementFromPoint(e.clientX, e.clientY));
      if (!to || (to.device === d.from.device && to.port === d.from.port)) return;
      if (to.device === d.from.device) return toast(t('A cable cannot join two ports of the same device'), 'err');
      if (cableAt(state, to.device, to.port)) return toast(t('That port already has a cable — disconnect it first'), 'err');
      const a = portOf(lib, state, d.from.device, d.from.port);
      const b = portOf(lib, state, to.device, to.port);
      if (!a || !b || !cableKindsFor(lib, a.connector, b.connector).length) return toast(t('No cable kind joins {a} to {b}', { a: a?.connector || '?', b: b?.connector || '?' }), 'err');
      setConnecting({ from: d.from, to });
      return;
    }
    if (d.moved) return;
    const hit = d.target.closest ? d.target.closest(SELECTABLE) : null;
    setSelected(hit ? { kind: kindOf(hit), id: hit.getAttribute('data-id') } : null);
  };
  const applyOps = async (ops, msg) => {
    try {
      await api.schematicOps(owner, ops, { summary: msg });
      toast(msg);
      onChanged?.();
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  const disconnect = (c) => {
    if (!window.confirm(t('Remove cable {name}?', { name: c.label || c.id }))) return;
    applyOps([{ op: 'disconnect', id: c.id }], t('Cable {name} removed', { name: c.label || c.id }));
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
          {location && lib && rackMap(state, lib, location, face) && <button className={`btn btn-sm ${showRack ? 'active' : ''}`} onClick={toggleRack} title={showRack ? t('Hide the rack elevation') : t('Show the rack elevation')}>{showRack ? t('Hide rack view') : t('Show rack view')}</button>}
        </div>
        <span className="hint">{editable ? t('Scroll to zoom, drag to pan, click to select, Esc to clear — drag from a port stub to another port to connect them.') : t('Scroll to zoom, drag to pan, click a device or cable to select it, Esc to clear.')}</span>
      </div>
      <div className="sch-stage">
        {location && showRack && lib && rackMap(state, lib, location, face) && (
          <RackMap map={rackMap(state, lib, location, face)} rackLabel={state.locations.find((l) => l.id === location)?.label} selected={selected} editable={editable} face={face} onFace={setFace}
            onGo={(it) => go({ kind: it.kind, id: it.id })}
            onMove={(u) => selected && applyOps([{ op: 'update_device', id: selected.id, rack: { u, face } }], t('{name} moved to U{u} ({face})', { name: state.devices.find((d) => d.id === selected.id)?.label || selected.id, u, face: face === 'rear' ? t('rear') : t('front') }))} />
        )}
        <div ref={boxRef} className="sch-viewport" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => (drag.current = null)}>
          <div ref={contentRef} className="sch-content" style={{ width: size.w, height: size.h, transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }} dangerouslySetInnerHTML={{ __html: svg }} />
          {wire && (
            <svg className="sch-overlay" width={size.w} height={size.h} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
              <line x1={wire.x1} y1={wire.y1} x2={wire.x2} y2={wire.y2} />
            </svg>
          )}
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
            {selected && <Details selected={selected} state={state} schedule={schedule} lib={lib} owner={owner} onGo={go} onClose={() => setSelected(null)} editable={editable} onConnect={(from) => setConnecting({ from })} onDisconnect={disconnect} onZoomPanel={setLightbox}
              onMoveU={(id, u, f = 'front', h = state.devices.find((d) => d.id === id)?.rack?.h || null) => applyOps([{ op: 'update_device', id, rack: u ? { u, face: f, ...(h ? { h } : {}) } : null }], u ? t('{name} moved to U{u} ({face})', { name: state.devices.find((d) => d.id === id)?.label || id, u, face: f === 'rear' ? t('rear') : t('front') }) : t('U position cleared'))} />}
          </aside>
        )}
      </div>
      {lightbox && <Lightbox src={lightbox.src} caption={lightbox.caption} onClose={() => setLightbox(null)} />}
      {connecting && lib && (
        <ConnectDialog lib={lib} state={state} from={connecting.from} to={connecting.to || null} onClose={() => setConnecting(null)}
          onConfirm={(op) => { setConnecting(null); applyOps([op], t('Connected {a} to {b}', { a: op.from.device, b: op.to.device })); }} />
      )}
    </div>
  );
}

/**
 * A picture shown large: fitted to the window first, then zoomed with the wheel or the buttons and
 * panned by dragging — a 1U front panel is eleven times wider than tall, so "fit" alone is too small
 * to read its port labels.
 */
function Lightbox({ src, caption, onClose }) {
  const stageRef = useRef(null);
  const [z, setZ] = useState(1);
  const [fitW, setFitW] = useState(0); // the width at zoom 1: the picture fitted to the stage
  const drag = useRef(null);
  const onLoad = (e) => {
    const st = stageRef.current.getBoundingClientRect();
    const img = e.target;
    const scale = Math.min(st.width / img.naturalWidth, st.height / img.naturalHeight, 1);
    setFitW(Math.max(1, img.naturalWidth * scale));
  };
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;
    const onWheel = (ev) => { ev.preventDefault(); setZ((v) => Math.min(8, Math.max(0.25, v * Math.exp(-ev.deltaY * 0.0025)))); };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  useEffect(() => {
    const esc = (ev) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  const down = (ev) => { drag.current = { x: ev.clientX, y: ev.clientY, sl: stageRef.current.scrollLeft, st: stageRef.current.scrollTop }; ev.currentTarget.setPointerCapture(ev.pointerId); };
  const move = (ev) => { const d = drag.current; if (!d) return; stageRef.current.scrollLeft = d.sl - (ev.clientX - d.x); stageRef.current.scrollTop = d.st - (ev.clientY - d.y); };
  const up = () => { drag.current = null; };
  return (
    <div className="modal-backdrop lightbox" onClick={onClose}>
      <figure onClick={(e) => e.stopPropagation()}>
        <div className="lightbox-bar">
          <span>{caption}</span>
          <span className="btn-row">
            <button className="btn btn-sm" onClick={() => setZ((v) => Math.max(0.25, v / 1.5))} title={t('Zoom out')}>−</button>
            <button className="btn btn-sm" onClick={() => setZ((v) => Math.min(8, v * 1.5))} title={t('Zoom in')}>+</button>
            <button className="btn btn-sm" onClick={() => setZ(1)}>{t('Fit')}</button>
            <button className="btn btn-sm" onClick={() => setZ(2)}>200%</button>
            <button className="btn btn-sm" onClick={() => setZ(4)}>400%</button>
            <button className="btn btn-sm" onClick={onClose}>{t('Close')}</button>
          </span>
        </div>
        <div ref={stageRef} className="lightbox-stage" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          <img src={src} alt={caption} draggable={false} onLoad={onLoad} style={fitW ? { width: fitW * z, maxWidth: 'none', maxHeight: 'none' } : {}} />
        </div>
        <div className="hint">{t('Scroll to zoom, drag to pan, Esc to close.')} · {Math.round(z * 100)}%</div>
      </figure>
    </div>
  );
}

/**
 * The rack seen from the front: one row per U, numbered from the top, every mounted device drawn at
 * its span. Click a device to jump to it; with a device selected and the schematic editable, click an
 * empty slot to move it there. Devices in the rack with no U yet are listed underneath.
 */
function RackMap({ map, rackLabel, selected, editable, face, onFace, onGo, onMove }) {
  const ROW = 16; // px per U — a 1U front at ~176 px wide keeps the real 11:1 proportions
  const picOf = (it) => (it.panels?.[face] ? face : it.panels?.front ? 'front' : it.panels?.rear ? 'rear' : null);
  const canMove = editable && selected && selected.kind === 'device' && [...map.items, ...map.unplaced].some((i) => i.id === selected.id);
  const rows = [];
  for (let u = map.units; u >= 1; u--) rows.push(u);
  return (
    <aside className="rack-map" title={rackLabel}>
      <div className="rack-map-title">{rackLabel}</div>
      <div className="small muted rack-map-sub">{[map.model, t('{n} U', { n: map.units })].filter(Boolean).join(' · ')}</div>
      <div className="rack-faces">
        <button className={face === 'front' ? 'active' : ''} onClick={() => onFace('front')}>{t('Front')} ({map.counts.front})</button>
        <button className={face === 'rear' ? 'active' : ''} onClick={() => onFace('rear')}>{t('Rear')} ({map.counts.rear})</button>
      </div>
      <div className="rack-map-body" style={{ height: map.units * ROW }}>
        {rows.map((u) => (
          <div key={u} className={`rack-row ${map.freeSlots.includes(u) ? 'free' : ''} ${canMove && map.freeSlots.includes(u) ? 'target' : ''}`} style={{ top: (map.units - u) * ROW, height: ROW }}
            title={canMove && map.freeSlots.includes(u) ? t('Move the selected device to U{u}', { u }) : `U${u}`}
            onClick={() => canMove && map.freeSlots.includes(u) && onMove(u)}>
            <span className="rack-u">{u}</span>
          </div>
        ))}
        {map.items.map((it) => {
          const side = picOf(it);
          return (
            <button key={it.id} className={`rack-item ${side ? 'with-pic' : ''} ${it.overlap ? 'overlap' : ''} ${selected && selected.id === it.id ? 'sel' : ''}`}
              style={{ top: (map.units - (it.u + it.h - 1)) * ROW + 1, height: it.h * ROW - 2 }} title={`${it.label} · U${it.u}${it.h > 1 ? `–${it.u + it.h - 1}` : ''}${side && side !== face ? ` · ${side === 'front' ? t('front picture') : t('rear picture')}` : ''}${it.overlap ? ` · ${t('overlaps another device')}` : ''}`} onClick={() => onGo(it)}>
              {side ? <img src={devicePanelUrl(it.template, side, it.panels[side])} alt={it.label} draggable={false} /> : it.label}
            </button>
          );
        })}
      </div>
      {map.unplaced.length > 0 && (
        <div className="rack-unplaced">
          <select value="" onChange={(e) => { const it = map.unplaced.find((x) => x.id === e.target.value); if (it) onGo(it); }} title={t('Devices in this rack without a U position — pick one, then click a free slot to place it')}>
            <option value="">{t('{n} without U — pick to place…', { n: map.unplaced.length })}</option>
            {map.unplaced.map((it) => <option key={it.id} value={it.id}>{it.label}{it.h > 1 ? ` (${it.h} U)` : ''}</option>)}
          </select>
        </div>
      )}
    </aside>
  );
}

/**
 * Making a cable: the source port is fixed, the far end is either the port it was dragged onto or
 * one picked here from the ports a cable kind can reach — then the kind (when several fit), a label
 * and a length. The server validates again when the operation is posted.
 */
function ConnectDialog({ lib, state, from, to, onClose, onConfirm }) {
  const nameOf = (id) => state.devices.find((d) => d.id === id)?.label || id;
  const src = portOf(lib, state, from.device, from.port);
  const targets = useMemo(() => compatibleTargets(lib, state, from.device, from.port), [lib, state, from]);
  const [q, setQ] = useState('');
  const [device, setDevice] = useState(to?.device || '');
  const [port, setPort] = useState(to?.port || '');
  const devices = useMemo(() => {
    const ids = [...new Set(targets.map((x) => x.device))];
    const qq = q.trim().toLowerCase();
    return ids.filter((id) => !qq || `${nameOf(id)} ${id}`.toLowerCase().includes(qq));
  }, [targets, q]);
  // a filter that leaves one device picks it; one free port on it is picked too
  useEffect(() => { if (devices.length === 1 && device !== devices[0]) { setDevice(devices[0]); setPort(''); } }, [devices.join('|')]);
  const ports = targets.filter((x) => x.device === device);
  useEffect(() => { if (ports.length === 1 && port !== ports[0].port) setPort(ports[0].port); }, [device, ports.length]);
  const chosen = targets.find((x) => x.device === device && x.port === port) || null;
  const kinds = chosen ? chosen.kinds : [];
  const [kind, setKind] = useState('');
  const [label, setLabel] = useState('');
  const [length, setLength] = useState('');
  useEffect(() => { setKind(kinds.length === 1 ? kinds[0] : kinds.includes(kind) ? kind : ''); }, [chosen?.device, chosen?.port]);
  const kindLabel = (id) => lib.cables.find((c) => c.id === id)?.label || id;
  const ok = chosen && kind;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>{t('New cable')}</h2></div>
        <div className="modal-body">
          <p><strong>{t('From')}:</strong> {nameOf(from.device)} · {src?.label || from.port} <span className="muted small">({src?.connector})</span></p>
          {targets.length === 0 ? <p className="hint warn">{t('No free port on another device takes a cable from this connector.')}</p> : (
            <div className="pair">
              <label style={{ flex: 2 }}>{t('To device')}
                <input value={q} placeholder={t('Filter…')} onChange={(e) => setQ(e.target.value)} />
                <select size={6} value={device} onChange={(e) => { setDevice(e.target.value); setPort(''); }}>
                  {devices.map((id) => <option key={id} value={id} onClick={() => { setDevice(id); setPort(''); }}>{nameOf(id)}</option>)}
                </select>
              </label>
              <label style={{ flex: 1.4 }}>{t('Port')}
                <select size={6} value={port} onChange={(e) => setPort(e.target.value)} disabled={!device}>
                  {ports.map((x) => <option key={x.port} value={x.port} onClick={() => setPort(x.port)}>{x.portLabel} ({x.connector})</option>)}
                </select>
              </label>
            </div>
          )}
          {chosen && (
            <div className="pair">
              <label>{t('Kind')}
                {kinds.length === 1 ? <input value={kindLabel(kinds[0])} readOnly /> : (
                  <select value={kind} onChange={(e) => setKind(e.target.value)}>
                    <option value="">{t('— choose —')}</option>
                    {kinds.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
                  </select>
                )}
              </label>
              <label>{t('Label')}<input value={label} placeholder={t('e.g. PWR-12')} onChange={(e) => setLabel(e.target.value)} /></label>
              <label style={{ flex: 0.6 }}>{t('Length (m)')}<input type="number" min="0" step="0.1" value={length} onChange={(e) => setLength(e.target.value)} /></label>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn btn-primary" disabled={!ok} onClick={() => onConfirm({ op: 'connect', kind, from, to: { device: chosen.device, port: chosen.port }, label: label.trim(), ...(length ? { length: Number(length) } : {}) })}>{t('Connect')}</button>
        </div>
      </div>
    </div>
  );
}

/** What the selected thing is and what hangs on it. */
function Details({ selected, state, schedule, lib, owner, onGo, onClose, editable = false, onConnect, onDisconnect, onMoveU, onZoomPanel }) {
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
        <div className="btn-row">
          <a className="btn btn-sm" href={cableLabelsUrl(owner, { ids: [c.id], lang: locale() })} target="_blank" rel="noreferrer">{t('Print label')}</a>
          {editable && <button className="btn btn-sm btn-danger" onClick={() => onDisconnect(c)}>{t('Remove cable')}</button>}
        </div>
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
      {editable && !isBlock && state.locations.find((l) => l.id === d.location)?.kind === 'rack' && (
        <div className="pair sch-upos">
          <label className="inline">{t('U position')}
            <input type="number" min="1" defaultValue={d.rack?.u || ''} key={`${d.id}:${d.rack?.u || ''}`} onBlur={(e) => { const u = Number(e.target.value); if (u !== (d.rack?.u || 0)) onMoveU(d.id, u || null, d.rack?.face || 'front'); }} onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }} />
          </label>
          <label className="inline">{t('Face')}
            <select value={d.rack?.face || 'front'} disabled={!d.rack?.u} onChange={(e) => onMoveU(d.id, d.rack.u, e.target.value)}>
              <option value="front">{t('Front')}</option><option value="rear">{t('Rear')}</option>
            </select>
          </label>
          <label className="inline" title={t('Leave empty to use the template height ({h} U)', { h: Math.max(1, Number(tpl?.heightU) || 1) })}>{t('Height (U)')}
            <input type="number" min="1" max="60" placeholder={String(Math.max(1, Number(tpl?.heightU) || 1))} defaultValue={d.rack?.h || ''} key={`h:${d.id}:${d.rack?.h || ''}`} disabled={!d.rack?.u}
              onBlur={(e) => { const h = Number(e.target.value) || null; if (h !== (d.rack?.h || null)) onMoveU(d.id, d.rack.u, d.rack?.face || 'front', h); }} onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }} />
          </label>
        </div>
      )}
      {tpl && Object.keys(tpl.panels || {}).length > 0 && (
        <div className="panel-grid">
          {panelOrder(tpl.panels).map((s) => (
            <figure key={s} className="panel-fig" title={t('Click to enlarge')} onClick={() => onZoomPanel({ src: devicePanelUrl(tpl.id, s, tpl.panels[s]), caption: `${tpl.name} — ${panelName(s)}` })}>
              <img src={devicePanelUrl(tpl.id, s, tpl.panels[s])} alt={s} />
              <figcaption className="small muted">{panelName(s)}</figcaption>
            </figure>
          ))}
        </div>
      )}
      <div className="field-label">{t('Connections')} ({links.length})</div>
      {ports.length > 0 ? (
        <table className="table sch-table">
          <thead><tr><th>{t('Port')}</th><th>{t('Connected to')}</th>{editable && <th></th>}</tr></thead>
          <tbody>
            {ports.map((p) => {
              const l = used.get(p.id);
              return (
                <tr key={p.id} className={l ? '' : 'sch-free'}>
                  <td>{p.label} <span className="muted small">{p.connector}</span></td>
                  <td>{l ? <><button className="link" onClick={() => onGo(endOf(l.other))}>{l.otherLabel}</button> · {l.otherPort} <span className="muted small">({l.kind}, <button className="link" onClick={() => onGo({ kind: 'cable', id: l.c.id })}>{l.c.label || l.c.id}</button>)</span></> : <span className="muted">{t('free')}</span>}</td>
                  {editable && !isBlock && (
                    <td className="sch-act">
                      {l ? <button className="btn btn-sm" onClick={() => onDisconnect(l.c)}>{t('Disconnect')}</button> : <button className="btn btn-sm" onClick={() => onConnect({ device: d.id, port: p.id })}>{t('Connect…')}</button>}
                    </td>
                  )}
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
