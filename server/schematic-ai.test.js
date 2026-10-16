import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIBRARY } from './library.js';
import { emptySchematic, applyOps } from './schematic.js';
import { describeState, buildPrompt, parseOps, schematicChat } from './schematic-ai.js';

const ctx = () => ({ library: DEFAULT_LIBRARY, catalog: [], modules: [{ slug: 'audio-system', name: 'Audio system' }], releasedSchematics: new Map() });
const inst = () =>
  applyOps(
    emptySchematic({ kind: 'installation', owner: 'sim' }),
    [
      { op: 'add_location', id: 'rack-1', label: 'Rack 1', kind: 'rack' },
      { op: 'add_device', id: 'pdu-1', template: 'pdu-8', label: 'Power strip 1', location: 'rack-1' },
      { op: 'add_device', id: 'umc', template: 'behringer-umc404hd', label: 'UMC404HD', location: 'rack-1' },
      { op: 'connect', from: { device: 'pdu-1', port: 'out-1' }, to: { device: 'umc', port: 'pwr' }, label: 'PWR-01' },
    ],
    ctx()
  ).state;

test('describeState lists locations, devices with free/used ports, and cables', () => {
  const text = describeState(inst(), ctx());
  assert.match(text, /LOCATIONS:\n- rack-1 "Rack 1" \(rack\)/);
  assert.match(text, /- pdu-1 "Power strip 1" \[pdu-8\] in rack-1: in\(iec-c14, in\), out-1\(schuko, out, used by PWR-01\), out-2\(schuko, out\)/);
  assert.match(text, /CABLES:\n- c-1 "PWR-01" power: pdu-1\.out-1 -> umc\.pwr/);
});

test('buildPrompt carries the op schema, the library and the rules', () => {
  const p = buildPrompt({ state: inst(), ctx: ctx(), guidelines: 'Never invent part numbers.', lang: 'en' });
  assert.match(p, /add_device/);
  assert.match(p, /behringer-umc404hd/);
  assert.match(p, /Never invent part numbers/);
  assert.match(p, /never emit coordinates/i);
  assert.match(p, /"reply"/);
});

test('parseOps is forgiving', () => {
  assert.deepEqual(parseOps('not json'), { reply: 'not json', ops: [], note: '' });
  const r = parseOps('{"reply":"ok","ops":[{"op":"add_device","template":"pc"},{"op":"explode"},"junk"]}');
  assert.equal(r.reply, 'ok');
  assert.deepEqual(r.ops, [{ op: 'add_device', template: 'pc' }]);
  assert.match(r.note, /explode/);
  assert.deepEqual(parseOps('{"reply":"","ops":[]}'), { reply: 'Done.', ops: [], note: '' });
});

test('schematicChat dry-runs the ops and returns a preview', async () => {
  const callModel = async (messages) => {
    assert.equal(messages[0].role, 'system');
    assert.match(messages.at(-1).content, /headphones/);
    return JSON.stringify({ reply: 'Connected the headset.', ops: [{ op: 'add_device', id: 'hs', template: 'headset', label: 'Headset L', location: 'rack-1' }, { op: 'connect', from: { device: 'umc', port: 'phones-1' }, to: { device: 'hs', port: 'jack' }, label: 'AUD-01' }] });
  };
  const r = await schematicChat({ state: inst(), ctx: ctx(), messages: [{ role: 'user', content: 'connect the headphones to phones 1' }], callModel });
  assert.equal(r.ops.length, 2);
  assert.equal(r.preview.devices.length, 3);
  assert.deepEqual(r.validation.errors, []);
});

test('schematicChat returns no ops when the applier refuses them', async () => {
  const callModel = async () => JSON.stringify({ reply: 'Done', ops: [{ op: 'connect', from: { device: 'umc', port: 'nope' }, to: { device: 'pdu-1', port: 'out-2' } }] });
  const r = await schematicChat({ state: inst(), ctx: ctx(), messages: [{ role: 'user', content: 'x' }], callModel });
  assert.deepEqual(r.ops, []);
  assert.equal(r.preview, null);
  assert.match(r.note, /port "nope"/);
});

test('buildPrompt carries chat attachments as source material', () => {
  const p = buildPrompt({ state: inst(), ctx: ctx(), attachments: [{ name: 'cables.csv', text: 'W10,VDS,5 m' }] });
  assert.match(p, /ATTACHED FILES/);
  assert.match(p, /=== cables\.csv ===\nW10,VDS,5 m/);
  assert.doesNotMatch(buildPrompt({ state: inst(), ctx: ctx() }), /ATTACHED FILES/);
});

test('attachmentsToText reads text files, describes images, and skips what it cannot use', async () => {
  const { attachmentsToText } = await import('./schematic-ai.js');
  const b64 = (s) => Buffer.from(s).toString('base64');
  const described = [];
  const r = await attachmentsToText(
    [
      { name: 'list.csv', type: 'text/csv', dataBase64: b64('a,b\n1,2') },
      { name: 'photo.jpg', type: 'image/jpeg', dataBase64: b64('not really a jpeg') },
      { name: 'big.bin', type: 'application/octet-stream', dataBase64: b64('x'.repeat(10)) },
      { name: 'empty.txt', type: 'text/plain', dataBase64: '' },
    ],
    { describe: async ({ name }) => { described.push(name); return { description: 'A rack with a PDU.', text: 'PDU-1' }; }, maxText: 1000 }
  );
  assert.deepEqual(r.texts.map((t) => t.name), ['list.csv', 'photo.jpg']);
  assert.equal(r.texts[0].text, 'a,b\n1,2');
  assert.match(r.texts[1].text, /A rack with a PDU\./);
  assert.match(r.texts[1].text, /PDU-1/);
  assert.deepEqual(described, ['photo.jpg']);
  assert.equal(r.notes.length, 2);
  assert.match(r.notes.join(' '), /big\.bin/);
});
