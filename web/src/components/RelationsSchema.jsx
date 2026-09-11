import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t, plural } from '../i18n.jsx';

/* Node geometry, in SVG units — the diagram scales to its container through the viewBox. */
const NODE_W = 124;
const NODE_H = 34;
const GAP = 16;
const RING_0 = 150; // clear of the centre node
// Rings must sit at least a node's width apart: a node to the left or right of the centre
// extends radially by half its width, so anything closer overlaps the ring beyond it.
const RING_STEP = NODE_W + GAP;

const cut = (s, n = 20) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

const MIN_Z = 0.4;
const MAX_Z = 4;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Where a pointer event sits in diagram coordinates, for zooming about the cursor. */
function pointIn(el, e, view, half) {
  const box = el.getBoundingClientRect();
  const span = (2 * half) / view.z;
  return {
    x: view.x + ((e.clientX - box.left) / box.width - 0.5) * span,
    y: view.y + ((e.clientY - box.top) / box.height - 0.5) * span,
  };
}

/**
 * Lay the satellites out on concentric rings: each ring takes as many nodes as fit around
 * its circumference, so a module with three parts draws one tidy ring and one with forty
 * grows outwards instead of overlapping itself.
 */
function rings(nodes) {
  const out = [];
  for (let i = 0, ring = 0; i < nodes.length; ring++) {
    const r = RING_0 + ring * RING_STEP;
    const cap = Math.max(6, Math.floor((2 * Math.PI * r) / (NODE_W + GAP)));
    const items = nodes.slice(i, i + cap);
    const step = (2 * Math.PI) / items.length;
    out.push(
      items.map((n, k) => {
        // Start at the top and walk clockwise; odd rings are offset so nodes do not line up
        // radially with the ring inside them.
        const a = -Math.PI / 2 + k * step + (ring % 2 ? step / 2 : 0);
        return { ...n, x: Math.cos(a) * r, y: Math.sin(a) * r };
      })
    );
    i += items.length;
  }
  return out.flat();
}

/**
 * What a built module is made of, as a diagram: the module in the middle, its software and
 * its parts pinned around it. The filters above are the point — a module with forty parts
 * is only readable once you narrow it to what you are looking at.
 */
