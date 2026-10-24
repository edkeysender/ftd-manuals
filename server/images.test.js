import test from 'node:test';
import assert from 'node:assert/strict';
import { rasterizeWide, sniff } from './images.js';

test('rasterizeWide renders a very large SVG at the requested width without exceeding the pixel limit', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12000 7000" width="12000" height="7000"><rect width="12000" height="7000" fill="#fff"/><rect x="100" y="100" width="500" height="300" fill="#000"/></svg>';
  const png = await rasterizeWide(svg, 1600);
  const info = sniff(png);
  assert.equal(info.type, 'png');
  assert.equal(info.width, 1600);
  assert.ok(Math.abs(info.height - Math.round((7000 / 12000) * 1600)) <= 1);
});
