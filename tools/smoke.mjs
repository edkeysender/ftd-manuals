/**
 * End-to-end smoke test: boots the API against a throwaway data repo and
 * exercises the whole module lifecycle over HTTP.
 * Usage: npm run smoke
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.SMOKE_PORT) || 5197; // SMOKE_PORT=… when another smoke run holds :5197
const BASE = `http://localhost:${PORT}`;

/** Test-only photo host for upload_photo_from_url: the console fetches URLs server-side and its own
 *  asset routes are behind the login, so the picture comes from here instead. */
let photoBytes = Buffer.alloc(0);
const photoHost = http
  .createServer((req, res) => {
    res.setHeader('Content-Type', 'image/png');
    res.end(photoBytes);
  })
  .listen(PORT + 1);
const PHOTO_URL = `http://localhost:${PORT + 1}/panel-photo.png`;
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

/** Session cookie of the signed-in user (set by login()); the API refuses everything without it.
 *  Every fetch() in this file sends it unless the call sets its own Cookie header. */
let cookie = '';
let mcpToken = '';
const rawFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => {
  const headers = { ...(init.headers || {}) };
  if (cookie && !headers.Cookie) headers.Cookie = cookie;
  if (mcpToken && !headers.Authorization && String(url).includes('/mcp')) headers.Authorization = `Bearer ${mcpToken}`;
  return rawFetch(url, { ...init, headers });
};