export default function RelationsSchema({ module, softwareFeed = {} }) {
  const navigate = useNavigate();
  const [show, setShow] = useState({ software: true, ftd: true, cots: true });
  const [q, setQ] = useState('');

  const all = useMemo(() => {
    const sw = (module.softwares || []).map((s) => ({
      key: `sw:${s.name}`,
      kind: 'software',
      label: s.name,
      sub: s.fromVersion ? t('from {v}', { v: s.fromVersion }) : '',
      title: `${s.name}${s.fromVersion ? ` — ${t('from {v}', { v: s.fromVersion })}` : ''}${
        (softwareFeed[s.name] || []).length ? ` · ${plural((softwareFeed[s.name] || []).length, 'release')}` : ''
      }`,
      to: '/software',
    }));
    const hw = (module.hardwareItems || []).map((h) => ({
      key: `hw:${h.id || h.name}`,
      kind: h.type === 'ftd' ? 'ftd' : 'cots',
      label: h.name,
      sub: h.type === 'ftd' ? h.version || 'v1' : [h.manufacturer, h.model].filter(Boolean).join(' '),
      title: `${h.name} — ${h.type === 'ftd' ? `FTD.aero ${h.version || 'v1'}` : `COTS ${[h.manufacturer, h.model].filter(Boolean).join(' ')}`}${h.notes ? `\n${h.notes}` : ''}`,
      to: `/modules/${module.slug}?tab=hardware`,
    }));
    return [...sw, ...hw];
  }, [module, softwareFeed]);

  const counts = {
    software: all.filter((n) => n.kind === 'software').length,
    ftd: all.filter((n) => n.kind === 'ftd').length,
    cots: all.filter((n) => n.kind === 'cots').length,
  };

  const needle = q.trim().toLowerCase();
  const visible = all.filter(
    (n) => show[n.kind] && (!needle || `${n.label} ${n.sub}`.toLowerCase().includes(needle))
  );
  const placed = useMemo(() => rings(visible), [visible.map((n) => n.key).join('|')]);

  const reach = placed.reduce((m, n) => Math.max(m, Math.hypot(n.x, n.y)), RING_0);
  const half = reach + NODE_W / 2 + 12;
  const toggle = (k) => setShow((s) => ({ ...s, [k]: !s[k] }));

  /* Viewport: zoom is a scale on the viewBox, pan an offset in diagram units. Both are held
     here rather than on the SVG element so the filters can reset them when the diagram
     changes size under the user. */
  const [view, setView] = useState({ z: 1, x: 0, y: 0 });
  const svgRef = useRef(null);
  const drag = useRef(null);
  const moved = useRef(false); // a drag that moved must not click the node it ended on
  const [dragging, setDragging] = useState(false);
  const reset = useCallback(() => setView({ z: 1, x: 0, y: 0 }), []);
  useEffect(reset, [show.software, show.ftd, show.cots, needle, reset]);

  const zoomBy = (factor, at) =>
    setView((v) => {
      const z = clamp(v.z * factor, MIN_Z, MAX_Z);
      if (z === v.z) return v;
      if (!at) return { ...v, z };
      // Keep the point under the cursor still: the view centre moves toward it by the
      // fraction of the span that the zoom removes.
      const k = 1 - v.z / z;
      return { z, x: v.x + (at.x - v.x) * k, y: v.y + (at.y - v.y) * k };
    });

  /* A wheel over the canvas zooms; the listener is attached by hand because React's onWheel
     is passive and so cannot preventDefault the page scroll. */
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, pointIn(el, e, view, half));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [view, half]);

  function onPointerDown(e) {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, view };
    moved.current = false;
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e) {
    const d = drag.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.x) > 3 || Math.abs(e.clientY - d.y) > 3) moved.current = true;
    const box = svgRef.current.getBoundingClientRect();
    // Screen pixels → diagram units: the viewBox spans 2*half/z across the element's width.
    const unitsPerPx = (2 * half) / d.view.z / box.width;
    setView({ ...d.view, x: d.view.x - (e.clientX - d.x) * unitsPerPx, y: d.view.y - (e.clientY - d.y) * unitsPerPx });
  }
  function endDrag(e) {
    if (drag.current && e.pointerId !== undefined && e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    drag.current = null;
    setDragging(false);
  }

  const span = (2 * half) / view.z;
  const viewBox = `${view.x - span / 2} ${view.y - span / 2} ${span} ${span}`;

  const FILTERS = [
    ['software', t('Software')],
    ['ftd', t('FTD.aero parts')],
    ['cots', t('Bought-in parts')],
  ];

  return (
    <div className="schema">
      <div className="schema-bar">
        {FILTERS.map(([k, label]) => (
          <button
            key={k}
            className={`chip chip-filter${show[k] ? ' on' : ''}`}
            disabled={!counts[k]}
            onClick={() => toggle(k)}
            aria-pressed={show[k]}
          >
            <span className={`dot dot-${k}`} /> {label} <span className="muted">{counts[k]}</span>
          </button>
        ))}
        <input
          className="schema-search"
          value={q}
          placeholder={t('Filter by name…')}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="hint">
          {visible.length === all.length
            ? t('{n} linked', { n: all.length })
            : t('{n} of {total} linked', { n: visible.length, total: all.length })}
        </span>
      </div>

      {!all.length ? (
        <div className="empty">
          <p>{t('This module has no software or parts linked yet.')}</p>
        </div>
      ) : (
        <div className="schema-canvas">
          <div className="schema-zoom">
            <button className="btn btn-sm" title={t('Zoom out')} onClick={() => zoomBy(1 / 1.25)} disabled={view.z <= MIN_Z}>−</button>
            <span className="muted small">{Math.round(view.z * 100)}%</span>
            <button className="btn btn-sm" title={t('Zoom in')} onClick={() => zoomBy(1.25)} disabled={view.z >= MAX_Z}>+</button>
            <button className="btn btn-sm" title={t('Fit the diagram back in view')} onClick={reset}>{t('Reset')}</button>
          </div>
          <svg
            ref={svgRef}
            className={dragging ? 'dragging' : ''}
            viewBox={viewBox}
            role="img"
            aria-label={t('Relations diagram — drag to move, scroll to zoom')}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <g className="schema-edges">
              {placed.map((n) => (
                <line key={n.key} x1="0" y1="0" x2={n.x} y2={n.y} />
              ))}
            </g>

            {placed.map((n) => (
              <g
                key={n.key}
                className={`schema-node node-${n.kind}`}
                transform={`translate(${n.x - NODE_W / 2} ${n.y - NODE_H / 2})`}
                onClick={() => !moved.current && navigate(n.to)}
                role="link"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && navigate(n.to)}
              >
                <title>{n.title}</title>
                <rect width={NODE_W} height={NODE_H} rx="7" />
                <text x={NODE_W / 2} y={n.sub ? 14 : 17}>{cut(n.label)}</text>
                {n.sub && (
                  <text className="sub" x={NODE_W / 2} y={26}>
                    {cut(n.sub, 22)}
                  </text>
                )}
              </g>
            ))}

            <g className="schema-node node-module" transform={`translate(${-NODE_W / 2 - 16} ${-NODE_H / 2 - 9})`}>
              <rect width={NODE_W + 32} height={NODE_H + 18} rx="9" />
              <text x={(NODE_W + 32) / 2} y="21">{cut(module.name, 22)}</text>
              <text className="sub" x={(NODE_W + 32) / 2} y="38">
                {[module.code, module.group].filter(Boolean).join(' · ')}
              </text>
            </g>
          </svg>
        </div>
      )}
    </div>
  );
}
