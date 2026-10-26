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

test('ports are drawn with the IEC 60617 contact symbols: a socket is an open arc, a plug a solid bar, a connected port shows the mated pair', async () => {
  const s = fixture();
  const svg = await renderSvg(s, ctx());
  const port = (dev, id) => {
    const m = svg.match(new RegExp(`<g class="sch-device" data-id="${dev}"[\\s\\S]*?</g></g>`));
    assert.ok(m, `device ${dev}`);
    const p = m[0].match(new RegExp(`<g class="sch-port" data-port="${id}"[\\s\\S]*?</g>`));
    assert.ok(p, `port ${dev}.${id}`);
    return p[0];
  };
  // the UMC's mains inlet (C14) is male: a bar — and mated, since PWR-01 plugs into it
  assert.match(port('umc', 'pwr'), /sch-sym-plug/);
  assert.match(port('umc', 'pwr'), /sch-sym-mate/);
  // Phones 2 is a free jack: an open arc and no mate
  assert.match(port('umc', 'phones-2'), /sch-sym-socket/);
  assert.doesNotMatch(port('umc', 'phones-2'), /sch-sym-mate/);
  // the strip's outlet 1 is a socket with a plug in it
  assert.match(port('pdu-1', 'out-1'), /sch-sym-socket/);
  assert.match(port('pdu-1', 'out-1'), /sch-sym-mate/);
  assert.doesNotMatch(port('pdu-1', 'out-2'), /sch-sym-mate/);
});

test('a multi-core cable carries the oblique stroke with its conductor count, a screened one the screen oval, and the drawing names the standard', async () => {
  const s = fixture();
  const svg = await renderSvg(s, ctx());
  const cable = (id) => svg.match(new RegExp(`<g class="sch-cable[^"]*" data-id="${id}"[\\s\\S]*?(?=<g class="sch-(?:cable|legend|external)|</svg>)`))[0];
  assert.match(cable('pwr'), /class="sch-cores"[\s\S]*>3</, 'power: 3 conductors');
  assert.doesNotMatch(cable('pwr'), /sch-screen/);
  assert.match(cable('aud'), /sch-screen/, 'audio is screened');
  assert.match(svg, /class="sch-legend"/);
  assert.match(svg, /PN-EN 60617 \(IEC 60617\)/);
  assert.match(await renderSvg(s, ctx(), { lang: 'pl' }), /Symbole graficzne wg PN-EN 60617/);
  // a legend lists only what the drawing uses: no PE terminal here
  assert.doesNotMatch(svg, /sch-legend-pe/);
});

/** A library with terminals and the protective devices of a power enclosure. */
function powerLib() {
  return {
    ...DEFAULT_LIBRARY,
    connectors: [...DEFAULT_LIBRARY.connectors, { id: 'term', label: 'Terminal', color: '#000', symbol: 'terminal' }],
    cables: [...DEFAULT_LIBRARY.cables, { id: 'wire', label: 'Wire', joins: [['term', 'term']], style: { color: '#000', width: 1.2, dash: '' }, cores: 1, screened: false }],
    devices: [
      ...DEFAULT_LIBRARY.devices,
      { id: 'mcb-b10', name: 'MCB HN-B10/1', category: 'other', manufacturer: 'Eaton', model: '194819', heightU: 0, sizeMm: null, symbol: 'mcb', poles: 1, rating: 'B10', ports: [{ id: 'in', label: '1', connector: 'term', direction: 'in', side: 'left' }, { id: 'out-1', label: '2', connector: 'term', direction: 'out', side: 'right' }, { id: 'out-2', label: '2 (second wire)', connector: 'term', direction: 'out', side: 'right' }], hardwareId: null, notes: '', panels: {} },
      { id: 'is-40-4', name: 'Switch disconnector IS-40/4', category: 'other', manufacturer: 'Eaton', model: 'IS-40/4', heightU: 0, sizeMm: null, symbol: 'switch-disconnector', poles: 4, rating: '40 A', ports: [{ id: 'in', label: 'In', connector: 'term', direction: 'in', side: 'left' }, { id: 'out', label: 'Out', connector: 'term', direction: 'out', side: 'right' }], hardwareId: null, notes: '', panels: {} },
      { id: 'fuse-2a', name: 'Fuse holder', category: 'other', manufacturer: '', model: '', heightU: 0, sizeMm: null, symbol: 'fuse', poles: 1, rating: '2 A', ports: [{ id: 'in', label: '1', connector: 'term', direction: 'in', side: 'left' }, { id: 'out', label: '2', connector: 'term', direction: 'out', side: 'right' }], hardwareId: null, notes: '', panels: {} },
      { id: 'terms', name: 'Terminals', category: 'other', manufacturer: '', model: '', heightU: 0, sizeMm: null, symbol: 'box', poles: null, rating: '', ports: [{ id: 't1', label: '1', connector: 'term', direction: 'bidir', side: 'left' }, { id: 't2', label: '2', connector: 'term', direction: 'bidir', side: 'left' }], hardwareId: null, notes: '', panels: {} },
    ],
  };
}

