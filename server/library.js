/**
 * Device library: connector kinds, cable kinds (which connector pairs they join) and device
 * templates (what a device IS and what it connects: typed ports). Pure functions — persistence is
 * schematics-store.js, which keeps the library on `main` in library/connectors.json and
 * library/devices.json. The defaults below are shipped with the console and are what a store
 * without those files reads.
 */
import { slugify } from './store-utils.js';

export const CATEGORIES = ['switch', 'router', 'pc', 'audio-interface', 'power-strip', 'headset', 'display', 'panel', 'other'];
export const SYMBOLS = ['box', 'switch', 'pc', 'power-strip', 'headset', 'display'];
export const PORT_DIRECTIONS = ['in', 'out', 'bidir'];
export const PORT_SIDES = ['left', 'right', 'top', 'bottom'];
export const PANEL_SIDES = ['front', 'rear'];
/** front, rear, or a named extra picture: lower-case letters, digits and dashes. */
export const PANEL_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Default symbol per category, when a template names none. */
const SYMBOL_OF = { switch: 'switch', router: 'switch', pc: 'pc', 'power-strip': 'power-strip', headset: 'headset', display: 'display' };

const DEFAULT_CONNECTORS = [
  { id: 'rj45', label: 'RJ45', color: '#2b7bba' },
  { id: 'usb-a', label: 'USB-A', color: '#555' },
  { id: 'usb-b', label: 'USB-B', color: '#555' },
  { id: 'usb-c', label: 'USB-C', color: '#555' },
  { id: 'iec-c13', label: 'IEC C13', color: '#111' },
  { id: 'iec-c14', label: 'IEC C14', color: '#111' },
  { id: 'schuko', label: 'Schuko', color: '#111' },
  { id: 'trs-6.35', label: 'TRS 6.35 mm', color: '#2a9d4b' },
  { id: 'xlr-m', label: 'XLR male', color: '#2a9d4b' },
  { id: 'xlr-f', label: 'XLR female', color: '#2a9d4b' },
  { id: 'hdmi', label: 'HDMI', color: '#8a4bb8' },
  { id: 'dp', label: 'DisplayPort', color: '#8a4bb8' },
  { id: 'db9', label: 'DB9', color: '#b8722b' },
];

/** `joins` lists the unordered connector pairs a cable kind may terminate in; `style` is how it prints. */
const DEFAULT_CABLES = [
  { id: 'ethernet', label: 'Ethernet', joins: [['rj45', 'rj45']], style: { color: '#2b7bba', width: 1.2, dash: '' } },
  { id: 'power', label: 'Power', joins: [['iec-c14', 'schuko'], ['iec-c14', 'iec-c13']], style: { color: '#111', width: 2, dash: '' } },
  { id: 'usb', label: 'USB', joins: [['usb-a', 'usb-b'], ['usb-a', 'usb-c'], ['usb-c', 'usb-c']], style: { color: '#555', width: 1.2, dash: '2 2' } },
  { id: 'audio', label: 'Audio', joins: [['trs-6.35', 'trs-6.35'], ['xlr-m', 'xlr-f']], style: { color: '#2a9d4b', width: 1.2, dash: '6 3' } },
  { id: 'video', label: 'Video', joins: [['hdmi', 'hdmi'], ['dp', 'dp']], style: { color: '#8a4bb8', width: 1.2, dash: '' } },
  { id: 'serial', label: 'Serial', joins: [['db9', 'db9']], style: { color: '#b8722b', width: 1.2, dash: '1 3' } },
];

const SEED_DEVICES = [
  {
    id: 'behringer-umc404hd', name: 'Behringer UMC404HD', category: 'audio-interface', manufacturer: 'Behringer', model: 'UMC404HD', heightU: 1, symbol: 'box',
    ports: [
      { id: 'pwr', label: 'Power', connector: 'iec-c14', direction: 'in', side: 'left' },
      { id: 'usb', label: 'USB', connector: 'usb-b', direction: 'bidir', side: 'left' },
      { id: 'phones-1', label: 'Phones 1', connector: 'trs-6.35', direction: 'out', side: 'right' },
      { id: 'phones-2', label: 'Phones 2', connector: 'trs-6.35', direction: 'out', side: 'right' },
    ],
  },
  {
    id: 'pdu-8', name: 'Power strip 8 outlets', category: 'power-strip', manufacturer: '', model: '', heightU: 1, symbol: 'power-strip',
    ports: [
      { id: 'in', label: 'Mains in', connector: 'iec-c14', direction: 'in', side: 'left' },
      ...Array.from({ length: 8 }, (_, i) => ({ id: `out-${i + 1}`, label: `Socket ${i + 1}`, connector: 'schuko', direction: 'out', side: 'right' })),
    ],
  },
  {
    id: 'switch-24', name: 'Ethernet switch 24 ports', category: 'switch', manufacturer: '', model: '', heightU: 1, symbol: 'switch',
    ports: [
      { id: 'pwr', label: 'Power', connector: 'iec-c14', direction: 'in', side: 'left' },
      ...Array.from({ length: 24 }, (_, i) => ({ id: `p${i + 1}`, label: `Port ${i + 1}`, connector: 'rj45', direction: 'bidir', side: 'right' })),
    ],
  },
  {
    id: 'headset', name: 'Headset', category: 'headset', manufacturer: '', model: '', heightU: 0, symbol: 'headset',
    ports: [{ id: 'jack', label: 'Jack', connector: 'trs-6.35', direction: 'in', side: 'left' }],
  },
  {
    id: 'pc', name: 'PC', category: 'pc', manufacturer: '', model: '', heightU: 2, symbol: 'pc',
    ports: [
      { id: 'pwr', label: 'Power', connector: 'iec-c14', direction: 'in', side: 'left' },
      { id: 'lan', label: 'LAN', connector: 'rj45', direction: 'bidir', side: 'right' },
      ...Array.from({ length: 4 }, (_, i) => ({ id: `usb-${i + 1}`, label: `USB ${i + 1}`, connector: 'usb-a', direction: 'bidir', side: 'right' })),
      { id: 'hdmi', label: 'HDMI', connector: 'hdmi', direction: 'out', side: 'right' },
    ],
  },
];

