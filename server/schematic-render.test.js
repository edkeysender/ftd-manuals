import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIBRARY } from './library.js';
import { emptySchematic, applyOps, cableSchedule, connectorFace } from './schematic.js';
import { layoutSchematic, renderSvg, scheduleHtml, faceHtml, schematicCsv, NODE_W } from './schematic-render.js';

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

test('a hand-moved node keeps its position, measured from its location frame, and the frame grows to keep it inside', async () => {
  const s = applyOps(fixture(), [{ op: 'move', id: 'hs', x: 400, y: 300 }], ctx()).state;
  const l = await layoutSchematic(s, ctx());
  const f = l.frames.cockpit;
  assert.equal(l.nodes.hs.x, f.x + 400);
  assert.equal(l.nodes.hs.y, f.y + 300);
  assert.ok(l.nodes.hs.x + l.nodes.hs.w <= f.x + f.w && l.nodes.hs.y + l.nodes.hs.h <= f.y + f.h, 'frame encloses the moved node');
  // the same offset holds in a one-location view, whose frame sits elsewhere on the page
  const { filterSchematic } = await import('./schematic.js');
  const l2 = await layoutSchematic(filterSchematic(s, { location: 'cockpit' }), ctx());
  assert.equal(l2.nodes.hs.x - l2.frames.cockpit.x, 400);
  assert.equal(l2.nodes.hs.y - l2.frames.cockpit.y, 300);
});

