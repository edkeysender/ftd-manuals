import test from 'node:test';
import assert from 'node:assert/strict';
import { zoomAt, fitView, centerOn, MIN_Z, MAX_Z } from './schematicView.js';

test('fitView scales the content into the box with padding and centres it', () => {
  const v = fitView({ w: 2000, h: 1000 }, { w: 1000, h: 800 }, 20);
  assert.equal(v.z, 0.48); // (1000-40)/2000
  assert.equal(v.x, 20);
  assert.equal(Math.round(v.y), 160); // (800 - 1000*0.48)/2
});

test('zoomAt keeps the point under the cursor fixed and clamps the scale', () => {
  const v = { x: 100, y: 50, z: 1 };
  const z2 = zoomAt(v, 2, 300, 250);
  // content point under (300,250) was ((300-100)/1, (250-50)/1) = (200,200); after zoom it must still map to (300,250)
  assert.equal(z2.z, 2);
  assert.equal(z2.x + 200 * 2, 300);
  assert.equal(z2.y + 200 * 2, 250);
  assert.equal(zoomAt(v, 1000, 0, 0).z, MAX_Z);
  assert.equal(zoomAt(v, 0.0001, 0, 0).z, MIN_Z);
});

test('centerOn puts a content point in the middle of the box, keeping or setting the scale', () => {
  const v = centerOn({ x: 0, y: 0, z: 0.5 }, { w: 1000, h: 600 }, { x: 400, y: 300 });
  assert.equal(v.z, 0.5);
  assert.equal(v.x + 400 * 0.5, 500);
  assert.equal(v.y + 300 * 0.5, 300);
  assert.equal(centerOn({ x: 0, y: 0, z: 0.5 }, { w: 1000, h: 600 }, { x: 0, y: 0 }, 2).z, 2);
});