function powerFixture(c) {
  return applyOps(
    emptySchematic({ kind: 'installation', owner: 'sim' }),
    [
      { op: 'add_location', id: 'ebi', label: 'Energy box 1', kind: 'rack' },
      { op: 'add_device', id: 'q2', template: 'is-40-4', label: '-Q2.MAIN', location: 'ebi' },
      { op: 'add_device', id: 'f10', template: 'mcb-b10', label: '-F10.VDS (VISUAL DISPLAY SYSTEM) B10', location: 'ebi' },
      { op: 'add_device', id: 'f1', template: 'fuse-2a', label: '-F1', location: 'ebi' },
      { op: 'add_device', id: 'x1', template: 'terms', label: '-X1', location: 'ebi' },
      { op: 'connect', id: 'w1', from: { device: 'q2', port: 'out' }, to: { device: 'f10', port: 'in' }, label: 'W1' },
      { op: 'connect', id: 'w2', from: { device: 'f10', port: 'out-1' }, to: { device: 'x1', port: 't1' }, label: 'W2' },
    ],
    c
  ).state;
}

test('a protective device is drawn as its IEC 60617 symbol: poles between the terminals, releases on a breaker, the tag and rating beside it', async () => {
  const c = { ...ctx(), library: powerLib() };
  const s = powerFixture(c);
  const svg = await renderSvg(s, c);
  const dev = (id) => svg.match(new RegExp(`<g class="sch-device sch-prot sch-prot-[a-z-]+" data-id="${id}"[\\s\\S]*?(?=<g class="sch-(?:device|block|cable|legend|external)|</svg>)`))?.[0] || '';
  const f10 = dev('f10');
  assert.match(f10, /sch-prot-mcb/, 'a breaker');
  assert.equal((f10.match(/class="sch-pole"/g) || []).length, 1, 'one pole');
  assert.match(f10, /sch-release-thermal/);
  assert.match(f10, /sch-release-magnetic/);
  assert.match(f10, /sch-contact-x/, 'the circuit-breaker cross at the fixed contact');
  // the information stack: tag on its own line, the function text, the rating, maker, part number, type, location
  assert.match(f10, /sch-tag"[^>]*>-F10\.VDS</);
  assert.match(f10, />\(VISUAL DISPLAY SYSTEM\) B10</);
  assert.match(f10, />B10</);
  assert.match(f10, />Eaton</);
  assert.match(f10, />194819</);
  assert.match(f10, />MCB HN-B10\/1</);
  assert.match(f10, />Energy box 1</);
  // terminal numbers at the ends of the pole
  assert.match(f10, /data-port="in"[\s\S]*?>1</);
  assert.match(f10, /data-port="out-1"[\s\S]*?>2</);
  // four coupled poles on the main switch, the isolating bar, no releases
  const q2 = dev('q2');
  assert.match(q2, /sch-prot-switch-disconnector/);
  assert.equal((q2.match(/class="sch-pole"/g) || []).length, 4);
  assert.match(q2, /sch-coupling/);
  assert.match(q2, /sch-isolator-bar/);
  assert.doesNotMatch(q2, /sch-release/);
  assert.doesNotMatch(f10, /sch-coupling/, 'one pole has nothing to couple');
  // the fuse is the rectangle with the conductor through it; a terminal block stays the general rectangle
  assert.match(dev('f1'), /sch-prot-fuse/);
  assert.match(svg, /<g class="sch-device" data-id="x1"/);
  // the legend names what is on the drawing, in the reader's language
  assert.match(svg, /sch-legend-mcb[\s\S]*?>Circuit breaker</);
  assert.match(svg, /sch-legend-switch-disconnector[\s\S]*?>Switch disconnector</);
  assert.match(svg, /sch-legend-fuse[\s\S]*?>Fuse</);
  assert.match(await renderSvg(s, c, { lang: 'pl' }), /Wyłącznik nadprądowy/);
});

test('a protective device takes its supply at the top and feeds out at the bottom, whatever side the template declares', async () => {
  const c = { ...ctx(), library: powerLib() };
  const s = powerFixture(c);
  const l = await layoutSchematic(s, c);
  const f10 = l.nodes.f10;
  const into = l.edges.w1.at(-1); // W1 ends on f10.in
  const outOf = l.edges.w2[0]; // W2 starts on f10.out-1
  assert.equal(into.y, f10.y, 'in at the top edge');
  assert.equal(outOf.y, f10.y + f10.h, 'out at the bottom edge');
  assert.ok(into.x > f10.x && into.x < f10.x + f10.w);
  assert.equal(into.x, outOf.x, 'in and out of one pole share its x');
  assert.ok(f10.h >= 70, 'tall enough for the symbol and the information stack');
});
