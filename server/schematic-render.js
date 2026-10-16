/**
 * The drawing of a schematic: elk lays the netlist out (devices and blocks inside location frames,
 * ports on the declared side), and the SVG is written by hand so the export never needs a browser.
 * Verdana, black lines; cable kinds differ by dash pattern as well as colour so a monochrome print
 * still reads. Positions an author moved by hand (`layout.manual`) are kept.
 */
import ELK from 'elkjs/lib/elk.bundled.js';
import { cableSchedule, connectorFace, portsOf } from './schematic.js';
import { templateFor, cableFor, connectorFor, DEFAULT_LIBRARY } from './library.js';

export const NODE_W = 160;
export const PORT_PITCH = 14;
export const FRAME_PAD = 24;
const HEAD_H = 22;
const STUB = 10;
const FONT = 'Verdana, Geneva, sans-serif';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** English fallbacks; docgen's STRINGS override these once Task 9 adds the keys. */
const WORDS = {
  en: { cable: 'Cable', kind: 'Kind', from: 'From', port: 'Port', to: 'To', length: 'Length', notes: 'Notes', connector: 'Connector', inside: 'Inside', externalPorts: 'External ports', m: 'm', block: 'module' },
  pl: { cable: 'Kabel', kind: 'Rodzaj', from: 'Z', port: 'Port', to: 'Do', length: 'Długość', notes: 'Uwagi', connector: 'Złącze', inside: 'Wewnątrz', externalPorts: 'Porty zewnętrzne', m: 'm', block: 'moduł' },
};
const words = (lang) => WORDS[lang] || WORDS.en;

/* ---- node geometry ---- */

/** The ports a node shows, by side. A block shows its module's connector face. */
function nodePorts(state, node, ctx) {
  const ports = portsOf(state, node.block ? { block: node.id } : { device: node.id }, ctx) || [];
  const by = { left: [], right: [], top: [], bottom: [] };
  // a block shows its module's connector face, which has no sides of its own: all on the left
  for (const p of ports) (node.block ? by.left : by[p.side] || by.right).push(p);
  return by;
}

function nodeSize(by) {
  const rows = Math.max(by.left.length, by.right.length, 1);
  const cols = Math.max(by.top.length, by.bottom.length, 0);
  return { w: Math.max(NODE_W, cols * PORT_PITCH + 40), h: HEAD_H + rows * PORT_PITCH + 10 };
}

/** Where a port's stub ends, in node-local coordinates. */
function portPoint(by, size, portId) {
  for (const side of ['left', 'right', 'top', 'bottom']) {
    const i = by[side].findIndex((p) => p.id === portId);
    if (i < 0) continue;
    if (side === 'left') return { x: 0, y: HEAD_H + 7 + i * PORT_PITCH, side };
    if (side === 'right') return { x: size.w, y: HEAD_H + 7 + i * PORT_PITCH, side };
    if (side === 'top') return { x: 20 + i * PORT_PITCH, y: 0, side };
    return { x: 20 + i * PORT_PITCH, y: size.h, side };
  }
  return { x: size.w / 2, y: size.h / 2, side: 'right' };
}

const nodesOf = (state) => [...state.devices.map((d) => ({ ...d, kind: 'device' })), ...state.blocks.map((b) => ({ ...b, id: b.id, block: true, kind: 'block', label: null }))];
const endNode = (e) => e.block || e.device;

