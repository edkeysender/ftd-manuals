/**
 * End-to-end smoke test: boots the API against a throwaway data repo and
 * exercises the whole module lifecycle over HTTP.
 * Usage: npm run smoke
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 5197;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftd-smoke-'));

const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT, FTD_DATA_DIR: path.join(dataDir, 'repo'), OPENAI_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(d));

let failed = false;
const ok = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed = true;
};

async function req(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${data.error}`);
  return data;
}

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try {
      await req('GET', '/api/status');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('server did not start');
}

try {
  await waitUp();

  // empty list
  ok((await req('GET', '/api/modules')).length === 0, 'starts with no modules');

  // create module via wizard payload (blank template)
  const created = await req('POST', '/api/modules', {
    name: 'Starting Panel',
    code: 'SW-STP',
    category: 'software',
    group: 'SIM',
    hardware: { type: 'ftd', version: 'v2' },
    softwares: [{ name: 'STP Core', fromVersion: 'v2.0.0' }],
    start: { mode: 'blank' },
  });
  ok(created.slug === 'starting-panel' && created.version === 'A1.0', 'wizard creates starting-panel A1.0');
  ok(created.branch === 'draft/starting-panel-a1.0', `draft branch is ${created.branch}`);

  let list = await req('GET', '/api/modules');
  ok(list.length === 1 && list[0].status === 'draft', 'module listed as Draft');
  ok(list[0].latestDoc === 'A1.0 draft r1', `latest doc label: ${list[0].latestDoc}`);
  ok(list[0].hardwareLabel === 'FTD.aero · v2', `hardware label: ${list[0].hardwareLabel}`);

  // edit: autosave, then a committed revision
  const doc0 = await req('GET', '/api/modules/starting-panel/docs/A1.0');
  ok(doc0.content.includes('<h2>Installation</h2>'), 'blank template has Installation section');
  ok(doc0.generated.includes('Revision record'), 'sections 1-3 generated');

  // assets: upload, list, serve
  const png1x1 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const uploaded = await req('POST', '/api/modules/starting-panel/docs/A1.0/assets', {
    files: [{ name: 'Panel Photo.PNG', dataBase64: png1x1 }],
  });
  ok(uploaded[0].url.endsWith('/assets/panel-photo.png'), `asset uploaded, sanitized: ${uploaded[0].url}`);
  const assetRes = await fetch(BASE + uploaded[0].url);
  ok(assetRes.ok && assetRes.headers.get('content-type') === 'image/png', 'asset served as image/png');
  const assetList = await req('GET', '/api/modules/starting-panel/assets');
  ok(assetList.some((a) => a.name === 'panel-photo.png'), 'asset listed');

  // AI settings (guidelines)
  await req('PUT', '/api/settings/ai', { guidelines: 'Use "flight compartment", never "cockpit".' });
  const aiSet = await req('GET', '/api/settings/ai');
  ok(aiSet.guidelines.includes('flight compartment'), 'AI guidelines saved and read back');

  // MCP endpoint: initialize + tools/list + a tool call
  async function mcpCall(body) {
    const res = await fetch(BASE + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const json = text.startsWith('event:') || text.startsWith('data:')
      ? JSON.parse(text.split('\n').find((l) => l.startsWith('data:')).slice(5))
      : JSON.parse(text);
    if (json.error) throw new Error(`MCP: ${json.error.message}`);
    return json.result;
  }
  const init = await mcpCall({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } },
  });
  ok(init.serverInfo?.name === 'ftd-docs-console', 'MCP initialize');
  const tools = await mcpCall({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  ok(tools.tools.some((t) => t.name === 'create_module') && tools.tools.some((t) => t.name === 'upload_photo'),
    `MCP exposes ${tools.tools.length} tools`);
  const search = await mcpCall({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'search_modules', arguments: { query: 'starting' } },
  });
  ok(JSON.parse(search.content[0].text).length === 1, 'MCP search_modules finds starting-panel');

  await req('PUT', '/api/modules/starting-panel/docs/A1.0/content', {
    html: doc0.content + '<p>Autosaved text.</p>',
    bump: false,
  });
  const afterAuto = await req('GET', '/api/modules/starting-panel/docs/A1.0');
  ok(afterAuto.doc.revision === 1, 'autosave keeps r1');

  await req('PUT', '/api/modules/starting-panel/docs/A1.0/content', {
    html: afterAuto.content + '<p>Grounding check added.</p>',
    bump: true,
    summary: 'Add grounding check',
  });
  const afterBump = await req('GET', '/api/modules/starting-panel/docs/A1.0');
  ok(afterBump.doc.revision === 2, 'committed change bumps to r2');
  ok(afterBump.doc.revisionRecord.some((r) => r.summary === 'Add grounding check'), 'revision record entry written');

  // review + release
  await req('POST', '/api/modules/starting-panel/docs/A1.0/submit-review');
  list = await req('GET', '/api/modules');
  ok(list[0].status === 'in-review', 'submit for review -> In review');

  await req('POST', '/api/modules/starting-panel/docs/A1.0/release');
  list = await req('GET', '/api/modules');
  ok(list[0].status === 'released' && list[0].latestDoc === 'A1.0', 'release -> Released A1.0 on main');
  const status = await req('GET', '/api/status');
  ok(status.drafts === 0, 'draft branch deleted after merge');

  // software feed: non-affecting release can be linked; affecting one raises the orange dot
  await req('POST', '/api/softwares', { name: 'STP Core', version: 'v2.0.1', manualAffecting: false });
  await req('POST', '/api/modules/starting-panel/docs/A1.0/cover', { name: 'STP Core', version: 'v2.0.1' });
  let detail = await req('GET', '/api/modules/starting-panel');
  const cov = detail.docs[0].covers.find((c) => c.name === 'STP Core');
  ok(cov.from === 'v2.0.0' && cov.to === 'v2.0.1', `A1.0 covers STP Core ${cov.from} – ${cov.to}`);
  ok(detail.needsDoc === false, 'no orange dot with covered releases');

  await req('POST', '/api/softwares', { name: 'STP Core', version: 'v2.1.0', manualAffecting: true });
  list = await req('GET', '/api/modules');
  ok(list[0].needsDoc === true, 'manual-affecting release raises the orange dot');

  // next doc version clears the dot (draft exists), then release supersedes A1.0
  const next = await req('POST', '/api/modules/starting-panel/docs', { bump: 'minor' });
  ok(next.version === 'A1.1', 'next version is A1.1');
  list = await req('GET', '/api/modules');
  ok(list[0].needsDoc === false, 'dot clears once a draft exists');
  ok(list[0].latestDoc === 'A1.1 draft r1', 'A1.1 draft listed');

  await req('POST', '/api/modules/starting-panel/docs/A1.1/submit-review');
  await req('POST', '/api/modules/starting-panel/docs/A1.1/release');
  detail = await req('GET', '/api/modules/starting-panel');
  ok(detail.docs.find((d) => d.version === 'A1.0').status === 'superseded', 'A1.0 superseded by A1.1');
  ok(detail.docs.find((d) => d.version === 'A1.1').status === 'released', 'A1.1 released');

  // copy wizard mode from a released doc
  const copy = await req('POST', '/api/modules', {
    name: 'IOS Panel',
    group: 'IOS',
    category: 'software',
    hardware: { type: 'none' },
    softwares: [],
    start: { mode: 'copy', sourceSlug: 'starting-panel', sourceVersion: 'A1.1' },
  });
  const copyDoc = await req('GET', `/api/modules/ios-panel/docs/A1.0`);
  ok(copyDoc.content.includes('Grounding check added'), 'copy mode copies content');
  ok(copyDoc.doc.revisionRecord.some((r) => r.inherited), 'copy mode inherits revision record');

  // discard a never-released module
  await req('POST', '/api/modules/ios-panel/docs/A1.0/discard');
  list = await req('GET', '/api/modules');
  ok(list.length === 1, 'discarded never-released module disappears');

  // history exists
  detail = await req('GET', '/api/modules/starting-panel');
  ok(detail.history.length >= 5, `history has ${detail.history.length} commits`);
} catch (e) {
  console.error('SMOKE ERROR:', e);
  failed = true;
} finally {
  server.kill();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {}
}

console.log(failed ? '\nSMOKE: FAILED' : '\nSMOKE: ALL PASS');
process.exit(failed ? 1 : 0);
