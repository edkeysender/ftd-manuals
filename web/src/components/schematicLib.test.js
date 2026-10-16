import test from 'node:test';
import assert from 'node:assert/strict';
import { cableKindsFor, portOf, isFree, compatibleTargets, rackMap } from './schematicLib.js';

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

test('rackMap lays rack-mounted devices out by U, flags overlaps and lists the rest', () => {
  const lib2 = { ...lib, devices: [{ id: 'amp', ports: [], heightU: 2 }, { id: 'strip', ports: [], heightU: 1 }, { id: 'pc', ports: [], heightU: 4 }, { id: 'tiny', ports: [], heightU: 0 }] };
  const st = {
    locations: [{ id: 'r1', label: 'Rack 1', kind: 'rack', unitsU: 12 }, { id: 'ios', label: 'IOS', kind: 'area' }],
    devices: [
      { id: 'a', template: 'amp', label: 'Amp', location: 'r1', rack: { u: 3 } },
      { id: 's', template: 'strip', label: 'Strip', location: 'r1', rack: { u: 4 } },
      { id: 'p', template: 'pc', label: 'PC', location: 'r1', rack: { u: 9 } },
      { id: 't', template: 'tiny', label: 'Tiny', location: 'r1', rack: null },
      { id: 'x', template: 'pc', label: 'Elsewhere', location: 'ios', rack: { u: 1 } },
    ],
    blocks: [{ id: 'b', module: 'audio', location: 'r1', rack: { u: 11 } }],
    cables: [],
  };
  const m = rackMap(st, lib2, 'r1');
  assert.equal(m.units, 12);
  assert.deepEqual(m.items.map((i) => [i.id, i.u, i.h, i.overlap]), [['p', 9, 4, true], ['b', 11, 1, true], ['s', 4, 1, true], ['a', 3, 2, true]], 'top first; PC 9-12 overlaps the block at 11, amp 3-4 overlaps the strip at 4');
  assert.deepEqual(m.unplaced.map((i) => i.id), ['t']);
  assert.equal(m.items.find((i) => i.id === 'b').label, 'audio');
  assert.equal(rackMap(st, lib2, 'ios'), null, 'an area has no U map');
  const free = rackMap({ ...st, devices: st.devices.filter((d) => d.id !== 's'), blocks: [] }, lib2, 'r1');
  assert.deepEqual(free.items.map((i) => i.overlap), [false, false]);
  assert.deepEqual(free.freeSlots.slice(0, 3), [1, 2, 5]);
  // the rear face is its own map: a PDU at the back does not collide with the front, and is counted per face
  const two = { ...st, devices: [...st.devices, { id: 'pdu', template: 'strip', label: 'PDU', location: 'r1', rack: { u: 3, face: 'rear' } }] };
  const front = rackMap(two, lib2, 'r1', 'front');
  const rear = rackMap(two, lib2, 'r1', 'rear');
  assert.ok(!front.items.some((i) => i.id === 'pdu'));
  assert.deepEqual(rear.items.map((i) => [i.id, i.overlap]), [['pdu', false]]);
  assert.deepEqual(front.counts, { front: 4, rear: 1 });
  assert.deepEqual(rear.unplaced.map((i) => i.id), ['t'], 'unplaced devices are listed on both faces');
  // a device's own height wins over the template's
  const tall = { ...st, devices: st.devices.map((d) => (d.id === 's' ? { ...d, rack: { u: 4, h: 3 } } : d)) };
  const tm = rackMap(tall, lib2, 'r1');
  assert.equal(tm.items.find((i) => i.id === 's').h, 3);
  assert.equal(tm.model, undefined);
  assert.equal(rackMap({ ...st, locations: [{ ...st.locations[0], model: 'Lanberg 12U' }, st.locations[1]] }, lib2, 'r1').model, 'Lanberg 12U');
  // the strip can draw the device's picture: items carry the template id and its panel pictures
  const pic = { ...lib2, devices: lib2.devices.map((d) => (d.id === 'pc' ? { ...d, panels: { front: 'png' } } : d)) };
  const pm = rackMap(st, pic, 'r1');
  assert.deepEqual(pm.items.find((i) => i.id === 'p').panels, { front: 'png' });
  assert.equal(pm.items.find((i) => i.id === 'p').template, 'pc');
  assert.deepEqual(pm.items.find((i) => i.id === 'a').panels, {});
});
