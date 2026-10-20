/**
 * Library operations — what the schematic chat (and an MCP agent) can do to the device library in the
 * same breath as the schematic: define a device template with its ports, extend one, add a connector or a
 * cable kind, attach a picture of a face. They travel in the same `ops` list as the schematic operations;
 * `splitOps` pulls them out, `previewLibrary` applies them to a copy of the library so the schematic ops
 * that follow (an add_device of the new template) can be validated before anything is written, and the
 * store (`schematics-store.applyLibraryOps`) writes them for real on accept.
 *
 * A picture is {attachment: "<file name sent with the chat message>"} — the browser swaps the bytes in on
 * accept — {url: "https://…"} fetched server-side, or {dataBase64, type}. In a preview it is `pending`.
 */
import { normalizeTemplate, PANEL_NAME, CONNECTOR_SYMBOLS, connectorSymbolOf, coresOf } from './library.js';

export const LIBRARY_OP_NAMES = ['create_template', 'update_template', 'create_connector', 'create_cable_kind', 'set_picture'];
export const isLibraryOp = (op) => !!op && typeof op === 'object' && LIBRARY_OP_NAMES.includes(op.op);

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

/** Library ops first (a template exists before a device uses it), schematic ops in their own order. */
export function splitOps(ops) {
  const list = Array.isArray(ops) ? ops : [];
  return { libraryOps: list.filter(isLibraryOp), schematicOps: list.filter((o) => !isLibraryOp(o)) };
}

