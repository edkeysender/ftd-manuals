import test from 'node:test';
import assert from 'node:assert/strict';
import { toAnthropicRequest, jsonFromText, providerOf } from './ai.js';

test('OpenAI-style messages become an Anthropic request: system out, image data URLs as image blocks', () => {
  const r = toAnthropicRequest(
    [
      { role: 'system', content: 'You write manuals.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: [{ type: 'text', text: 'Describe' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'high' } }] },
    ],
    { json: true }
  );
  assert.equal(r.system, 'You write manuals.\n\nRespond with a single JSON object and nothing else — no prose, no code fences.');
  assert.deepEqual(r.messages[0], { role: 'user', content: 'Hello' });
  assert.deepEqual(r.messages[1], { role: 'assistant', content: 'Hi' });
  assert.deepEqual(r.messages[2].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  assert.deepEqual(r.messages[2].content[0], { type: 'text', text: 'Describe' });
  assert.equal(toAnthropicRequest([{ role: 'user', content: 'x' }], {}).system, undefined);
});

test('jsonFromText tolerates code fences and leading prose', () => {
  assert.equal(jsonFromText('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(jsonFromText('Here you go:\n{"a":1}'), '{"a":1}');
  assert.equal(jsonFromText('{"a":1}'), '{"a":1}');
  assert.equal(jsonFromText('no json here'), 'no json here');
});

test('providerOf picks Anthropic when its key is set, OpenAI otherwise, AI_PROVIDER overriding', () => {
  assert.equal(providerOf({ ANTHROPIC_API_KEY: 'k' }), 'anthropic');
  assert.equal(providerOf({ OPENAI_API_KEY: 'k' }), 'openai');
  assert.equal(providerOf({ OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' }), 'anthropic');
  assert.equal(providerOf({ OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', AI_PROVIDER: 'openai' }), 'openai');
  assert.equal(providerOf({}), 'none');
});
