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