/** Validate a picture source: one of attachment / url / dataBase64. */
export function pictureSource(p, where) {
  if (!p || typeof p !== 'object') throw new Error(`${where}: a picture is {attachment}, {url} or {dataBase64, type}`);
  if (str(p.attachment)) return { attachment: str(p.attachment) };
  if (str(p.url)) {
    if (!/^https?:\/\//i.test(str(p.url))) throw new Error(`${where}: a picture url must start with http(s)://`);
    return { url: str(p.url) };
  }
  if (str(p.dataBase64)) return { dataBase64: str(p.dataBase64), type: str(p.type) };
  throw new Error(`${where}: a picture is {attachment}, {url} or {dataBase64, type}`);
}

/** {side: source} from an op's `pictures`, every side name checked. */
export function picturesOf(op, where) {
  const out = {};
  for (const [side, p] of Object.entries(op.pictures && typeof op.pictures === 'object' ? op.pictures : {})) {
    if (!PANEL_NAME.test(side)) throw new Error(`${where}: a picture name is front, rear or a short kebab-case word, not "${side}"`);
    out[side] = pictureSource(p, `${where} picture "${side}"`);
  }
  return out;
}

/**
 * Apply library ops to a copy of the library — the same checks the store makes, nothing written.
 * Returns the library as it would be; pictures are marked `pending` on the template's panels.
 */
export function previewLibrary(library, libraryOps) {
  const lib = { connectors: library.connectors.map((c) => ({ ...c })), cables: library.cables.map((c) => ({ ...c, joins: c.joins.map((j) => [...j]) })), devices: library.devices.map((d) => ({ ...d, ports: [...d.ports], panels: { ...(d.panels || {}) } })) };
  for (const op of libraryOps) applyLibraryOp(lib, op);
  return lib;
}

/** The connector record a create_connector op describes: its IEC 60617 contact symbol defaults to a socket. */
export function connectorFromOp(op) {
  const symbol = str(op.symbol);
  if (symbol && !CONNECTOR_SYMBOLS.includes(symbol)) throw new Error(`create_connector "${op.id}": symbol must be one of ${CONNECTOR_SYMBOLS.join(', ')}`);
  return { id: str(op.id), label: str(op.label), color: str(op.color) || '#555', symbol: symbol || connectorSymbolOf({ id: str(op.id) }) };
}

/** The cable-kind record a create_cable_kind op describes (joins already checked by the caller). */
export function cableKindFromOp(op) {
  const style = op.style && typeof op.style === 'object' ? op.style : {};
  const joins = (Array.isArray(op.joins) ? op.joins : []).map((j) => [str(j[0]), str(j[1])]);
  return { id: str(op.id), label: str(op.label), joins, style: { color: str(style.color) || '#555', width: Number(style.width) || 1.2, dash: str(style.dash) }, cores: coresOf(op.cores), screened: Boolean(op.screened) };
}

/** One op on an in-memory library (mutates `lib`). Returns the human line for it. */
export function applyLibraryOp(lib, op) {
  const where = op.op;
  switch (op.op) {
    case 'create_connector': {
      const id = str(op.id);
      const label = str(op.label);
      if (!id || !label) throw new Error('create_connector needs an id and a label');
      if (lib.connectors.some((c) => c.id === id)) throw new Error(`Connector "${id}" already exists`);
      lib.connectors.push(connectorFromOp(op));
      return `Added connector ${label}`;
    }
    case 'create_cable_kind': {
      const id = str(op.id);
      const label = str(op.label);
      if (!id || !label) throw new Error('create_cable_kind needs an id and a label');
      if (lib.cables.some((c) => c.id === id)) throw new Error(`Cable kind "${id}" already exists`);
      const joins = Array.isArray(op.joins) ? op.joins : [];
      if (!joins.length) throw new Error(`create_cable_kind "${id}": joins must list at least one pair of connector ids`);
      for (const pair of joins) {
        if (!Array.isArray(pair) || pair.length !== 2) throw new Error(`create_cable_kind "${id}": every join is a pair of connector ids`);
        for (const c of pair) if (!lib.connectors.some((x) => x.id === c)) throw new Error(`create_cable_kind "${id}" joins unknown connector "${c}"`);
      }
      lib.cables.push(cableKindFromOp(op));
      return `Added cable kind ${label}`;
    }
    case 'create_template': {
      const taken = new Set(lib.devices.map((d) => d.id));
      const pictures = picturesOf(op, where);
      const { op: _o, pictures: _p, ...spec } = op;
      const t = normalizeTemplate(spec, taken, lib.connectors);
      if (taken.has(t.id)) throw new Error(`Device template "${t.id}" already exists`);
      for (const side of Object.keys(pictures)) t.panels[side] = 'pending';
      lib.devices.push(t);
      return `Added device template ${t.name} (${t.ports.length} ports)`;
    }
    case 'update_template': {
      const id = str(op.id);
      const idx = lib.devices.findIndex((d) => d.id === id);
      if (idx < 0) throw new Error(`Device template "${id}" not found`);
      const cur = lib.devices[idx];
      const pictures = picturesOf(op, where);
      const { op: _o, pictures: _p, addPorts, ...patch } = op;
      const ports = Array.isArray(patch.ports) ? patch.ports : [...cur.ports, ...(Array.isArray(addPorts) ? addPorts : [])];
      const t = normalizeTemplate({ ...cur, ...patch, ports, id }, new Set(), lib.connectors);
      for (const side of Object.keys(pictures)) t.panels[side] = 'pending';
      lib.devices[idx] = t;
      return `Updated device template ${t.name}`;
    }
    case 'set_picture': {
      const id = str(op.template);
      const side = str(op.side) || 'front';
      const t = lib.devices.find((d) => d.id === id);
      if (!t) throw new Error(`Device template "${id}" not found`);
      if (!PANEL_NAME.test(side)) throw new Error(`set_picture: a picture name is front, rear or a short kebab-case word, not "${side}"`);
      pictureSource(op.picture, `set_picture ${id} ${side}`);
      t.panels = { ...(t.panels || {}), [side]: 'pending' };
      return `Picture ${side} of ${t.name}`;
    }
    default:
      throw new Error(`Unknown library operation "${op.op}"`);
  }
}

/** One English line for an op (the store's summaries; the UI translates its own). */
export function describeLibraryOp(op) {
  switch (op?.op) {
    case 'create_template': return `Add device template ${op.name || op.id || ''}`.trim();
    case 'update_template': return `Update device template ${op.id || ''}`.trim();
    case 'create_connector': return `Add connector ${op.label || op.id || ''}`.trim();
    case 'create_cable_kind': return `Add cable kind ${op.label || op.id || ''}`.trim();
    case 'set_picture': return `Picture ${op.side || 'front'} of ${op.template || ''}`.trim();
    default: return String(op?.op || '');
  }
}
