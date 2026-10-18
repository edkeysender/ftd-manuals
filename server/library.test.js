import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIBRARY, normalizeLibrary, normalizeTemplate, cableKindsFor, templateFor, templateIdFor } from './library.js';

test('default library has the connectors and cable kinds the spec lists', () => {
  const ids = DEFAULT_LIBRARY.connectors.map((c) => c.id);
  for (const id of ['rj45', 'usb-a', 'usb-b', 'usb-c', 'iec-c13', 'iec-c14', 'schuko', 'trs-6.35', 'xlr-m', 'xlr-f', 'hdmi', 'dp', 'db9']) {
    assert.ok(ids.includes(id), `connector ${id}`);
  }
  assert.deepEqual(DEFAULT_LIBRARY.cables.map((c) => c.id).sort(), ['audio', 'ethernet', 'power', 'serial', 'usb', 'video']);
  assert.ok(DEFAULT_LIBRARY.devices.some((d) => d.id === 'behringer-umc404hd'));
});

test('cableKindsFor is unordered and empty for an impossible pair', () => {
  assert.deepEqual(cableKindsFor(DEFAULT_LIBRARY, 'rj45', 'rj45'), ['ethernet']);
  assert.deepEqual(cableKindsFor(DEFAULT_LIBRARY, 'schuko', 'iec-c14'), ['power']);
  assert.deepEqual(cableKindsFor(DEFAULT_LIBRARY, 'iec-c14', 'schuko'), ['power']);
  assert.deepEqual(cableKindsFor(DEFAULT_LIBRARY, 'rj45', 'usb-b'), []);
});

test('normalizeLibrary fills missing parts from the defaults and drops broken rows', () => {
  const lib = normalizeLibrary({ devices: [{ id: 'x', name: 'X' }, { name: 'no id' }, null] });
  assert.equal(lib.connectors.length, DEFAULT_LIBRARY.connectors.length);
  assert.equal(lib.cables.length, DEFAULT_LIBRARY.cables.length);
  assert.deepEqual(lib.devices.map((d) => d.id), ['x']);
  assert.deepEqual(lib.devices[0].ports, []);
  assert.equal(lib.devices[0].category, 'other');
});

test('normalizeTemplate derives the id, validates ports and refuses duplicates', () => {
  const t = normalizeTemplate(
    { name: 'Netgear GS724T', category: 'switch', ports: [{ id: 'p1', label: 'Port 1', connector: 'rj45' }, { label: 'Power', connector: 'iec-c14', direction: 'in' }] },
    new Set()
  );
  assert.equal(t.id, 'netgear-gs724t');
  assert.equal(t.ports[0].direction, 'bidir');
  assert.equal(t.ports[0].side, 'right');
  assert.equal(t.ports[1].id, 'power');
  assert.equal(t.heightU, 1);
  assert.throws(() => normalizeTemplate({ name: '' }), /name/i);
  assert.throws(() => normalizeTemplate({ name: 'A', category: 'spaceship' }), /category/i);
  assert.throws(() => normalizeTemplate({ name: 'A', ports: [{ id: 'p', label: 'P', connector: 'nope' }] }), /connector/i);
  assert.throws(() => normalizeTemplate({ name: 'A', ports: [{ id: 'p', label: 'P', connector: 'rj45' }, { id: 'p', label: 'Q', connector: 'rj45' }] }), /port id/i);
  assert.throws(() => normalizeTemplate({ name: 'A', ports: [{ id: 'p', label: 'P', connector: 'rj45', direction: 'sideways' }] }), /direction/i);
});

test('templateIdFor and templateFor', () => {
  assert.equal(templateIdFor('Power strip 8', new Set(['power-strip-8'])), 'power-strip-8-2');
  assert.equal(templateFor(DEFAULT_LIBRARY, 'behringer-umc404hd').name, 'Behringer UMC404HD');
  assert.equal(templateFor(DEFAULT_LIBRARY, 'nope'), null);
});

test('normalizeTemplate keeps the panel pictures a template has', () => {
  const t = normalizeTemplate({ name: 'UMC202HD', panels: { front: 'svg', rear: 'png' } });
  assert.deepEqual(t.panels, { front: 'svg', rear: 'png' });
  assert.deepEqual(normalizeTemplate({ name: 'Plain' }).panels, {});
  assert.throws(() => normalizeTemplate({ name: 'Bad', panels: { 'Top View!': 'svg' } }), /picture name/);
  // beyond the two faces, a template may carry named pictures: a mainboard's rear I/O, a card's bracket
  assert.deepEqual(normalizeTemplate({ name: 'PC', panels: { front: 'jpg', 'mainboard-io': 'png', 'gpu-io': 'png' } }).panels, { front: 'jpg', 'mainboard-io': 'png', 'gpu-io': 'png' });
});

test('normalizeTemplate keeps the physical size (mm) of a device and refuses a nonsense one', () => {
  const t = normalizeTemplate({ name: 'Case', category: 'pc', heightU: 4, sizeMm: { w: '430', h: 176, d: 468 } });
  assert.deepEqual(t.sizeMm, { w: 430, h: 176, d: 468 });
  assert.equal(normalizeTemplate({ name: 'Plain', category: 'pc' }).sizeMm, null);
  assert.deepEqual(normalizeTemplate({ name: 'Deep only', category: 'pc', sizeMm: { d: 300 } }).sizeMm, { d: 300 });
  assert.throws(() => normalizeTemplate({ name: 'Bad', category: 'pc', sizeMm: { d: -1 } }), /size/i);
});
