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
  env: {
    ...process.env,
    PORT,
    FTD_DATA_DIR: path.join(dataDir, 'repo'),
    FTD_INBOX_DIR: path.join(dataDir, 'inbox'),
    FTD_IMPORT_ROOTS: path.join(dataDir, 'imports'),
    OPENAI_API_KEY: '',
  },
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
    checklist: { mode: 'template' },
  });
  ok(created.slug === 'starting-panel' && created.version === 'A1.0', 'wizard creates starting-panel A1.0');
  ok(created.fat === true, 'wizard seeds a FAT checklist from the template');
  ok(created.branch === 'draft/starting-panel-a1.0', `draft branch is ${created.branch}`);

  let list = await req('GET', '/api/modules');
  ok(list.length === 1 && list[0].status === 'draft', 'module listed as Draft');
  ok(list[0].latestDoc === 'A1.0 draft r1', `latest doc label: ${list[0].latestDoc}`);
  ok(list[0].hardwareLabel === 'Starting Panel', `legacy hardware input became a catalog item: ${list[0].hardwareLabel}`);
  ok(list[0].hardware.length === 1 && list[0].hardware[0].type === 'ftd' && list[0].hardware[0].version === 'v2', 'module row carries resolved hardware items');

  // hardware catalog: create, assign several units to one module, generated section lists each
  const cam1 = await req('POST', '/api/hardware', { name: 'Cockpit camera — PTZ', type: 'cots', manufacturer: 'Axis', model: 'M5075-G' });
  ok(cam1.id === 'cockpit-camera-ptz', `catalog item id: ${cam1.id}`);
  let hwList = await req('GET', '/api/hardware');
  ok(hwList.length === 2 && hwList.find((h) => h.id === 'starting-panel').usedBy[0].slug === 'starting-panel', 'catalog lists usage');
  const cam = await req('POST', '/api/modules', {
    name: 'Camera',
    group: 'SIM',
    category: 'peripherals',
    hardware: [{ id: cam1.id }, { name: 'Cockpit camera — fixed', type: 'cots', manufacturer: 'Axis', model: 'M3086' }, { name: 'Camera bracket', type: 'ftd', version: 'v3' }],
    start: { mode: 'blank' },
    checklist: { mode: 'template' },
  });
  ok(cam.hardware.length === 3, 'module created with 3 hardware units (1 existing + 2 new)');
  hwList = await req('GET', '/api/hardware');
  ok(hwList.length === 4, `new units joined the catalog (${hwList.length} items)`);
  const camDoc = await req('GET', '/api/modules/camera/docs/A1.0');
  ok(camDoc.module.hardwareItems.length === 3 && camDoc.module.hardwareIds.length === 3, 'module.json stores hardwareIds, read resolves items');
  ok(camDoc.generated.includes('Cockpit camera — fixed') && camDoc.generated.includes('COTS · Axis M3086'), 'section 3 lists every unit');
  ok((camDoc.content.match(/<h3>/g) || []).length >= 6, 'blank template has one subsection per unit in Installation and Operation');
  ok(camDoc.checklist.phases[0].items.some((i) => i.check.includes('Camera bracket')), 'FAT identification has a row per unit');
  const patched = await req('PATCH', '/api/modules/camera', { hardware: [{ id: cam1.id }] });
  ok(patched.hardwareIds.length === 1 && patched.hardwareItems[0].id === cam1.id, 'PATCH replaces the assignment');
  let delErr = null;
  try { await req('DELETE', `/api/hardware/${cam1.id}`); } catch (e) { delErr = e.message; }
  ok(/assigned to Camera/.test(delErr || ''), 'cannot delete a unit still assigned');
  ok((await req('DELETE', '/api/hardware/camera-bracket')).ok === true, 'unassigned unit can be deleted');
  const hwUpd = await req("PUT", `/api/hardware/${cam1.id}`, { notes: "Above the IOS" });
  ok(hwUpd.notes === "Above the IOS" && (await req('GET', '/api/modules/camera')).module.hardwareItems[0].notes === 'Above the IOS', 'catalog edit is visible through the module');
  await req('POST', '/api/modules/camera/docs/A1.0/discard');
  ok(!(await req('GET', '/api/modules')).find((m) => m.slug === 'camera'), 'camera module discarded (cleanup)');

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
  const stamped = assetList.find((a) => a.name === 'panel-photo.png');
  ok(stamped.meta?.addedIn === 'A1.0' && stamped.stale.length === 0, 'upload stamps the asset with the doc version');
  ok(stamped.meta.software[0]?.name === 'STP Core' && stamped.meta.software[0].version === 'v2.0.0', `stamp records software as of upload: ${stamped.meta.software[0]?.version}`);
  ok(stamped.meta.hardware[0]?.id === 'starting-panel' && stamped.meta.hardware[0].version === 'v2', `stamp records hardware version: ${stamped.meta.hardware[0]?.version}`);
  const badApplies = await req('PUT', '/api/modules/starting-panel/docs/A1.0/assets/panel-photo.png/meta', { appliesTo: ['nope'] }).catch((e) => e);
  ok(badApplies instanceof Error && /not linked/.test(badApplies.message), 'appliesTo must name linked hardware');
  const applied = await req('PUT', '/api/modules/starting-panel/docs/A1.0/assets/panel-photo.png/meta', { appliesTo: ['starting-panel'] });
  ok(applied.meta.appliesTo[0] === 'starting-panel', 'appliesTo saved on the draft');

  // illustration house style: default served, editable, resettable
  const style0 = await req('GET', '/api/settings/illustration-style');
  ok(style0.isDefault && /Technical Aviation Manual Line-Art/.test(style0.style), 'illustration style defaults to the house style');
  await req('PUT', '/api/settings/illustration-style', { style: 'Custom style: pencil sketch.' });
  const style1 = await req('GET', '/api/settings/illustration-style');
  ok(!style1.isDefault && style1.style === 'Custom style: pencil sketch.', 'illustration style saved (versioned in settings/)');
  await req('PUT', '/api/settings/illustration-style', { style: '' });
  ok((await req('GET', '/api/settings/illustration-style')).isDefault, 'illustration style reset to default');

  // style exemplars: upload, serve, list, delete
  const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const ex = await req('POST', '/api/settings/illustration-style/exemplars', { files: [{ name: 'My Style (1).png', dataBase64: PNG1 }] });
  ok(ex.length === 1 && ex[0].name === 'my-style-1.png', `exemplar uploaded and sanitized: ${ex[0].name}`);
  const exRes = await fetch(BASE + ex[0].url);
  ok(exRes.ok && exRes.headers.get('content-type') === 'image/png', 'exemplar served as image/png');
  ok((await req('GET', '/api/settings/illustration-style')).exemplars.length === 1, 'exemplar listed with the style');
  await req('DELETE', '/api/settings/illustration-style/exemplars/my-style-1.png');
  ok((await req('GET', '/api/settings/illustration-style')).exemplars.length === 0, 'exemplar deleted');

  // photo → line-art: without an API key the endpoint must fail loudly (no silent placeholder)
  const illRes = await fetch(BASE + '/api/modules/starting-panel/docs/A1.0/illustrate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetName: 'panel-photo.png', instructions: 'number the latches' }),
  });
  const illBody = await illRes.json();
  ok(illRes.status === 400 && /OPENAI_API_KEY/.test(illBody.error), 'illustrate endpoint reports missing image API key');
  const illMissing = await fetch(BASE + '/api/modules/starting-panel/docs/A1.0/illustrate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  ok(illMissing.status === 400, 'illustrate endpoint rejects a request without an image');

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
  ok(tools.tools.some((t) => t.name === 'replace_in_doc') && tools.tools.some((t) => t.name === 'generate_illustration') && tools.tools.every((t) => t.annotations),
    `MCP exposes ${tools.tools.length} tools`);
  const search = await mcpCall({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'search_modules', arguments: { query: 'starting' } },
  });
  ok(JSON.parse(search.content[0].text).length === 1, 'MCP search_modules finds starting-panel');

  // MCP editing tools
  const ins = await mcpCall({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'insert_into_section', arguments: { slug: 'starting-panel', version: 'A1.0', section: 'Operation', html: '<p>Inserted via MCP.</p>', summary: 'MCP insert' } },
  });
  ok(!ins.isError && JSON.parse(ins.content[0].text).revision === 2, 'MCP insert_into_section bumps to r2');
  let body = (await req('GET', '/api/modules/starting-panel/docs/A1.0')).content;
  ok(body.indexOf('Inserted via MCP') > body.indexOf('<h2>Operation</h2>') && body.indexOf('Inserted via MCP') < body.indexOf('<h2>Maintenance</h2>'), 'insert landed inside Operation');
  const rep = await mcpCall({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'replace_in_doc', arguments: { slug: 'starting-panel', version: 'A1.0', find: 'Inserted via MCP.', replace: 'Replaced via MCP.' } },
  });
  ok(!rep.isError, 'MCP replace_in_doc');
  body = (await req('GET', '/api/modules/starting-panel/docs/A1.0')).content;
  ok(body.includes('Replaced via MCP.') && !body.includes('Inserted via MCP.'), 'replace applied');
  const bad = await mcpCall({
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'replace_in_doc', arguments: { slug: 'starting-panel', version: 'A1.0', find: 'nope-not-there', replace: 'x' } },
  });
  ok(bad.isError === true, 'replace_in_doc reports missing text as error');
  const revBefore = (await req('GET', '/api/modules/starting-panel/docs/A1.0')).doc.revision;
  const batch = await mcpCall({
    jsonrpc: '2.0', id: 60, method: 'tools/call',
    params: { name: 'edit_doc', arguments: { slug: 'starting-panel', version: 'A1.0', summary: 'batch', edits: [
      { find: 'Replaced via MCP.', replace: 'Batched via MCP.' },
      { section: 'Maintenance', html: '<p>Batch insert.</p>' },
    ] } },
  });
  ok(!batch.isError && JSON.parse(batch.content[0].text).revision === revBefore + 1, 'MCP edit_doc applies 2 edits with one revision bump');
  body = (await req('GET', '/api/modules/starting-panel/docs/A1.0')).content;
  ok(body.includes('Batched via MCP.') && body.indexOf('Batch insert.') > body.indexOf('<h2>Maintenance</h2>'), 'edit_doc batch applied');
  const batchBad = await mcpCall({
    jsonrpc: '2.0', id: 61, method: 'tools/call',
    params: { name: 'edit_doc', arguments: { slug: 'starting-panel', version: 'A1.0', edits: [
      { section: 'Maintenance', html: '<p>should not land</p>' },
      { find: 'nope-not-there', replace: 'x' },
    ] } },
  });
  body = (await req('GET', '/api/modules/starting-panel/docs/A1.0')).content;
  ok(batchBad.isError === true && batchBad.content[0].text.includes('edit[1]') && !body.includes('should not land'), 'edit_doc is atomic and names the failing edit');
  const withAssets = await mcpCall({
    jsonrpc: '2.0', id: 62, method: 'tools/call',
    params: { name: 'get_doc', arguments: { slug: 'starting-panel', include_assets: true } },
  });
  ok(Array.isArray(JSON.parse(withAssets.content[0].text).assets), 'get_doc include_assets returns assets');
  const toolList = await mcpCall({ jsonrpc: '2.0', id: 63, method: 'tools/list' });
  ok(toolList.tools.some((t) => t.name === 'convert_to_line_art'), 'MCP exposes convert_to_line_art');
  const conv = await mcpCall({
    jsonrpc: '2.0', id: 64, method: 'tools/call',
    params: { name: 'convert_to_line_art', arguments: { slug: 'starting-panel', version: 'A1.0', reference_asset: 'panel-photo.png' } },
  });
  ok(conv.isError === true && /OPENAI_API_KEY/.test(conv.content[0].text), 'MCP convert_to_line_art reports missing image API key');

  // FAT checklist: read, edit (bumps revision), export, remove + recreate over MCP
  const cl = await req('GET', '/api/modules/starting-panel/docs/A1.0/checklist');
  ok(cl.checklist && cl.checklist.phases.length >= 3 && cl.checklist.phases[0].items[0].id === 'I-1', `checklist has ${cl.checklist.phases.length} phases with ids`);
  ok(cl.checklist.phases.some((p) => p.title === 'Software') && cl.checklist.phases.some((p) => p.items.some((i) => /STP Core/.test(i.check))),
    'software template includes linked software version check');
  ok(cl.template && cl.html && cl.html.includes('Factory Acceptance Test'), 'checklist endpoint returns template and rendered html');
  const clRevBefore = (await req('GET', '/api/modules/starting-panel/docs/A1.0')).doc.revision;
  const edited = JSON.parse(JSON.stringify(cl.checklist));
  edited.phases[0].items.push({ check: 'Custom smoke check', expected: 'OK', type: 'measure', unit: 'V' });
  const saved = await req('PUT', '/api/modules/starting-panel/docs/A1.0/checklist', { checklist: edited, summary: 'FAT smoke edit' });
  ok(saved.doc.revision === clRevBefore + 1 && saved.doc.fat === true, 'saving the checklist bumps the revision');
  ok(saved.checklist.phases[0].items.some((i) => i.check === 'Custom smoke check' && i.unit === 'V' && i.id), 'custom item normalised with id and unit');
  ok((await req('GET', '/api/modules/starting-panel/docs/A1.0')).doc.revisionRecord.at(-1).summary === 'FAT smoke edit', 'checklist edit in revision record');
  const clHtmlRes = await fetch(BASE + '/api/modules/starting-panel/docs/A1.0/checklist.html');
  const clHtml = await clHtmlRes.text();
  ok(clHtmlRes.status === 200 && clHtml.startsWith('<!doctype html>') && clHtml.includes('Custom smoke check') && clHtml.includes('Non-conformances') && clHtml.includes('Acceptance'),
    'standalone FAT checklist export');
  const rm = await mcpCall({ jsonrpc: '2.0', id: 70, method: 'tools/call', params: { name: 'save_checklist', arguments: { slug: 'starting-panel', version: 'A1.0', checklist: null } } });
  ok(!rm.isError && JSON.parse(rm.content[0].text).doc.fat === false, 'MCP save_checklist null removes the checklist');
  ok(JSON.parse((await mcpCall({ jsonrpc: '2.0', id: 71, method: 'tools/call', params: { name: 'get_doc', arguments: { slug: 'starting-panel' } } })).content[0].text).checklist === null,
    'get_doc reports no checklist');
  ok((await fetch(BASE + '/api/modules/starting-panel/docs/A1.0/checklist.html')).status === 404, 'export 404s without a checklist');
  const tpl = await mcpCall({ jsonrpc: '2.0', id: 72, method: 'tools/call', params: { name: 'get_checklist_template', arguments: { slug: 'starting-panel' } } });
  const tplObj = JSON.parse(tpl.content[0].text);
  ok(!tpl.isError && tplObj.phases.length >= 3, 'MCP get_checklist_template');
  const reSaved = await mcpCall({ jsonrpc: '2.0', id: 73, method: 'tools/call', params: { name: 'save_checklist', arguments: { slug: 'starting-panel', version: 'A1.0', checklist: tplObj, summary: 'FAT via MCP' } } });
  ok(!reSaved.isError && JSON.parse(reSaved.content[0].text).doc.fat === true, 'MCP save_checklist restores a checklist');
  const badCl = await req('PUT', '/api/modules/starting-panel/docs/A1.0/checklist', { checklist: { phases: [{ title: '', items: [] }] } }).catch((e) => e);
  ok(badCl instanceof Error && /title is required/.test(badCl.message), 'invalid checklist rejected');
  const fromUrl = await mcpCall({
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'upload_photo_from_url', arguments: { slug: 'starting-panel', version: 'A1.0', url: BASE + uploaded[0].url, name: 'copy-of-photo.png' } },
  });
  ok(!fromUrl.isError && JSON.parse(fromUrl.content[0].text)[0].name === 'copy-of-photo.png', 'MCP upload_photo_from_url');
  const localDir = path.join(dataDir, 'imports', 'imgs');
  fs.mkdirSync(localDir, { recursive: true });
  fs.writeFileSync(path.join(localDir, 'Wiring Diagram.png'), Buffer.from(png1x1, 'base64'));
  fs.writeFileSync(path.join(localDir, 'notes.txt'), 'not an image');
  const imp = await mcpCall({
    jsonrpc: '2.0', id: 9, method: 'tools/call',
    params: { name: 'import_local_files', arguments: { slug: 'starting-panel', version: 'A1.0', paths: [localDir] } },
  });
  const impRes = imp.isError ? [] : JSON.parse(imp.content[0].text);
  ok(impRes.length === 1 && impRes[0].name === 'wiring-diagram.png', 'MCP import_local_files imports images from a folder');
  fs.rmSync(localDir, { recursive: true, force: true });

  // asset validation: truncated / mislabelled files are rejected everywhere
  const truncated = Buffer.from(png1x1, 'base64').subarray(0, 40).toString('base64');
  const badUp = await mcpCall({
    jsonrpc: '2.0', id: 80, method: 'tools/call',
    params: { name: 'upload_photo', arguments: { slug: 'starting-panel', version: 'A1.0', name: 'broken.png', data_base64: truncated } },
  });
  ok(badUp.isError === true && /truncated/.test(badUp.content[0].text), 'MCP upload_photo rejects a truncated PNG');
  const badApi = await req('POST', '/api/modules/starting-panel/docs/A1.0/assets', { files: [{ name: 'notreally.png', dataBase64: Buffer.from('hello world, not a png').toString('base64') }] }).catch((e) => e);
  ok(badApi instanceof Error && /not a PNG/.test(badApi.message), 'API upload rejects non-image bytes under an image name');
  const misnamed = await req('POST', '/api/modules/starting-panel/docs/A1.0/assets', { files: [{ name: 'photo.jpg', dataBase64: png1x1 }] }).catch((e) => e);
  ok(misnamed instanceof Error && /extension says JPG/.test(misnamed.message), 'API upload rejects a mislabelled extension');
  ok(!(await req('GET', '/api/modules/starting-panel/assets')).some((a) => /broken|notreally|photo\.jpg/.test(a.name)), 'nothing from the rejected uploads was stored');
  const outside = await mcpCall({
    jsonrpc: '2.0', id: 81, method: 'tools/call',
    params: { name: 'import_local_files', arguments: { slug: 'starting-panel', version: 'A1.0', paths: [path.join(os.tmpdir(), 'anything.png')] } },
  });
  ok(outside.isError === true && /outside the allowed import roots/.test(outside.content[0].text), 'import_local_files refuses paths outside the import roots');

  // inbox: drop → list → import by name (removed from inbox) → delete asset
  const inb = await req('POST', '/api/inbox', { files: [{ name: 'CBW Operation.png', dataBase64: png1x1 }, { name: 'CBW Operation.png', dataBase64: png1x1 }] });
  ok(inb.length === 2 && inb[0].name === 'CBW Operation.png' && inb[1].name === 'CBW Operation-2.png', 'inbox stores dropped files, de-duplicating names');
  const inbBad = await req('POST', '/api/inbox', { files: [{ name: 'bad.png', dataBase64: truncated }] }).catch((e) => e);
  ok(inbBad instanceof Error && /truncated/.test(inbBad.message), 'inbox rejects truncated files too');
  const inbList = await req('GET', '/api/inbox');
  ok(inbList.files.length === 2 && inbList.files[0].width === 1 && inbList.files[0].complete === true, 'inbox list has pixel size and completeness');
  const mcpInbox = await mcpCall({ jsonrpc: '2.0', id: 82, method: 'tools/call', params: { name: 'list_inbox', arguments: {} } });
  ok(!mcpInbox.isError && JSON.parse(mcpInbox.content[0].text).files.length === 2, 'MCP list_inbox');
  const impInbox = await mcpCall({
    jsonrpc: '2.0', id: 83, method: 'tools/call',
    params: { name: 'import_local_files', arguments: { slug: 'starting-panel', version: 'A1.0', paths: ['CBW Operation.png'] } },
  });
  ok(!impInbox.isError && JSON.parse(impInbox.content[0].text)[0].name === 'cbw-operation.png', 'MCP import_local_files imports an inbox file by bare name');
  ok((await req('GET', '/api/inbox')).files.length === 1, 'imported file left the inbox');
  const impApi = await req('POST', '/api/modules/starting-panel/docs/A1.0/assets/import', { names: ['CBW Operation-2.png'] });
  ok(impApi[0].name === 'cbw-operation-2.png' && (await req('GET', '/api/inbox')).files.length === 0, 'API import from inbox empties it');
  ok((await req('GET', '/api/modules/starting-panel/assets')).some((a) => a.name === 'cbw-operation.png'), 'imported inbox file is a module asset');
  const del = await mcpCall({ jsonrpc: '2.0', id: 84, method: 'tools/call', params: { name: 'delete_asset', arguments: { slug: 'starting-panel', version: 'A1.0', name: 'cbw-operation.png' } } });
  ok(!del.isError && JSON.parse(del.content[0].text).removed === true, 'MCP delete_asset');
  const mcpStamp = await mcpCall({
    jsonrpc: '2.0', id: 96, method: 'tools/call',
    params: { name: 'update_asset', arguments: { slug: 'starting-panel', version: 'A1.0', name: 'panel-photo.png', applies_to: [] } },
  });
  ok(!mcpStamp.isError && JSON.parse(mcpStamp.content[0].text).meta.appliesTo.length === 0, 'MCP update_asset resets appliesTo to all units');
  await req('PUT', '/api/modules/starting-panel/docs/A1.0/assets/panel-photo.png/meta', { appliesTo: ['starting-panel'] });
  ok(!(await req('GET', '/api/modules/starting-panel/assets')).some((a) => a.name === 'cbw-operation.png'), 'deleted asset is gone from the list');
  await req('DELETE', '/api/modules/starting-panel/docs/A1.0/assets/cbw-operation-2.png');
  const delMissing = await req('DELETE', '/api/modules/starting-panel/docs/A1.0/assets/cbw-operation-2.png').catch((e) => e);
  ok(delMissing instanceof Error && /not found/.test(delMissing.message), 'deleting a missing asset is an error');
  const upd = await mcpCall({
    jsonrpc: '2.0', id: 8, method: 'tools/call',
    params: { name: 'update_module', arguments: { slug: 'starting-panel', code: 'SW-STP2' } },
  });
  ok(!upd.isError && JSON.parse(upd.content[0].text).code === 'SW-STP2', 'MCP update_module edits metadata');
  // restore the body (no bump) so the later content checks still hold
  await req('PUT', '/api/modules/starting-panel/docs/A1.0/content', { html: doc0.content, bump: false });

  await req('PUT', '/api/modules/starting-panel/docs/A1.0/content', {
    html: doc0.content + '<p>Autosaved text.</p>',
    bump: false,
  });
  const afterAuto = await req('GET', '/api/modules/starting-panel/docs/A1.0');
  ok(afterAuto.doc.revision === 7, 'autosave keeps revision (r7)');

  await req('PUT', '/api/modules/starting-panel/docs/A1.0/content', {
    html: afterAuto.content + `<p>Grounding check added.</p><figure><img src="${uploaded[0].url}" alt="Panel"><figcaption>Panel</figcaption></figure>`,
    bump: true,
    summary: 'Add grounding check',
  });
  const afterBump = await req('GET', '/api/modules/starting-panel/docs/A1.0');
  ok(afterBump.doc.revision === 8, 'committed change bumps to r8');
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

  detail = await req('GET', '/api/modules/starting-panel');
  ok(detail.uncovered.length === 1 && detail.uncovered[0].version === 'v2.1.0', 'module detail lists the uncovered release');

  // next doc version becomes the manual for the uncovered release and clears the dot; later it supersedes A1.0
  const next = await req('POST', '/api/modules/starting-panel/docs', { bump: 'minor' });
  ok(next.version === 'A1.1', 'next version is A1.1');
  ok(next.covers.length === 1 && next.covers[0].name === 'STP Core' && next.covers[0].from === 'v2.1.0' && next.covers[0].to === 'v2.1.0',
    'new version is seeded to cover STP Core v2.1.0');
  detail = await req('GET', '/api/modules/starting-panel');
  ok(detail.docs.find((d) => d.version === 'A1.1').covers[0].from === 'v2.1.0', 'A1.1 draft carries the covered release');
  ok(detail.uncovered.length === 0, 'nothing uncovered once the draft claims the release');
  list = await req('GET', '/api/modules');
  ok(list[0].needsDoc === false, 'dot clears once a draft exists');
  ok(list[0].latestDoc === 'A1.1 draft r1', 'A1.1 draft listed');

  // asset version stamps: the manual-affecting release makes the A1.0 picture stale; verifying re-stamps it
  let photo = (await req('GET', '/api/modules/starting-panel/assets')).find((a) => a.name === 'panel-photo.png');
  ok(photo.stale.includes('STP Core v2.1.0'), `asset stale after manual-affecting release: ${photo.stale.join(', ')}`);
  const staleCount = (await req('GET', '/api/modules/starting-panel')).staleAssets;
  ok(staleCount >= 1, `module detail counts stale assets (got ${staleCount}: ${(await req('GET', '/api/modules/starting-panel/assets')).filter((a) => a.stale.length).map((a) => `${a.name} [${a.stale.join(', ')}]`).join('; ')})`);
  await req('PUT', '/api/hardware/starting-panel', { version: 'v3' });
  photo = (await req('GET', '/api/modules/starting-panel/assets')).find((a) => a.name === 'panel-photo.png');
  ok(photo.stale.includes('Starting Panel v3'), `hardware version change also flags the picture: ${photo.stale.join(', ')}`);
  const verified = await req('PUT', '/api/modules/starting-panel/docs/A1.1/assets/panel-photo.png/meta', { verify: true });
  ok(verified.stale.length === 0 && verified.meta.verifiedIn === 'A1.1' && verified.meta.software[0].version === 'v2.1.0' && verified.meta.hardware[0].version === 'v3',
    'verify re-stamps the asset with current versions');
  ok(verified.meta.appliesTo[0] === 'starting-panel', 'verify keeps appliesTo');
  const guarded = await req('DELETE', '/api/modules/starting-panel/docs/A1.1/assets/panel-photo.png').catch((e) => e);
  ok(guarded instanceof Error && /embedded in released A1.0/.test(guarded.message), 'cannot delete an asset a released doc still embeds');

  // a second manual-affecting release while A1.1 is still a draft: assign it to the draft
  await req('POST', '/api/softwares', { name: 'STP Core', version: 'v2.1.1', manualAffecting: true });
  ok((await req('GET', '/api/modules/starting-panel')).uncovered.some((u) => u.version === 'v2.1.1'), 'v2.1.1 is uncovered');
  const assigned = await req('POST', '/api/modules/starting-panel/docs/A1.1/cover', { name: 'STP Core', version: 'v2.1.1' });
  ok(assigned.covers[0].from === 'v2.1.0' && assigned.covers[0].to === 'v2.1.1', 'draft A1.1 now covers STP Core v2.1.0 – v2.1.1');
  ok((await req('GET', '/api/modules/starting-panel')).uncovered.length === 0, 'assigning to the draft clears the uncovered list');
  const badSw = await req('POST', '/api/modules/starting-panel/docs/A1.1/cover', { name: 'Other Soft', version: 'v1' }).catch((e) => e);
  ok(badSw instanceof Error && /not linked to this module/.test(badSw.message), 'cannot cover a software the module is not linked to');

  await req('POST', '/api/modules/starting-panel/docs/A1.1/submit-review');
  await req('POST', '/api/modules/starting-panel/docs/A1.1/release');
  detail = await req('GET', '/api/modules/starting-panel');
  ok(detail.docs.find((d) => d.version === 'A1.0').status === 'superseded', 'A1.0 superseded by A1.1');
  ok(detail.docs.find((d) => d.version === 'A1.1').status === 'released', 'A1.1 released');
  ok(detail.docs.find((d) => d.version === 'A1.1').covers[0].to === 'v2.1.1' && detail.needsDoc === false,
    'released A1.1 keeps its covered range; no orange dot');
  const superseded = await req('POST', '/api/modules/starting-panel/docs/A1.0/cover', { name: 'STP Core', version: 'v2.1.1' }).catch((e) => e);
  ok(superseded instanceof Error && /superseded/.test(superseded.message), 'a superseded doc cannot take new releases');
  ok(detail.docs.find((d) => d.version === 'A1.1').fat === true && (await req('GET', '/api/modules/starting-panel/docs/A1.1/checklist')).checklist,
    'next doc version inherits the FAT checklist');
  ok((await req('GET', '/api/modules')).find((m) => m.slug === 'starting-panel').fat === true, 'modules list flags FAT');

  // copy wizard mode from a released doc
  const copy = await req('POST', '/api/modules', {
    name: 'IOS Panel',
    group: 'IOS',
    category: 'software',
    hardware: { type: 'none' },
    softwares: [],
    start: { mode: 'copy', sourceSlug: 'starting-panel', sourceVersion: 'A1.1' },
    checklist: { mode: 'copy' },
  });
  const copyDoc = await req('GET', `/api/modules/ios-panel/docs/A1.0`);
  ok(copyDoc.checklist && copyDoc.checklist.phases.length >= 3, 'copy mode copies the FAT checklist');
  ok(copyDoc.content.includes('Grounding check added'), 'copy mode copies content');
  ok(copyDoc.doc.revisionRecord.some((r) => r.inherited), 'copy mode inherits revision record');

  // discard a never-released module
  await req('POST', '/api/modules/ios-panel/docs/A1.0/discard');
  list = await req('GET', '/api/modules');
  ok(list.length === 1, 'discarded never-released module disappears');

  // manuals: create from selected modules, compile, export, update, delete
  const manual = await req('POST', '/api/manuals', { name: 'B737 Simulator Manual', group: 'SIM', modules: ['starting-panel'] });
  ok(manual.slug === 'b737-simulator-manual' && manual.modules.length === 1, 'manual created from selected modules');
  const compiled = await req('GET', '/api/manuals/b737-simulator-manual');
  ok(compiled.chapters.length === 1 && compiled.chapters[0].doc.version === 'A1.1' && !compiled.chapters[0].isDraft,
    'manual compiles the released A1.1 as chapter 1');
  ok(compiled.html.includes('class="chapter"') && compiled.html.includes('Table of contents') && compiled.html.includes('Grounding check added'),
    'compiled html has chapter, TOC and module content');
  const fatRes = await fetch(BASE + '/api/manuals/b737-simulator-manual/fat.html');
  const fatHtml = await fatRes.text();
  ok(fatRes.status === 200 && fatHtml.includes('Factory Acceptance Test protocol') && fatHtml.includes('id="fat-starting-panel"') && fatHtml.includes('Modules under test'),
    'manual FAT protocol compiles the module checklists');
  ok(compiled.html.includes('href="#c1-s4"') && compiled.html.includes('id="c1-s4"') && compiled.html.includes('href="#ch-starting-panel"'),
    'TOC links point at anchored headings');
  ok(compiled.html.includes('proprietary material protected by international law') && compiled.html.includes('class="head-box"'),
    'manual has header box and proprietary footer');
  // cover + logo upload, then export inlines them
  const png1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  await req('POST', '/api/manuals/b737-simulator-manual/cover', { name: 'sim.png', dataBase64: png1 });
  await req('POST', '/api/settings/logo', { name: 'Logo.PNG', dataBase64: png1 });
  const coverRes = await fetch(BASE + '/api/manuals/b737-simulator-manual/cover');
  ok(coverRes.ok && coverRes.headers.get('content-type') === 'image/png', 'manual cover served');
  const withCover = await req('GET', '/api/manuals/b737-simulator-manual');
  ok(withCover.hasCover && withCover.hasLogo && withCover.html.includes('/api/settings/logo'), 'compiled manual uses cover and logo');
  const exp2 = await (await fetch(BASE + '/api/manuals/b737-simulator-manual/export.html')).text();
  ok(!exp2.includes('/api/settings/logo') && !exp2.includes('/api/manuals/') && exp2.includes('data:image/png;base64,'),
    'export inlines logo and cover as data URIs');
  const exp = await fetch(BASE + '/api/manuals/b737-simulator-manual/export.html');
  const expHtml = await exp.text();
  ok(exp.ok && expHtml.startsWith('<!doctype html>') && expHtml.includes('<style>'), 'standalone export served');
  const mlist = await req('GET', '/api/manuals');
  ok(mlist.length === 1 && mlist[0].unreleased === 0, 'manual listed as all released');
  await req('PUT', '/api/manuals/b737-simulator-manual', { modules: [] });
  ok((await req('GET', '/api/manuals/b737-simulator-manual')).chapters.length === 0, 'manual modules updated');
  await req('DELETE', '/api/manuals/b737-simulator-manual');
  ok((await req('GET', '/api/manuals')).length === 0, 'manual deleted');

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
