import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.FTD_AUTH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ftd-secrets-'));
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
const secrets = await import('./secrets.js');
const ai = await import('./ai.js');
test.after(() => fs.rmSync(process.env.FTD_AUTH_DIR, { recursive: true, force: true }));

test('keys saved in Settings are stored outside the document repo, masked when read back, and picked up by the provider', async () => {
  assert.deepEqual(secrets.maskedKeys(), { anthropic: null, openai: null });
  assert.equal(ai.providerOf(), 'none');
  await secrets.setSecrets({ ANTHROPIC_API_KEY: 'sk-ant-api03-abcdefghijkl' });
  assert.deepEqual(secrets.maskedKeys(), { anthropic: '…ijkl', openai: null });
  assert.equal(ai.providerOf(), 'anthropic');
  assert.equal(ai.aiAvailable(), true);
  assert.equal(ai.openaiAvailable(), false);
  const file = path.join(process.env.FTD_AUTH_DIR, 'secrets.json');
  assert.ok(fs.existsSync(file));
  assert.equal((fs.statSync(file).mode & 0o777) & 0o077, 0, 'secrets.json is readable by the owner only');
  await secrets.setSecrets({ OPENAI_API_KEY: 'sk-openai-1234' });
  assert.equal(ai.openaiAvailable(), true);
  assert.equal(ai.providerOf(), 'anthropic', 'Anthropic stays the chat provider when both keys exist');
  await secrets.setSecrets({ ANTHROPIC_API_KEY: '' });
  assert.deepEqual(secrets.maskedKeys(), { anthropic: null, openai: '…1234' });
  assert.equal(ai.providerOf(), 'openai');
  assert.equal(ai.keyFor('OPENAI_API_KEY'), 'sk-openai-1234');
});