export async function layoutSchematic(state, ctx) {
  const elk = new ELK();
  const nodes = nodesOf(state);
  const meta = new Map(nodes.map((n) => {
    const by = nodePorts(state, n, ctx);
    return [n.id, { by, size: nodeSize(by) }];
  }));
  const manual = new Set(state.layout?.manual || []);
  const childOf = (n) => {
    const { size } = meta.get(n.id);
    const fixed = manual.has(n.id) && state.layout.nodes[n.id];
    return { id: n.id, width: size.w, height: size.h, ...(fixed ? { x: fixed.x, y: fixed.y, layoutOptions: { 'elk.position': `(${fixed.x},${fixed.y})` } } : {}) };
  };
  // racks first, areas after; the frames sit far enough apart that a cable between two racks reads as leaving one
  const ordered = [...state.locations].sort((a, b) => (a.kind === 'rack' ? 0 : 1) - (b.kind === 'rack' ? 0 : 1));
  const frames = ordered.map((l) => {
    const children = nodes.filter((n) => n.location === l.id).map(childOf);
    return {
      id: l.id,
      layoutOptions: { 'elk.padding': `[top=${FRAME_PAD + 14},left=${FRAME_PAD},bottom=${FRAME_PAD},right=${FRAME_PAD}]`, 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.margins': '[top=40,left=60,bottom=40,right=60]' },
      children,
      // an empty location is still a place on the drawing, not a dot
      ...(children.length ? {} : { width: 160, height: 60 }),
    };
  });
  const loose = nodes.filter((n) => !n.location || !state.locations.some((l) => l.id === n.location)).map(childOf);
  const graph = {
    id: 'root',
    layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.spacing.nodeNode': '30', 'elk.layered.spacing.nodeNodeBetweenLayers': '60', 'elk.hierarchyHandling': 'INCLUDE_CHILDREN', 'elk.spacing.componentComponent': '160' },
    children: [...frames, ...loose],
    edges: state.cables.map((c) => ({ id: c.id, sources: [endNode(c.from)], targets: [endNode(c.to)] })),
  };
  const out = await elk.layout(graph);
  const abs = { nodes: {}, frames: {}, edges: {} };
  const walk = (n, ox, oy, isFrame) => {
    const x = ox + (n.x || 0);
    const y = oy + (n.y || 0);
    (isFrame ? abs.frames : abs.nodes)[n.id] = { x, y, w: n.width || 0, h: n.height || 0 };
    for (const c of n.children || []) walk(c, x, y, false);
  };
  for (const c of out.children || []) walk(c, 0, 0, state.locations.some((l) => l.id === c.id));
  // a manual position is absolute: overwrite what elk did with it
  for (const id of manual) if (state.layout.nodes[id] && abs.nodes[id]) Object.assign(abs.nodes[id], state.layout.nodes[id]);
  // cables go port to port: straight stubs out of each port, then an orthogonal dog-leg
  for (const c of state.cables) {
    const a = portAbs(state, abs, meta, c.from);
    const b = portAbs(state, abs, meta, c.to);
    if (!a || !b) continue;
    const a2 = { x: a.x + (a.side === 'left' ? -STUB : a.side === 'right' ? STUB : 0), y: a.y + (a.side === 'top' ? -STUB : a.side === 'bottom' ? STUB : 0) };
    const b2 = { x: b.x + (b.side === 'left' ? -STUB : b.side === 'right' ? STUB : 0), y: b.y + (b.side === 'top' ? -STUB : b.side === 'bottom' ? STUB : 0) };
    const midX = (a2.x + b2.x) / 2;
    abs.edges[c.id] = [a, a2, { x: midX, y: a2.y }, { x: midX, y: b2.y }, b2, b];
  }
  const all = [...Object.values(abs.nodes), ...Object.values(abs.frames)];
  return { ...abs, width: Math.max(out.width || 0, ...all.map((n) => n.x + n.w)) + 20, height: Math.max(out.height || 0, ...all.map((n) => n.y + n.h)) + 20 };
}

function portAbs(state, abs, meta, end) {
  const id = endNode(end);
  const n = abs.nodes[id];
  const m = meta.get(id);
  if (!n || !m) return null;
  const p = portPoint(m.by, m.size, end.port);
  return { x: n.x + p.x, y: n.y + p.y, side: p.side };
}

/* ---- SVG ---- */

export async function renderSvg(state, ctx, { lang = 'en', title = '' } = {}) {
  const W = words(lang);
  const l = await layoutSchematic(state, ctx);
  const nodes = nodesOf(state);
  const parts = [];
  for (const loc of state.locations) {
    const f = l.frames[loc.id];
    if (!f) continue;
    const rack = loc.kind === 'rack';
    parts.push(`<g class="sch-frame sch-frame-${esc(loc.kind)}" data-id="${esc(loc.id)}"><rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" rx="8" fill="${rack ? '#f7f7f7' : 'none'}" stroke="#000" stroke-width="${rack ? 1.6 : 0.8}" stroke-dasharray="${rack ? '' : '4 3'}"/><text x="${f.x + 10}" y="${f.y + 17}" font-size="${rack ? 13 : 11}" font-weight="bold">${esc(loc.label)}</text></g>`);
  }
  for (const n of nodes) {
    const box = l.nodes[n.id];
    if (!box) continue;
    const by = nodePorts(state, n, ctx);
    const size = { w: box.w, h: box.h };
    const label = n.block ? ctx.modules.find((m) => m.slug === n.module)?.name || n.module : n.label;
    const sub = n.block ? `${W.block} · ${n.schematic?.version || ''}` : templateFor(ctx.library, n.template)?.model || '';
    const ports = ['left', 'right', 'top', 'bottom'].flatMap((side) =>
      by[side].map((p) => {
        const pt = portPoint(by, size, p.id);
        const col = connectorFor(ctx.library, p.connector)?.color || '#000';
        const x2 = pt.x + (side === 'left' ? -STUB : side === 'right' ? STUB : 0);
        const y2 = pt.y + (side === 'top' ? -STUB : side === 'bottom' ? STUB : 0);
        const tx = side === 'left' ? pt.x + 4 : side === 'right' ? pt.x - 4 : pt.x;
        const anchor = side === 'left' ? 'start' : side === 'right' ? 'end' : 'middle';
        return `<g class="sch-port" data-port="${esc(p.id)}"><circle class="sch-port-hit" cx="${box.x + x2}" cy="${box.y + y2}" r="7" fill="transparent"/><line x1="${box.x + pt.x}" y1="${box.y + pt.y}" x2="${box.x + x2}" y2="${box.y + y2}" stroke="${col}" stroke-width="1.5"/><text x="${box.x + tx}" y="${box.y + pt.y + 3}" font-size="7" text-anchor="${anchor}">${esc(p.label)}</text></g>`;
      })
    );
    parts.push(`<g class="sch-${n.block ? 'block' : 'device'}" data-id="${esc(n.id)}"><rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="#fff" stroke="#000" stroke-width="${n.block ? 1.6 : 1}"/><text x="${box.x + box.w / 2}" y="${box.y + 13}" font-size="9" font-weight="bold" text-anchor="middle">${esc(label)}</text>${sub ? `<text x="${box.x + box.w / 2}" y="${box.y + HEAD_H - 2}" font-size="6.5" text-anchor="middle" fill="#444">${esc(sub)}</text>` : ''}${ports.join('')}</g>`);
  }
  for (const c of state.cables) {
    const pts = l.edges[c.id];
    if (!pts) continue;
    const kind = cableFor(ctx.library, c.kind);
    const st = kind?.style || {};
    const mid = pts[Math.floor(pts.length / 2)];
    parts.push(`<g class="sch-cable sch-cable-${esc(c.kind)}" data-id="${esc(c.id)}"><polyline points="${pts.map((p) => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="${st.color || '#000'}" stroke-width="${st.width || 1.2}"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''}/>${c.label ? `<text x="${mid.x + 3}" y="${mid.y - 3}" font-size="7" fill="#000">${esc(c.label)}</text>` : ''}</g>`);
  }
  // a module's connector face: its external ports as a column on the left edge
  if (state.kind === 'module' && state.externalPorts.length) {
    const face = connectorFace(state, ctx);
    face.forEach((p, i) => {
      const y = 30 + i * 18;
      parts.push(`<g class="sch-external" data-id="${esc(p.id)}"><rect x="4" y="${y - 9}" width="90" height="14" fill="#f3f3f3" stroke="#000" stroke-width="0.6"/><text x="8" y="${y + 1}" font-size="7">${esc(p.label)}${p.connector ? ` (${esc(connectorFor(ctx.library, p.connector)?.label || p.connector)})` : ''}</text></g>`);
    });
  }
  const width = Math.max(l.width, 300);
  const height = Math.max(l.height, 120, state.kind === 'module' ? 40 + state.externalPorts.length * 18 : 0);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="${FONT}" class="schematic" role="img"${title ? ` aria-label="${esc(title)}"` : ''}>${title ? `<title>${esc(title)}</title>` : ''}<rect width="${width}" height="${height}" fill="#fff"/>${parts.join('')}</svg>`;
}

/* ---- tables ---- */

const fmtLen = (n, W) => (n === null || n === undefined ? '' : `${n} ${W.m}`);

export function scheduleHtml(schedule, lang = 'en') {
  const W = words(lang);
  const rows = schedule.map((r) => `<tr><td>${esc(r.label || r.id)}</td><td>${esc(r.kindLabel)}</td><td>${esc(r.from)}</td><td>${esc(r.fromPort)}</td><td>${esc(r.to)}</td><td>${esc(r.toPort)}</td><td>${fmtLen(r.length, W)}</td></tr>`).join('\n');
  return `<table class="cable-schedule">\n<thead><tr><th>${W.cable}</th><th>${W.kind}</th><th>${W.from}</th><th>${W.port}</th><th>${W.to}</th><th>${W.port}</th><th>${W.length}</th></tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table>`;
}

export function faceHtml(face, lang = 'en', library = null) {
  const W = words(lang);
  const rows = face.map((p) => `<tr><td>${esc(p.label)}</td><td>${esc((library && connectorFor(library, p.connector)?.label) || CONNECTOR_LABELS[p.connector] || p.connector || '—')}</td><td>${esc(p.device)} · ${esc(p.port)}</td></tr>`).join('\n');
  return `<table class="port-list">\n<thead><tr><th>${W.port}</th><th>${W.connector}</th><th>${W.inside}</th></tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table>`;
}
const CONNECTOR_LABELS = Object.fromEntries(DEFAULT_LIBRARY.connectors.map((c) => [c.id, c.label]));

export function schematicCsv(schedule) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = 'label,kind,from,from_port,to,to_port,length_m,notes';
  return [head, ...schedule.map((r) => [r.label || r.id, r.kindLabel, r.from, r.fromPort, r.to, r.toPort, r.length ?? '', r.notes].map(cell).join(','))].join('\n');
}
