/**
 * What the browser needs to know about the device library to offer connections: which cable kinds
 * join two connectors, a device's typed ports, which ports are free, and which ports a given port
 * could be wired to. Mirrors the rules the server applies in server/schematic.js; the server still
 * has the last word when the operation is posted.
 */
export const cableKindsFor = (lib, a, b) =>
  (lib?.cables || []).filter((c) => (c.joins || []).some(([x, y]) => (x === a && y === b) || (x === b && y === a))).map((c) => c.id);

export const templateOf = (lib, state, deviceId) => {
  const d = (state.devices || []).find((x) => x.id === deviceId);
  return d ? (lib?.devices || []).find((t) => t.id === d.template) || null : null;
};

export const portsOf = (lib, state, deviceId) => templateOf(lib, state, deviceId)?.ports || [];
export const portOf = (lib, state, deviceId, portId) => portsOf(lib, state, deviceId).find((p) => p.id === portId) || null;

export const cableAt = (state, deviceId, portId) =>
  (state.cables || []).find((c) => (c.from.device === deviceId && c.from.port === portId) || (c.to.device === deviceId && c.to.port === portId)) || null;
export const isFree = (state, deviceId, portId) => !cableAt(state, deviceId, portId);

const directionOk = (a, b) => !((a === 'out' && b === 'out') || (a === 'in' && b === 'in'));

/** Every free port on another device that some cable kind joins to (deviceId, portId): [{device, label, port, portLabel, connector, kinds}]. */
export function compatibleTargets(lib, state, deviceId, portId) {
  const from = portOf(lib, state, deviceId, portId);
  if (!from) return [];
  const out = [];
  for (const d of state.devices || []) {
    if (d.id === deviceId) continue;
    for (const p of portsOf(lib, state, d.id)) {
      if (!isFree(state, d.id, p.id) || !directionOk(from.direction, p.direction)) continue;
      const kinds = cableKindsFor(lib, from.connector, p.connector);
      if (kinds.length) out.push({ device: d.id, label: d.label, port: p.id, portLabel: p.label, connector: p.connector, kinds });
    }
  }
  return out;
}

/**
 * A rack's elevation: every device and block mounted in it at its U span (top first), whether two of
 * them overlap, what sits in the rack without a U position, and which slots are free. Null for an
 * area. A template's heightU of 0 counts as one slot when the device was given a position anyway.
 */
export function rackMap(state, lib, locationId, face = 'front') {
  const loc = (state.locations || []).find((l) => l.id === locationId);
  if (!loc || loc.kind !== 'rack') return null;
  const units = Number(loc.unitsU) || 42;
  const items = [];
  const unplaced = [];
  const counts = { front: 0, rear: 0 };
  const faceOf = (r) => r?.face || 'front';
  for (const d of state.devices || []) {
    if (d.location !== locationId) continue;
    const tpl = templateOf(lib, state, d.id);
    const h = Number(d.rack?.h) || Math.max(1, Number(tpl?.heightU) || 1);
    const pic = { template: tpl?.id || d.template, panels: tpl?.panels || {} };
    if (d.rack?.u) {
      counts[faceOf(d.rack)] += 1;
      if (faceOf(d.rack) === face) items.push({ id: d.id, kind: 'device', label: d.label, u: Number(d.rack.u), h, face, ...pic });
    } else unplaced.push({ id: d.id, kind: 'device', label: d.label, h, ...pic });
  }
  for (const b of state.blocks || []) {
    if (b.location !== locationId) continue;
    if (b.rack?.u) {
      counts[faceOf(b.rack)] += 1;
      if (faceOf(b.rack) === face) items.push({ id: b.id, kind: 'block', label: b.module, u: Number(b.rack.u), h: 1, face });
    } else unplaced.push({ id: b.id, kind: 'block', label: b.module, h: 1 });
  }
  const top = (i) => i.u + i.h - 1;
  for (const i of items) i.overlap = items.some((o) => o !== i && o.u <= top(i) && i.u <= top(o));
  items.sort((a, b) => top(b) - top(a) || b.u - a.u);
  const taken = new Set();
  for (const i of items) for (let u = i.u; u <= top(i); u++) taken.add(u);
  const freeSlots = [];
  for (let u = 1; u <= units; u++) if (!taken.has(u)) freeSlots.push(u);
  return { units, model: loc.model, depthMm: loc.depthMm || null, face, counts, items, unplaced, freeSlots };
}
