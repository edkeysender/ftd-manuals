import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIBRARY } from './library.js';
import { emptySchematic, applyOps, validateSchematic, connectorFace, cableSchedule, SchematicError, filterSchematic } from './schematic.js';

const ctx = () => ({ library: DEFAULT_LIBRARY, catalog: [], modules: [{ slug: 'audio-system', name: 'Audio system' }], releasedSchematics: new Map() });

function moduleWithUmc() {
  const { state } = applyOps(
    emptySchematic({ kind: 'module', owner: 'audio-system' }),
    [
      { op: 'add_device', id: 'umc', template: 'behringer-umc404hd', label: 'UMC404HD' },
      { op: 'add_device', id: 'hs', template: 'headset', label: 'Headset L' },
      { op: 'connect', id: 'c1', from: { device: 'umc', port: 'phones-1' }, to: { device: 'hs', port: 'jack' }, label: 'AUD-01' },
      { op: 'set_external_port', id: 'power-in', label: 'Power in', device: 'umc', port: 'pwr' },
      { op: 'set_external_port', id: 'usb-host', label: 'USB to host', device: 'umc', port: 'usb' },
    ],
    ctx()
  );
  return state;
}

test('emptySchematic', () => {
  const s = emptySchematic({ kind: 'installation', owner: 'sim-1' });
  assert.equal(s.kind, 'installation');
  assert.equal(s.version, 'A1.0');
  assert.deepEqual(s.devices, []);
  assert.deepEqual(s.layout, { nodes: {}, manual: [] });
});

test('add_device derives an id from the label and infers the cable kind on connect', () => {
  const s = moduleWithUmc();
  assert.equal(s.devices.length, 2);
  assert.equal(s.cables[0].kind, 'audio');
  const { state } = applyOps(s, [{ op: 'add_device', template: 'headset', label: 'Headset R' }], ctx());
  assert.equal(state.devices[2].id, 'headset-r');
});

test('applyOps is atomic and names the failing op', () => {
  const s = moduleWithUmc();
  const before = JSON.stringify(s);
  assert.throws(
    () => applyOps(s, [{ op: 'add_device', template: 'pc', label: 'PC' }, { op: 'connect', from: { device: 'pc', port: 'nope' }, to: { device: 'umc', port: 'usb' } }], ctx()),
    (e) => e instanceof SchematicError && e.index === 1 && /port "nope"/.test(e.message)
  );
  assert.equal(JSON.stringify(s), before);
});

test('connect refuses incompatible connectors, busy ports and out→out', () => {
  const s = moduleWithUmc();
  assert.throws(() => applyOps(s, [{ op: 'connect', from: { device: 'umc', port: 'usb' }, to: { device: 'hs', port: 'jack' } }], ctx()), /no cable kind joins/i);
  assert.throws(() => applyOps(s, [{ op: 'add_device', id: 'hs2', template: 'headset' }, { op: 'connect', from: { device: 'umc', port: 'phones-1' }, to: { device: 'hs2', port: 'jack' } }], ctx()), /already has cable/i);
  assert.throws(() => applyOps(s, [{ op: 'add_device', id: 'umc2', template: 'behringer-umc404hd' }, { op: 'connect', from: { device: 'umc', port: 'phones-2' }, to: { device: 'umc2', port: 'phones-1' } }], ctx()), /two outputs/i);
});

test('connect needs an explicit kind when several fit, and the kind must join the pair', () => {
  const lib = { ...DEFAULT_LIBRARY, cables: [...DEFAULT_LIBRARY.cables, { id: 'patch', label: 'Patch', joins: [['rj45', 'rj45']], style: {} }] };
  const c = { ...ctx(), library: lib };
  const { state } = applyOps(emptySchematic({ kind: 'module', owner: 'm' }), [{ op: 'add_device', id: 'a', template: 'pc' }, { op: 'add_device', id: 'b', template: 'switch-24' }], c);
  assert.throws(() => applyOps(state, [{ op: 'connect', from: { device: 'a', port: 'lan' }, to: { device: 'b', port: 'p1' } }], c), /ethernet, patch/);
  assert.throws(() => applyOps(state, [{ op: 'connect', kind: 'audio', from: { device: 'a', port: 'lan' }, to: { device: 'b', port: 'p1' } }], c), /audio/);
  const ok = applyOps(state, [{ op: 'connect', kind: 'patch', from: { device: 'a', port: 'lan' }, to: { device: 'b', port: 'p1' } }], c);
  assert.equal(ok.state.cables[0].kind, 'patch');
});

