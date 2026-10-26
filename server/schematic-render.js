/**
 * The drawing of a schematic: elk lays the netlist out (devices and blocks inside location frames,
 * ports on the declared side), and the SVG is written by hand so the export never needs a browser.
 * Verdana, black lines; cable kinds differ by dash pattern as well as colour so a monochrome print
 * still reads. Positions an author moved by hand (`layout.manual`) are kept.
 */
import ELK from 'elkjs/lib/elk.bundled.js';
import { cableSchedule, connectorFace, portsOf } from './schematic.js';
import { templateFor, cableFor, connectorFor, connectorSymbolOf, isProtectiveSymbol, DEFAULT_LIBRARY } from './library.js';

export const NODE_W = 160;
export const PORT_PITCH = 14;
export const FRAME_PAD = 24;
const HEAD_H = 22;
const POLE_PITCH = 16; // between the poles of a protective device
const PROT_MIN_H = 84; // a pole with its symbol and the information stack beside it
const INFO_PITCH = 9;
const LAMP_BAR = 14; // the lamps' common return bar sits this far above the bottom edge
const STUB = 12;
const FONT = 'Verdana, Geneva, sans-serif';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** English fallbacks; docgen's STRINGS override these once Task 9 adds the keys. */
const WORDS = {
  en: {
    cable: 'Cable', kind: 'Kind', type: 'Type', colour: 'Colour', from: 'From', port: 'Port', to: 'To', length: 'Length', notes: 'Notes', connector: 'Connector', inside: 'Inside', externalPorts: 'External ports', m: 'm', block: 'module',
    symSocket: 'Socket (female)', symPlug: 'Plug (male)', symMate: 'Plug and socket', symTerminal: 'Terminal', symPe: 'Protective earth', symCores: 'n conductors', symScreen: 'Screened', symMcb: 'Circuit breaker', symSwitchDisc: 'Switch disconnector', symFuse: 'Fuse', symLamp: 'Indicator lamp', symbols: 'Graphical symbols per PN-EN 60617 (IEC 60617)',
  },
  pl: {
    cable: 'Kabel', kind: 'Rodzaj', type: 'Typ', colour: 'Kolor', from: 'Z', port: 'Port', to: 'Do', length: 'Długość', notes: 'Uwagi', connector: 'Złącze', inside: 'Wewnątrz', externalPorts: 'Porty zewnętrzne', m: 'm', block: 'moduł',
    symSocket: 'Gniazdo (żeńskie)', symPlug: 'Wtyk (męski)', symMate: 'Wtyk i gniazdo', symTerminal: 'Zacisk', symPe: 'Uziemienie ochronne', symCores: 'n żył', symScreen: 'Ekranowany', symMcb: 'Wyłącznik nadprądowy', symSwitchDisc: 'Rozłącznik izolacyjny', symFuse: 'Bezpiecznik', symLamp: 'Lampka sygnalizacyjna', symbols: 'Symbole graficzne wg PN-EN 60617 (IEC 60617)',
  },
};
const words = (lang) => WORDS[lang] || WORDS.en;

/* ---- node geometry ---- */

/** The ports a node shows, by side. A block shows its module's connector face. */
function nodePorts(state, node, ctx) {
  const ports = portsOf(state, node.block ? { block: node.id } : { device: node.id }, ctx) || [];
  const by = { left: [], right: [], top: [], bottom: [] };
  const prot = node.block ? null : protectiveOf(state, node, ctx);
  if (prot) {
    // a protective device stands upright: supply at the top, load at the bottom, whatever side the template says
    for (const p of ports) (p.direction === 'out' ? by.bottom : by.top).push(p);
    if (!by.bottom.length && by.top.length > 1) by.bottom.push(by.top.pop());
    by.prot = prot;
    return by;
  }
  // a block shows its module's connector face, which has no sides of its own: all on the left
  for (const p of ports) (node.block ? by.left : by[p.side] || by.right).push(p);
  return by;
}

/**
 * A device whose template is a protective device (`mcb`, `switch-disconnector`, `fuse`): what the drawing
 * says beside its symbol, the way a schematic sheet does — the tag on its own line, then the rest of the
 * label (function text), the rating, maker, part number, type and location.
 */
