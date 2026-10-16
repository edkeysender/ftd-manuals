/**
 * The schematic as data: devices with typed ports, cables between ports, locations, a module's
 * external ports. Everything that changes it is an **operation**; `applyOps` validates and applies a
 * whole list or nothing. Pure — the git side is schematics-store.js, the drawing schematic-render.js.
 */
import { slugify } from './store-utils.js';
import { cableKindsFor, templateFor, connectorFor, cableFor } from './library.js';

export class SchematicError extends Error {
  constructor(message, { code = 'invalid', index = -1 } = {}) {
    super(message);
    this.code = code;
    this.index = index;
  }
}

const now = () => new Date().toISOString();
const str = (v) => String(v ?? '').trim();
const clone = (v) => JSON.parse(JSON.stringify(v));

export function emptySchematic({ kind, owner }) {
  if (kind !== 'module' && kind !== 'installation') throw new SchematicError(`kind must be module or installation, not "${kind}"`);
  const ts = now();
  return {
    kind,
    owner,
    version: 'A1.0',
    revision: 1,
    status: 'draft',
    branch: null,
    createdAt: ts,
    updatedAt: ts,
    releasedAt: null,
    locations: [],
    blocks: [],
    devices: [],
    cables: [],
    externalPorts: [],
    layout: { nodes: {}, manual: [] },
    revisions: [],
    releaseRecord: [],
    hotfix: null,
  };
}

export const endpointKey = (e) => (e.block ? `b:${e.block}:${e.port}` : `d:${e.device}:${e.port}`);

