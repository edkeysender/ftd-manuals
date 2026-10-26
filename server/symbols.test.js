import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIBRARY, SYMBOLS, CONNECTOR_SYMBOLS } from './library.js';
import { SYMBOL_CATALOG, symbolSvg, symbolCatalog } from './symbols.js';

test('the symbol catalog names every symbol the drawing can make, with its PN-EN 60617 reference in both languages', () => {
  const ids = new Set(SYMBOL_CATALOG.map((s) => s.id));
  for (const id of ['box', 'mcb', 'switch-disconnector', 'fuse', 'lamp', ...CONNECTOR_SYMBOLS, 'mate', 'cores', 'screen', 'junction', 'coupling']) assert.ok(ids.has(id), id);
  // the pictorial template symbols draw as the general rectangle: the catalog says so instead of listing them
  const box = SYMBOL_CATALOG.find((s) => s.id === 'box');
  for (const id of SYMBOLS.filter((s) => !ids.has(s))) assert.ok(box.aliases.includes(id), `${id} is a box`);
  for (const s of SYMBOL_CATALOG) {
    assert.equal(s.standard, 'PN-EN 60617 (IEC 60617)', s.id);
    assert.match(s.ref, /^\d\d-\d\d-\d\d$/, `${s.id} has a reference`);
    assert.ok(s.name.en && s.name.pl, `${s.id} is named in en and pl`);
    assert.ok(['device', 'contact', 'cable', 'graphic'].includes(s.kind), s.id);
  }
  assert.deepEqual(SYMBOL_CATALOG.find((s) => s.id === 'mcb').params, ['poles', 'rating']);
  assert.deepEqual(SYMBOL_CATALOG.find((s) => s.id === 'socket').params, []);
});

test('symbolSvg draws each symbol with the drawing\'s own functions, as a standalone svg', () => {
  const svg = (id) => symbolSvg(id);
  assert.match(svg('mcb'), /^<svg[^>]*viewBox/);
  assert.match(svg('mcb'), /sch-release-thermal/);
  assert.match(svg('mcb'), /sch-contact-x/);
  assert.match(svg('switch-disconnector'), /sch-isolator-bar/);
  assert.match(svg('fuse'), /sch-fuse/);
  assert.match(svg('lamp'), /sch-lamp/);
  assert.match(svg('socket'), /sch-sym-socket/);
  assert.match(svg('mate'), /sch-sym-mate/);
  assert.match(svg('pe'), /sch-sym-pe/);
  assert.match(svg('cores'), /sch-cores[\s\S]*>n</);
  assert.match(svg('screen'), /sch-screen/);
  assert.match(svg('junction'), /sch-junction/);
  assert.match(svg('coupling'), /sch-coupling/);
  assert.match(svg('box'), /<rect/);
  assert.throws(() => symbolSvg('nope'), /symbol/i);
});

test('symbolCatalog says, in the reader\'s language, which library records draw with each symbol', () => {
  const lib = {
    ...DEFAULT_LIBRARY,
    devices: [...DEFAULT_LIBRARY.devices, { id: 'mcb-b10', name: 'MCB HN-B10/1', category: 'other', manufacturer: 'Eaton', model: '194819', heightU: 0, sizeMm: null, symbol: 'mcb', poles: 1, rating: 'B10', ports: [], hardwareId: null, notes: '', panels: {} }],
  };
  const cat = symbolCatalog(lib, 'pl');
  const mcb = cat.find((s) => s.id === 'mcb');
  assert.equal(mcb.label, 'Wyłącznik nadprądowy');
  assert.deepEqual(mcb.usedBy.map((u) => u.id), ['mcb-b10']);
  assert.match(mcb.svg, /^<svg/);
  const box = cat.find((s) => s.id === 'box');
  assert.ok(box.usedBy.some((u) => u.id === 'pc'), 'a pictorial template draws as the general rectangle');
  assert.ok(!box.usedBy.some((u) => u.id === 'mcb-b10'));
  const socket = cat.find((s) => s.id === 'socket');
  assert.ok(socket.usedBy.some((u) => u.id === 'schuko'), 'connectors that draw as a socket');
  const cores = cat.find((s) => s.id === 'cores');
  assert.ok(cores.usedBy.some((u) => u.id === 'ethernet'), 'cable kinds with a conductor count');
  assert.ok(cat.find((s) => s.id === 'screen').usedBy.some((u) => u.id === 'usb'));
  assert.equal(symbolCatalog(lib, 'en').find((s) => s.id === 'mcb').label, 'Circuit breaker');
});

test('GET /api/library/symbols serves the catalog in the asked language', async () => {
  const { symbolsRoute } = await import('./symbols.js');
  const out = await symbolsRoute({ query: { lang: 'pl' } }, async () => DEFAULT_LIBRARY);
  assert.ok(Array.isArray(out.symbols) && out.symbols.length > 10);
  assert.equal(out.symbols.find((s) => s.id === 'fuse').label, 'Bezpiecznik');
  assert.equal(out.standard, 'PN-EN 60617 (IEC 60617)');
});
