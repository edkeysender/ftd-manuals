import test from 'node:test';
import assert from 'node:assert/strict';
import { cableKindsFor, portOf, isFree, compatibleTargets } from './schematicLib.js';

const lib = {
  connectors: [{ id: 'term' }, { id: 'rj45' }, { id: 'iec-c13' }, { id: 'iec-c14' }],
  cables: [
    { id: 'wire', label: 'Wire', joins: [['term', 'term']] }, { id: 'dc', label: 'DC', joins: [['term', 'term']] },
    { id: 'ethernet', label: 'Ethernet', joins: [['rj45', 'rj45']] }, { id: 'power', label: 'Power', joins: [['iec-c14', 'iec-c13']] },
  ],
  devices: [
    { id: 'pc', ports: [{ id: 'power', connector: 'iec-c14', direction: 'in', label: 'IEC' }, { id: 'lan', connector: 'rj45', direction: 'bidir', label: 'LAN' }] },
    { id: 'strip', ports: [{ id: 'out-1', connector: 'iec-c13', direction: 'out', label: 'Out 1' }, { id: 'out-2', connector: 'iec-c13', direction: 'out', label: 'Out 2' }] },
    { id: 'sw', ports: [{ id: 'p1', connector: 'rj45', direction: 'bidir', label: 'Port 1' }, { id: 'pwr', connector: 'term', direction: 'in', label: 'Power' }] },
  ],
};
const state = {
  devices: [{ id: 'a', template: 'pc', label: 'PC A' }, { id: 'b', template: 'pc', label: 'PC B' }, { id: 's', template: 'strip', label: 'Strip' }, { id: 'w', template: 'sw', label: 'Switch' }],
  blocks: [],
  cables: [{ id: 'c1', kind: 'power', from: { device: 's', port: 'out-1' }, to: { device: 'a', port: 'power' } }],
};

test('cableKindsFor is unordered; portOf and isFree read the state', () => {
  assert.deepEqual(cableKindsFor(lib, 'iec-c13', 'iec-c14'), ['power']);
  assert.deepEqual(cableKindsFor(lib, 'term', 'term'), ['wire', 'dc']);
  assert.deepEqual(cableKindsFor(lib, 'rj45', 'term'), []);
  assert.equal(portOf(lib, state, 'a', 'lan').connector, 'rj45');
  assert.equal(isFree(state, 'a', 'power'), false);
  assert.equal(isFree(state, 'a', 'lan'), true);
});

test('compatibleTargets lists free ports another cable kind can reach, never the same device or a busy port', () => {
  const t = compatibleTargets(lib, state, 'b', 'power');
  assert.deepEqual(t.map((x) => [x.device, x.port, x.kinds]), [['s', 'out-2', ['power']]]);
  const lan = compatibleTargets(lib, state, 'a', 'lan');
  assert.deepEqual(lan.map((x) => `${x.device}.${x.port}`), ['b.lan', 'w.p1']);
  assert.deepEqual(compatibleTargets(lib, state, 'w', 'pwr'), [], 'no other term port exists');
  // direction: out→out and in→in are refused
  const lib2 = { ...lib, devices: [...lib.devices, { id: 'src', ports: [{ id: 'o', connector: 'iec-c13', direction: 'out', label: 'O' }] }] };
  const state2 = { ...state, devices: [...state.devices, { id: 'x', template: 'src', label: 'X' }] };
  assert.ok(!compatibleTargets(lib2, state2, 's', 'out-2').some((x) => x.device === 'x'));
});
