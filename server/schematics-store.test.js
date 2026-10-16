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
const { SchematicError } = await import('./schematic.js');

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

async function makeModule(name, hardware = []) {
  const r = await store.createModuleDoc({ name, hardware, softwares: [] }, [{ manual: 'technician', content: blankContent(name, [], 'technician', []) }]);
  return r.slug;
}

test('module schematic: create, ops as commits, review, release with note, next version', async () => {
  const slug = await makeModule('Audio system', [{ name: 'Behringer UMC404HD', type: 'cots', manufacturer: 'Behringer', model: 'UMC404HD' }]);
  assert.equal(await sch.getSchematic(slug), null, 'no schematic yet');
  assert.equal(await sch.getSchematic('no-such-module'), null);
  const created = await sch.createSchematic(slug);
  assert.equal(created.version, 'A1.0');
  assert.equal(created.branch, `draft/${slug}-schematic-a1.0`);
  await assert.rejects(sch.createSchematic(slug), /already open/);

  const hwId = (await store.listHardware()).find((h) => h.name === 'Behringer UMC404HD').id;
  const dry = await sch.applySchematicOps(slug, [{ op: 'add_device', id: 'umc', hardwareId: hwId, template: 'behringer-umc404hd' }], { dryRun: true });
  assert.equal(dry.state.devices.length, 1);
  assert.equal((await sch.getSchematic(slug)).state.devices.length, 0, 'dry run writes nothing');

  const r = await sch.applySchematicOps(
    slug,
    [
      { op: 'add_device', id: 'umc', hardwareId: hwId, template: 'behringer-umc404hd', label: 'UMC404HD' },
      { op: 'add_device', id: 'hs', template: 'headset', label: 'Headset L' },
      { op: 'connect', id: 'c1', from: { device: 'umc', port: 'phones-1' }, to: { device: 'hs', port: 'jack' }, label: 'AUD-01' },
      { op: 'set_external_port', id: 'power-in', label: 'Power in', device: 'umc', port: 'pwr' },
    ],
    { summary: 'First wiring' }
  );
  assert.equal(r.state.revision, 2);
  assert.equal(r.summary.length, 4);
  await assert.rejects(sch.applySchematicOps(slug, [{ op: 'connect', from: { device: 'umc', port: 'nope' }, to: { device: 'hs', port: 'jack' } }]), (e) => e instanceof SchematicError && e.index === 0);

  let g = await sch.getSchematic(slug);
  assert.equal(g.owner.kind, 'module');
  assert.equal(g.owner.name, 'Audio system');
  assert.equal(g.isDraft, true);
  assert.equal(g.face.length, 1);
  assert.equal(g.schedule[0].kindLabel, 'Audio');
  assert.ok(g.history.length >= 2);
  assert.ok(g.validation.warnings.some((w) => w.code === 'device-unpowered'));

  await assert.rejects(sch.releaseSchematic(slug, { note: '' }), (e) => e.code === 'note-required');
  assert.equal((await sch.setSchematicStatus(slug, 'in-review')).status, 'in-review');
  const rel = await sch.releaseSchematic(slug, { note: 'Initial wiring of the audio system.' });
  assert.equal(rel.status, 'released');
  assert.equal(rel.branch, null);
  assert.equal(rel.releaseRecord.at(-1).summary, 'Initial wiring of the audio system.');
  assert.ok(rel.releaseRecord.at(-1).public);
  assert.ok(!(await store.repo.branches()).includes(`draft/${slug}-schematic-a1.0`));
  g = await sch.getSchematic(slug);
  assert.equal(g.isDraft, false);
  assert.equal(g.released.version, 'A1.0');
  assert.equal((await sch.releasedSchematicOf(slug)).revision, rel.revision);
  await assert.rejects(sch.applySchematicOps(slug, [{ op: 'tidy' }]), /no open draft/i);

  const next = await sch.createSchematic(slug, { bump: 'minor' });
  assert.equal(next.version, 'A1.1');
  assert.equal(next.revision, 1);
  assert.equal(next.devices.length, 2, 'the next version starts from the released netlist');
  assert.equal((await sch.releasedSchematicOf(slug)).version, 'A1.0', 'main still holds the release');
  g = await sch.getSchematic(slug);
  assert.equal(g.state.version, 'A1.1');
  assert.equal(g.released.version, 'A1.0');
  await sch.discardSchematic(slug);
  assert.equal((await sch.getSchematic(slug)).state.version, 'A1.0');
  await assert.rejects(sch.discardSchematic(slug), /no open draft/i);
});