async function req(method, url, body, opts = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(opts.cookie ?? cookie ? { Cookie: opts.cookie ?? cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${method} ${url} -> ${res.status}: ${data.error}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Sign in and return that user's session cookie (does not change the default one). */
async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login ${email} -> ${res.status}`);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try {
      await req('GET', '/api/status');
      return;
    } catch (e) {
      if (e.status === 401) return; // up, just not signed in yet
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('server did not start');
}

try {
  await waitUp();

  // login: nothing works anonymously, the seeded admin signs in, editors cannot delete
  const anon = await req('GET', '/api/modules').catch((e) => e);
  ok(anon instanceof Error && anon.status === 401, 'API refuses anonymous requests with 401');
  const badLogin = await login('l.wicenciak@ftd.aero', 'wrong').catch((e) => e);
  ok(badLogin instanceof Error, 'wrong password is refused');
  cookie = await login('l.wicenciak@ftd.aero', 'Simulation01');
  const me = await req('GET', '/api/auth/me');
  ok(me.user.email === 'l.wicenciak@ftd.aero' && me.user.role === 'admin', 'default administrator l.wicenciak@ftd.aero signs in');
  const mod = await req('POST', '/api/users', { email: 'mod@ftd.aero', name: 'Mo', password: 'modpass123', role: 'moderator' });
  ok(mod.role === 'moderator' && !('passwordHash' in mod), 'admin creates a moderator (no hash in the response)');
  const legacyRole = await req('POST', '/api/users', { email: 'old@ftd.aero', password: 'oldpass123', role: 'editor' }).catch((e) => e);
  ok(legacyRole instanceof Error && /admin, moderator, viewer/.test(legacyRole.message), 'the editor role is gone — admin, moderator, viewer');
  const modCookie = await login('mod@ftd.aero', 'modpass123');
  const modDel = await req('DELETE', `/api/users/${mod.id}`, undefined, { cookie: modCookie }).catch((e) => e);
  ok(modDel instanceof Error && modDel.status === 403, 'moderator cannot delete (403)');
  const modUsers = await req('GET', '/api/users', undefined, { cookie: modCookie }).catch((e) => e);
  ok(modUsers instanceof Error && modUsers.status === 403, 'moderator cannot list users (403)');
  ok((await req('GET', '/api/modules', undefined, { cookie: modCookie })).length === 0, 'moderator can read modules');
  const viewer = await req('POST', '/api/users', { email: 'view@ftd.aero', name: 'Vi', password: 'viewpass123', role: 'viewer' });
  const viewerCookie = await login('view@ftd.aero', 'viewpass123');
  ok((await req('GET', '/api/modules', undefined, { cookie: viewerCookie })).length === 0, 'viewer can read');
  const viewerWrite = await req('POST', '/api/modules', { name: 'Nope', group: 'SIM' }, { cookie: viewerCookie }).catch((e) => e);
  ok(viewerWrite instanceof Error && viewerWrite.status === 403 && /read-only/.test(viewerWrite.message), 'viewer cannot write (403 read-only)');
  const selfDel = await req('DELETE', `/api/users/${me.user.id}`).catch((e) => e);
  ok(selfDel instanceof Error && /own account/.test(selfDel.message), 'admin cannot delete own account');
  ok((await req('DELETE', `/api/users/${mod.id}`)).ok === true, 'admin deletes the moderator');
  const deadSession = await req('GET', '/api/auth/me', undefined, { cookie: modCookie }).catch((e) => e);
  ok(deadSession instanceof Error && deadSession.status === 401, 'deleted user session is invalid');

  // MCP authorization: OAuth redirect flow (discovery → register → authorize → token)
  const mcpAnon = await rawFetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  ok(mcpAnon.status === 401 && /resource_metadata=/.test(mcpAnon.headers.get('www-authenticate') || ''), 'MCP 401 points clients at the OAuth discovery documents');
  const odisc = await (await rawFetch(BASE + '/.well-known/oauth-authorization-server')).json();
  ok(odisc.authorization_endpoint.endsWith('/oauth/authorize') && odisc.registration_endpoint.endsWith('/oauth/register') && odisc.code_challenge_methods_supported.includes('S256'), 'authorization-server metadata');
  const prm = await (await rawFetch(BASE + '/.well-known/oauth-protected-resource/mcp')).json();
  ok(prm.resource.endsWith('/mcp') && prm.authorization_servers[0] === BASE, 'protected-resource metadata');
  const oreg = await (await rawFetch(BASE + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Smoke agent', redirect_uris: ['http://localhost:9999/cb'] }) })).json();
  ok(/^mcp-[0-9a-f]{24}$/.test(oreg.client_id) && oreg.token_endpoint_auth_method === 'none', 'dynamic client registration');
  const crypto = await import('node:crypto');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authQ = new URLSearchParams({ client_id: oreg.client_id, redirect_uri: 'http://localhost:9999/cb', response_type: 'code', state: 'st-42', code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp' });
  const signinPage = await (await rawFetch(BASE + `/oauth/authorize?${authQ}`)).text();
  ok(/Sign in to continue/.test(signinPage) && /Smoke agent/.test(signinPage), 'anonymous authorize shows the sign-in page');
  const consentPage = await (await fetch(BASE + `/oauth/authorize?${authQ}`)).text();
  ok(/Authorize Smoke agent/.test(consentPage) && /l\.wicenciak@ftd\.aero/.test(consentPage), 'signed-in authorize shows the consent page');
  const approve = await fetch(BASE + '/oauth/authorize', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `${authQ}&action=approve` });
  const loc = new URL(approve.headers.get('location'));
  ok(approve.status === 302 && loc.origin + loc.pathname === 'http://localhost:9999/cb' && loc.searchParams.get('state') === 'st-42' && loc.searchParams.get('code'), 'approval redirects back with a code');
  const code = loc.searchParams.get('code');
  const badVerifier = await (await rawFetch(BASE + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: oreg.client_id, redirect_uri: 'http://localhost:9999/cb', code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier' }) })).json();
  ok(badVerifier.error === 'invalid_grant', 'PKCE mismatch is refused (and the code is burned)');
  const approve2 = await fetch(BASE + '/oauth/authorize', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `${authQ}&action=approve` });
  const code2 = new URL(approve2.headers.get('location')).searchParams.get('code');
  const tok = await (await rawFetch(BASE + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: code2, client_id: oreg.client_id, redirect_uri: 'http://localhost:9999/cb', code_verifier: verifier }) })).json();
  ok(tok.access_token && tok.refresh_token && tok.expires_in === 3600 && tok.token_type === 'Bearer', 'code + verifier exchange for tokens');
  mcpToken = tok.access_token;
  const refreshed = await (await rawFetch(BASE + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: oreg.client_id }) })).json();
  ok(refreshed.access_token && refreshed.refresh_token && refreshed.refresh_token !== tok.refresh_token, 'refresh grant rotates the refresh token');
  const reused = await (await rawFetch(BASE + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: oreg.client_id }) })).json();
  ok(reused.error === 'invalid_grant', 'a rotated refresh token cannot be reused');
  const viewerConsent = await rawFetch(BASE + `/oauth/authorize?${authQ}`, { headers: { Cookie: viewerCookie } });
  ok(viewerConsent.status === 403 && /not allowed for your role/.test(await viewerConsent.text()), 'viewers cannot authorize MCP agents');
  const badBearer = await rawFetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer not-a-token' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  ok(badBearer.status === 401, 'MCP refuses an unknown access token');
  ok((await req('DELETE', `/api/users/${viewer.id}`)).ok === true, 'viewer cleaned up');

  // empty list
  ok((await req('GET', '/api/modules')).length === 0, 'starts with no modules');

  // a manual relates to a software created on the Software page — with a registered version
  const ghost = await req('POST', '/api/modules', { name: 'Ghost Panel', group: 'SIM', softwares: [{ name: 'Nobody Made Me', fromVersion: 'v1' }] }).catch((e) => e);
  ok(ghost instanceof Error && /not found — create it on the Software page/.test(ghost.message), 'a module cannot link a software that was not created on the Software page');
  await req('POST', '/api/software', { name: 'STP Core', version: 'v2.0.0' });
  const ghostVer = await req('POST', '/api/modules', { name: 'Ghost Panel', group: 'SIM', softwares: [{ name: 'STP Core', fromVersion: 'v9.9' }] }).catch((e) => e);
  ok(ghostVer instanceof Error && /not a registered release/.test(ghostVer.message), 'a from-version must be a registered release');
  ok((await req('GET', '/api/modules')).length === 0, 'nothing was created by the refused links');

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
  ok(created.branch === 'draft/starting-panel-customer-a1.0' && created.key === 'customer:A1.0' && created.docs.length === 1,
    `draft branch is ${created.branch} (default manual type = customer)`);

  let list = await req('GET', '/api/modules');
  ok(list.length === 1 && list[0].status === 'draft', 'module listed as Draft');
  ok(list[0].latestDoc === 'A1.0 draft r1', `latest doc label: ${list[0].latestDoc}`);
  ok(list[0].manuals.customer?.status === 'draft' && list[0].manuals.customer.key === 'customer:A1.0' && !list[0].manuals.technician,
    'row summarises manuals per type');
  const types = await req('GET', '/api/manual-types');
  ok(types.length === 4 && types.map((t) => t.id).join(',') === 'customer,technician,software-customer,software-technician', 'manual types exposed');
  const legacyAlias = await req('GET', '/api/modules/starting-panel/docs/A1.0');
  const typedKey = await req('GET', '/api/modules/starting-panel/docs/customer:A1.0');
  ok(legacyAlias.doc.key === 'customer:A1.0' && legacyAlias.doc.manual === 'customer' && typedKey.doc.key === legacyAlias.doc.key,
    'bare version A1.0 and customer:A1.0 address the same doc');
  ok(legacyAlias.generated.includes('customer manual') && legacyAlias.generated.includes('Manual type'), 'generated intro names the manual type');
  const badKey = await req('GET', '/api/modules/starting-panel/docs/pilot:A1.0').catch((e) => e);
  ok(badKey instanceof Error && /Unknown manual type/.test(badKey.message), 'unknown manual type in a key is rejected');
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
    manuals: ['customer', 'technician'],
    start: { mode: 'blank' },
    checklist: { mode: 'template' },
  });
  ok(cam.hardware.length === 3, 'module created with 3 hardware units (1 existing + 2 new)');
  ok(cam.docs.length === 2 && cam.docs.map((d) => d.key).join(',') === 'customer:A1.0,technician:A1.0', `two manuals created: ${cam.docs.map((d) => d.branch).join(', ')}`);
  ok(cam.docs[0].fat === false && cam.docs[1].fat === true, 'the FAT checklist goes to the technician manual');
  hwList = await req('GET', '/api/hardware');
  ok(hwList.length === 4, `new units joined the catalog (${hwList.length} items)`);
  const camDoc = await req('GET', '/api/modules/camera/docs/A1.0');
  ok(camDoc.module.hardwareItems.length === 3 && camDoc.module.hardwareIds.length === 3, 'module.json stores hardwareIds, read resolves items');
  ok(camDoc.generated.includes('Cockpit camera — fixed') && camDoc.generated.includes('COTS · Axis M3086'), 'section 3 lists every unit');
  ok((camDoc.content.match(/<h3>/g) || []).length >= 6, 'customer template has one subsection per unit in Description and Operation');
  ok(camDoc.content.includes('<h2>Description</h2>') && !camDoc.content.includes('<h2>Installation</h2>'), 'customer manual sections: Description, Operation, Maintenance, Appendixes');
  const camTech = await req('GET', '/api/modules/camera/docs/technician:A1.0');
  ok(camTech.doc.manual === 'technician' && camTech.doc.branch === 'draft/camera-technician-a1.0', 'technician doc on its own branch');
  ok(camTech.content.includes('<h2>Installation</h2>') && camTech.content.includes('<h2>Configuration</h2>') && (camTech.content.match(/<h3>/g) || []).length >= 6,
    'technician manual sections: Installation, Configuration, Maintenance, Appendixes with per-unit subsections');
  ok(camTech.generated.includes('technician manual') && camTech.generated.includes('not part of the documentation handed to the simulator operator'), 'technician intro states the audience');
  ok(camTech.checklist.phases[0].items.some((i) => i.check.includes('Camera bracket')), 'FAT identification has a row per unit');
  const swNoLink = await req('POST', '/api/modules/camera/docs', { manual: 'software-customer' }).catch((e) => e);
  ok(swNoLink instanceof Error && /link the module to a software/.test(swNoLink.message), 'software manual refused without a software relation');
  const camList = (await req('GET', '/api/modules')).find((m) => m.slug === 'camera');
  ok(camList.manuals.customer && camList.manuals.technician && camList.status === 'draft', 'list row shows both manuals');
  const patched = await req('PATCH', '/api/modules/camera', { hardware: [{ id: cam1.id }] });
  ok(patched.hardwareIds.length === 1 && patched.hardwareItems[0].id === cam1.id, 'PATCH replaces the assignment');
  ok((await req('GET', '/api/modules/camera/docs/technician:A1.0')).module.hardwareIds.length === 1, 'metadata edit reaches every open draft branch');
  let delErr = null;
  try { await req('DELETE', `/api/hardware/${cam1.id}`); } catch (e) { delErr = e.message; }
  ok(/assigned to Camera/.test(delErr || ''), 'cannot delete a unit still assigned');
  ok((await req('DELETE', '/api/hardware/camera-bracket')).ok === true, 'unassigned unit can be deleted');
  const hwUpd = await req("PUT", `/api/hardware/${cam1.id}`, { notes: "Above the IOS" });
  ok(hwUpd.notes === "Above the IOS" && (await req('GET', '/api/modules/camera')).module.hardwareItems[0].notes === 'Above the IOS', 'catalog edit is visible through the module');
  await req('POST', '/api/modules/camera/docs/technician:A1.0/discard');
  ok((await req('GET', '/api/modules/camera')).docs.length === 1, 'discarding one manual keeps the other');
  await req('POST', '/api/modules/camera/docs/A1.0/discard');
  ok(!(await req('GET', '/api/modules')).find((m) => m.slug === 'camera'), 'camera module discarded (cleanup)');

  // edit: autosave, then a committed revision
  const doc0 = await req('GET', '/api/modules/starting-panel/docs/A1.0');
  ok(doc0.content.includes('<h2>Description</h2>') && doc0.content.includes('<h2>Operation</h2>'), 'blank customer template has Description and Operation sections');
  ok(doc0.generated.includes('Revision record'), 'sections 1-3 generated');

  // assets: upload, list, serve
  const png1x1 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  photoBytes = Buffer.from(png1x1, 'base64');
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

  // attachments: files the reader downloads (config, firmware) — stored as they are, served as downloads
  const cfg = Buffer.from('{"brightness": 80, "channel": 2}\n');
  const attUp = await req('POST', '/api/modules/starting-panel/docs/A1.0/assets', {
    files: [
      { name: 'Intercom Config.JSON', dataBase64: cfg.toString('base64') },
      { name: 'firmware.zip', dataBase64: Buffer.from('PK not really a zip').toString('base64') },
    ],
    attachments: true,
  });
  ok(attUp.length === 2 && attUp[0].name === 'intercom-config.json' && attUp[1].name === 'firmware.zip', `attachments stored as they are (zip not expanded): ${attUp.map((a) => a.name).join(', ')}`);
  const attRes = await fetch(BASE + attUp[0].url);
  ok(attRes.ok && attRes.headers.get('content-type').startsWith('application/json') && attRes.headers.get('content-disposition') === 'attachment; filename="intercom-config.json"', `attachment served as a download with its type: ${attRes.headers.get('content-disposition')}`);
  ok((await attRes.text()) === cfg.toString(), 'attachment bytes intact');
  const attList = await req('GET', '/api/modules/starting-panel/assets');
  ok(attList.find((a) => a.name === 'intercom-config.json')?.kind === 'attachment' && attList.find((a) => a.name === 'panel-photo.png')?.kind === 'image', 'asset list tells attachments from images (kind)');
  const noExt = await req('POST', '/api/modules/starting-panel/docs/A1.0/assets', { files: [{ name: 'README', dataBase64: cfg.toString('base64') }], attachments: true }).catch((e) => e);
  ok(noExt instanceof Error && /extension/.test(noExt.message), 'an attachment without a file extension is refused');
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
    params: { name: 'upload_photo_from_url', arguments: { slug: 'starting-panel', version: 'A1.0', url: PHOTO_URL, name: 'copy-of-photo.png' } },
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
  const toolNames = (await mcpCall({ jsonrpc: '2.0', id: 80, method: 'tools/list' })).tools.map((t) => t.name);
  ok(!toolNames.includes('upload_photo') && !toolNames.includes('upload_photo_part') && ['get_asset', 'describe_asset', 'attach_figure', 'request_upload'].every((n) => toolNames.includes(n)),
    'MCP: base64 upload tools are gone, image tools are there');
  // the agent can LOOK at assets: image content blocks
  const ga = await mcpCall({ jsonrpc: '2.0', id: 81, method: 'tools/call', params: { name: 'get_asset', arguments: { slug: 'starting-panel', name: 'panel-photo.png' } } });
  const gaImg = ga.content.find((c) => c.type === 'image');
  const gaMeta = JSON.parse(ga.content.find((c) => c.type === 'text').text);
  ok(!ga.isError && gaImg && gaImg.mimeType === 'image/jpeg' && gaImg.data.length > 100 && gaMeta.name === 'panel-photo.png' && gaMeta.original?.type === 'png', 'MCP get_asset returns a JPEG preview + metadata');
  const gaFull = await mcpCall({ jsonrpc: '2.0', id: 82, method: 'tools/call', params: { name: 'get_asset', arguments: { slug: 'starting-panel', name: 'panel-photo.png', size: 'full' } } });
  ok(gaFull.content.find((c) => c.type === 'image')?.mimeType === 'image/png' && gaFull.content.find((c) => c.type === 'image').data === png1x1, 'get_asset size=full returns the original bytes');
  const laThumbs = await mcpCall({ jsonrpc: '2.0', id: 83, method: 'tools/call', params: { name: 'list_assets', arguments: { slug: 'starting-panel', thumbnails: true } } });
  ok(!laThumbs.isError && laThumbs.content.filter((c) => c.type === 'image').length >= 1 && JSON.parse(laThumbs.content[0].text).some((a) => a.name === 'panel-photo.png'), 'list_assets thumbnails=true carries a picture per asset');
  const attGet = await mcpCall({ jsonrpc: '2.0', id: 84, method: 'tools/call', params: { name: 'get_asset', arguments: { slug: 'starting-panel', name: 'intercom-config.json' } } });
  ok(!attGet.isError && attGet.content.every((c) => c.type === 'text') && attGet.content.some((c) => c.text.includes('"brightness": 80')), 'get_asset returns the text of an attachment');
  const resized = await fetch(BASE + uploaded[0].url + '?w=64');
  ok(resized.status === 200 && resized.headers.get('content-type') === 'image/png', 'asset route serves a resized same-format variant with ?w=');
  const resList = await mcpCall({ jsonrpc: '2.0', id: 84, method: 'resources/list', params: {} });
  const resUri = 'ftd://modules/starting-panel/assets/panel-photo.png';
  ok(resList.resources.some((r) => r.uri === resUri && r.mimeType === 'image/png'), 'assets are listed as MCP resources');
  const resRead = await mcpCall({ jsonrpc: '2.0', id: 85, method: 'resources/read', params: { uri: resUri } });
  ok(resRead.contents?.[0]?.blob === png1x1 && resRead.contents[0].mimeType === 'image/png', 'resources/read returns the asset bytes');
  const noVision = await mcpCall({ jsonrpc: '2.0', id: 86, method: 'tools/call', params: { name: 'describe_asset', arguments: { slug: 'starting-panel', name: 'panel-photo.png' } } });
  ok(noVision.isError === true && /OPENAI_API_KEY/.test(noVision.content[0].text), 'describe_asset needs the vision model (clean error without a key)');
  const upLink = JSON.parse((await mcpCall({ jsonrpc: '2.0', id: 89, method: 'tools/call', params: { name: 'request_upload', arguments: { slug: 'starting-panel' } } })).content[0].text);
  ok(/\/#\/modules\/starting-panel\?tab=assets$/.test(upLink.url) && upLink.url.startsWith('http://localhost:' + PORT) && /list_inbox/.test(upLink.instructions), `request_upload hands out the Assets-tab link: ${upLink.url}`);
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

  // chunked base64 upload → inbox: parts in any order, per-part re-encoding caught, corrupt assembly discarded
  ok((await req('GET', '/api/inbox')).files.length === 0, 'inbox is empty after the imports');

  // documents as a source of pictures: Word (zip) and PDF are expanded on drop
  const mcpTool = async (id, name, args) => {
    const r = await mcpCall({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    return r.isError ? new Error(r.content[0].text) : JSON.parse(r.content[0].text);
  };
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const storeZip = (entries) => {
    const locals = []; const centrals = []; let off = 0;
    for (const [name, data] of entries) {
      const n = Buffer.from(name); const crc = crc32(data);
      const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
      const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
      locals.push(lh, n, data); centrals.push(ch, n); off += 30 + n.length + data.length;
    }
    const cd = Buffer.concat(centrals); const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
    return Buffer.concat([...locals, cd, eocd]);
  };
  const sharp = (await import('sharp')).default;
  const png64 = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#3366cc' } }).png().toBuffer();
  const jpg80 = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#cc6633' } }).jpeg().toBuffer();
  const docx = storeZip([
    ['[Content_Types].xml', Buffer.from('<Types/>')],
    ['word/_rels/document.xml.rels', Buffer.from('<Relationships><Relationship Id="rId5" Type="image" Target="media/image1.png"/></Relationships>')],
    ['word/document.xml', Buffer.from('<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Installation</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Mount the panel &amp; connect it.</w:t></w:r></w:p><w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>Check the LED</w:t></w:r></w:p><w:p><w:r><w:drawing><a:blip r:embed="rId5"/></w:drawing></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Pin</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Signal</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>')],
    ['word/media/image1.png', png64],
    ['word/media/image2.png', Buffer.from(png1x1, 'base64')], // icon-sized → skipped
  ]);
  const dropDoc = await req('POST', '/api/inbox', { files: [{ name: 'FCOM chapter 3.docx', dataBase64: docx.toString('base64') }] });
  ok(dropDoc.some((f) => f.name === 'fcom-chapter-3-image1.png' && f.from === 'FCOM chapter 3.docx') && dropDoc.some((f) => f.name === 'fcom-chapter-3.html' && f.text) && !dropDoc.some((f) => /image2/.test(f.name)),
    `dropping a Word file leaves its pictures and content in the inbox: ${dropDoc.map((f) => f.name).join(', ')}`);
  const docText = await mcpTool(870, 'read_inbox_text', { name: 'fcom-chapter-3.html' });
  ok(!(docText instanceof Error) &&
    docText.text === '<h2>Installation</h2>\n<p>Mount the panel &amp; connect it.</p>\n<ul><li>Check the LED</li></ul>\n<p>[figure: fcom-chapter-3-image1.png]</p>\n<table><tr><td>Pin</td><td>Signal</td></tr></table>',
    `Word content extracted as semantic HTML with heading, list, figure marker and table:\n${docText.text}`);
  const zlib = await import('node:zlib');
  const rgbRaw = Buffer.alloc(64 * 64 * 3, 0x40);
  const rows = []; for (let y = 0; y < 64; y++) rows.push(Buffer.from([0]), rgbRaw.subarray(y * 192, (y + 1) * 192));
  const flate = zlib.deflateSync(Buffer.concat(rows));
  const pdfParts = [Buffer.from('%PDF-1.4\n')];
  pdfParts.push(Buffer.from(`1 0 obj << /Type /XObject /Subtype /Image /Width 80 /Height 60 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg80.length} >> stream\n`), jpg80, Buffer.from('\nendstream endobj\n'));
  pdfParts.push(Buffer.from(`2 0 obj << /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace 4 0 R /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 /Columns 64 >> /Length 5 0 R >> stream\n`), flate, Buffer.from('\nendstream endobj\n'));
  pdfParts.push(Buffer.from(`3 0 obj << /Type /XObject /Subtype /Image /Width 80 /Height 60 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg80.length} >> stream\n`), jpg80, Buffer.from('\nendstream endobj\n')); // duplicate → deduplicated
  pdfParts.push(Buffer.from('4 0 obj /DeviceRGB endobj\n'), Buffer.from(`5 0 obj ${flate.length} endobj\n`));
  pdfParts.push(Buffer.from('6 0 obj << /Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 256 >> stream\n'), Buffer.alloc(256), Buffer.from('\nendstream endobj\n')); // tiny → skipped
  const idxFlate = zlib.deflateSync(Buffer.alloc(64 * 64, 1)); // every pixel = palette entry 1
  pdfParts.push(Buffer.from(`7 0 obj\n<<\n/Type/XObject\n/Subtype/Image\n/Length ${idxFlate.length}\n/Filter/FlateDecode\n/Width 64\n/Height 64\n/BitsPerComponent 8\n/ColorSpace[/Indexed/DeviceRGB 1 8 0 R]\n>>\nstream\n`), idxFlate, Buffer.from('\nendstream\nendobj\n')); // PDFsharp style: no spaces between names, palette in a stream
  pdfParts.push(Buffer.from('8 0 obj << /Length 6 >> stream\n'), Buffer.from([0, 0, 0, 0x12, 0x34, 0x56]), Buffer.from('\nendstream endobj\n%%EOF\n'));
  const pdf = Buffer.concat(pdfParts);
  const dropPdf = await req('POST', '/api/inbox', { files: [{ name: 'Assembly spec.pdf', dataBase64: pdf.toString('base64') }] });
  const pdfNames = dropPdf.map((f) => f.name);
  ok(pdfNames.includes('Assembly spec.pdf') && pdfNames.includes('assembly-spec-1.jpg') && pdfNames.includes('assembly-spec-2.png') && pdfNames.includes('assembly-spec-4.png') && pdfNames.length === 4,
    `dropping a PDF keeps it and extracts its pictures (JPEG as-is, Flate+predictor → PNG, Indexed palette → PNG, duplicates and icons skipped): ${pdfNames.join(', ')}`);
  const inbNow = (await req('GET', '/api/inbox')).files;
  ok(inbNow.find((f) => f.name === 'assembly-spec-1.jpg')?.width === 80 && inbNow.find((f) => f.name === 'assembly-spec-2.png')?.width === 64 && inbNow.find((f) => f.name === 'fcom-chapter-3-image1.png')?.complete === true, 'extracted pictures are complete and correctly sized');
  const idxPng = await sharp(Buffer.from(await (await fetch(BASE + '/api/inbox/assembly-spec-4.png')).arrayBuffer())).raw().toBuffer({ resolveWithObject: true });
  ok(idxPng.info.width === 64 && idxPng.data[0] === 0x12 && idxPng.data[1] === 0x34 && idxPng.data[2] === 0x56, 'Indexed palette (no-space names, palette stream) expanded to the right colours');
  const impDoc = await mcpTool(871, 'import_local_files', { slug: 'starting-panel', version: 'A1.0', paths: ['fcom-chapter-3-image1.png', 'assembly-spec-2.png'] });
  ok(!(impDoc instanceof Error) && impDoc.length === 2 && impDoc[1].url.endsWith('/assembly-spec-2.png'), 'extracted pictures import like any inbox file');
  const viaAssets = await req('POST', '/api/modules/starting-panel/docs/A1.0/assets', { files: [{ name: 'Wiring notes.docx', dataBase64: docx.toString('base64') }] });
  ok(viaAssets.length === 1 && viaAssets[0].name === 'wiring-notes-image1.png', 'a Word file dropped on the Assets tab lands as its pictures (no text sidecar in assets)');
  const emptyDoc = await req('POST', '/api/inbox', { files: [{ name: 'empty.docx', dataBase64: storeZip([['word/document.xml', Buffer.from('<w:document/>')]]).toString('base64') }] }).catch((e) => e);
  ok(emptyDoc instanceof Error && /no pictures found/.test(emptyDoc.message), 'a document without pictures is reported');
  for (const n of ['fcom-chapter-3.html', 'Assembly spec.pdf', 'assembly-spec-1.jpg', 'assembly-spec-4.png']) await req('DELETE', `/api/inbox/${encodeURIComponent(n)}`);
  ok((await req('GET', '/api/inbox')).files.length === 0, 'inbox cleaned up after the document tests');
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
    html:
      afterAuto.content +
      `<p>Grounding check added.</p><figure><img src="${uploaded[0].url}" alt="Panel"><figcaption>Panel</figcaption></figure>` +
      `<p><a class="attachment" href="${attUp[0].url}" download="intercom-config.json">intercom-config.json</a></p>`,
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
  ok(next.version === 'A1.1' && next.key === 'customer:A1.1' && next.branch === 'draft/starting-panel-customer-a1.1', 'next version is customer A1.1');
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
  ok(guarded instanceof Error && /embedded in released customer manual A1.0/.test(guarded.message), 'cannot delete an asset a released doc still embeds');

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

  // manual types on a released module: technician + software manuals get their own streams
  const tech = await req('POST', '/api/modules/starting-panel/docs', { manual: 'technician', start: { mode: 'blank' }, checklist: { mode: 'template' } });
  ok(tech.key === 'technician:A1.0' && tech.branch === 'draft/starting-panel-technician-a1.0' && tech.fat === true, 'technician manual A1.0 added to a released module');
  const techDoc = await req('GET', '/api/modules/starting-panel/docs/technician:A1.0');
  ok(techDoc.doc.status === 'draft' && techDoc.content.includes('<h2>Configuration</h2>') && techDoc.doc.covers[0]?.name === 'STP Core', 'technician draft readable, seeded with the software relation');
  const techDup = await req('POST', '/api/modules/starting-panel/docs', { manual: 'technician', bump: 'minor' }).catch((e) => e);
  ok(techDup instanceof Error && /draft already exists/.test(techDup.message), 'no second open draft of the same manual type');
  const swc = await mcpCall({ jsonrpc: '2.0', id: 90, method: 'tools/call', params: { name: 'create_doc_version', arguments: { slug: 'starting-panel', manual: 'software-customer' } } });
  const swcRes = swc.isError ? null : JSON.parse(swc.content[0].text);
  ok(swcRes && swcRes.key === 'software-customer:A1.0' && swcRes.fat === false, 'MCP create_doc_version starts the software customer manual');
  const swcDoc = await req('GET', '/api/modules/starting-panel/docs/software-customer:A1.0');
  ok(swcDoc.content.includes('<h2>Overview</h2>') && swcDoc.content.includes('STP Core') && swcDoc.generated.includes('software customer manual'), 'software customer manual template names the linked software');
  detail = await req('GET', '/api/modules/starting-panel');
  ok(Object.keys(detail.manuals).join(',') === 'customer,technician,software-customer' && detail.status === 'draft', `module now has ${Object.keys(detail.manuals).length} manual types`);
  ok(detail.docs.filter((d) => d.manual === 'customer').length === 2 && detail.docs.find((d) => d.key === 'customer:A1.1').status === 'released', 'customer stream unaffected by the new types');
  const mcpLatestTech = JSON.parse((await mcpCall({ jsonrpc: '2.0', id: 91, method: 'tools/call', params: { name: 'get_doc', arguments: { slug: 'starting-panel', manual: 'technician' } } })).content[0].text);
  ok(mcpLatestTech.doc.key === 'technician:A1.0', 'MCP get_doc picks the latest doc of the requested manual type');
  const mcpLatestCust = JSON.parse((await mcpCall({ jsonrpc: '2.0', id: 92, method: 'tools/call', params: { name: 'get_doc', arguments: { slug: 'starting-panel' } } })).content[0].text);
  ok(mcpLatestCust.doc.key === 'customer:A1.1', 'MCP get_doc defaults to the customer manual');
  const techIns = await mcpCall({
    jsonrpc: '2.0', id: 93, method: 'tools/call',
    params: { name: 'insert_into_section', arguments: { slug: 'starting-panel', version: 'technician:A1.0', section: 'Configuration', html: '<p>Set the static IP.</p>' } },
  });
  ok(!techIns.isError && (await req('GET', '/api/modules/starting-panel/docs/technician:A1.0')).content.includes('Set the static IP.'), 'MCP edits address docs by key');
  // MCP addresses any manual by {manual, version} or by manual alone (latest open draft)
  const call = async (id, name, args) => {
    const r = await mcpCall({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    return r.isError ? new Error(r.content[0].text) : JSON.parse(r.content[0].text);
  };
  const byManual = await call(100, 'insert_into_section', { slug: 'starting-panel', manual: 'technician', section: 'Maintenance', html: '<p>Replace the fuse.</p>' });
  ok(!(byManual instanceof Error) && byManual.manual === 'technician' && byManual.revision >= 2, 'MCP {manual} without version edits the open technician draft');
  const bareVer = await call(101, 'replace_in_doc', { slug: 'starting-panel', manual: 'software-customer', version: 'A1.0', find: 'Replace the fuse.', replace: 'x' });
  ok(bareVer instanceof Error && /not found in the current body/.test(bareVer.message), 'MCP {manual, bare version} targets that manual (text lives in the technician doc)');
  const swEdit = await call(102, 'insert_into_section', { slug: 'starting-panel', manual: 'software-customer', version: 'A1.0', section: 'Operation', html: '<p>Add a user.</p>' });
  ok(!(swEdit instanceof Error) && swEdit.manual === 'software-customer' && (await req('GET', '/api/modules/starting-panel/docs/software-customer:A1.0')).content.includes('Add a user.'), 'MCP edits the software customer manual by {manual, version}');
  const conflict = await call(103, 'get_doc', { slug: 'starting-panel', manual: 'customer', version: 'technician:A1.0' });
  ok(conflict instanceof Error && /give one or the other/.test(conflict.message), 'MCP rejects a key that contradicts manual');
  const noType = await call(104, 'get_doc', { slug: 'starting-panel', manual: 'software-technician' });
  ok(noType instanceof Error && /create_doc_version/.test(noType.message), 'MCP names the missing manual type and how to create it');
  const techPhoto = await call(105, 'upload_photo_from_url', { slug: 'starting-panel', manual: 'technician', name: 'wiring.png', url: PHOTO_URL });
  ok(!(techPhoto instanceof Error) && techPhoto[0].name === 'wiring.png', 'MCP upload_photo_from_url lands on the technician draft (by manual, no version)');
  const att = await call(1050, 'attach_figure', { slug: 'starting-panel', manual: 'technician', asset: 'wiring.png', section: 'Configuration', after_text: 'Set the static IP.', caption: 'Wiring of the panel', applies_to: ['starting-panel'] });
  ok(!(att instanceof Error) && att.doc.revision >= 2 && /<figure><img src="[^"]*wiring\.png" alt="Wiring of the panel"><figcaption>Wiring of the panel<\/figcaption><\/figure>/.test(att.figure), 'MCP attach_figure builds the figure');
  const attBody = (await req('GET', '/api/modules/starting-panel/docs/technician:A1.0')).content;
  const ipIdx = attBody.indexOf('Set the static IP.');
  const figIdx = attBody.indexOf('<figure><img src="/api/modules/starting-panel/assets/wiring.png"');
  const nextH2 = attBody.indexOf('<h2>', ipIdx);
  ok(ipIdx > 0 && figIdx > ipIdx && figIdx < nextH2, 'attach_figure placed the figure right after the paragraph with after_text, inside the section');
  ok((await req('GET', '/api/modules/starting-panel/assets')).find((a) => a.name === 'wiring.png').meta.appliesTo.join() === 'starting-panel', 'attach_figure stamped applies_to');
  const attBad = await call(1051, 'attach_figure', { slug: 'starting-panel', manual: 'technician', asset: 'wiring.png', section: 'Configuration', after_text: 'no such phrase', caption: 'x' });
  ok(attBad instanceof Error && /not found in section/.test(attBad.message), 'attach_figure reports an after_text that is not in the section');
  const techAssets = await call(106, 'get_doc', { slug: 'starting-panel', manual: 'technician', include_assets: true });
  ok(techAssets.assets.some((a) => a.name === 'wiring.png' && a.meta?.addedIn === 'A1.0') && techAssets.doc.key === 'technician:A1.0', 'asset stamped from the technician doc, visible module-wide');
  const techFig = await call(107, 'insert_into_section', { slug: 'starting-panel', manual: 'technician', section: 'Installation', html: `<figure><img src="${techAssets.assets.find((a) => a.name === 'wiring.png').url}" alt="Wiring"><figcaption>Wiring</figcaption></figure>` });
  ok(!(techFig instanceof Error), 'figure inserted into the technician manual');
  const stampT = await call(108, 'update_asset', { slug: 'starting-panel', manual: 'technician', name: 'wiring.png', applies_to: ['starting-panel'] });
  ok(!(stampT instanceof Error) && stampT.meta.appliesTo[0] === 'starting-panel', 'MCP update_asset by manual');
  const mt = await call(109, 'list_manual_types', {});
  ok(mt.length === 4 && mt[1].id === 'technician' && mt[1].sections.includes('Configuration'), 'MCP list_manual_types');
  const swList = await call(110, 'list_software', {});
  const stp = swList.find((s) => s.name === 'STP Core');
  ok(stp && stp.modules[0].slug === 'starting-panel' && stp.modules[0].manuals['software-customer']?.status === 'draft' && stp.releases.length >= 3, 'MCP list_software lists modules, software manuals and releases');
  ok(stp.releases.find((r) => r.version === 'v2.1.1').coveredBy.some((c) => c.key === 'customer:A1.1' && c.status === 'released'), 'list_software shows which doc covers a release');
  ok(techAssets.assets.find((a) => a.name === 'wiring.png').meta.addedManual === 'technician', 'stamp records which manual the asset was added from');
  ok((await req('GET', '/api/software')).find((s) => s.name === 'STP Core').manualCount === 1, 'GET /api/software serves the Software page');
  const reg = await call(111, 'register_software_release', { name: 'STP Core', version: 'v2.2.1', manual_affecting: false, note: 'hotfix' });
  ok(!(reg instanceof Error) && reg['STP Core'].some((r) => r.version === 'v2.2.1'), 'MCP register_software_release');
  const covMcp = await call(112, 'cover_release', { slug: 'starting-panel', manual: 'software-customer', software: 'STP Core', release: 'v2.2.1' });
  ok(!(covMcp instanceof Error) && covMcp.covers[0].to === 'v2.2.1', 'MCP cover_release on the software customer draft');
  const swTech = await call(113, 'create_doc_version', { slug: 'starting-panel', manual: 'software-technician', checklist: 'none' });
  ok(!(swTech instanceof Error) && swTech.key === 'software-technician:A1.0', 'MCP creates the software technician manual');
  ok(!((await call(114, 'submit_for_review', { slug: 'starting-panel', manual: 'software-technician' })) instanceof Error), 'MCP submit_for_review by manual');
  const back = await call(115, 'back_to_draft', { slug: 'starting-panel', manual: 'software-technician' });
  ok(!(back instanceof Error) && back.status === 'draft', 'MCP back_to_draft');
  const disc = await call(116, 'discard_doc', { slug: 'starting-panel', manual: 'software-technician', version: 'A1.0' });
  ok(!(disc instanceof Error) && disc.ok && !(await req('GET', '/api/modules/starting-panel')).docs.some((d) => d.manual === 'software-technician'), 'MCP discard_doc removes the software technician draft');
  const discNoVer = await call(117, 'discard_doc', { slug: 'starting-panel', manual: 'technician' });
  ok(discNoVer instanceof Error, 'discard_doc requires an explicit version');
  // create a software over MCP, link it, register a new version, open its manuals
  const dup = await call(120, 'create_software', { name: 'STP Core' });
  ok(dup instanceof Error && /already exists/.test(dup.message), 'create_software refuses an existing name');
  const newSw = await call(121, 'create_software', { name: ' 2N Access Unit ', version: 'v1.0.0', modules: [{ slug: 'starting-panel' }] });
  ok(!(newSw instanceof Error) && newSw.name === '2N Access Unit' && newSw.releases[0].version === 'v1.0.0' && newSw.modules[0].linked === true, 'MCP create_software registers the feed entry and links the module');
  const spMod = await req('GET', '/api/modules/starting-panel');
  ok(spMod.module.softwares.some((s) => s.name === '2N Access Unit' && s.fromVersion === 'v1.0.0'), 'module link carries the first version as from-version');
  ok((await req('GET', '/api/modules/starting-panel/docs/technician:A1.0')).module.softwares.length === 2, 'link written on the open draft branches too');
  const swRow = (await call(122, 'list_software', { name: '2N' }))[0];
  ok(swRow && swRow.modules[0].slug === 'starting-panel' && swRow.releases.length === 1, 'list_software shows the new software');
  const rel2 = await call(123, 'register_software_release', { name: '2N Access Unit', version: 'v1.1.0', manual_affecting: true });
  ok(!(rel2 instanceof Error) && rel2['2N Access Unit'].length === 2, 'register_software_release adds a new version');
  const relink = await call(124, 'link_software', { slug: 'starting-panel', name: '2N Access Unit', from_version: 'v1.1.0' });
  ok(!(relink instanceof Error) && relink.linked === false && relink.softwares.find((s) => s.name === '2N Access Unit').fromVersion === 'v1.1.0', 'link_software updates the from-version of an existing link');
  const emptySw = await call(125, 'create_software', { name: 'Orphan Tool' });
  ok(!(emptySw instanceof Error) && emptySw.releases.length === 0 && (await req('GET', '/api/software')).some((s) => s.name === 'Orphan Tool' && s.modules.length === 0), 'a software with no version and no module still lists on the Software page');
  const linkBadVer = await req('POST', '/api/modules/starting-panel/software', { name: 'Orphan Tool', fromVersion: 'v0.1' }).catch((e) => e);
  ok(linkBadVer instanceof Error && /not a registered release/.test(linkBadVer.message), 'linking with a version the software never released is refused');
  const linkApi = await req('POST', '/api/modules/starting-panel/software', { name: 'Orphan Tool' });
  ok(linkApi.linked === true && linkApi.softwares.length === 3, 'API link endpoint (no release yet → no from-version)');
  const badRel = await req('POST', '/api/softwares', { name: 'Never Created', version: 'v1.0' }).catch((e) => e);
  ok(badRel instanceof Error && /not found — create it on the Software page/.test(badRel.message), 'a release cannot be registered for a software that was not created');
  const unlinkOk = await call(126, 'link_software', { slug: 'starting-panel', name: 'Orphan Tool', unlink: true });
  ok(!(unlinkOk instanceof Error) && unlinkOk.softwares.length === 2, 'link_software unlink removes the link');
  const unlinkMissing = await call(127, 'link_software', { slug: 'starting-panel', name: 'Orphan Tool', unlink: true });
  ok(unlinkMissing instanceof Error && /not linked/.test(unlinkMissing.message), 'unlinking a software that is not linked is an error');
  // languages: English is the source; Polish is a translation stored next to it
  const enDoc = await req('GET', '/api/modules/starting-panel/docs/technician:A1.0');
  ok(enDoc.lang === 'en' && enDoc.languages.en.source === true && enDoc.languages.pl.exists === false, 'doc reports its languages (pl missing)');
  const plEmpty = await req('GET', '/api/modules/starting-panel/docs/technician:A1.0?lang=pl');
  ok(plEmpty.lang === 'pl' && plEmpty.content === '' && plEmpty.generated.includes('Rejestr zmian') && plEmpty.generated.includes('Instrukcja techniczna'), 'pl view: empty body, generated sections in Polish');
  const noAi = await req('POST', '/api/modules/starting-panel/docs/technician:A1.0/translate', { lang: 'pl' }).catch((e) => e);
  ok(noAi instanceof Error && /OPENAI_API_KEY/.test(noAi.message), 'AI translation reports the missing API key');
  const badLang = await req('GET', '/api/modules/starting-panel/docs/technician:A1.0?lang=de').catch((e) => e);
  ok(badLang instanceof Error && /Unknown language/.test(badLang.message), 'unknown language rejected');
  const plHtml = enDoc.content.replace('<h2>Installation</h2>', '<h2>Instalacja</h2>').replace('Set the static IP.', 'Ustaw statyczny adres IP.');
  const revBeforePl = enDoc.doc.revision;
  const plDoc = await req('POST', '/api/modules/starting-panel/docs/technician:A1.0/translate', { lang: 'pl', html: plHtml });
  ok(plDoc.lang === 'pl' && plDoc.content.includes('Instalacja') && plDoc.languages.pl.exists && plDoc.languages.pl.source === 'manual' && !plDoc.languages.pl.stale, 'a supplied translation is stored as the pl body');
  ok(plDoc.doc.revision === revBeforePl + 1 && /Polski translation/.test(plDoc.doc.revisionRecord.at(-1).summary), 'translation is a revision');
  ok((await req('GET', '/api/modules/starting-panel/docs/technician:A1.0')).content.includes('<h2>Installation</h2>'), 'English body untouched by the translation');
  const plSaved = await req('PUT', '/api/modules/starting-panel/docs/technician:A1.0/content', { html: plDoc.content + '<p>Dodano po polsku.</p>', bump: true, summary: 'Polish fix', lang: 'pl' });
  ok(plSaved.revisionRecord.at(-1).summary === 'Polish fix (PL)' && plSaved.languages.pl.edited === true, 'pl edit commits with a (PL) tag and marks the translation edited');
  const plRead = await req('GET', '/api/modules/starting-panel/docs/technician:A1.0?lang=pl');
  ok(plRead.content.includes('Dodano po polsku.') && !(await req('GET', '/api/modules/starting-panel/docs/technician:A1.0')).content.includes('Dodano po polsku.'), 'pl edit lands in the pl body only');
  ok(!plRead.languages.pl.stale, 'pl edits do not make the translation stale');
  await req('PUT', '/api/modules/starting-panel/docs/technician:A1.0/content', { html: enDoc.content + '<p>English changed.</p>', bump: false });
  const plStale = await req('GET', '/api/modules/starting-panel/docs/technician:A1.0?lang=pl');
  ok(plStale.languages.pl.stale === true && plStale.languages.pl.basedOnRevision === revBeforePl, 'English edit marks the pl translation stale');
  const mcpPl = await call(130, 'get_doc', { slug: 'starting-panel', manual: 'technician', lang: 'pl' });
  ok(!(mcpPl instanceof Error) && mcpPl.lang === 'pl' && mcpPl.content.includes('Instalacja') && mcpPl.languages.pl.stale === true, 'MCP get_doc lang=pl');
  const mcpPlIns = await call(131, 'insert_into_section', { slug: 'starting-panel', manual: 'technician', lang: 'pl', section: 'Instalacja', html: '<p>Przez MCP.</p>' });
  ok(!(mcpPlIns instanceof Error) && (await req('GET', '/api/modules/starting-panel/docs/technician:A1.0?lang=pl')).content.includes('Przez MCP.'), 'MCP insert_into_section edits the Polish body by its Polish headings');
  const mcpNoPl = await call(132, 'replace_in_doc', { slug: 'starting-panel', manual: 'software-customer', lang: 'pl', find: 'x', replace: 'y' });
  ok(mcpNoPl instanceof Error && /translate_doc/.test(mcpNoPl.message), 'editing a missing translation points at translate_doc');
  const mcpTr = await call(133, 'translate_doc', { slug: 'starting-panel', manual: 'software-customer', lang: 'pl', html: '<h2>Przegląd</h2><p>PL.</p><h2>Obsługa</h2><p>x</p>' });
  ok(!(mcpTr instanceof Error) && mcpTr.languages.pl.exists && mcpTr.lang === 'pl', 'MCP translate_doc stores a supplied translation');
  const mcpTrAi = await call(134, 'translate_doc', { slug: 'starting-panel', manual: 'software-customer', lang: 'pl' });
  ok(mcpTrAi instanceof Error && /OPENAI_API_KEY/.test(mcpTrAi.message), 'MCP translate_doc without html needs the AI');
  // review comments: viewers comment on selected text; author resolves; MCP agents see and close threads
  const techBody = (await req('GET', '/api/modules/starting-panel/docs/technician:A1.0')).content;
  const cm = await req('POST', '/api/modules/starting-panel/docs/technician:A1.0/comments', {
    author: 'Ola', text: 'Say which fuse rating.', anchor: { quote: 'Replace the fuse.', section: 'Maintenance', before: '', after: '', lang: 'en' },
  });
  ok(cm.id && cm.status === 'open' && cm.author === 'Ola' && cm.anchor.quote === 'Replace the fuse.', 'comment thread created on a quote');
  const cmEmpty = await req('POST', '/api/modules/starting-panel/docs/technician:A1.0/comments', { author: 'Ola', text: '   ' }).catch((e) => e);
  ok(cmEmpty instanceof Error && /text is required/.test(cmEmpty.message), 'empty comment rejected');
  ok((await req('GET', '/api/modules/starting-panel')).docs.find((d) => d.key === 'technician:A1.0').openComments === 1, 'module docs carry the open comment count');
  ok((await req('GET', '/api/modules/starting-panel/docs/technician:A1.0')).content === techBody, 'commenting does not touch the body');
  const rp = await req('POST', `/api/modules/starting-panel/docs/technician:A1.0/comments/${cm.id}/replies`, { author: 'Author', text: '5 A slow-blow — will add.' });
  ok(rp.replies.length === 1 && rp.replies[0].author === 'Author', 'reply added to the thread');
  const mcpCm = await call(140, 'list_comments', { slug: 'starting-panel', manual: 'technician' });
  ok(Array.isArray(mcpCm) && mcpCm[0].id === cm.id && mcpCm[0].replies.length === 1, 'MCP list_comments');
  const mcpRes = await call(141, 'resolve_comment', { slug: 'starting-panel', manual: 'technician', id: cm.id, note: 'Fuse rating added in r9' });
  ok(!(mcpRes instanceof Error) && mcpRes.status === 'resolved' && mcpRes.resolvedBy === 'AI agent' && mcpRes.replies.at(-1).text === 'Fuse rating added in r9', 'MCP resolve_comment with a closing note');
  ok((await req('GET', '/api/modules/starting-panel')).docs.find((d) => d.key === 'technician:A1.0').openComments === 0, 'resolved threads leave the open count');
  const reopened = await req('PUT', `/api/modules/starting-panel/docs/technician:A1.0/comments/${cm.id}`, { status: 'open', author: 'Ola' });
  ok(reopened.status === 'open' && !reopened.resolvedBy, 'thread reopened');
  const listed = await req('GET', '/api/modules/starting-panel/docs/technician:A1.0/comments');
  ok(listed.length === 1 && listed[0].status === 'open', 'GET comments lists the thread');
  const gone = await req('DELETE', `/api/modules/starting-panel/docs/technician:A1.0/comments/${cm.id}`);
  ok(gone.id === cm.id && (await req('GET', '/api/modules/starting-panel/docs/technician:A1.0/comments')).length === 0, 'thread deleted');
  const cmReleased = await req('POST', '/api/modules/starting-panel/docs/customer:A1.1/comments', { author: 'Ola', text: 'x', anchor: { quote: 'y' } }).catch((e) => e);
  ok(cmReleased instanceof Error && /no draft branch|Draft or In-review/.test(cmReleased.message), 'no comments on a released doc');
  // cleanup: drop the 2N link so the checks below see STP Core only
  await call(128, 'link_software', { slug: 'starting-panel', name: '2N Access Unit', unlink: true });
  ok((await req('GET', '/api/modules/starting-panel')).module.softwares.length === 1, '2N link removed (cleanup)');
  await req('PATCH', '/api/modules/starting-panel', { code: 'SW-STP3' });
  ok((await req('GET', '/api/modules/starting-panel/docs/technician:A1.0')).module.code === 'SW-STP3' && (await req('GET', '/api/modules/starting-panel/docs/A1.1')).module.code === 'SW-STP3',
    'metadata edit written on main and on every open draft');
  // orange dot is per manual type: a manual-affecting release uncovered by the new technician manual
  await req('POST', '/api/softwares', { name: 'STP Core', version: 'v2.2.0', manualAffecting: true });
  detail = await req('GET', '/api/modules/starting-panel');
  // software-customer already spans v2.0.0–v2.2.1 (cover_release above), so only the other two types miss v2.2.0
  ok(detail.uncovered.filter((u) => u.version === 'v2.2.0').map((u) => u.manual).sort().join(',') === 'customer,technician', 'uncovered release listed per manual type');
  ok(detail.needsDoc === true, 'customer manual has no open draft → orange dot');
  await req('POST', '/api/modules/starting-panel/docs/technician:A1.0/cover', { name: 'STP Core', version: 'v2.2.0' });
  await req('POST', '/api/modules/starting-panel/docs/software-customer:A1.0/cover', { name: 'STP Core', version: 'v2.2.0' });
  const nextCust = await req('POST', '/api/modules/starting-panel/docs', { manual: 'customer', bump: 'major' });
  ok(nextCust.key === 'customer:A2.0' && nextCust.covers[0]?.from === 'v2.2.0', 'customer A2.0 seeded with the release the customer stream did not cover');
  detail = await req('GET', '/api/modules/starting-panel');
  ok(detail.uncovered.length === 0 && detail.needsDoc === false, 'every manual type covers v2.2.0');
  // release the technician manual; assemble a technician manual from it
  await req('POST', '/api/modules/starting-panel/docs/technician:A1.0/submit-review');
  await req('POST', '/api/modules/starting-panel/docs/technician:A1.0/release');
  detail = await req('GET', '/api/modules/starting-panel');
  ok(detail.manuals.technician.status === 'released' && detail.manuals.customer.status === 'draft' && detail.docs.find((d) => d.key === 'customer:A1.1').status === 'released',
    'releasing the technician manual supersedes nothing in the customer stream');
  const techManual = await req('POST', '/api/manuals', { name: 'B737 Technician Manual', group: 'SIM', manual: 'technician', modules: ['starting-panel'] });
  ok(techManual.manual === 'technician', 'assembled manual stores its type');
  const techCompiled = await req('GET', '/api/manuals/b737-technician-manual');
  const techPl = await req('GET', '/api/manuals/b737-technician-manual?lang=pl');
  ok(techPl.lang === 'pl' && techPl.chapters[0].langFallback === false && techPl.html.includes('Spis treści') && techPl.html.includes('Instalacja') && techPl.html.includes('Przez MCP.'), 'manual compiles in Polish from the released translation');
  const techPlExport = await (await fetch(BASE + '/api/manuals/b737-technician-manual/export.html?lang=pl')).text();
  ok(techPlExport.includes('<html lang="pl">') && techPlExport.includes('Rejestr zmian') && techPlExport.includes('Wykaz obowiązujących stron') && techPlExport.includes('Informacje ogólne'), 'Polish export (incl. the General chapter)');
  const techNext = await req('POST', '/api/modules/starting-panel/docs', { manual: 'technician', bump: 'minor' });
  const techNextPl = await req('GET', `/api/modules/starting-panel/docs/${techNext.key}?lang=pl`);
  // the A1.0 translation was already stale (English edited after it) — the copy keeps that status
  ok(techNextPl.languages.pl.exists && techNextPl.languages.pl.stale === true && techNextPl.content.includes('Przez MCP.'), 'next doc version carries the translation over, staleness included');
  await req('POST', `/api/modules/starting-panel/docs/${techNext.key}/discard`);
  ok(techCompiled.chapters[0].doc.key === 'technician:A1.0' && !techCompiled.chapters[0].isDraft && techCompiled.html.includes('Set the static IP.') && techCompiled.html.includes('Technician manual'),
    'technician manual compiles the released technician docs');
  ok((await req('GET', '/api/manuals')).find((m) => m.slug === 'b737-technician-manual').unreleased === 0, 'readiness counts the manual type being assembled');
  await req('PUT', '/api/manuals/b737-technician-manual', { manual: 'software-technician' });
  const swtCompiled = await req('GET', '/api/manuals/b737-technician-manual');
  ok(swtCompiled.chapters[0].missing === true && /software technician manual/.test(swtCompiled.chapters[0].reason || ''), 'a module without that manual type is a missing chapter');
  await req('DELETE', '/api/manuals/b737-technician-manual');
  // clean up the extra drafts so the customer-stream checks below keep their assumptions
  await req('POST', '/api/modules/starting-panel/docs/customer:A2.0/discard');
  await req('POST', '/api/modules/starting-panel/docs/software-customer:A1.0/discard');
  detail = await req('GET', '/api/modules/starting-panel');
  ok(Object.keys(detail.manuals).join(',') === 'customer,technician' && detail.manuals.customer.version === 'A1.1', 'extra drafts discarded (cleanup)');

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
  ok(copyDoc.doc.revisionRecord.some((r) => r.inherited) && copyDoc.doc.copiedFrom.manual === 'customer', 'copy mode inherits revision record');
  const copy2 = await req('POST', '/api/modules', {
    name: 'IOS Panel 2',
    group: 'IOS',
    category: 'software',
    manuals: ['customer', 'technician'],
    start: { mode: 'copy', sourceSlug: 'starting-panel' },
    checklist: { mode: 'copy' },
  });
  ok(copy2.docs.length === 2 && /no released/.test(copy2.aiNote || '') === false, 'copy without a version takes each manual type from its released doc');
  const copy2Tech = await req('GET', '/api/modules/ios-panel-2/docs/technician:A1.0');
  ok(copy2Tech.content.includes('Set the static IP.') && copy2Tech.doc.copiedFrom.version === 'A1.0', 'technician manual copied from the released technician A1.0');
  ok((await req('GET', '/api/modules/ios-panel-2/docs/A1.0')).content.includes('Grounding check added'), 'customer manual copied from the released customer A1.1');
  await req('POST', '/api/modules/ios-panel-2/docs/A1.0/discard');
  await req('POST', '/api/modules/ios-panel-2/docs/technician:A1.0/discard');

  // discard a never-released module
  await req('POST', '/api/modules/ios-panel/docs/A1.0/discard');
  list = await req('GET', '/api/modules');
  ok(list.length === 1, 'discarded never-released module disappears');

  // manuals: create from selected modules, compile, export, update, delete
  const manual = await req('POST', '/api/manuals', { name: 'B737 Simulator Manual', group: 'SIM', modules: ['starting-panel'] });
  ok(manual.slug === 'b737-simulator-manual' && manual.modules.length === 1 && manual.manual === 'customer', 'manual created from selected modules (customer manual by default)');
  const compiled = await req('GET', '/api/manuals/b737-simulator-manual');
  ok(compiled.chapters.length === 1 && compiled.chapters[0].doc.version === 'A1.1' && !compiled.chapters[0].isDraft,
    'manual compiles the released A1.1 as chapter 1');
  ok(compiled.html.includes('class="chapter"') && compiled.html.includes('Table of contents') && compiled.html.includes('Grounding check added'),
    'compiled html has chapter, TOC and module content');
  ok(compiled.html.includes('id="ch-general"') && compiled.html.includes('General Info') && compiled.html.includes('office@ftd.aero') && compiled.html.includes('List of Effective Pages'),
    'manual opens with the General chapter: General Info, manufacturer address, List of Effective Pages');
  ok(compiled.html.indexOf('id="ch-general"') < compiled.html.indexOf('id="revision-record"') && compiled.html.indexOf('id="revision-record"') < compiled.html.indexOf('id="toc"') && compiled.html.indexOf('id="toc"') < compiled.html.indexOf('id="lep"'),
    'General chapter order: 1.1 General Info, 1.2 Revision record, 1.3 Table of contents, 1.4 List of Effective Pages');
  // a released software manual of the same audience joins the bundle as its own chapter
  const swcNew = await req('POST', '/api/modules/starting-panel/docs', { manual: 'software-customer' });
  await req('POST', `/api/modules/starting-panel/docs/${swcNew.key}/release`);
  const withSw = await req('GET', '/api/manuals/b737-simulator-manual');
  ok(withSw.chapters.length === 2 && withSw.chapters[1].slug === 'starting-panel--software' && withSw.chapters[1].software === true && withSw.chapters[1].doc.key === 'software-customer:A1.0',
    'released software customer manual compiles as a second chapter of its module');
  ok(withSw.chapters[1].title.includes('STP Core') && withSw.html.includes('id="ch-starting-panel--software"'),
    `software chapter titled after the linked software: ${withSw.chapters[1].title}`);
  const fatRes = await fetch(BASE + '/api/manuals/b737-simulator-manual/fat.html');
  const fatHtml = await fatRes.text();
  ok(fatRes.status === 200 && fatHtml.includes('Factory Acceptance Test protocol') && fatHtml.includes('id="fat-starting-panel"') && fatHtml.includes('Modules under test'),
    'manual FAT protocol compiles the module checklists');
  ok(compiled.html.includes('href="#c2-s4"') && compiled.html.includes('id="c2-s4"') && compiled.html.includes('href="#ch-starting-panel"') && compiled.html.includes('href="#general-info"'),
    'TOC links point at anchored headings; General is chapter 1, module chapters number from 2');
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
  ok(
    !exp2.includes('/api/modules/starting-panel/assets/intercom-config.json') &&
      /<a class="attachment" href="data:application\/json;base64,[A-Za-z0-9+/=]+" download="intercom-config\.json">/.test(exp2),
    'export inlines an attachment as a downloadable data URI'
  );
  ok(exp2.includes('class="lep-pages"') && exp2.includes('pagedjs_pages') && exp2.includes('font-family: Verdana'),
    'export paginates itself (paged.js inlined) to fill the List of Effective Pages, in Verdana');
  const exp = await fetch(BASE + '/api/manuals/b737-simulator-manual/export.html');
  const expHtml = await exp.text();
  ok(exp.ok && expHtml.startsWith('<!doctype html>') && expHtml.includes('<style id="manual-css">'), 'standalone export served');
  const mlist = await req('GET', '/api/manuals');
  ok(mlist.length === 1 && mlist[0].unreleased === 0, 'manual listed as all released');
  await req('PUT', '/api/manuals/b737-simulator-manual', { modules: [] });
  ok((await req('GET', '/api/manuals/b737-simulator-manual')).chapters.length === 0, 'manual modules updated');
  await req('DELETE', '/api/manuals/b737-simulator-manual');
  ok((await req('GET', '/api/manuals')).length === 0, 'manual deleted');

  // module types: what the module is decides which manuals are drafted
  const mst = await req('POST', '/api/modules', { name: 'Starter Kit', code: 'SK', category: 'instructor-station', group: 'IOS', type: 'module-software', software: 'STP Core', parts: 'Płyta czołowa v1\nEncoder', checklist: { mode: 'template' } });
  ok(mst.docs.length === 4 && mst.docs.map((d) => d.manual).join(',') === 'customer,technician,software-customer,software-technician', 'module-software drafts all four manuals');
  const mstMod = await req('GET', '/api/modules/starter-kit');
  ok(mstMod.module.type === 'module-software' && mstMod.module.softwares[0].name === 'STP Core', 'module type stored, selected software linked');
  ok(mstMod.module.hardwareItems.some((h) => h.name === 'Płyta czołowa' && h.type === 'ftd' && h.version === 'v1') && mstMod.module.hardwareItems.some((h) => h.name === 'Encoder' && h.type === 'cots'), 'parts parsed: trailing version = made by FTD, none = bought');
  ok(mstMod.docs.find((d) => d.manual === 'technician').docCode === 'SK-TECH-HW' && mstMod.docs.find((d) => d.manual === 'software-customer').docCode === 'SK-USER-SW', 'doc codes derived from the module code');
  ok(mstMod.docs.find((d) => d.manual === 'technician').fat === true && mstMod.docs.find((d) => d.manual === 'customer').fat === false, 'FAT lands on the technician manual');
  const mstDoc = await req('GET', '/api/modules/starter-kit/docs/technician:A1.0');
  ok(mstDoc.generated.includes('<h3>Parts</h3>') && mstDoc.generated.includes('SK-TECH-HW') && mstDoc.generated.includes('Płyta czołowa'), 'generated section 3 lists the parts and the document code');
  ok((await req('GET', '/api/modules')).find((m) => m.slug === 'starter-kit').type === 'module-software', 'list row carries the module type');
  const badType = await req('POST', '/api/modules', { name: 'Bad', group: 'SIM', type: 'kit' }).catch((e) => e);
  ok(badType instanceof Error && /Unknown module type/.test(badType.message), 'unknown module type rejected');
  const tpk = await req('POST', '/api/modules', { name: 'Smoke Detector', code: 'ST-622', group: 'IOS', category: 'peripherals', type: 'third-party-kit' });
  ok(tpk.docs.length === 2, 'third-party-kit drafts customer + technician');
  const tpkMod = await req('GET', '/api/modules/smoke-detector');
  ok(tpkMod.module.hardwareItems.length === 1 && tpkMod.module.hardwareItems[0].name === 'Smoke Detector' && tpkMod.module.hardwareItems[0].type === 'cots' && tpkMod.module.hardwareItems[0].model === 'ST-622',
    'a 3rd-party module without parts becomes its own bought part');
  await req('DELETE', '/api/modules/smoke-detector');
  const swAuto = await req('POST', '/api/modules', { name: 'Config Tool', group: 'IOS', category: 'software', type: 'own-software' });
  ok(swAuto.docs.length === 2 && swAuto.docs.every((d) => d.manual.startsWith('software-')), 'own-software drafts the software pair');
  ok((await req('GET', '/api/modules/config-tool')).module.softwares[0].name === 'Config Tool', 'a software named after the module was created and linked');
  ok((await req('GET', '/api/software')).some((r) => r.name === 'Config Tool' && r.modules.length === 1), 'the auto-linked software shows on the Software page');
  await req('DELETE', '/api/modules/starter-kit');
  await req('DELETE', '/api/modules/config-tool');
  ok(!(await req('GET', '/api/modules')).some((m) => ['starter-kit', 'config-tool'].includes(m.slug)), 'type-test modules removed (cleanup)');

  // software delete: unlinks from modules, drops the feed entry; the module keeps its other software
  await req('POST', '/api/software', { name: 'Tmp Tool', version: 'v0.1', modules: [{ slug: 'starting-panel' }] });
  ok((await req('GET', '/api/software')).some((r) => r.name === 'Tmp Tool' && r.modules.length === 1 && r.releases.length === 1), 'software created, linked and versioned');
  const delSw = await req('DELETE', '/api/software/' + encodeURIComponent('Tmp Tool'));
  ok(delSw.unlinked.includes('starting-panel') && delSw.releases === 1, 'delete reports unlinked modules and dropped releases');
  ok(!(await req('GET', '/api/software')).some((r) => r.name === 'Tmp Tool'), 'deleted software gone from the Software page');
  const spRow = (await req('GET', '/api/modules')).find((m) => m.slug === 'starting-panel');
  ok(spRow.softwares.some((s) => s.name === 'STP Core') && !spRow.softwares.some((s) => s.name === 'Tmp Tool'), 'module keeps STP Core, loses Tmp Tool');
  const delUnknownSw = await req('DELETE', '/api/software/Nope').catch((e) => e);
  ok(delUnknownSw instanceof Error && /not found/.test(delUnknownSw.message), 'deleting an unknown software is refused');

  // a software's OWN manual: an own-software module named after it, edited like any doc
  await req('POST', '/api/software', { name: 'Deck Planner', version: 'v3.0.0' });
  const own = await req('POST', '/api/software/' + encodeURIComponent('Deck Planner') + '/own-manual', { group: 'IOS' });
  ok(own.slug === 'deck-planner' && own.key === 'software-customer:A1.0' && own.docs.length === 2 && own.docs.every((d) => d.manual.startsWith('software-')), 'own manual = own-software module with the software pair');
  const ownRow = (await req('GET', '/api/software')).find((r) => r.name === 'Deck Planner');
  ok(ownRow.modules.length === 1 && ownRow.modules[0].type === 'own-software' && ownRow.modules[0].fromVersion === 'v3.0.0' && ownRow.manualCount === 2, 'Software page row shows the own manual with its from-version');
  const ownDoc = await req('GET', '/api/modules/deck-planner/docs/software-customer:A1.0');
  ok(ownDoc.content.includes('<h2>Overview</h2>') && ownDoc.content.includes('Deck Planner') && ownDoc.doc.status === 'draft', 'own manual opens in the editor as a draft');
  const ownDup = await req('POST', '/api/software/' + encodeURIComponent('Deck Planner') + '/own-manual', {}).catch((e) => e);
  ok(ownDup instanceof Error && /already exists/.test(ownDup.message), 'a second own manual is refused');
  const ownUnknown = await req('POST', '/api/software/Nope/own-manual', {}).catch((e) => e);
  ok(ownUnknown instanceof Error && /not found/.test(ownUnknown.message), 'own manual of an unknown software is refused');
  const ownMcp = await call(140, 'create_software', { name: 'Route Editor', own_manual: true, group: 'IOS', version: 'v1.0' });
  ok(!(ownMcp instanceof Error) && ownMcp.ownModule?.slug === 'route-editor' && ownMcp.ownModule.docs.length === 2, 'MCP create_software own_manual creates the module too');
  const ownMcp2 = await call(141, 'create_software_manual', { name: 'Route Editor' });
  ok(ownMcp2 instanceof Error && /already exists/.test(ownMcp2.message), 'MCP create_software_manual refuses a duplicate');
  const clash = await req('POST', '/api/software', { name: 'Starting Panel', ownManual: { group: 'SIM' } }).catch((e) => e);
  ok(clash instanceof Error && /already exists/.test(clash.message) && !(await req('GET', '/api/software')).some((r) => r.name === 'Starting Panel'), 'own manual clashing with a module slug fails before the feed is touched');
  await req('DELETE', '/api/modules/deck-planner');
  await req('DELETE', '/api/modules/route-editor');
  await req('DELETE', '/api/software/' + encodeURIComponent('Deck Planner'));
  await req('DELETE', '/api/software/' + encodeURIComponent('Route Editor'));
  ok(!(await req('GET', '/api/modules')).some((m) => ['deck-planner', 'route-editor'].includes(m.slug)), 'own-manual modules removed (cleanup)');

  // history exists
  detail = await req('GET', '/api/modules/starting-panel');
  ok(detail.history.length >= 5, `history has ${detail.history.length} commits`);

  // module delete: a released module with an open draft — folder on main and the draft branch go
  const before = (await req('GET', '/api/modules')).length;
  const tmpMod = await req('POST', '/api/modules', { name: 'Tmp Module', group: 'SIM', category: 'peripherals', hardware: { type: 'none' }, softwares: [], start: { mode: 'blank' }, checklist: { mode: 'none' } });
  await req('POST', `/api/modules/${tmpMod.slug}/docs/${tmpMod.key}/release`);
  const tmpNext = await req('POST', `/api/modules/${tmpMod.slug}/docs`, { manual: 'customer', bump: 'minor' });
  const delMod = await req('DELETE', `/api/modules/${tmpMod.slug}`);
  ok(delMod.slug === tmpMod.slug && delMod.docs === 2 && delMod.branchesDeleted.length === 1 && delMod.branchesDeleted[0] === tmpNext.branch, `delete_module reports ${delMod.docs} docs, branch ${delMod.branchesDeleted[0]}`);
  ok((await req('GET', '/api/modules')).length === before, 'deleted module gone from the list');
  const tmpGone = await req('GET', `/api/modules/${tmpMod.slug}`).catch((e) => e);
  ok(tmpGone instanceof Error, 'deleted module detail is 404');
  const delUnknownMod = await req('DELETE', `/api/modules/${tmpMod.slug}`).catch((e) => e);
  ok(delUnknownMod instanceof Error && /not found/.test(delUnknownMod.message), 'deleting an unknown module is refused');
} catch (e) {
  console.error('SMOKE ERROR:', e);
  failed = true;
} finally {
  server.kill();
  photoHost.close();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {}
}

console.log(failed ? '\nSMOKE: FAILED' : '\nSMOKE: ALL PASS');
process.exit(failed ? 1 : 0);
