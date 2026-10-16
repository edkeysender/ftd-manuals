import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.FTD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ftd-routes-'));
const { schematicRef } = await import('./schematic-routes.js');
test.after(() => fs.rmSync(process.env.FTD_DATA_DIR, { recursive: true, force: true }));

test('schematicRef reads the owner kind from the request URL', () => {
  assert.equal(schematicRef({ originalUrl: '/api/modules/audio/schematic', params: { slug: 'audio' } }), 'audio');
  assert.equal(schematicRef({ originalUrl: '/api/installations/sim-a/schematic/ops?x=1', params: { slug: 'sim-a' } }), 'inst:sim-a');
});