function protectiveOf(state, node, ctx) {
  const tpl = templateFor(ctx.library, node.template);
  if (!tpl || !isProtectiveSymbol(tpl.symbol)) return null;
  const label = String(node.label || '');
  const m = label.match(/^(\S+)\s+([\s\S]*)$/);
  const tag = m ? m[1] : label;
  const location = state.locations.find((l) => l.id === node.location)?.label || '';
  const lines = [m ? m[2] : '', tpl.rating, tpl.manufacturer, tpl.model, tpl.name, location].map((x) => String(x || '').trim()).filter(Boolean);
  // the poles stand right of the information stack: its width decides where the first pole is
  const infoW = Math.max(tag.length * 9 * 0.62, ...lines.map((t) => textWidth(t)));
  return { symbol: tpl.symbol, poles: Math.max(1, Number(tpl.poles) || 1), tag, lines, x0: Math.ceil(6 + infoW + 16) };
}

/** What a port is called on the drawing: the detail in brackets goes (the card and tooltip keep it). */
export function shortPortLabel(label) {
  const s = String(label || '');
  if (s.length <= 22) return s;
  const bare = s.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  return bare.length <= 26 ? bare : `${bare.slice(0, 25)}…`;
}
const PORT_FONT = 7;
const textWidth = (s) => String(s || '').length * PORT_FONT * 0.6; // Verdana is wide: ~0.6 em per character

/** A symbol is as wide as its port labels need: the longest on the left plus the longest on the right. */
function nodeSize(by) {
  if (by.prot) return protectiveSize(by);
  const rows = Math.max(by.left.length, by.right.length, 1);
  const cols = Math.max(by.top.length, by.bottom.length, 0);
  const widest = (ports) => Math.max(0, ...ports.map((p) => textWidth(shortPortLabel(p.label))));
  const labels = widest(by.left) + widest(by.right) + (by.left.length && by.right.length ? 28 : 16);
  return { w: Math.max(NODE_W, cols * PORT_PITCH + 40, Math.ceil(labels)), h: HEAD_H + rows * PORT_PITCH + 10 };
}

/** The information stack on the left, the poles to its right, the terminal numbers after the last pole. */
function protectiveSize(by) {
  const { prot } = by;
  const termW = Math.max(0, ...[...by.top, ...by.bottom].map((p) => textWidth(shortPortLabel(p.label))));
  const poles = Math.max(prot.poles, 1);
  return { w: Math.ceil(prot.x0 + (poles - 1) * POLE_PITCH + 10 + termW + 8), h: Math.max(PROT_MIN_H, 14 + (prot.lines.length + 1) * INFO_PITCH + 6) };
}

/** The x of the i-th port on one edge of a protective device: one per pole, extra wires beside the last pole. */
function polePortX(prot, i, side = 'top') {
  const poles = Math.max(prot.poles, 1);
  // a lamp's return leaves the common bar under the middle lamp
  if (side === 'bottom' && prot.symbol === 'lamp') return prot.x0 + Math.floor((poles - 1) / 2) * POLE_PITCH + i * 6;
  return i < poles ? prot.x0 + i * POLE_PITCH : prot.x0 + (poles - 1) * POLE_PITCH + (i - poles + 1) * 6;
}