test('remove_device refuses while cabled unless cascade', () => {
  const s = moduleWithUmc();
  assert.throws(() => applyOps(s, [{ op: 'remove_device', id: 'hs' }], ctx()), /cable/i);
  const r = applyOps(s, [{ op: 'remove_device', id: 'hs', cascade: true }], ctx());
  assert.equal(r.state.cables.length, 0);
  assert.equal(r.state.devices.length, 1);
});

test('disconnect then update_cable of the same id fails; update ops patch fields', () => {
  const s = moduleWithUmc();
  assert.throws(() => applyOps(s, [{ op: 'disconnect', id: 'c1' }, { op: 'update_cable', id: 'c1', label: 'X' }], ctx()), (e) => e.index === 1);
  const { state } = applyOps(s, [{ op: 'update_device', id: 'hs', label: 'Headset left', notes: 'Captain' }, { op: 'update_cable', id: 'c1', label: 'AUD-99', length: 2.5 }], ctx());
  assert.equal(state.devices[1].label, 'Headset left');
  assert.equal(state.cables[0].length, 2.5);
});

test('external ports: only existing device ports, module only, unset removes', () => {
  const s = moduleWithUmc();
  assert.deepEqual(connectorFace(s, ctx()).map((p) => p.id), ['power-in', 'usb-host']);
  assert.equal(connectorFace(s, ctx())[0].connector, 'iec-c14');
  assert.throws(() => applyOps(s, [{ op: 'set_external_port', id: 'x', label: 'X', device: 'umc', port: 'nope' }], ctx()), /port "nope"/);
  const { state } = applyOps(s, [{ op: 'unset_external_port', id: 'usb-host' }], ctx());
  assert.deepEqual(state.externalPorts.map((p) => p.id), ['power-in']);
  const inst = emptySchematic({ kind: 'installation', owner: 'sim' });
  assert.throws(() => applyOps(inst, [{ op: 'set_external_port', id: 'x', label: 'X', device: 'a', port: 'b' }], ctx()), /module schematic/i);
});

test('installation: locations, blocks from released module schematics, cables to block ports', () => {
  const released = { ...moduleWithUmc(), status: 'released', revision: 3 };
  const c = { ...ctx(), releasedSchematics: new Map([['audio-system', released]]) };
  const inst = emptySchematic({ kind: 'installation', owner: 'sim' });
  assert.throws(() => applyOps(inst, [{ op: 'place_block', id: 'audio', module: 'audio-system', location: 'rack-1' }], c), /location "rack-1"/);
  assert.throws(() => applyOps(inst, [{ op: 'add_location', id: 'rack-1', label: 'Rack 1', kind: 'rack', unitsU: 42 }, { op: 'place_block', id: 'x', module: 'other', location: 'rack-1' }], c), /no released schematic/i);
  const { state, summary } = applyOps(
    inst,
    [
      { op: 'add_location', id: 'rack-1', label: 'Rack 1', kind: 'rack', unitsU: 42 },
      { op: 'add_location', label: 'Cockpit' },
      { op: 'place_block', id: 'audio', module: 'audio-system', location: 'rack-1', rack: { u: 12 } },
      { op: 'add_device', id: 'pdu-1', template: 'pdu-8', label: 'Power strip 1', location: 'rack-1' },
      { op: 'connect', from: { device: 'pdu-1', port: 'out-1' }, to: { block: 'audio', port: 'power-in' }, label: 'PWR-07' },
    ],
    c
  );
  assert.equal(state.locations[1].id, 'cockpit');
  assert.equal(state.locations[1].kind, 'area');
  assert.deepEqual(state.blocks[0].schematic, { version: 'A1.0', revision: 3 });
  assert.equal(state.cables[0].kind, 'power');
  assert.equal(summary.length, 5);
  assert.throws(() => applyOps(state, [{ op: 'connect', from: { device: 'pdu-1', port: 'out-2' }, to: { block: 'audio', port: 'nope' } }], c), /external port "nope"/);
  assert.throws(() => applyOps(state, [{ op: 'remove_location', id: 'rack-1' }], c), /still holds/i);
  assert.throws(() => applyOps(state, [{ op: 'add_device', template: 'pc', location: 'nowhere' }], c), /location "nowhere"/);
  // module-only ops are refused on an installation and vice versa
  assert.throws(() => applyOps(moduleWithUmc(), [{ op: 'add_location', label: 'X' }], c), /installation/i);
  // cable schedule names block ends with the module name
  const sched = cableSchedule(state, c);
  assert.equal(sched[0].to, 'Audio system');
  assert.equal(sched[0].toPort, 'Power in');
  assert.equal(sched[0].kindLabel, 'Power');
});