test('hotfix: branch reopens the released version, publish writes it back, release note can be rewritten', async () => {
  const slug = await makeModule('Hotfix module');
  await sch.createSchematic(slug);
  await sch.applySchematicOps(slug, [{ op: 'add_device', id: 'hs', template: 'headset', label: 'Headset' }]);
  await sch.releaseSchematic(slug, { note: 'First.' });
  const released = await sch.releasedSchematicOf(slug);
  await assert.rejects(sch.startSchematicHotfix('no-such'), /not found/);
  const hf = await sch.startSchematicHotfix(slug);
  assert.equal(hf.revision, released.revision + 1);
  assert.ok(hf.hotfix);
  assert.equal(hf.status, 'released');
  await assert.rejects(sch.createSchematic(slug), /hotfix|open/i);
  await assert.rejects(sch.startSchematicHotfix(slug), /already/);
  const g = await sch.getSchematic(slug);
  assert.equal(g.editable, true);
  await sch.applySchematicOps(slug, [{ op: 'update_device', id: 'hs', label: 'Headset (captain)' }]);
  assert.equal((await sch.releasedSchematicOf(slug)).devices[0].label, 'Headset', 'main keeps compiling the released copy');
  const pub = await sch.releaseSchematic(slug, { note: 'Renamed the headset.' });
  assert.equal(pub.hotfix, null);
  assert.equal(pub.version, 'A1.0');
  assert.equal((await sch.releasedSchematicOf(slug)).devices[0].label, 'Headset (captain)');
  const noted = await sch.setSchematicReleaseNote(slug, 'Renamed the captain headset.');
  assert.equal(noted.releaseRecord.at(-1).summary, 'Renamed the captain headset.');
});

test('installation: blocks follow released module schematics, outdated blocks are reported, resolveSchematicRef', async () => {
  const slug = await makeModule('Rack audio');
  await sch.createSchematic(slug);
  await sch.applySchematicOps(slug, [{ op: 'add_device', id: 'umc', template: 'behringer-umc404hd' }, { op: 'set_external_port', id: 'power-in', label: 'Power in', device: 'umc', port: 'pwr' }]);
  await assert.rejects(sch.applySchematicOps(instRefOf(await sch.createInstallation({ name: 'Sim A' })), [{ op: 'place_block', id: 'audio', module: slug, location: 'rack-1' }]), /no released schematic/);
  await sch.releaseSchematic(slug, { note: 'Released.' });
  const ref = sch.instRef('sim-a');
  assert.equal(await sch.resolveSchematicRef('Sim A'), ref);
  assert.equal(await sch.resolveSchematicRef('sim-a'), ref);
  assert.equal(await sch.resolveSchematicRef(slug), slug);
  const g0 = await sch.getSchematic(ref);
  assert.equal(g0.owner.kind, 'installation');
  assert.equal(g0.state.locations.length, 3, 'default locations');
  await sch.applySchematicOps(ref, [
    { op: 'place_block', id: 'audio', module: slug, location: 'rack-1' },
    { op: 'add_device', id: 'pdu-1', template: 'pdu-8', label: 'Power strip 1', location: 'rack-1' },
    { op: 'connect', from: { device: 'pdu-1', port: 'out-1' }, to: { block: 'audio', port: 'power-in' }, label: 'PWR-01' },
  ]);
  let g = await sch.getSchematic(ref);
  assert.deepEqual(g.validation.errors, []);
  assert.equal(g.schedule[0].to, 'Rack audio');
  // the module releases a new schematic version: the block is outdated until refreshed
  await sch.createSchematic(slug);
  await sch.applySchematicOps(slug, [{ op: 'add_device', id: 'hs', template: 'headset' }]);
  await sch.releaseSchematic(slug, { note: 'Added the headset.' });
  g = await sch.getSchematic(ref);
  assert.ok(g.validation.warnings.some((w) => w.code === 'block-outdated'));
  await sch.applySchematicOps(ref, [{ op: 'refresh_block', id: 'audio' }]);
  g = await sch.getSchematic(ref);
  assert.ok(!g.validation.warnings.some((w) => w.code === 'block-outdated'));
  assert.equal(g.state.blocks[0].schematic.version, 'A1.1');
  const rel = await sch.releaseSchematic(ref, { note: 'Installation wiring issue 1.' });
  assert.equal(rel.status, 'released');
  const list = await sch.listInstallations();
  assert.equal(list.find((i) => i.slug === 'sim-a').schematic.status, 'released');
});

function instRefOf(rec) {
  return sch.instRef(rec.slug);
}