test('a node with no location is moved in page coordinates', async () => {
  const s = applyOps(fixture(), [{ op: 'add_device', id: 'spare', template: 'headset', label: 'Spare' }, { op: 'move', id: 'spare', x: 900, y: 40 }], ctx()).state;
  const l = await layoutSchematic(s, ctx());
  assert.equal(l.nodes.spare.x, 900);
  assert.equal(l.nodes.spare.y, 40);
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
  assert.match(html, /<th>Cable<\/th><th>Kind<\/th><th>Type<\/th><th>Colour<\/th><th>From<\/th><th>Port<\/th><th>To<\/th><th>Port<\/th><th>Length<\/th>/);
  assert.match(html, /PWR-01/);
  assert.match(html, /3 m/);
  const pl = scheduleHtml(cableSchedule(s, ctx()), 'pl');
  assert.match(pl, /<th>Kabel<\/th>/);
  const face = faceHtml(connectorFace(applyOps(emptySchematic({ kind: 'module', owner: 'm' }), [{ op: 'add_device', id: 'umc', template: 'behringer-umc404hd' }, { op: 'set_external_port', id: 'p', label: 'Power in', device: 'umc', port: 'pwr' }], ctx()).state, ctx()), 'en');
  assert.match(face, /<table class="port-list">/);
  assert.match(face, /IEC C14/);
  const csv = schematicCsv(cableSchedule(s, ctx()));
  assert.equal(csv.split('\n')[0], 'label,kind,type,color,from,from_port,to,to_port,length_m,notes');
  assert.match(csv, /PWR-01,Power,,,Power strip 1,Socket 1,UMC404HD,Power,,/);
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

test('cableLabelsHtml prints two labels per cable with its name, code and both ends', async () => {
  const { cableLabelsHtml } = await import('./schematic-render.js');
  const s = fixture();
  const html = cableLabelsHtml(cableSchedule(s, ctx()), { code: 'S2602', title: 'S2602 wiring', lang: 'en' });
  assert.match(html, /<!doctype html>/i);
  assert.equal((html.match(/class="label"/g) || []).length, 4, 'two cables, one label per end');
  assert.match(html, /S2602-PWR<\/div>/, 'the code is the installation code plus the cable id');
  assert.match(html, /PWR-01/);
  assert.match(html, /Power strip 1 · Socket 1/);
  assert.match(html, /UMC404HD · Power/);
  assert.match(html, /3 m/);
  assert.match(html, /@page/);
  const typed = cableLabelsHtml(cableSchedule(applyOps(s, [{ op: 'update_cable', id: 'aud', type: 'MR-D05UDL3M-B 6×0.13', color: 'black' }], ctx()).state, ctx()), { code: 'S2602' });
  assert.match(typed, /MR-D05UDL3M-B 6×0\.13 · black/);
  assert.doesNotMatch(html, /<script/);
  const one = cableLabelsHtml(cableSchedule(s, ctx()).filter((r) => r.id === 'aud'), { code: 'S2602' });
  assert.equal((one.match(/class="label"/g) || []).length, 2);
});

test('a device with long port labels on both sides gets a wider symbol and shortened labels on the drawing', async () => {
  const lib = {
    ...DEFAULT_LIBRARY,
    devices: [...DEFAULT_LIBRARY.devices, { id: 'wordy', name: 'Wordy', category: 'other', ports: [
      { id: 'a', label: 'Input 1 (front, XLR/TRS combo, mic/line/inst)', connector: 'trs-6.35', direction: 'in', side: 'left' },
      { id: 'b', label: 'Line output 10 (balanced TRS)', connector: 'trs-6.35', direction: 'out', side: 'right' },
      { id: 'c', label: 'Microphone preamplifier input', connector: 'trs-6.35', direction: 'in', side: 'left' },
      { id: 'd', label: 'Balanced line output number ten', connector: 'trs-6.35', direction: 'out', side: 'right' },
    ] }],
  };
  const c = { ...ctx(), library: lib };
  const s = applyOps(emptySchematic({ kind: 'module', owner: 'm' }), [{ op: 'add_device', id: 'w', template: 'wordy' }, { op: 'add_device', id: 'h', template: 'headset' }], c).state;
  const l = await layoutSchematic(s, c);
  assert.ok(l.nodes.w.w > NODE_W + 40, `wide symbol, got ${l.nodes.w.w}`);
  assert.match(await renderSvg(s, c), />Balanced line output numb…</, 'a long label without brackets is cut with an ellipsis');
  assert.equal(l.nodes.h.w, NODE_W, 'short labels keep the default width');
  const svg = await renderSvg(s, c);
  assert.match(svg, />Input 1</, 'the parenthetical detail is dropped on the drawing');
  assert.doesNotMatch(svg, /<text[^>]*>Input 1 \(front/, 'the drawing text is the short form; only the tooltip has the full label');
  assert.match(svg, /<title>Input 1 \(front, XLR\/TRS combo, mic\/line\/inst\)<\/title>/, 'the full label is the tooltip');
});

test('devices in a rack are drawn in rack order: the higher its U, the higher on the drawing', async () => {
  const s = applyOps(
    emptySchematic({ kind: 'installation', owner: 'sim' }),
    [
      { op: 'add_location', id: 'rack-1', label: 'Rack 1', kind: 'rack', unitsU: 30 },
      { op: 'add_device', id: 'pdu', template: 'pdu-8', label: 'PDU', location: 'rack-1', rack: { u: 2, face: 'rear' } },
      { op: 'add_device', id: 'low', template: 'pc', label: 'PC low', location: 'rack-1', rack: { u: 4 } },
      { op: 'add_device', id: 'mid', template: 'pc', label: 'PC mid', location: 'rack-1', rack: { u: 9 } },
      { op: 'add_device', id: 'high', template: 'pc', label: 'PC high', location: 'rack-1', rack: { u: 14 } },
      { op: 'add_device', id: 'loose', template: 'pc', label: 'PC no U', location: 'rack-1' },
      { op: 'connect', from: { device: 'pdu', port: 'out-1' }, to: { device: 'low', port: 'pwr' } },
      { op: 'connect', from: { device: 'pdu', port: 'out-2' }, to: { device: 'mid', port: 'pwr' } },
      { op: 'connect', from: { device: 'pdu', port: 'out-3' }, to: { device: 'high', port: 'pwr' } },
      { op: 'connect', from: { device: 'pdu', port: 'out-4' }, to: { device: 'loose', port: 'pwr' } },
    ],
    ctx()
  ).state;
  const l = await layoutSchematic(s, ctx());
  assert.ok(l.nodes.high.y < l.nodes.mid.y, `high (${l.nodes.high.y}) above mid (${l.nodes.mid.y})`);
  assert.ok(l.nodes.mid.y < l.nodes.low.y, `mid (${l.nodes.mid.y}) above low (${l.nodes.low.y})`);
  assert.ok(l.nodes.low.y < l.nodes.loose.y, 'a device with no U goes under the ones that have one');
});
