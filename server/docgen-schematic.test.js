import test from 'node:test';
import assert from 'node:assert/strict';
import { generatedSections, strings } from './docgen.js';

const module = { slug: 'audio', name: 'Audio system', code: 'AUD', hardwareIds: [], hardwareItems: [], softwares: [] };
const doc = (manual) => ({ version: 'A1.0', revision: 1, status: 'released', manual, revisionRecord: [], releasedAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', covers: [] });
const schematic = { svg: '<svg xmlns="http://www.w3.org/2000/svg"><g class="sch-device"/></svg>', faceHtml: '<table class="port-list"></table>', scheduleHtml: '<table class="cable-schedule"></table>', version: 'A1.0', revision: 3 };

test('technician manual prints the Connections block; customer manual never does', () => {
  const tech = generatedSections(module, doc('technician'), 'en', { schematic });
  assert.match(tech, /<h3>Connections<\/h3>/);
  assert.match(tech, /<figure class="schematic" data-schematic="audio"/);
  assert.match(tech, /class="sch-device"/);
  assert.match(tech, /Wiring of Audio system — AUD-SCH A1\.0/);
  assert.match(tech, /class="port-list"/);
  assert.match(tech, /class="cable-schedule"/);
  const cust = generatedSections(module, doc('customer'), 'en', { schematic });
  assert.doesNotMatch(cust, /Connections|schematic/);
  const none = generatedSections(module, doc('technician'), 'en', { schematic: null });
  assert.doesNotMatch(none, /Connections/);
});

test('assembled chapter keeps the Connections block, in Polish too', () => {
  const html = generatedSections(module, doc('technician'), 'pl', { schematic, assembled: true });
  assert.match(html, /<section class="auto-section" data-auto="3">/);
  assert.match(html, /<h3>Połączenia<\/h3>/);
  assert.equal(strings('pl').connections, 'Połączenia');
  assert.equal(strings('en').installationWiring, 'Installation wiring');
});