export const DEFAULT_LIBRARY = { connectors: DEFAULT_CONNECTORS, cables: DEFAULT_CABLES, devices: SEED_DEVICES };

const str = (v) => String(v ?? '').trim();

export function templateIdFor(name, takenIds) {
  const base = slugify(name) || 'device';
  let id = base;
  for (let n = 2; takenIds.has(id); n++) id = `${base}-${n}`;
  return id;
}

function normalizePort(p, connectorIds, seen) {
  if (!p || typeof p !== 'object') throw new Error('A port must be an object {id, label, connector, direction, side}');
  const label = str(p.label) || str(p.id);
  const id = str(p.id) || slugify(label);
  if (!id) throw new Error('A port needs an id or a label');
  if (seen.has(id)) throw new Error(`Port id "${id}" is listed twice`);
  seen.add(id);
  const connector = str(p.connector);
  if (!connectorIds.has(connector)) throw new Error(`Port "${id}": unknown connector "${connector}" — one of ${[...connectorIds].join(', ')}`);
  const direction = str(p.direction) || 'bidir';
  if (!PORT_DIRECTIONS.includes(direction)) throw new Error(`Port "${id}": direction must be one of ${PORT_DIRECTIONS.join(', ')}`);
  const side = str(p.side) || (direction === 'in' ? 'left' : 'right');
  if (!PORT_SIDES.includes(side)) throw new Error(`Port "${id}": side must be one of ${PORT_SIDES.join(', ')}`);
  return { id, label, connector, direction, side };
}

/** Clean one template spec (UI, API, MCP) into a library record. `connectors` defaults to the shipped set. */
export function normalizeTemplate(spec, takenIds = new Set(), connectors = DEFAULT_CONNECTORS) {
  if (!spec || typeof spec !== 'object') throw new Error('A device template must be an object');
  const name = str(spec.name);
  if (!name) throw new Error('A device template needs a name');
  const category = str(spec.category) || 'other';
  if (!CATEGORIES.includes(category)) throw new Error(`Unknown category "${category}" — one of ${CATEGORIES.join(', ')}`);
  const symbol = str(spec.symbol) || SYMBOL_OF[category] || 'box';
  if (!SYMBOLS.includes(symbol)) throw new Error(`Unknown symbol "${symbol}" — one of ${SYMBOLS.join(', ')}`);
  const connectorIds = new Set(connectors.map((c) => c.id));
  const seen = new Set();
  const ports = Array.isArray(spec.ports) ? spec.ports.map((p) => normalizePort(p, connectorIds, seen)) : [];
  const heightU = spec.heightU === undefined || spec.heightU === null || spec.heightU === '' ? 1 : Number(spec.heightU);
  // pictures of the device's faces, kept as files next to the library: {front: 'svg'|'png'|…, rear: …}
  // the two faces plus any named picture (a mainboard's rear I/O, a card's bracket): {name: ext}
  const panels = {};
  for (const [side, ext] of Object.entries(spec.panels && typeof spec.panels === 'object' ? spec.panels : {})) {
    if (!PANEL_NAME.test(side)) throw new Error(`A picture name is front, rear or a short kebab-case word such as "mainboard-io", not "${side}"`);
    if (ext) panels[side] = String(ext);
  }
  if (!Number.isFinite(heightU) || heightU < 0) throw new Error('heightU must be a number of rack units (0 for a device outside a rack)');
  return {
    id: str(spec.id) || templateIdFor(name, takenIds),
    name,
    category,
    manufacturer: str(spec.manufacturer),
    model: str(spec.model),
    heightU,
    symbol,
    ports,
    hardwareId: str(spec.hardwareId) || null,
    notes: str(spec.notes),
    panels,
  };
}

/** What a stored library file resolves to: broken rows dropped, missing parts filled from the defaults. */
export function normalizeLibrary(raw) {
  const connectors = Array.isArray(raw?.connectors) && raw.connectors.length ? raw.connectors.filter((c) => c && c.id && c.label) : DEFAULT_CONNECTORS;
  const cables = Array.isArray(raw?.cables) && raw.cables.length ? raw.cables.filter((c) => c && c.id && Array.isArray(c.joins)) : DEFAULT_CABLES;
  const devices = [];
  const taken = new Set();
  for (const d of Array.isArray(raw?.devices) ? raw.devices : SEED_DEVICES) {
    if (!d || !d.id || !d.name) continue;
    try {
      const t = normalizeTemplate(d, taken, connectors);
      taken.add(t.id);
      devices.push(t);
    } catch {
      // a template that no longer parses (a connector removed under it) is left out, not fatal
    }
  }
  return { connectors, cables, devices };
}

export function cableKindsFor(library, a, b) {
  return library.cables.filter((c) => c.joins.some(([x, y]) => (x === a && y === b) || (x === b && y === a))).map((c) => c.id);
}

export const templateFor = (library, id) => library.devices.find((d) => d.id === id) || null;
export const connectorFor = (library, id) => library.connectors.find((c) => c.id === id) || null;
export const cableFor = (library, id) => library.cables.find((c) => c.id === id) || null;
