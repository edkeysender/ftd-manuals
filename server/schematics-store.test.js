import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.FTD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ftd-schematics-'));
const store = await import('./store.js');
await store.initStore();
const sch = await import('./schematics-store.js');
const { blankContent } = await import('./docgen.js');

test.after(() => fs.rmSync(process.env.FTD_DATA_DIR, { recursive: true, force: true }));

test('library reads the defaults until something is saved, then the saved file', async () => {
  const lib = await sch.getLibrary();
  assert.ok(lib.devices.some((d) => d.id === 'behringer-umc404hd'));
  const t = await sch.createDeviceTemplate({ name: 'Netgear GS724T', category: 'switch', ports: [{ id: 'p1', label: 'Port 1', connector: 'rj45' }] });
  assert.equal(t.id, 'netgear-gs724t');
  assert.ok((await sch.getLibrary()).devices.some((d) => d.id === 'netgear-gs724t'));
  assert.ok((await sch.getLibrary()).devices.some((d) => d.id === 'behringer-umc404hd'), 'seed templates are kept when the first custom one is saved');
  await assert.rejects(sch.createDeviceTemplate({ name: 'Netgear GS724T', id: 'netgear-gs724t' }), /already exists/);
  const u = await sch.updateDeviceTemplate('netgear-gs724t', { model: 'GS724T', ports: [{ id: 'p1', label: 'Port 1', connector: 'rj45' }, { id: 'pwr', label: 'Power', connector: 'iec-c14', direction: 'in' }] });
  assert.equal(u.ports.length, 2);
  assert.equal(u.model, 'GS724T');
  await assert.rejects(sch.updateDeviceTemplate('nope', {}), /not found/);
});

test('connectors: saved set must be consistent', async () => {
  const lib = await sch.getLibrary();
  await assert.rejects(sch.saveConnectors({ connectors: lib.connectors, cables: [{ id: 'x', label: 'X', joins: [['rj45', 'nope']] }] }), /nope/);
  await assert.rejects(sch.saveConnectors({ connectors: [{ id: 'rj45', label: 'A' }, { id: 'rj45', label: 'B' }], cables: [] }), /twice/);
  const saved = await sch.saveConnectors({ connectors: [...lib.connectors, { id: 'rj12', label: 'RJ12', color: '#999' }], cables: [...lib.cables, { id: 'phone', label: 'Phone', joins: [['rj12', 'rj12']], style: {} }] });
  assert.ok(saved.connectors.some((c) => c.id === 'rj12'));
  assert.ok((await sch.getLibrary()).cables.some((c) => c.id === 'phone'));
});

test('installations: create, list, update, delete', async () => {
  const inst = await sch.createInstallation({ name: 'B737 NG FTD #001', device: 'B737 NG FTD', serialNumber: 'FTD-2026-001', operator: 'Example Academy' });
  assert.equal(inst.slug, 'b737-ng-ftd-001');
  await assert.rejects(sch.createInstallation({ name: 'B737 NG FTD #001' }), /already exists/);
  await assert.rejects(sch.createInstallation({ name: '' }), /name/i);
  const list = await sch.listInstallations();
  assert.equal(list.length, 1);
  assert.equal(list[0].serialNumber, 'FTD-2026-001');
  const upd = await sch.updateInstallation(inst.slug, { operator: 'Other Academy', serialNumber: '' });
  assert.equal(upd.operator, 'Other Academy');
  assert.equal(upd.serialNumber, null);
  assert.equal((await sch.getInstallation(inst.slug)).operator, 'Other Academy');
  assert.equal(await sch.getInstallation('nope'), null);
  const del = await sch.deleteInstallation(inst.slug);
  assert.equal(del.slug, inst.slug);
  assert.equal(await sch.getInstallation(inst.slug), null);
  await assert.rejects(sch.deleteInstallation(inst.slug), /not found/);
});

test('a manual can link an installation', async () => {
  const inst = await sch.createInstallation({ name: 'Linked sim' });
  const m = await store.createManual({ name: 'Linked manual', manual: 'technician', modules: [], installation: inst.slug });
  assert.equal(m.installation, 'linked-sim');
  await assert.rejects(sch.deleteInstallation(inst.slug), /Linked manual/);
  await store.updateManual(m.slug, { installation: '' });
  assert.equal((await store.getManual(m.slug)).installation, null);
  await sch.deleteInstallation(inst.slug);
});
