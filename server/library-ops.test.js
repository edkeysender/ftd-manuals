import test from 'node:test';
import assert from 'node:assert/strict';
import { splitOps, previewLibrary, LIBRARY_OP_NAMES, describeLibraryOp } from './library-ops.js';
import { DEFAULT_LIBRARY, normalizeLibrary } from './library.js';
import { applyOps } from './schematic.js';

const lib = () => normalizeLibrary({ ...DEFAULT_LIBRARY, devices: [] });

test('library ops come first, schematic ops keep their order', () => {
  const { libraryOps, schematicOps } = splitOps([
    { op: 'add_location', id: 'r1', label: 'Rack 1', kind: 'rack' },
    { op: 'create_template', name: 'Projector X', category: 'other', ports: [{ id: 'hdmi', label: 'HDMI', connector: 'hdmi', direction: 'in' }] },
    { op: 'add_device', template: 'projector-x', label: 'Projector L' },
  ]);
  assert.deepEqual(libraryOps.map((o) => o.op), ['create_template']);
  assert.deepEqual(schematicOps.map((o) => o.op), ['add_location', 'add_device']);
  assert.ok(LIBRARY_OP_NAMES.includes('set_picture'));
});

test('previewLibrary applies template, connector, cable kind and picture ops in memory so add_device can use the new template', () => {
  const next = previewLibrary(lib(), [
    { op: 'create_connector', id: 'bnc', label: 'BNC', color: '#777' },
    { op: 'create_cable_kind', id: 'coax', label: 'Coax', joins: [['bnc', 'bnc']] },
    { op: 'create_template', name: 'Projector X', manufacturer: 'Acme', category: 'other', heightU: 0, ports: [{ id: 'hdmi', label: 'HDMI', connector: 'hdmi', direction: 'in' }, { id: 'sdi', label: 'SDI', connector: 'bnc', direction: 'in' }], pictures: { front: { attachment: 'proj.jpg' } } },
    { op: 'update_template', id: 'projector-x', model: 'X1', addPorts: [{ id: 'dp', label: 'DisplayPort', connector: 'dp', direction: 'in' }] },
    { op: 'set_picture', template: 'projector-x', side: 'rear', picture: { url: 'https://example.com/rear.png' } },
  ]);
  const t = next.devices.find((d) => d.id === 'projector-x');
  assert.equal(t.model, 'X1');
  assert.deepEqual(t.ports.map((p) => p.id), ['hdmi', 'sdi', 'dp']);
  assert.deepEqual(t.panels, { front: 'pending', rear: 'pending' });
  assert.ok(next.connectors.some((c) => c.id === 'bnc') && next.cables.some((c) => c.id === 'coax'));
  const state = { kind: 'installation', owner: 'x', devices: [], cables: [], blocks: [], locations: [], externalPorts: [] };
  const { state: s2 } = applyOps(state, [{ op: 'add_device', template: 'projector-x', label: 'Projector L' }], { library: next, catalog: [], modules: [], releasedSchematics: new Map() });
  assert.equal(s2.devices[0].template, 'projector-x');
});

test('previewLibrary refuses what the store would refuse', () => {
  assert.throws(() => previewLibrary(lib(), [{ op: 'create_template', name: 'Bad', ports: [{ id: 'a', label: 'A', connector: 'nope' }] }]), /nope/);
  assert.throws(() => previewLibrary(lib(), [{ op: 'create_template', name: 'UMC', id: 'behringer-umc404hd' }, { op: 'create_template', name: 'UMC', id: 'behringer-umc404hd' }]), /already exists/);
  assert.throws(() => previewLibrary(lib(), [{ op: 'update_template', id: 'ghost', model: 'x' }]), /not found/);
  assert.throws(() => previewLibrary(lib(), [{ op: 'create_cable_kind', id: 'coax', label: 'Coax', joins: [['bnc', 'bnc']] }]), /unknown connector/);
  assert.throws(() => previewLibrary(lib(), [{ op: 'set_picture', template: 'ghost', side: 'front', picture: { url: 'x' } }]), /not found/);
  assert.throws(() => previewLibrary(lib(), [{ op: 'create_template', name: 'P', pictures: { front: {} } }]), /attachment|url|dataBase64/);
  assert.match(describeLibraryOp({ op: 'create_template', name: 'Projector X' }), /Projector X/);
});

test('create_connector takes an IEC symbol and create_cable_kind its cores and screen; the defaults are a socket and an unscreened cable of unknown core count', () => {
  const next = previewLibrary(lib(), [
    { op: 'create_connector', id: 'bnc', label: 'BNC', symbol: 'plug' },
    { op: 'create_connector', id: 'f-type', label: 'F-type' },
    { op: 'create_cable_kind', id: 'coax', label: 'Coax', joins: [['bnc', 'bnc']], cores: 1, screened: true },
    { op: 'create_cable_kind', id: 'plain', label: 'Plain', joins: [['f-type', 'f-type']] },
  ]);
  assert.equal(next.connectors.find((c) => c.id === 'bnc').symbol, 'plug');
  assert.equal(next.connectors.find((c) => c.id === 'f-type').symbol, 'socket');
  const coax = next.cables.find((c) => c.id === 'coax');
  assert.deepEqual([coax.cores, coax.screened], [1, true]);
  const plain = next.cables.find((c) => c.id === 'plain');
  assert.deepEqual([plain.cores, plain.screened], [null, false]);
  assert.throws(() => previewLibrary(lib(), [{ op: 'create_connector', id: 'z', label: 'Z', symbol: 'triangle' }]), /symbol/);
});