/** Where a port's stub ends, in node-local coordinates. */
function portPoint(by, size, portId) {
  if (by.prot) {
    const t = by.top.findIndex((p) => p.id === portId);
    if (t >= 0) return { x: polePortX(by.prot, t), y: 0, side: 'top' };
    const b = by.bottom.findIndex((p) => p.id === portId);
    if (b >= 0) return { x: polePortX(by.prot, b, 'bottom'), y: size.h, side: 'bottom' };
  }
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
  const manualPos = (id) => (manual.has(id) && state.layout.nodes[id]) || null;
  // the order a rack reads in: the device mounted highest comes first, devices with no U after them,
  // and a hand-moved node sits where it was put — elk keeps that order among nodes of one layer
  const rankOf = (n) => {
    const m = manualPos(n.id);
    if (m) return m.y;
    const u = n.rack?.u;
    return Number.isFinite(u) && u > 0 ? 100000 - u * 10 : 200000;
  };
  const childOf = (n) => {
    const { size } = meta.get(n.id);
    return { id: n.id, width: size.w, height: size.h, layoutOptions: { 'elk.position': `(0,${rankOf(n)})` } };
  };
  // racks first, areas after; the frames sit far enough apart that a cable between two racks reads as leaving one
  const ordered = [...state.locations].sort((a, b) => (a.kind === 'rack' ? 0 : 1) - (b.kind === 'rack' ? 0 : 1));
  const frames = ordered.map((l) => {
    const children = nodes.filter((n) => n.location === l.id).sort((a, b) => rankOf(a) - rankOf(b)).map(childOf);
    return {
      id: l.id,
      layoutOptions: { 'elk.padding': `[top=${FRAME_PAD + 14},left=${FRAME_PAD},bottom=${FRAME_PAD},right=${FRAME_PAD}]`, 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.margins': '[top=40,left=60,bottom=40,right=60]', 'elk.layered.crossingMinimization.semiInteractive': 'true' },
      children,
      // an empty location is still a place on the drawing, not a dot
      ...(children.length ? {} : { width: 160, height: 60 }),
    };
  });
  const framed = (n) => n.location && state.locations.some((l) => l.id === n.location);
  const loose = nodes.filter((n) => !framed(n)).map(childOf);
  const graph = {
    id: 'root',
    layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.spacing.nodeNode': '30', 'elk.layered.spacing.nodeNodeBetweenLayers': '60', 'elk.hierarchyHandling': 'INCLUDE_CHILDREN', 'elk.spacing.componentComponent': '160', 'elk.layered.crossingMinimization.semiInteractive': 'true' },
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
  // a hand-moved node goes where it was put: measured from its location frame (so the offset holds in
  // the whole drawing and in a one-rack view alike), or from the page when it has no location — and
  // the frame grows to keep it inside
  for (const n of nodes) {
    const m = manualPos(n.id);
    const box = abs.nodes[n.id];
    if (!m || !box) continue;
    const f = framed(n) ? abs.frames[n.location] : null;
    box.x = (f ? f.x : 0) + m.x;
    box.y = (f ? f.y : 0) + m.y;
    if (!f) continue;
    const x0 = Math.min(f.x, box.x - FRAME_PAD);
    const y0 = Math.min(f.y, box.y - FRAME_PAD - 14);
    const x1 = Math.max(f.x + f.w, box.x + box.w + FRAME_PAD);
    const y1 = Math.max(f.y + f.h, box.y + box.h + FRAME_PAD);
    Object.assign(f, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
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

/* ---- IEC 60617 symbols ---- */

const DIR = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } };
const r1 = (n) => Math.round(n * 10) / 10;

/**
 * The contact symbol at the end of a port stub, after IEC 60617: `e` is the stub's end, `side` which
 * way it points (out of the node). Female contact = open semicircle, its back towards the device;
 * male = solid bar along the line; terminal = small circle; pe = the earth symbol. A connected
 * socket gets the plug's bar inside its arc, a connected plug the arc around its bar — the standard's
 * "plug and socket" — so a free port and a used one read differently at a glance.
 */
export function contactSymbol(symbol, e, side, color, { mated = false } = {}) {
  const u = DIR[side] || DIR.right; // outward
  const v = { x: -u.y, y: u.x }; // across
  const at = (du, dv) => `${r1(e.x + u.x * du + v.x * dv)},${r1(e.y + u.y * du + v.y * dv)}`;
  // a semicircle centred `du` out along the stub; it opens outward (its back to the device) unless `inward`
  const arc = (du, r, inward = false) => `<path d="M${at(du, r)} A${r} ${r} 0 0 ${inward ? 0 : 1} ${at(du, -r)}" fill="none" stroke="${color}" stroke-width="1.2"/>`;
  const bar = (du) => `<line x1="${at(du - 3, 0).replace(',', '" y1="')}" x2="${at(du + 3, 0).replace(',', '" y2="')}" stroke="${color}" stroke-width="2.8"/>`;
  const cls = `sch-sym sch-sym-${symbol}${mated ? ' sch-sym-mate' : ''}`;
  // a plug's mate is the cable's socket: it comes from the cable side, so its back faces the cable and its bowl takes the bar's tip
  if (symbol === 'plug') return `<g class="${cls}">${bar(0)}${mated ? arc(1.5, 3.4, true) : ''}</g>`;
  if (symbol === 'terminal') return `<g class="${cls}"><circle cx="${at(0, 0).replace(',', '" cy="')}" r="2" fill="none" stroke="${color}" stroke-width="1"/></g>`;
  if (symbol === 'pe') {
    const bars = [[0, 4.5], [2, 3], [4, 1.5]].map(([du, h]) => `<line x1="${at(du, h).replace(',', '" y1="')}" x2="${at(du, -h).replace(',', '" y2="')}" stroke="${color}" stroke-width="1.1"/>`).join('');
    return `<g class="${cls}">${bars}</g>`;
  }
  return `<g class="${cls}">${arc(0, 3)}${mated ? bar(1.5) : ''}</g>`;
}

/** The longest straight run of a cable's polyline, skipping the two stubs, and a point a fraction along it. */
function cableRun(pts) {
  let best = null;
  for (let i = 1; i < pts.length - 2; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!best || len > best.len) best = { a, b, len, vertical: Math.abs(b.x - a.x) < Math.abs(b.y - a.y) };
  }
  if (!best) return null;
  best.at = (f) => ({ x: best.a.x + (best.b.x - best.a.x) * f, y: best.a.y + (best.b.y - best.a.y) * f });
  return best;
}

/** The marks a cable kind puts on its line: the oblique stroke with the conductor count, the screen oval. */
export function cableMarks(pts, kind, color) {
  const run = cableRun(pts);
  if (!run || run.len < 24) return '';
  const out = [];
  if (kind?.cores) {
    const m = run.at(0.35);
    out.push(`<g class="sch-cores"><line x1="${r1(m.x - 4)}" y1="${r1(m.y + 4)}" x2="${r1(m.x + 4)}" y2="${r1(m.y - 4)}" stroke="${color}" stroke-width="1"/><text x="${r1(m.x + (run.vertical ? 5 : 3))}" y="${r1(m.y - (run.vertical ? 2 : 5))}" font-size="6" fill="${color}">${kind.cores}</text></g>`);
  }
  if (kind?.screened) {
    const m = run.at(kind.cores ? 0.65 : 0.5);
    out.push(`<ellipse class="sch-screen" cx="${r1(m.x)}" cy="${r1(m.y)}" rx="${run.vertical ? 3 : 6}" ry="${run.vertical ? 6 : 3}" fill="none" stroke="${color}" stroke-width="0.8"/>`);
  }
  return out.join('');
}

/**
 * One pole of a protective device after IEC 60617, upright between (x, 0) and (x, h) in node-local
 * coordinates — the make contact (07-02-01) with: for `mcb` the circuit-breaker cross at the fixed contact
 * (07-13-05) and the thermal and electromagnetic releases (07-15-xx) that work it; for
 * `switch-disconnector` the isolating bar at the free end and the load-switch circle at the pivot
 * (07-13-08); for `fuse` the fuse rectangle on the conductor (07-21-01).
 */
export function poleSymbol(symbol, x, h, color = '#000') {
  const c = h / 2;
  const L = (x1, y1, x2, y2, cls = '') => `<line${cls ? ` class="${cls}"` : ''} x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.2"/>`;
  if (symbol === 'fuse') {
    return `<g class="sch-pole">${L(x, 0, x, h)}<rect class="sch-fuse" x="${x - 4}" y="${c - 12}" width="8" height="24" fill="#fff" stroke="${color}" stroke-width="1.2"/></g>`;
  }
  if (symbol === 'lamp') {
    // the signal lamp: a circle with the cross through it; the pole ends on the common bar at LAMP_BAR above the bottom edge
    const r = 6;
    const k = r * Math.SQRT1_2;
    return `<g class="sch-pole">${L(x, 0, x, c - r)}${L(x, c + r, x, h - LAMP_BAR)}<g class="sch-lamp"><circle cx="${x}" cy="${c}" r="${r}" fill="#fff" stroke="${color}" stroke-width="1.2"/>${L(x - k, c - k, x + k, c + k)}${L(x - k, c + k, x + k, c - k)}</g></g>`;
  }
  const parts = [L(x, 0, x, c - 12), L(x, c + 10, x, h), L(x, c + 10, x - 8, c - 16, 'sch-blade')];
  if (symbol === 'mcb') {
    // 07-13-05: the cross marks the end of the fixed contact — the upper line, where the blade meets it when closed
    parts.push(`<g class="sch-contact-x">${L(x - 3, c - 15, x + 3, c - 9)}${L(x - 3, c - 9, x + 3, c - 15)}</g>`);
    parts.push(`<path class="sch-release-thermal" d="M${x - 11},${c - 13} h-6 v9 h6" fill="none" stroke="${color}" stroke-width="1.1"/>`);
    parts.push(`<g class="sch-release-magnetic">${L(x - 11, c + 1, x - 22, c + 8)}<polygon points="${x - 23},${c + 8.6} ${x - 17.5},${c + 8.2} ${x - 19.5},${c + 3.8}" fill="${color}"/></g>`);
  } else if (symbol === 'switch-disconnector') {
    parts.push(L(x - 4, c - 12, x + 4, c - 12, 'sch-isolator-bar'));
    parts.push(`<circle class="sch-load-switch" cx="${x}" cy="${c + 10}" r="2.4" fill="#fff" stroke="${color}" stroke-width="1.1"/>`);
  }
  return `<g class="sch-pole">${parts.join('')}</g>`;
}

/** The legend under the drawing: only the symbols it uses, and the standard they follow. */
function legendSvg(used, y, W) {
  const items = [];
  const pole = (sym) => (x) => `<g transform="translate(${x + 8},${y - 2}) scale(0.5)">${poleSymbol(sym, 24, 48)}</g>`;
  if (used.mcb) items.push({ id: 'mcb', w: 86, draw: pole('mcb'), text: W.symMcb });
  if (used['switch-disconnector']) items.push({ id: 'switch-disconnector', w: 104, draw: pole('switch-disconnector'), text: W.symSwitchDisc });
  if (used.fuse) items.push({ id: 'fuse', w: 56, draw: pole('fuse'), text: W.symFuse });
  if (used.lamp) items.push({ id: 'lamp', w: 80, draw: pole('lamp'), text: W.symLamp });
  const line = (x) => `<line x1="${x}" y1="${y + 10}" x2="${x + 14}" y2="${y + 10}" stroke="#000" stroke-width="1.2"/>`;
  if (used.socket) items.push({ id: 'socket', w: 92, draw: (x) => `${line(x)}${contactSymbol('socket', { x: x + 14, y: y + 10 }, 'right', '#000')}`, text: W.symSocket });
  if (used.plug) items.push({ id: 'plug', w: 80, draw: (x) => `${line(x)}${contactSymbol('plug', { x: x + 14, y: y + 10 }, 'right', '#000')}`, text: W.symPlug });
  if (used.mate) items.push({ id: 'mate', w: 92, draw: (x) => `${line(x)}${contactSymbol('socket', { x: x + 14, y: y + 10 }, 'right', '#000', { mated: true })}<line x1="${x + 18}" y1="${y + 10}" x2="${x + 26}" y2="${y + 10}" stroke="#000" stroke-width="1.2"/>`, text: W.symMate });
  if (used.terminal) items.push({ id: 'terminal', w: 64, draw: (x) => `${line(x)}${contactSymbol('terminal', { x: x + 16, y: y + 10 }, 'right', '#000')}`, text: W.symTerminal });
  if (used.pe) items.push({ id: 'pe', w: 100, draw: (x) => `${line(x)}${contactSymbol('pe', { x: x + 14, y: y + 10 }, 'right', '#000')}`, text: W.symPe });
  if (used.cores) items.push({ id: 'cores', w: 84, draw: (x) => `<line x1="${x}" y1="${y + 10}" x2="${x + 20}" y2="${y + 10}" stroke="#000" stroke-width="1.2"/><line x1="${x + 6}" y1="${y + 14}" x2="${x + 14}" y2="${y + 6}" stroke="#000" stroke-width="1"/><text x="${x + 13}" y="${y + 5}" font-size="6">n</text>`, text: W.symCores });
  if (used.screen) items.push({ id: 'screen', w: 72, draw: (x) => `<line x1="${x}" y1="${y + 10}" x2="${x + 20}" y2="${y + 10}" stroke="#000" stroke-width="1.2"/><ellipse cx="${x + 10}" cy="${y + 10}" rx="6" ry="3" fill="none" stroke="#000" stroke-width="0.8"/>`, text: W.symScreen });
  let x = 12;
  const parts = [];
  for (const it of items) {
    parts.push(`<g class="sch-legend-${it.id}">${it.draw(x)}<text x="${x + 30}" y="${y + 13}" font-size="7">${esc(it.text)}</text></g>`);
    x += 34 + it.w;
  }
  parts.push(`<text class="sch-legend-norm" x="${x}" y="${y + 13}" font-size="7" fill="#444">${esc(W.symbols)}</text>`);
  return { svg: `<g class="sch-legend">${parts.join('')}</g>`, width: x + W.symbols.length * 7 * 0.6 + 12, height: 24 };
}

/* ---- SVG ---- */

export async function renderSvg(state, ctx, { lang = 'en', title = '' } = {}) {
  const W = words(lang);
  const l = await layoutSchematic(state, ctx);
  const nodes = nodesOf(state);
  const parts = [];
  const used = { socket: false, plug: false, mate: false, terminal: false, pe: false, cores: false, screen: false, mcb: false, 'switch-disconnector': false, fuse: false, lamp: false };
  const endKey = (e) => `${endNode(e)}:${e.port}`;
  const connected = new Set(state.cables.flatMap((c) => [endKey(c.from), endKey(c.to)]));
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
    if (by.prot) {
      parts.push(protectiveSvg(n, box, by, ctx, connected, used));
      continue;
    }
    const label = n.block ? ctx.modules.find((m) => m.slug === n.module)?.name || n.module : n.label;
    const sub = n.block ? `${W.block} · ${n.schematic?.version || ''}` : templateFor(ctx.library, n.template)?.model || '';
    const ports = ['left', 'right', 'top', 'bottom'].flatMap((side) =>
      by[side].map((p) => {
        const pt = portPoint(by, size, p.id);
        const conn = connectorFor(ctx.library, p.connector);
        const col = conn?.color || '#000';
        const symbol = connectorSymbolOf(conn || { id: p.connector });
        const x2 = pt.x + (side === 'left' ? -STUB : side === 'right' ? STUB : 0);
        const y2 = pt.y + (side === 'top' ? -STUB : side === 'bottom' ? STUB : 0);
        const tx = side === 'left' ? pt.x + 4 : side === 'right' ? pt.x - 4 : pt.x;
        const anchor = side === 'left' ? 'start' : side === 'right' ? 'end' : 'middle';
        const mated = (symbol === 'socket' || symbol === 'plug') && connected.has(`${n.id}:${p.id}`);
        used[symbol] = true;
        if (mated) used.mate = true;
        // the stub stops short of a socket's back so the arc reads as the contact, not a blob on the line
        const back = symbol === 'socket' ? 3 : symbol === 'terminal' ? 2 : 0;
        const xe = x2 - (side === 'left' ? -back : side === 'right' ? back : 0);
        const ye = y2 - (side === 'top' ? -back : side === 'bottom' ? back : 0);
        return `<g class="sch-port" data-port="${esc(p.id)}"><title>${esc(p.label)}</title><circle class="sch-port-hit" cx="${box.x + x2}" cy="${box.y + y2}" r="7" fill="transparent"/><line x1="${box.x + pt.x}" y1="${box.y + pt.y}" x2="${box.x + xe}" y2="${box.y + ye}" stroke="${col}" stroke-width="1.5"/>${contactSymbol(symbol, { x: box.x + x2, y: box.y + y2 }, side, col, { mated })}<text x="${box.x + tx}" y="${box.y + pt.y + 3}" font-size="${PORT_FONT}" text-anchor="${anchor}">${esc(shortPortLabel(p.label))}</text></g>`;
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
    const marks = cableMarks(pts, kind, st.color || '#000');
    if (marks && kind?.cores) used.cores = true;
    if (marks && kind?.screened) used.screen = true;
    parts.push(`<g class="sch-cable sch-cable-${esc(c.kind)}" data-id="${esc(c.id)}"><polyline points="${pts.map((p) => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="${st.color || '#000'}" stroke-width="${st.width || 1.2}"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''}/>${marks}${c.label ? `<text x="${mid.x + 3}" y="${mid.y - 3}" font-size="7" fill="#000">${esc(c.label)}</text>` : ''}</g>`);
  }
  // a module's connector face: its external ports as a column on the left edge
  if (state.kind === 'module' && state.externalPorts.length) {
    const face = connectorFace(state, ctx);
    face.forEach((p, i) => {
      const y = 30 + i * 18;
      parts.push(`<g class="sch-external" data-id="${esc(p.id)}"><rect x="4" y="${y - 9}" width="90" height="14" fill="#f3f3f3" stroke="#000" stroke-width="0.6"/><text x="8" y="${y + 1}" font-size="7">${esc(p.label)}${p.connector ? ` (${esc(connectorFor(ctx.library, p.connector)?.label || p.connector)})` : ''}</text></g>`);
    });
  }
  let width = Math.max(l.width, 300);
  let height = Math.max(l.height, 120, state.kind === 'module' ? 40 + state.externalPorts.length * 18 : 0);
  // the legend: what the symbols on this drawing mean, and the standard they follow
  if (nodes.length) {
    const legend = legendSvg(used, height - 4, W);
    parts.push(legend.svg);
    width = Math.max(width, Math.ceil(legend.width));
    height += legend.height;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="${FONT}" class="schematic" role="img"${title ? ` aria-label="${esc(title)}"` : ''}>${title ? `<title>${esc(title)}</title>` : ''}<rect class="sch-paper" width="${width}" height="${height}" fill="#fff"/>${parts.join('')}</svg>`;
}

/** A protective device on the drawing: its poles, coupled when several, the terminals, and the information stack. */
function protectiveSvg(n, box, by, ctx, connected, used) {
  const { prot } = by;
  const size = { w: box.w, h: box.h };
  used[prot.symbol] = true;
  const poles = Math.max(prot.poles, 1);
  const poleX = (k) => box.x + prot.x0 + k * POLE_PITCH;
  const sym = Array.from({ length: poles }, (_, k) => `<g transform="translate(${poleX(k)},${box.y})">${poleSymbol(prot.symbol, 0, box.h)}</g>`);
  // several poles are worked together: the mechanical coupling, a dashed line through the blades
  const c = box.y + box.h / 2;
  let coupling = '';
  if (prot.symbol === 'lamp') {
    // the lamps share a return: the common bar, and the return lead leaving it under the middle lamp with a junction dot
    const yb = box.y + box.h - LAMP_BAR;
    const xr = box.x + polePortX(prot, 0, 'bottom');
    coupling = `<line class="sch-common" x1="${poleX(0)}" y1="${yb}" x2="${poleX(poles - 1)}" y2="${yb}" stroke="#000" stroke-width="1.2"/><line x1="${xr}" y1="${yb}" x2="${xr}" y2="${box.y + box.h}" stroke="#000" stroke-width="1.2"/>${poles > 1 ? `<circle class="sch-junction" cx="${xr}" cy="${yb}" r="2.2" fill="#000"/>` : ''}`;
  } else if (poles > 1 && prot.symbol !== 'fuse') {
    coupling = `<line class="sch-coupling" x1="${poleX(0) - 5}" y1="${c - 4}" x2="${poleX(poles - 1) - 5}" y2="${c - 4}" stroke="#000" stroke-width="1" stroke-dasharray="3 2"/>`;
  }
  const ports = ['top', 'bottom'].flatMap((side) =>
    by[side].map((p, i) => {
      const pt = portPoint(by, size, p.id);
      const conn = connectorFor(ctx.library, p.connector);
      const col = conn?.color || '#000';
      const symbol = connectorSymbolOf(conn || { id: p.connector });
      used[symbol] = true;
      const mated = (symbol === 'socket' || symbol === 'plug') && connected.has(`${n.id}:${p.id}`);
      if (mated) used.mate = true;
      const y2 = pt.y + (side === 'top' ? -STUB : STUB);
      const back = symbol === 'socket' ? 3 : symbol === 'terminal' ? 2 : 0;
      const ye = y2 - (side === 'top' ? -back : back);
      // the terminal number sits beside the first wire of a pole; a second wire on the same terminal keeps its name in the tooltip
      const ty = box.y + (side === 'top' ? 9 : box.h - 3);
      const words = String(p.label || '').trim().split(/\s+/);
      // one terminal group over several poles ("L1 L2 L3"): its words spread over the poles, one each
      const spread = side === 'top' && by.top.length === 1 && poles > 1 && words.length === poles;
      const text = spread
        ? words.map((w, k) => `<text x="${poleX(k) + 3}" y="${ty}" font-size="${PORT_FONT}" text-anchor="start">${esc(w)}</text>`).join('')
        : i < poles ? `<text x="${box.x + pt.x + 4}" y="${ty}" font-size="${PORT_FONT}" text-anchor="start">${esc(shortPortLabel(p.label))}</text>` : '';
      return `<g class="sch-port" data-port="${esc(p.id)}"><title>${esc(p.label)}</title><circle class="sch-port-hit" cx="${box.x + pt.x}" cy="${box.y + y2}" r="7" fill="transparent"/><line x1="${box.x + pt.x}" y1="${box.y + pt.y}" x2="${box.x + pt.x}" y2="${box.y + ye}" stroke="${col}" stroke-width="1.5"/>${contactSymbol(symbol, { x: box.x + pt.x, y: box.y + y2 }, side, col, { mated })}${text}</g>`;
    })
  );
  const info = [`<text class="sch-tag" x="${box.x + 4}" y="${box.y + 13}" font-size="9" font-weight="bold">${esc(prot.tag)}</text>`, ...prot.lines.map((t, i) => `<text x="${box.x + 4}" y="${box.y + 13 + (i + 1) * INFO_PITCH + 1}" font-size="${PORT_FONT}"${i === 0 ? '' : ' fill="#333"'}>${esc(t)}</text>`)];
  return `<g class="sch-device sch-prot sch-prot-${esc(prot.symbol)}" data-id="${esc(n.id)}"><rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="#fff" stroke="none"/>${info.join('')}${sym.join('')}${coupling}${ports.join('')}</g>`;
}

/* ---- tables ---- */

const fmtLen = (n, W) => (n === null || n === undefined ? '' : `${n} ${W.m}`);

export function scheduleHtml(schedule, lang = 'en') {
  const W = words(lang);
  const rows = schedule.map((r) => `<tr><td>${esc(r.label || r.id)}</td><td>${esc(r.kindLabel)}</td><td>${esc(r.type || '')}</td><td>${esc(r.color || '')}</td><td>${esc(r.from)}</td><td>${esc(r.fromPort)}</td><td>${esc(r.to)}</td><td>${esc(r.toPort)}</td><td>${fmtLen(r.length, W)}</td></tr>`).join('\n');
  return `<table class="cable-schedule">\n<thead><tr><th>${W.cable}</th><th>${W.kind}</th><th>${W.type}</th><th>${W.colour}</th><th>${W.from}</th><th>${W.port}</th><th>${W.to}</th><th>${W.port}</th><th>${W.length}</th></tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table>`;
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
  const head = 'label,kind,type,color,from,from_port,to,to_port,length_m,notes';
  return [head, ...schedule.map((r) => [r.label || r.id, r.kindLabel, r.type || '', r.color || '', r.from, r.fromPort, r.to, r.toPort, r.length ?? '', r.notes].map(cell).join(','))].join('\n');
}

/* ---- printable cable labels ---- */

const LABEL_WORDS = {
  en: { thisEnd: 'This end', otherEnd: 'Other end', labels: 'Cable labels', printHint: 'Print this page (Ctrl/Cmd+P). Two labels per cable, one for each end — 60 × 32 mm, cut along the dashed lines.' },
  pl: { thisEnd: 'Ten koniec', otherEnd: 'Drugi koniec', labels: 'Etykiety kabli', printHint: 'Wydrukuj tę stronę (Ctrl/Cmd+P). Dwie etykiety na kabel, po jednej na każdy koniec — 60 × 32 mm, tnij wzdłuż linii przerywanych.' },
};

/**
 * One printable page of cable labels: for every cable two labels (one per end), each with the cable's
 * name, its code (the installation code plus the cable id), the end it sits on and where the other
 * end goes, the kind and the length. Plain HTML + CSS; the browser prints it.
 */
export function cableLabelsHtml(schedule, { code = '', title = '', lang = 'en' } = {}) {
  const W = LABEL_WORDS[lang] || LABEL_WORDS.en;
  const labelCode = (r) => `${code ? `${code}-` : ''}${String(r.id).toUpperCase()}`;
  const one = (r, here, herePort, there, therePort) => `<div class="label">
<div class="code">${esc(labelCode(r))}</div>
<div class="name">${esc(r.label || r.id)}</div>
<div class="end"><span class="k">${W.thisEnd}</span> ${esc(here)} · ${esc(herePort)}</div>
<div class="end"><span class="k">${W.otherEnd}</span> ${esc(there)} · ${esc(therePort)}</div>
<div class="meta">${esc([r.kindLabel, r.type, r.color].filter(Boolean).join(' · '))}${r.length != null ? ` · ${esc(r.length)} m` : ''}${code ? ` · ${esc(code)}` : ''}</div>
</div>`;
  const labels = schedule.flatMap((r) => [one(r, r.from, r.fromPort, r.to, r.toPort), one(r, r.to, r.toPort, r.from, r.fromPort)]);
  return `<!doctype html>
<html lang="${esc(lang)}"><head><meta charset="utf-8"><title>${esc(title || W.labels)}</title>
<style>
@page { size: A4; margin: 10mm; }
body { font-family: Verdana, Geneva, sans-serif; margin: 0; color: #000; }
.hint { font-size: 10pt; margin: 0 0 6mm; color: #333; }
.sheet { display: grid; grid-template-columns: repeat(3, 60mm); gap: 3mm; }
.label { width: 60mm; height: 32mm; box-sizing: border-box; border: 0.3mm dashed #888; padding: 2mm 2.5mm; position: relative; overflow: hidden; break-inside: avoid; page-break-inside: avoid; }
.code { position: absolute; top: 1.5mm; right: 2.5mm; font-size: 6.5pt; letter-spacing: 0.03em; color: #333; }
.name { font-size: 14pt; font-weight: bold; line-height: 1.1; margin: 1.5mm 0 1.5mm; max-width: 44mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.end { font-size: 7.5pt; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.end .k { display: inline-block; min-width: 15mm; color: #555; }
.meta { position: absolute; left: 2.5mm; right: 2.5mm; bottom: 1.5mm; font-size: 6.5pt; color: #333; border-top: 0.2mm solid #bbb; padding-top: 0.8mm; }
@media print { .hint { display: none; } }
</style></head><body>
<p class="hint">${W.printHint}</p>
<div class="sheet">
${labels.join('\n')}
</div>
</body></html>`;
}