test('promoteDeviceToModule creates the module, its catalog item and a schematic exposing every port', async () => {
  const t = await sch.createDeviceTemplate({ name: 'Cisco SG350', category: 'switch', manufacturer: 'Cisco', model: 'SG350-10', ports: [{ id: 'pwr', label: 'Power', connector: 'iec-c14', direction: 'in' }, { id: 'p1', label: 'Port 1', connector: 'rj45' }] });
  const r = await sch.promoteDeviceToModule(t.id, { name: 'Core switch', code: 'CSW' });
  assert.equal(r.slug, 'core-switch');
  const m = await store.getModule('core-switch');
  assert.equal(m.module.hardwareItems[0].manufacturer, 'Cisco');
  assert.equal((await sch.getLibrary()).devices.find((d) => d.id === t.id).hardwareId, r.hardwareId);
  const g = await sch.getSchematic('core-switch');
  assert.equal(g.state.devices.length, 1);
  assert.deepEqual(g.face.map((p) => p.port), ['pwr', 'p1']);
  await assert.rejects(sch.promoteDeviceToModule('nope', { name: 'X' }), /not found/);
});

test('release is refused while validation has errors, and a used template cannot be deleted', async () => {
  const slug = await makeModule('Broken module');
  await sch.createSchematic(slug);
  await sch.applySchematicOps(slug, [{ op: 'add_device', id: 'sw', template: 'switch-24' }]);
  await assert.rejects(sch.deleteDeviceTemplate('switch-24'), /broken-module/);
  // an error that only validation sees: the device's template vanishes from the library file
  const lib = await sch.getLibrary();
  await store.mutate(async () => {
    await store.repo.checkout('main');
    await store.repo.writeFile(sch.LIB_DEVICES_FILE, JSON.stringify({ devices: lib.devices.filter((d) => d.id !== 'switch-24') }, null, 2) + '\n');
    await store.repo.commitAll('test: drop switch-24');
  });
  sch.dropCaches();
  await assert.rejects(sch.releaseSchematic(slug, { note: 'x' }), (e) => e.code === 'blockers' && /template-missing/.test(JSON.stringify(e.blockers)));
  await store.mutate(async () => {
    await store.repo.checkout('main');
    await store.repo.writeFile(sch.LIB_DEVICES_FILE, JSON.stringify({ devices: lib.devices }, null, 2) + '\n');
    await store.repo.commitAll('test: restore switch-24');
  });
  sch.dropCaches();
});

test('the technician manual and the assembled manual carry the released wiring', async () => {
  const slug = await makeModule('Wired module');
  const m = await store.getModule(slug);
  const techKey = m.docs.find((d) => d.manual === 'technician').key;
  assert.doesNotMatch((await store.getDoc(slug, techKey)).generated, /Connections/, 'no schematic yet');
  await sch.createSchematic(slug);
  await sch.applySchematicOps(slug, [{ op: 'add_device', id: 'hs', template: 'headset', label: 'Headset' }, { op: 'set_external_port', id: 'jack', label: 'Headset jack', device: 'hs', port: 'jack' }]);
  assert.doesNotMatch((await store.getDoc(slug, techKey)).generated, /Connections/, 'a draft schematic does not print');
  await sch.releaseSchematic(slug, { note: 'Wired.' });
  const d = await store.getDoc(slug, techKey);
  assert.match(d.generated, /<h3>Connections<\/h3>/);
  assert.match(d.generated, /Headset jack/);

  await store.releaseDoc(slug, techKey, { force: true, note: 'Released for the test.' });
  const inst = await sch.createInstallation({ name: 'Wired sim', device: 'FNPT II', serialNumber: 'SN-7', operator: 'Op' });
  const ref = sch.instRef(inst.slug);
  await sch.applySchematicOps(ref, [
    { op: 'place_block', id: 'wm', module: slug, location: 'cockpit' },
    { op: 'add_device', id: 'pdu', template: 'pdu-8', label: 'PDU', location: 'rack-1' },
    { op: 'add_device', id: 'umc', template: 'behringer-umc404hd', label: 'UMC', location: 'rack-1' },
    { op: 'connect', from: { device: 'umc', port: 'phones-1' }, to: { block: 'wm', port: 'jack' }, label: 'AUD-01' },
  ]);
  const manual = await store.createManual({ name: 'Wired manual', manual: 'technician', modules: [slug], installation: inst.slug, serialNumber: 'IGNORED' });
  let compiled = await store.compileManual(manual.slug);
  assert.equal(compiled.manual.serialNumber, 'SN-7', 'the cover reads the installation');
  assert.equal(compiled.manual.device, 'FNPT II');
  assert.ok(!compiled.chapters.some((c) => c.installation), 'a draft installation does not print');
  assert.ok(compiled.state.blockers.some((b) => /installation/i.test(b)), 'and the state says why');
  await sch.releaseSchematic(ref, { note: 'Issue 1.' });
  compiled = await store.compileManual(manual.slug);
  const ch = compiled.chapters.find((c) => c.installation);
  assert.ok(ch, 'wiring chapter present');
  assert.match(ch.content, /<figure class="schematic installation"/);
  assert.match(ch.content, /cable-schedule/);
  assert.equal(compiled.installation.released, true);
  const html = (await import('./docgen.js')).manualBodyHtml(compiled);
  assert.match(html, /Installation wiring/);
});