test('refresh_block re-pins the newest release and validation flags a dropped external port', () => {
  const v1 = { ...moduleWithUmc(), status: 'released', revision: 3 };
  const c1 = { ...ctx(), releasedSchematics: new Map([['audio-system', v1]]) };
  const { state } = applyOps(
    emptySchematic({ kind: 'installation', owner: 'sim' }),
    [
      { op: 'add_location', id: 'rack-1', label: 'Rack 1', kind: 'rack' },
      { op: 'place_block', id: 'audio', module: 'audio-system', location: 'rack-1' },
      { op: 'add_device', id: 'pdu-1', template: 'pdu-8', location: 'rack-1' },
      { op: 'connect', from: { device: 'pdu-1', port: 'out-1' }, to: { block: 'audio', port: 'power-in' } },
    ],
    c1
  );
  const v2 = applyOps(v1, [{ op: 'unset_external_port', id: 'power-in' }], c1).state;
  const c2 = { ...ctx(), releasedSchematics: new Map([['audio-system', { ...v2, version: 'A1.1', revision: 1, status: 'released' }]]) };
  const v = validateSchematic(state, c2);
  assert.ok(v.warnings.some((w) => w.code === 'block-outdated' && w.ref === 'audio'));
  assert.ok(v.errors.some((e) => e.code === 'port-missing' && /power-in/.test(e.message)));
  const refreshed = applyOps(state, [{ op: 'refresh_block', id: 'audio' }], c2).state;
  assert.deepEqual(refreshed.blocks[0].schematic, { version: 'A1.1', revision: 1 });
  assert.ok(validateSchematic(refreshed, c2).errors.some((e) => e.code === 'port-missing'));
  assert.ok(!validateSchematic(refreshed, c2).warnings.some((w) => w.code === 'block-outdated'));
});

test('validation warnings: unlabeled cable, unpowered device, empty location, device outside any location', () => {
  const { state } = applyOps(
    emptySchematic({ kind: 'installation', owner: 'sim' }),
    [
      { op: 'add_location', id: 'rack-1', label: 'Rack 1', kind: 'rack' },
      { op: 'add_location', id: 'ios', label: 'IOS' },
      { op: 'add_device', id: 'pc', template: 'pc', location: 'rack-1' },
      { op: 'add_device', id: 'sw', template: 'switch-24' },
      { op: 'connect', from: { device: 'pc', port: 'lan' }, to: { device: 'sw', port: 'p1' } },
    ],
    ctx()
  );
  const v = validateSchematic(state, ctx());
  assert.deepEqual(v.errors, []);
  const codes = v.warnings.map((w) => w.code).sort();
  assert.deepEqual(codes, ['cable-unlabeled', 'device-unplaced', 'device-unpowered', 'device-unpowered', 'location-empty']);
});

test('move and tidy maintain the layout, and the device list keeps hardwareId when given', () => {
  const c = { ...ctx(), catalog: [{ id: 'behringer-umc404hd', name: 'Behringer UMC404HD', type: 'cots', manufacturer: 'Behringer', model: 'UMC404HD' }] };
  const { state } = applyOps(
    emptySchematic({ kind: 'module', owner: 'm' }),
    [{ op: 'add_device', id: 'umc', template: 'behringer-umc404hd', hardwareId: 'behringer-umc404hd' }, { op: 'move', id: 'umc', x: 10, y: 20 }],
    c
  );
  assert.deepEqual(state.layout, { nodes: { umc: { x: 10, y: 20 } }, manual: ['umc'] });
  assert.equal(state.devices[0].hardwareId, 'behringer-umc404hd');
  assert.throws(() => applyOps(state, [{ op: 'add_device', id: 'x', hardwareId: 'unknown-part' }], c), /catalog/i);
  const tidy = applyOps(state, [{ op: 'tidy' }], c).state;
  assert.deepEqual(tidy.layout.manual, []);
  assert.throws(() => applyOps(state, [{ op: 'fly' }], c), /unknown op "fly"/i);
});

