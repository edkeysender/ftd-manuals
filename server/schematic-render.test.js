import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIBRARY } from './library.js';
import { emptySchematic, applyOps, cableSchedule, connectorFace } from './schematic.js';
import { layoutSchematic, renderSvg, scheduleHtml, faceHtml, schematicCsv } from './schematic-render.js';

const ctx = () => ({ library: DEFAULT_LIBRARY, catalog: [], modules: [{ slug: 'audio-system', name: 'Audio system' }], releasedSchematics: new Map() });

function fixture() {
  return applyOps(
    emptySchematic({ kind: 'installation', owner: 'sim' }),
    [
      { op: 'add_location', id: 'rack-1', label: 'Rack 1', kind: 'rack' },
      { op: 'add_location', id: 'cockpit', label: 'Cockpit' },
      { op: 'add_device', id: 'pdu-1', template: 'pdu-8', label: 'Power strip 1', location: 'rack-1' },
      { op: 'add_device', id: 'umc', template: 'behringer-umc404hd', label: 'UMC404HD', location: 'rack-1' },
      { op: 'add_device', id: 'hs', template: 'headset', label: 'Headset L', location: 'cockpit' },
      { op: 'connect', id: 'pwr', from: { device: 'pdu-1', port: 'out-1' }, to: { device: 'umc', port: 'pwr' }, label: 'PWR-01' },
      { op: 'connect', id: 'aud', from: { device: 'umc', port: 'phones-1' }, to: { device: 'hs', port: 'jack' }, label: 'AUD-01', length: 3 },
    ],
    ctx()
  ).state;
}

test('layout places every node inside its frame and routes every cable', async () => {
  const s = fixture();
  const l = await layoutSchematic(s, ctx());
  for (const id of ['pdu-1', 'umc', 'hs']) assert.ok(l.nodes[id] && l.nodes[id].w > 0, `node ${id}`);
  for (const id of ['rack-1', 'cockpit']) assert.ok(l.frames[id] && l.frames[id].w > 0, `frame ${id}`);
  const inside = (n, f) => n.x >= f.x && n.y >= f.y && n.x + n.w <= f.x + f.w && n.y + n.h <= f.y + f.h;
  assert.ok(inside(l.nodes.umc, l.frames['rack-1']));
  assert.ok(inside(l.nodes.hs, l.frames.cockpit));
  assert.ok(l.edges.pwr.length >= 2 && l.edges.aud.length >= 2);
  assert.ok(l.width > 0 && l.height > 0);
});

test('a hand-moved node keeps its position', async () => {
  const s = applyOps(fixture(), [{ op: 'move', id: 'hs', x: 900, y: 40 }], ctx()).state;
  const l = await layoutSchematic(s, ctx());
  assert.equal(l.nodes.hs.x, 900);
  assert.equal(l.nodes.hs.y, 40);
});

test('renderSvg emits one svg with a group per device, a frame per location, a path per cable, and port labels', async () => {
  const svg = await renderSvg(fixture(), ctx(), { title: 'Sim wiring' });
  assert.match(svg, /^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.equal((svg.match(/class="sch-device"/g) || []).length, 3);
  assert.equal((svg.match(/class="sch-frame/g) || []).length, 2);
  assert.equal((svg.match(/class="sch-cable/g) || []).length, 2);
  assert.match(svg, />Socket 1</);
  assert.equal((svg.match(/class="sch-port-hit"/g) || []).length, (svg.match(/class="sch-port"/g) || []).length, 'every port has a hit area for dragging');
  assert.match(svg, />PWR-01</);
  assert.match(svg, /font-family="Verdana/);
  assert.match(svg, /stroke-dasharray="6 3"/, 'audio prints dashed');
  assert.doesNotMatch(svg, /<script/);
});

test('a module schematic renders its external ports as a connector face', async () => {
  const m = applyOps(
    emptySchematic({ kind: 'module', owner: 'audio-system' }),
    [{ op: 'add_device', id: 'umc', template: 'behringer-umc404hd' }, { op: 'set_external_port', id: 'power-in', label: 'Power in', device: 'umc', port: 'pwr' }],
    ctx()
  ).state;
  const svg = await renderSvg(m, ctx());
  assert.match(svg, /class="sch-external"/);
  assert.match(svg, />Power in \(IEC C14\)</);
});

test('tables and csv', () => {
  const s = fixture();
  const html = scheduleHtml(cableSchedule(s, ctx()), 'en');
  assert.match(html, /<table class="cable-schedule">/);
  assert.match(html, /<th>Cable<\/th><th>Kind<\/th><th>From<\/th><th>Port<\/th><th>To<\/th><th>Port<\/th><th>Length<\/th>/);
  assert.match(html, /PWR-01/);
  assert.match(html, /3 m/);
  const pl = scheduleHtml(cableSchedule(s, ctx()), 'pl');
  assert.match(pl, /<th>Kabel<\/th>/);
  const face = faceHtml(connectorFace(applyOps(emptySchematic({ kind: 'module', owner: 'm' }), [{ op: 'add_device', id: 'umc', template: 'behringer-umc404hd' }, { op: 'set_external_port', id: 'p', label: 'Power in', device: 'umc', port: 'pwr' }], ctx()).state, ctx()), 'en');
  assert.match(face, /<table class="port-list">/);
  assert.match(face, /IEC C14/);
  const csv = schematicCsv(cableSchedule(s, ctx()));
  assert.equal(csv.split('\n')[0], 'label,kind,from,from_port,to,to_port,length_m,notes');
  assert.match(csv, /PWR-01,Power,Power strip 1,Socket 1,UMC404HD,Power,,/);
});

test('a block draws each external port once, on its left edge', async () => {
  const released = applyOps(
    emptySchematic({ kind: 'module', owner: 'audio-system' }),
    [{ op: 'add_device', id: 'hs', template: 'headset' }, { op: 'set_external_port', id: 'jack', label: 'Headset jack', device: 'hs', port: 'jack' }],
    ctx()
  ).state;
  const c = { ...ctx(), releasedSchematics: new Map([['audio-system', { ...released, status: 'released' }]]) };
  const inst = applyOps(
    emptySchematic({ kind: 'installation', owner: 'sim' }),
    [{ op: 'add_location', id: 'rack-1', label: 'Rack 1', kind: 'rack' }, { op: 'place_block', id: 'audio', module: 'audio-system', location: 'rack-1' }],
    c
  ).state;
  const svg = await renderSvg(inst, c);
  assert.equal((svg.match(/data-port="jack"/g) || []).length, 1);
  const l = await layoutSchematic(inst, c);
  assert.ok(l.nodes.audio.w > 0);
});

test('an empty location still draws as a visible frame', async () => {
  const inst = applyOps(emptySchematic({ kind: 'installation', owner: 'sim' }), [{ op: 'add_location', id: 'ios', label: 'IOS' }], ctx()).state;
  const l = await layoutSchematic(inst, ctx());
  assert.ok(l.frames.ios.w >= 100 && l.frames.ios.h >= 40, `frame ${JSON.stringify(l.frames.ios)}`);
});