function uniqueId(base, taken) {
  base = slugify(base) || 'item';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/* ---- lookups ---- */

const deviceOf = (state, id) => state.devices.find((d) => d.id === id) || null;
const blockOf = (state, id) => state.blocks.find((b) => b.id === id) || null;
const locationOf = (state, id) => state.locations.find((l) => l.id === id) || null;
const moduleName = (ctx, slug) => ctx.modules.find((m) => m.slug === slug)?.name || slug;

/** The external ports a released module schematic exposes, typed through its devices' templates. */
export function connectorFace(moduleState, ctx) {
  return (moduleState?.externalPorts || []).map((ep) => {
    const dev = deviceOf(moduleState, ep.device);
    const tpl = dev ? templateFor(ctx.library, dev.template) : null;
    const port = tpl?.ports.find((p) => p.id === ep.port) || null;
    return { id: ep.id, label: ep.label, device: ep.device, port: ep.port, connector: port?.connector || null, direction: port?.direction || 'bidir' };
  });
}

/** Typed ports of one endpoint owner: a device (its template ports) or a block (its module's face). */
export function portsOf(state, end, ctx) {
  if (end.block) {
    const b = blockOf(state, end.block);
    if (!b) return null;
    const released = ctx.releasedSchematics.get(b.module);
    return released ? connectorFace(released, ctx) : [];
  }
  const d = deviceOf(state, end.device);
  if (!d) return null;
  const tpl = templateFor(ctx.library, d.template);
  return tpl ? tpl.ports : [];
}

function resolveEnd(state, end, ctx, who) {
  if (!end || typeof end !== 'object' || !str(end.port) || (!str(end.device) && !str(end.block)))
    throw new SchematicError(`${who} must be {device, port} or {block, port}`);
  const ports = portsOf(state, end, ctx);
  if (!ports) throw new SchematicError(`${who}: unknown ${end.block ? `block "${end.block}"` : `device "${end.device}"`}`);
  const port = ports.find((p) => p.id === end.port);
  if (!port) {
    const owner = end.block ? `block "${end.block}"` : `device "${end.device}"`;
    throw new SchematicError(`${who}: ${end.block ? 'external ' : ''}port "${end.port}" does not exist on ${owner} — it has: ${ports.map((p) => p.id).join(', ') || 'none'}`);
  }
  const norm = end.block ? { block: str(end.block), port: str(end.port) } : { device: str(end.device), port: str(end.port) };
  return { end: norm, port };
}

const endLabel = (state, end, ctx) => {
  if (end.block) {
    const b = blockOf(state, end.block);
    return b ? moduleName(ctx, b.module) : end.block;
  }
  const d = deviceOf(state, end.device);
  return d ? d.label : end.device;
};
const portLabel = (state, end, ctx) => (portsOf(state, end, ctx) || []).find((p) => p.id === end.port)?.label || end.port;

/* ---- operations ---- */

const needKind = (state, kind, op) => {
  if (state.kind !== kind) throw new SchematicError(`${op} belongs to ${kind === 'module' ? 'a module schematic' : 'an installation'}, not to ${state.kind === 'module' ? 'a module schematic' : 'an installation'}`);
};

const OPS = {
  add_device(state, op, ctx) {
    const template = str(op.template);
    const hardwareId = str(op.hardwareId) || null;
    let tpl = template ? templateFor(ctx.library, template) : null;
    if (template && !tpl) throw new SchematicError(`unknown device template "${template}" — list_device_templates names them`);
    if (hardwareId && !ctx.catalog.some((h) => h.id === hardwareId)) throw new SchematicError(`"${hardwareId}" is not in the hardware catalog`);
    if (!tpl && hardwareId) tpl = ctx.library.devices.find((d) => d.hardwareId === hardwareId) || null;
    if (!tpl) throw new SchematicError('add_device needs a template (or a hardwareId whose catalog item has a template)');
    const label = str(op.label) || (hardwareId ? ctx.catalog.find((h) => h.id === hardwareId).name : tpl.name);
    const taken = new Set([...state.devices.map((d) => d.id), ...state.blocks.map((b) => b.id)]);
    const id = str(op.id) || uniqueId(label, taken);
    if (taken.has(id)) throw new SchematicError(`id "${id}" is already used`);
    const location = str(op.location) || null;
    if (location && !locationOf(state, location)) throw new SchematicError(`unknown location "${location}" — add_location first`);
    if (location && state.kind === 'module') throw new SchematicError('a module schematic has no locations');
    state.devices.push({ id, template: tpl.id, hardwareId, label, location, rack: rackOf(op.rack), notes: str(op.notes) });
    return `Added ${label}${location ? ` in ${locationOf(state, location).label}` : ''}`;
  },
  update_device(state, op) {
    const d = deviceOf(state, str(op.id));
    if (!d) throw new SchematicError(`unknown device "${op.id}"`);
    if (op.label !== undefined) d.label = str(op.label) || d.label;
    if (op.notes !== undefined) d.notes = str(op.notes);
    if (op.rack !== undefined) d.rack = rackOf(op.rack);
    if (op.location !== undefined) {
      const loc = str(op.location) || null;
      if (loc && !locationOf(state, loc)) throw new SchematicError(`unknown location "${loc}"`);
      d.location = loc;
    }
    return `Updated ${d.label}`;
  },
  remove_device(state, op) {
    const d = deviceOf(state, str(op.id));
    if (!d) throw new SchematicError(`unknown device "${op.id}"`);
    const attached = state.cables.filter((c) => c.from.device === d.id || c.to.device === d.id);
    if (attached.length && !op.cascade) throw new SchematicError(`${d.label} still has ${attached.length} cable(s) — disconnect them or pass cascade: true`);
    state.cables = state.cables.filter((c) => !attached.includes(c));
    state.externalPorts = state.externalPorts.filter((p) => p.device !== d.id);
    state.devices = state.devices.filter((x) => x !== d);
    delete state.layout.nodes[d.id];
    state.layout.manual = state.layout.manual.filter((x) => x !== d.id);
    return `Removed ${d.label}${attached.length ? ` and ${attached.length} cable(s)` : ''}`;
  },
  connect(state, op, ctx) {
    const a = resolveEnd(state, op.from, ctx, 'from');
    const b = resolveEnd(state, op.to, ctx, 'to');
    if (endpointKey(a.end) === endpointKey(b.end)) throw new SchematicError('a cable cannot join a port to itself');
    const kinds = cableKindsFor(ctx.library, a.port.connector, b.port.connector);
    if (!kinds.length) throw new SchematicError(`no cable kind joins ${a.port.connector} to ${b.port.connector}`);
    let kind = str(op.kind);
    if (kind && !kinds.includes(kind)) throw new SchematicError(`a ${kind} cable does not join ${a.port.connector} to ${b.port.connector} — ${kinds.join(', ')} would`);
    if (!kind) {
      if (kinds.length > 1) throw new SchematicError(`several cable kinds fit (${kinds.join(', ')}) — say which with kind`);
      kind = kinds[0];
    }
    if (a.port.direction === 'out' && b.port.direction === 'out') throw new SchematicError('two outputs cannot be joined');
    if (a.port.direction === 'in' && b.port.direction === 'in') throw new SchematicError('two inputs cannot be joined');
    for (const end of [a.end, b.end]) {
      const busy = state.cables.find((c) => endpointKey(c.from) === endpointKey(end) || endpointKey(c.to) === endpointKey(end));
      if (busy) throw new SchematicError(`${endLabel(state, end, ctx)} ${portLabel(state, end, ctx)} already has cable ${busy.label || busy.id}`);
    }
    const taken = new Set(state.cables.map((c) => c.id));
    const id = str(op.id) || uniqueId(`c-${state.cables.length + 1}`, taken);
    if (taken.has(id)) throw new SchematicError(`cable id "${id}" is already used`);
    state.cables.push({ id, kind, from: a.end, to: b.end, label: str(op.label), length: numOrNull(op.length), notes: str(op.notes) });
    return `Connected ${endLabel(state, a.end, ctx)} ${portLabel(state, a.end, ctx)} → ${endLabel(state, b.end, ctx)} ${portLabel(state, b.end, ctx)} (${kind})`;
  },
  update_cable(state, op) {
    const c = state.cables.find((x) => x.id === str(op.id));
    if (!c) throw new SchematicError(`unknown cable "${op.id}"`);
    if (op.label !== undefined) c.label = str(op.label);
    if (op.length !== undefined) c.length = numOrNull(op.length);
    if (op.notes !== undefined) c.notes = str(op.notes);
    return `Updated cable ${c.label || c.id}`;
  },
  disconnect(state, op) {
    const c = state.cables.find((x) => x.id === str(op.id));
    if (!c) throw new SchematicError(`unknown cable "${op.id}"`);
    state.cables = state.cables.filter((x) => x !== c);
    return `Removed cable ${c.label || c.id}`;
  },
  set_external_port(state, op, ctx) {
    needKind(state, 'module', 'set_external_port');
    const { end, port } = resolveEnd(state, { device: op.device, port: op.port }, ctx, 'external port');
    const id = str(op.id) || uniqueId(str(op.label) || port.label, new Set(state.externalPorts.map((p) => p.id)));
    const existing = state.externalPorts.find((p) => p.id === id);
    const rec = { id, label: str(op.label) || port.label, device: end.device, port: end.port };
    if (existing) Object.assign(existing, rec);
    else state.externalPorts.push(rec);
    return `${existing ? 'Updated' : 'Declared'} external port ${rec.label}`;
  },
  unset_external_port(state, op) {
    needKind(state, 'module', 'unset_external_port');
    const before = state.externalPorts.length;
    state.externalPorts = state.externalPorts.filter((p) => p.id !== str(op.id));
    if (state.externalPorts.length === before) throw new SchematicError(`unknown external port "${op.id}"`);
    return `Removed external port ${op.id}`;
  },
  add_location(state, op) {
    needKind(state, 'installation', 'add_location');
    const label = str(op.label);
    if (!label) throw new SchematicError('add_location needs a label');
    const id = str(op.id) || uniqueId(label, new Set(state.locations.map((l) => l.id)));
    if (locationOf(state, id)) throw new SchematicError(`location "${id}" already exists`);
    const kind = str(op.kind) || 'area';
    if (!['rack', 'area'].includes(kind)) throw new SchematicError('location kind must be rack or area');
    state.locations.push({ id, label, kind, unitsU: kind === 'rack' ? Number(op.unitsU) || 42 : null });
    return `Added location ${label}`;
  },
  update_location(state, op) {
    needKind(state, 'installation', 'update_location');
    const l = locationOf(state, str(op.id));
    if (!l) throw new SchematicError(`unknown location "${op.id}"`);
    if (op.label !== undefined) l.label = str(op.label) || l.label;
    if (op.kind !== undefined) {
      if (!['rack', 'area'].includes(op.kind)) throw new SchematicError('location kind must be rack or area');
      l.kind = op.kind;
      l.unitsU = l.kind === 'rack' ? l.unitsU || 42 : null;
    }
    if (op.unitsU !== undefined && l.kind === 'rack') l.unitsU = Number(op.unitsU) || 42;
    return `Updated location ${l.label}`;
  },
  remove_location(state, op) {
    needKind(state, 'installation', 'remove_location');
    const l = locationOf(state, str(op.id));
    if (!l) throw new SchematicError(`unknown location "${op.id}"`);
    const used = [...state.devices, ...state.blocks].filter((x) => x.location === l.id);
    if (used.length) throw new SchematicError(`${l.label} still holds ${used.length} item(s) — move them first`);
    state.locations = state.locations.filter((x) => x !== l);
    return `Removed location ${l.label}`;
  },
  place_block(state, op, ctx) {
    needKind(state, 'installation', 'place_block');
    const module = str(op.module);
    const released = ctx.releasedSchematics.get(module);
    if (!released) throw new SchematicError(`module "${module}" has no released schematic — release it before placing it`);
    const location = str(op.location) || null;
    if (location && !locationOf(state, location)) throw new SchematicError(`unknown location "${location}" — add_location first`);
    const taken = new Set([...state.devices.map((d) => d.id), ...state.blocks.map((b) => b.id)]);
    const id = str(op.id) || uniqueId(module, taken);
    if (taken.has(id)) throw new SchematicError(`id "${id}" is already used`);
    state.blocks.push({ id, module, schematic: { version: released.version, revision: released.revision }, location, rack: rackOf(op.rack) });
    return `Placed ${moduleName(ctx, module)}${location ? ` in ${locationOf(state, location).label}` : ''}`;
  },
  refresh_block(state, op, ctx) {
    needKind(state, 'installation', 'refresh_block');
    const b = blockOf(state, str(op.id));
    if (!b) throw new SchematicError(`unknown block "${op.id}"`);
    const released = ctx.releasedSchematics.get(b.module);
    if (!released) throw new SchematicError(`module "${b.module}" has no released schematic`);
    b.schematic = { version: released.version, revision: released.revision };
    return `${moduleName(ctx, b.module)} now follows schematic ${released.version} r${released.revision}`;
  },
  remove_block(state, op, ctx) {
    needKind(state, 'installation', 'remove_block');
    const b = blockOf(state, str(op.id));
    if (!b) throw new SchematicError(`unknown block "${op.id}"`);
    const attached = state.cables.filter((c) => c.from.block === b.id || c.to.block === b.id);
    if (attached.length && !op.cascade) throw new SchematicError(`${moduleName(ctx, b.module)} still has ${attached.length} cable(s) — disconnect them or pass cascade: true`);
    state.cables = state.cables.filter((c) => !attached.includes(c));
    state.blocks = state.blocks.filter((x) => x !== b);
    delete state.layout.nodes[b.id];
    state.layout.manual = state.layout.manual.filter((x) => x !== b.id);
    return `Removed ${moduleName(ctx, b.module)}`;
  },
  move(state, op) {
    const id = str(op.id);
    if (!deviceOf(state, id) && !blockOf(state, id) && !locationOf(state, id)) throw new SchematicError(`unknown node "${id}"`);
    const x = Number(op.x);
    const y = Number(op.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new SchematicError('move needs numeric x and y');
    state.layout.nodes[id] = { x, y };
    if (!state.layout.manual.includes(id)) state.layout.manual.push(id);
    return `Moved ${id}`;
  },
  tidy(state, op) {
    const ids = Array.isArray(op.ids) && op.ids.length ? op.ids.map(str) : null;
    state.layout.manual = ids ? state.layout.manual.filter((id) => !ids.includes(id)) : [];
    return ids ? `Tidied ${ids.join(', ')}` : 'Tidied the layout';
  },
};

/** Where in a rack: the U position and the face it is mounted on (front unless said otherwise). */
function rackOf(v) {
  if (!v || typeof v !== 'object') return null;
  const u = Number(v.u);
  if (!(Number.isFinite(u) && u > 0)) return null;
  const face = str(v.face) || 'front';
  if (!RACK_FACES.includes(face)) throw new SchematicError(`a rack face is front or rear, not "${face}"`);
  return { u, face };
}
export const RACK_FACES = ['front', 'rear'];
const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Apply a list of operations to a copy of `state`. All or nothing: the first failing op aborts the
 * whole list with a SchematicError carrying its index, and the caller's state is untouched.
 */
export function applyOps(state, ops, ctx) {
  if (!Array.isArray(ops) || !ops.length) throw new SchematicError('ops must be a non-empty array');
  const next = clone(state);
  const summary = [];
  ops.forEach((op, index) => {
    const fn = op && OPS[op.op];
    if (!fn) throw new SchematicError(`unknown op "${op?.op}" — one of ${Object.keys(OPS).join(', ')}`, { code: 'unknown-op', index });
    try {
      summary.push(fn(next, op, ctx));
    } catch (e) {
      if (e instanceof SchematicError) {
        e.index = index;
        e.message = `op ${index + 1} (${op.op}): ${e.message}`;
      }
      throw e;
    }
  });
  next.updatedAt = now();
  return { state: next, summary };
}

/* ---- validation ---- */

/** Errors block a release; warnings do not. */
export function validateSchematic(state, ctx) {
  const errors = [];
  const warnings = [];
  const err = (code, message, ref) => errors.push({ code, message, ref });
  const warn = (code, message, ref) => warnings.push({ code, message, ref });

  for (const d of state.devices) {
    if (!templateFor(ctx.library, d.template)) err('template-missing', `${d.label}: device template "${d.template}" no longer exists`, d.id);
    if (d.hardwareId && !ctx.catalog.some((h) => h.id === d.hardwareId)) warn('catalog-missing', `${d.label}: catalog item "${d.hardwareId}" no longer exists`, d.id);
    if (state.kind === 'installation' && !d.location) warn('device-unplaced', `${d.label} is in no location`, d.id);
    if (d.location && !locationOf(state, d.location)) err('location-missing', `${d.label}: location "${d.location}" does not exist`, d.id);
  }
  for (const b of state.blocks) {
    const released = ctx.releasedSchematics.get(b.module);
    if (!released) err('block-unreleased', `${moduleName(ctx, b.module)} has no released schematic`, b.id);
    else if (released.version !== b.schematic?.version || released.revision !== b.schematic?.revision)
      warn('block-outdated', `${moduleName(ctx, b.module)} follows schematic ${b.schematic?.version} r${b.schematic?.revision}; ${released.version} r${released.revision} is released — refresh the block`, b.id);
    if (b.location && !locationOf(state, b.location)) err('location-missing', `${moduleName(ctx, b.module)}: location "${b.location}" does not exist`, b.id);
  }
  const seen = new Map();
  for (const c of state.cables) {
    const name = c.label || c.id;
    if (!c.label) warn('cable-unlabeled', `cable ${c.id} has no label`, c.id);
    const ends = [c.from, c.to].map((end) => {
      const ports = portsOf(state, end, ctx);
      if (!ports) {
        err('end-missing', `cable ${name}: ${end.block ? `block "${end.block}"` : `device "${end.device}"`} does not exist`, c.id);
        return null;
      }
      const port = ports.find((p) => p.id === end.port);
      if (!port) {
        err('port-missing', `cable ${name}: port "${end.port}" does not exist on ${endLabel(state, end, ctx)}`, c.id);
        return null;
      }
      const key = endpointKey(end);
      if (seen.has(key)) err('port-busy', `cable ${name} and ${seen.get(key)} both end on ${endLabel(state, end, ctx)} ${port.label}`, c.id);
      seen.set(key, name);
      return port;
    });
    if (ends[0] && ends[1]) {
      const kinds = cableKindsFor(ctx.library, ends[0].connector, ends[1].connector);
      if (!cableFor(ctx.library, c.kind)) err('kind-missing', `cable ${name}: cable kind "${c.kind}" no longer exists`, c.id);
      else if (!kinds.includes(c.kind)) err('kind-mismatch', `cable ${name}: a ${c.kind} cable does not join ${ends[0].connector} to ${ends[1].connector}`, c.id);
      if (ends[0].direction === 'out' && ends[1].direction === 'out') err('direction', `cable ${name} joins two outputs`, c.id);
      if (ends[0].direction === 'in' && ends[1].direction === 'in') err('direction', `cable ${name} joins two inputs`, c.id);
    }
  }
  for (const d of state.devices) {
    const tpl = templateFor(ctx.library, d.template);
    const powerIn = tpl?.ports.find((p) => p.direction === 'in' && isPowerConnector(ctx, p.connector));
    if (powerIn && !seen.has(endpointKey({ device: d.id, port: powerIn.id }))) warn('device-unpowered', `${d.label} has no power cable`, d.id);
  }
  for (const l of state.locations) {
    if (![...state.devices, ...state.blocks].some((x) => x.location === l.id)) warn('location-empty', `${l.label} holds nothing`, l.id);
  }
  // a simulator ships with up to four racks; a fifth is usually a rack that belongs to another installation
  const racks = state.locations.filter((l) => l.kind === 'rack');
  if (racks.length > MAX_RACKS) warn('too-many-racks', `${racks.length} racks — a simulator holds up to ${MAX_RACKS}`, racks[MAX_RACKS].id);
  return { errors, warnings };
}

export const MAX_RACKS = 4;

/* ---- views ---- */

/**
 * One location's view of an installation: what sits in it, every cable that touches it, and the
 * devices or blocks at the far end of those cables (kept in their own locations, so the drawing says
 * where a cable leaves to). `view` names the ids so the UI can filter its lists the same way.
 * With no location the state comes back as it is.
 */
export function filterSchematic(state, { location = null } = {}) {
  if (!location) return state;
  if (!locationOf(state, location)) throw new SchematicError(`unknown location "${location}"`);
  const inside = (x) => x.location === location;
  const deviceIds = state.devices.filter(inside).map((d) => d.id);
  const blockIds = state.blocks.filter(inside).map((b) => b.id);
  const mine = (end) => (end.block ? blockIds.includes(end.block) : deviceIds.includes(end.device));
  const cables = state.cables.filter((c) => mine(c.from) || mine(c.to));
  const partnerDevices = new Set();
  const partnerBlocks = new Set();
  for (const c of cables) for (const end of [c.from, c.to]) {
    if (mine(end)) continue;
    if (end.block) partnerBlocks.add(end.block);
    else partnerDevices.add(end.device);
  }
  const devices = state.devices.filter((d) => deviceIds.includes(d.id) || partnerDevices.has(d.id));
  const blocks = state.blocks.filter((b) => blockIds.includes(b.id) || partnerBlocks.has(b.id));
  const usedLocations = new Set([location, ...devices.map((d) => d.location), ...blocks.map((b) => b.location)].filter(Boolean));
  const locations = state.locations.filter((l) => usedLocations.has(l.id));
  return {
    ...state,
    locations,
    devices,
    blocks,
    cables,
    externalPorts: state.kind === 'module' ? state.externalPorts : [],
    view: { location, deviceIds, blockIds, cableIds: cables.map((c) => c.id), partnerIds: [...partnerDevices, ...partnerBlocks] },
  };
}

/** A connector any power cable may terminate in. */
const isPowerConnector = (ctx, connector) => !!cableFor(ctx.library, 'power')?.joins.some((pair) => pair.includes(connector));

/* ---- derived tables ---- */

export function cableSchedule(state, ctx) {
  return state.cables.map((c) => ({
    id: c.id,
    label: c.label,
    kind: c.kind,
    kindLabel: cableFor(ctx.library, c.kind)?.label || c.kind,
    from: endLabel(state, c.from, ctx),
    fromPort: portLabel(state, c.from, ctx),
    to: endLabel(state, c.to, ctx),
    toPort: portLabel(state, c.to, ctx),
    length: c.length,
    notes: c.notes,
  }));
}

export const OP_NAMES = Object.keys(OPS);
export { connectorFor };