test('filterSchematic keeps a location, everything in it, its cables and the far ends of those cables', () => {
  const { state } = applyOps(
    emptySchematic({ kind: 'installation', owner: 'sim' }),
    [
      { op: 'add_location', id: 'rack-1', label: 'Rack 1', kind: 'rack' },
      { op: 'add_location', id: 'rack-2', label: 'Rack 2', kind: 'rack' },
      { op: 'add_location', id: 'cockpit', label: 'Cockpit' },
      { op: 'add_device', id: 'pdu', template: 'pdu-8', location: 'rack-1' },
      { op: 'add_device', id: 'pc', template: 'pc', location: 'rack-2' },
      { op: 'add_device', id: 'sw', template: 'switch-24', location: 'rack-2' },
      { op: 'add_device', id: 'hs', template: 'headset', location: 'cockpit' },
      { op: 'add_device', id: 'umc', template: 'behringer-umc404hd', location: 'rack-1' },
      { op: 'connect', from: { device: 'pdu', port: 'out-1' }, to: { device: 'pc', port: 'pwr' }, label: 'PWR-1' },
      { op: 'connect', from: { device: 'pc', port: 'lan' }, to: { device: 'sw', port: 'p1' }, label: 'NET-1' },
      { op: 'connect', from: { device: 'umc', port: 'phones-1' }, to: { device: 'hs', port: 'jack' }, label: 'AUD-1' },
    ],
    ctx()
  );
  const v = filterSchematic(state, { location: 'rack-2' });
  assert.deepEqual(v.devices.map((d) => d.id).sort(), ['pc', 'pdu', 'sw']);
  assert.deepEqual(v.cables.map((c) => c.label).sort(), ['NET-1', 'PWR-1']);
  assert.deepEqual(v.locations.map((l) => l.id), ['rack-1', 'rack-2'], 'the selected rack and the far ends’ locations, in the original order');
  assert.deepEqual(v.view, { location: 'rack-2', deviceIds: ['pc', 'sw'], blockIds: [], cableIds: v.cables.map((c) => c.id), partnerIds: ['pdu'] });
  assert.equal(filterSchematic(state, { location: null }), state);
  assert.throws(() => filterSchematic(state, { location: 'nope' }), /unknown location/);
});

test('validation warns when an installation has more than four racks', () => {
  const ops = [1, 2, 3, 4, 5].map((i) => ({ op: 'add_location', id: `rack-${i}`, label: `Rack ${i}`, kind: 'rack' }));
  const { state } = applyOps(emptySchematic({ kind: 'installation', owner: 'sim' }), ops, ctx());
  const v = validateSchematic(state, ctx());
  assert.ok(v.warnings.some((w) => w.code === 'too-many-racks' && /4/.test(w.message)));
  const four = applyOps(emptySchematic({ kind: 'installation', owner: 'sim' }), ops.slice(0, 4), ctx()).state;
  assert.ok(!validateSchematic(four, ctx()).warnings.some((w) => w.code === 'too-many-racks'));
});

test('a rack position carries the face it is mounted on, front by default', () => {
  const { state } = applyOps(
    emptySchematic({ kind: 'installation', owner: 'sim' }),
    [
      { op: 'add_location', id: 'rack-1', label: 'Rack 1', kind: 'rack' },
      { op: 'add_device', id: 'pdu', template: 'pdu-8', location: 'rack-1', rack: { u: 1, face: 'rear' } },
      { op: 'add_device', id: 'pc', template: 'pc', location: 'rack-1', rack: { u: 1 } },
    ],
    ctx()
  );
  assert.deepEqual(state.devices[0].rack, { u: 1, face: 'rear' });
  assert.deepEqual(state.devices[1].rack, { u: 1, face: 'front' });
  assert.throws(() => applyOps(state, [{ op: 'update_device', id: 'pc', rack: { u: 2, face: 'side' } }], ctx()), /front or rear/);
  const moved = applyOps(state, [{ op: 'update_device', id: 'pc', rack: { u: 2, face: 'rear' } }], ctx()).state;
  assert.deepEqual(moved.devices[1].rack, { u: 2, face: 'rear' });
});

test('a rack location has a model and a U count that can be edited; a device may override its height in U', () => {
  const { state } = applyOps(
    emptySchematic({ kind: 'installation', owner: 'sim' }),
    [
      { op: 'add_location', id: 'rack-1', label: 'Rack 1', kind: 'rack', unitsU: 24, model: 'Lanberg 24U 800×1000' },
      { op: 'add_device', id: 'pc', template: 'pc', location: 'rack-1', rack: { u: 1, h: 5 } },
    ],
    ctx()
  );
  assert.equal(state.locations[0].model, 'Lanberg 24U 800×1000');
  assert.equal(state.locations[0].unitsU, 24);
  assert.deepEqual(state.devices[0].rack, { u: 1, face: 'front', h: 5 });
  const upd = applyOps(state, [{ op: 'update_location', id: 'rack-1', model: 'Triton 42U', unitsU: 42 }, { op: 'update_device', id: 'pc', rack: { u: 1 } }], ctx()).state;
  assert.equal(upd.locations[0].model, 'Triton 42U');
  assert.equal(upd.locations[0].unitsU, 42);
  assert.deepEqual(upd.devices[0].rack, { u: 1, face: 'front' }, 'no h means the template height applies');
  assert.throws(() => applyOps(state, [{ op: 'update_device', id: 'pc', rack: { u: 1, h: 0.5 } }], ctx()), /whole number of U/);
  assert.throws(() => applyOps(state, [{ op: 'update_location', id: 'rack-1', unitsU: 0 }], ctx()), /between 1 and 60/);
});