test('a release line written on main does not block releasing the next version', async () => {
  const slug = await makeModule('Noted module');
  await sch.createSchematic(slug);
  await sch.applySchematicOps(slug, [{ op: 'add_device', id: 'hs', template: 'headset', label: 'Headset' }]);
  await sch.releaseSchematic(slug, { note: 'First.' });
  const next = await sch.createSchematic(slug);
  assert.equal(next.version, 'A1.1');
  await sch.setSchematicReleaseNote(slug, 'First, reworded.');
  await sch.applySchematicOps(slug, [{ op: 'update_device', id: 'hs', label: 'Headset L' }]);
  const rel = await sch.releaseSchematic(slug, { note: 'Second.' });
  assert.equal(rel.version, 'A1.1');
  const onMain = await sch.releasedSchematicOf(slug);
  assert.equal(onMain.version, 'A1.1');
  assert.equal(onMain.devices[0].label, 'Headset L');
  assert.equal(onMain.releaseRecord.find((r) => r.version === 'A1.0').summary, 'First, reworded.');
  assert.equal((await store.repo.currentBranch()), 'main');
});

test('deleting a module drops its schematic draft branch too', async () => {
  const slug = await makeModule('Doomed module');
  await sch.createSchematic(slug);
  const branch = `draft/${slug}-schematic-a1.0`;
  assert.ok((await store.repo.branches()).includes(branch));
  const del = await store.deleteModule(slug);
  assert.ok(del.branchesDeleted.includes(branch), `branchesDeleted: ${del.branchesDeleted}`);
  assert.ok(!(await store.repo.branches()).includes(branch));
  assert.ok(!(await store.listModules()).some((m) => m.slug === slug), 'the module is gone from the list');
});

test('the wiring chapter carries a doc key so the manual signature sees installation changes', async () => {
  const slug = await makeModule('Keyed module');
  await sch.createSchematic(slug);
  await sch.applySchematicOps(slug, [{ op: 'add_device', id: 'hs', template: 'headset' }, { op: 'set_external_port', id: 'jack', label: 'Jack', device: 'hs', port: 'jack' }]);
  await sch.releaseSchematic(slug, { note: 'Wired.' });
  const techKey = (await store.getModule(slug)).docs.find((d) => d.manual === 'technician').key;
  await store.releaseDoc(slug, techKey, { force: true, note: 'Released.' });
  const inst = await sch.createInstallation({ name: 'Keyed <sim> & co' });
  const ref = sch.instRef(inst.slug);
  await sch.applySchematicOps(ref, [{ op: 'place_block', id: 'km', module: slug, location: 'cockpit' }]);
  await sch.releaseSchematic(ref, { note: 'Issue 1.' });
  const manual = await store.createManual({ name: 'Keyed manual', manual: 'technician', modules: [slug], installation: inst.slug });
  const compiled = await store.compileManual(manual.slug);
  const ch = compiled.chapters.find((c) => c.installation);
  assert.equal(ch.doc.key, 'schematic:A1.0');
  assert.match(ch.content, /Keyed &lt;sim&gt; &amp; co/);
  assert.doesNotMatch(ch.content, /<sim>/);
});

test('a connector used by a template cannot be removed from the rules', async () => {
  const lib = await sch.getLibrary();
  await assert.rejects(
    sch.saveConnectors({ connectors: lib.connectors.filter((c) => c.id !== 'trs-6.35'), cables: lib.cables.filter((c) => c.id !== 'audio') }),
    /trs-6\.35.*(headset|behringer)/i
  );
  assert.ok((await sch.getLibrary()).devices.some((d) => d.id === 'headset'), 'nothing was lost');
});

test('two concurrent template creates both land', async () => {
  const [a, b] = await Promise.all([
    sch.createDeviceTemplate({ name: 'Concurrent A', ports: [] }),
    sch.createDeviceTemplate({ name: 'Concurrent B', ports: [] }),
  ]);
  const ids = (await sch.getLibrary()).devices.map((d) => d.id);
  assert.ok(ids.includes(a.id) && ids.includes(b.id), `have ${ids.join(', ')}`);
});
