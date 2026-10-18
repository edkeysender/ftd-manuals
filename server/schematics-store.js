/**
 * Git side of the schematics: the device library (two files on main), installations (a record on
 * main + a versioned schematic), and the schematic lifecycle of a module or an installation —
 * draft branch, operations as commits, review, release with a note, hotfix, discard, next version.
 * The netlist rules are in schematic.js; this file only moves files and branches, always inside
 * the store's lock, and leaves the tree on main.
 */
import * as store from './store.js';
import { repo, mutate, readJson, readJsonMany, slugify } from './store.js';
import { normalizeLibrary, normalizeTemplate, DEFAULT_LIBRARY, PANEL_NAME } from './library.js';
import { sniff } from './images.js';
import { emptySchematic, applyOps, validateSchematic, connectorFace, cableSchedule, SchematicError } from './schematic.js';
import { renderSvg, scheduleHtml, faceHtml } from './schematic-render.js';
import { splitOps, previewLibrary, picturesOf, pictureSource, describeLibraryOp } from './library-ops.js';
import { fetchFile } from './sources.js';

const now = () => new Date().toISOString();
const str = (v) => String(v ?? '').trim();
const json = (v) => JSON.stringify(v, null, 2) + '\n';
const escHtml = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ------------------------------------------------------------------ */
/* Device library                                                      */
/* ------------------------------------------------------------------ */

export const LIB_CONNECTORS_FILE = 'library/connectors.json';
export const LIB_DEVICES_FILE = 'library/devices.json';

let libCache = null;

/** The library as main holds it right now — what a writer inside the lock must read (the cache may
 *  predate the write that just finished ahead of it in the lock chain). */
async function loadLibrary() {
  const files = await readJsonMany([{ ref: 'main', file: LIB_CONNECTORS_FILE }, { ref: 'main', file: LIB_DEVICES_FILE }]);
  const conn = files.get(`main:${LIB_CONNECTORS_FILE}`);
  const dev = files.get(`main:${LIB_DEVICES_FILE}`);
  return normalizeLibrary({ connectors: conn?.connectors, cables: conn?.cables, devices: dev?.devices });
}

export async function getLibrary() {
  if (!libCache) libCache = await loadLibrary();
  return libCache;
}

/** Every write of this module goes through here: the store's lock, then both caches dropped. */
async function change(fn) {
  try {
    return await mutate(fn);
  } finally {
    libCache = null;
  }
}

async function writeOnMain(file, data, message) {
  await repo.checkout('main');
  await repo.writeFile(file, json(data));
  await repo.commitAll(message);
}

export async function saveConnectors({ connectors, cables }) {
  if (!Array.isArray(connectors) || !connectors.length) throw new Error('connectors must be a non-empty array');
  if (!Array.isArray(cables)) throw new Error('cables must be an array');
  const ids = new Set();
  for (const c of connectors) {
    if (!c || !str(c.id) || !str(c.label)) throw new Error('every connector needs an id and a label');
    if (ids.has(c.id)) throw new Error(`connector "${c.id}" is listed twice`);
    ids.add(c.id);
  }
  const cableIds = new Set();
  for (const c of cables) {
    if (!c || !str(c.id) || !str(c.label) || !Array.isArray(c.joins)) throw new Error('every cable kind needs an id, a label and a joins list');
    if (cableIds.has(c.id)) throw new Error(`cable kind "${c.id}" is listed twice`);
    cableIds.add(c.id);
    for (const pair of c.joins) {
      if (!Array.isArray(pair) || pair.length !== 2) throw new Error(`cable kind "${c.id}": every join is a pair of connector ids`);
      for (const id of pair) if (!ids.has(id)) throw new Error(`cable kind "${c.id}" joins unknown connector "${id}"`);
    }
  }
  // a connector a template's port names cannot go: the template would silently stop parsing
  const current = await getLibrary();
  for (const t of current.devices) {
    const gone = t.ports.filter((p) => !ids.has(p.connector)).map((p) => p.connector);
    if (gone.length) throw new Error(`Connector ${[...new Set(gone)].join(', ')} is used by the device template "${t.name}" (${t.id}) — change its ports first`);
  }
  const data = { connectors, cables };
  await change(() => writeOnMain(LIB_CONNECTORS_FILE, data, 'library: connectors and cable kinds'));
  return getLibrary();
}

async function writeDevices(devices, message) {
  await writeOnMain(LIB_DEVICES_FILE, { devices }, message);
}

/* The device list is one shared file: it is read and rewritten inside the same lock section, so two
   writers (the UI and an MCP agent) cannot lose each other's template. */
export async function createDeviceTemplate(spec) {
  return change(async () => {
    const lib = await loadLibrary();
    const taken = new Set(lib.devices.map((d) => d.id));
    const t = normalizeTemplate(spec, taken, lib.connectors);
    if (taken.has(t.id)) throw new Error(`Device template "${t.id}" already exists`);
    await writeDevices([...lib.devices, t], `library: add device ${t.name}`);
    return t;
  });
}

export async function updateDeviceTemplate(id, patch) {
  return change(async () => {
    const lib = await loadLibrary();
    const idx = lib.devices.findIndex((d) => d.id === id);
    if (idx < 0) throw new Error(`Device template "${id}" not found`);
    const t = normalizeTemplate({ ...lib.devices[idx], ...patch, id }, new Set(), lib.connectors);
    const devices = lib.devices.slice();
    devices[idx] = t;
    await writeDevices(devices, `library: update device ${t.name}`);
    return t;
  });
}

export async function deleteDeviceTemplate(id) {
  return change(async () => {
    const lib = await loadLibrary();
    if (!lib.devices.some((d) => d.id === id)) throw new Error(`Device template "${id}" not found`);
    const users = (await allSchematics()).filter((s) => s.state.devices.some((d) => d.template === id));
    if (users.length) throw new Error(`Device template "${id}" is used by ${users.map((s) => s.ref).join(', ')} — remove those devices first`);
    await writeDevices(lib.devices.filter((d) => d.id !== id), `library: remove device ${id}`);
    return { ok: true, id };
  });
}

/* ---- panel pictures: what a device's front and rear look like ---- */

const PANEL_MIME = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const panelFile = (id, side, ext) => `library/panels/${id}-${side}.${ext}`;
const isSvg = (buf) => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(buf.toString('utf8', 0, 2048));

/** Store a picture of one face of a device template (SVG or a raster image). */
export async function saveDevicePanel(id, side, buffer, mime = '') {
  if (!PANEL_NAME.test(side)) throw new Error(`A picture name is front, rear or a short kebab-case word such as "mainboard-io", not "${side}"`);
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('No image data');
  let ext = null;
  if (isSvg(buffer) || mime === 'image/svg+xml') ext = 'svg';
  else {
    const info = sniff(buffer);
    if (info && PANEL_MIME[info.type]) ext = info.type === 'jpeg' ? 'jpg' : info.type;
  }
  if (!ext) throw new Error('A panel picture must be an image (SVG, PNG, JPEG, WebP or GIF)');
  return change(async () => {
    const lib = await loadLibrary();
    const idx = lib.devices.findIndex((d) => d.id === id);
    if (idx < 0) throw new Error(`Device template "${id}" not found`);
    const t = { ...lib.devices[idx], panels: { ...(lib.devices[idx].panels || {}), [side]: ext } };
    const devices = lib.devices.slice();
    devices[idx] = t;
    await repo.checkout('main');
    for (const other of Object.keys(PANEL_MIME)) {
      // one picture per face: an older file of another type goes
      if (other !== ext && (await repo.show('main', panelFile(id, side, other))) !== null) await repo.removePath(panelFile(id, side, other));
    }
    await repo.writeFile(panelFile(id, side, ext), buffer);
    await repo.writeFile(LIB_DEVICES_FILE, json({ devices }));
    await repo.commitAll(`library: ${side} panel of ${t.name}`);
    return t;
  });
}

export async function getDevicePanel(id, side) {
  const lib = await getLibrary();
  const t = lib.devices.find((d) => d.id === id);
  const ext = t?.panels?.[side];
  if (!ext) return null;
  const buffer = await repo.showBinary('main', panelFile(id, side, ext));
  return buffer ? { buffer, mime: PANEL_MIME[ext] || 'application/octet-stream', ext } : null;
}

export async function deleteDevicePanel(id, side) {
  return change(async () => {
    const lib = await loadLibrary();
    const idx = lib.devices.findIndex((d) => d.id === id);
    if (idx < 0) throw new Error(`Device template "${id}" not found`);
    const panels = { ...(lib.devices[idx].panels || {}) };
    const ext = panels[side];
    if (!ext) return lib.devices[idx];
    delete panels[side];
    const t = { ...lib.devices[idx], panels };
    const devices = lib.devices.slice();
    devices[idx] = t;
    await repo.checkout('main');
    await repo.removePath(panelFile(id, side, ext));
    await repo.writeFile(LIB_DEVICES_FILE, json({ devices }));
    await repo.commitAll(`library: remove ${side} panel of ${t.name}`);
    return t;
  });
}

/* ------------------------------------------------------------------ */
/* Installations                                                       */
/* ------------------------------------------------------------------ */

const INST_REF = 'inst:';
export const instRef = (slug) => `${INST_REF}${slug}`;
export const isInstRef = (ref) => String(ref || '').startsWith(INST_REF);
export const refSlug = (ref) => (isInstRef(ref) ? String(ref).slice(INST_REF.length) : String(ref || ''));
const installationFile = (slug) => `installations/${slug}/installation.json`;
const INST_FILE_RE = /^installations\/([^/]+)\/installation\.json$/;

const cleanInstallation = (v) => ({
  name: str(v.name),
  device: str(v.device) || null,
  serialNumber: str(v.serialNumber) || null,
  operator: str(v.operator) || null,
});

export async function getInstallation(slug) {
  return readJson('main', installationFile(slug));
}

export async function listInstallations() {
  const files = (await repo.lsFiles('main', 'installations')).filter((f) => INST_FILE_RE.test(f));
  const recs = await readJsonMany(files.map((file) => ({ ref: 'main', file })));
  const out = [];
  for (const file of files) {
    const rec = recs.get(`main:${file}`);
    if (!rec) continue;
    const live = await readLive(instRef(rec.slug));
    const state = live.draft?.state || live.main;
    out.push({ ...rec, schematic: state ? { version: state.version, revision: state.revision, status: state.status, hotfix: !!state.hotfix } : null });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function createInstallation(input = {}) {
  const fields = cleanInstallation(input);
  if (!fields.name) throw new Error('An installation needs a name');
  const slug = slugify(fields.name);
  if (await getInstallation(slug)) throw new Error(`An installation with slug "${slug}" already exists`);
  const ts = now();
  const rec = { slug, ...fields, createdAt: ts, updatedAt: ts };
  const starting = Array.isArray(input.locations) ? input.locations : DEFAULT_LOCATIONS;
  await change(async () => {
    await writeOnMain(installationFile(slug), rec, `installations: create ${slug}`);
    await writeFirstSchematic(instRef(slug), startingState(instRef(slug), starting));
  });
  return rec;
}

const DEFAULT_LOCATIONS = [
  { id: 'rack-1', label: 'Rack 1', kind: 'rack', unitsU: 42 },
  { id: 'ios', label: 'Instructor station', kind: 'area' },
  { id: 'cockpit', label: 'Cockpit', kind: 'area' },
];

function startingState(ref, locations) {
  const state = emptySchematic({ kind: isInstRef(ref) ? 'installation' : 'module', owner: refSlug(ref) });
  if (state.kind === 'installation' && locations.length) {
    const ops = locations.map((l) => ({ op: 'add_location', id: l.id, label: l.label, kind: l.kind, unitsU: l.unitsU, depthMm: l.depthMm }));
    return applyOps(state, ops, { library: DEFAULT_LIBRARY, catalog: [], modules: [], releasedSchematics: new Map() }).state;
  }
  return state;
}

export async function updateInstallation(slug, patch) {
  const existing = await getInstallation(slug);
  if (!existing) throw new Error(`Installation "${slug}" not found`);
  const rec = { ...existing };
  for (const k of ['name', 'device', 'serialNumber', 'operator']) if (patch[k] !== undefined) rec[k] = str(patch[k]) || (k === 'name' ? existing.name : null);
  rec.updatedAt = now();
  await change(() => writeOnMain(installationFile(slug), rec, `installations: update ${slug}`));
  return rec;
}

export async function deleteInstallation(slug) {
  const existing = await getInstallation(slug);
  if (!existing) throw new Error(`Installation "${slug}" not found`);
  const linked = (await store.listManuals()).filter((m) => m.installation === slug);
  if (linked.length) throw new Error(`Installation "${existing.name}" is linked by ${linked.map((m) => m.name).join(', ')} — unlink it in Edit manual first`);
  const prefix = branchPrefix(instRef(slug));
  const branches = (await repo.branches()).filter((b) => b.startsWith(prefix));
  await change(async () => {
    await repo.checkout('main');
    for (const b of branches) await repo.deleteBranch(b);
    await repo.removePath(`installations/${slug}`);
    await repo.commitAll(`installations: delete ${slug}`);
  });
  return { slug, branchesDeleted: branches };
}

/* ------------------------------------------------------------------ */
/* Schematic lifecycle                                                 */
/* ------------------------------------------------------------------ */

const schematicFile = (ref) => (isInstRef(ref) ? `installations/${refSlug(ref)}/schematic.json` : `modules/${refSlug(ref)}/schematic.json`);
const branchPrefix = (ref) => `draft/${isInstRef(ref) ? `inst/${refSlug(ref)}` : refSlug(ref)}-schematic-`;
const branchFor = (ref, version) => `${branchPrefix(ref)}${String(version).toLowerCase()}`;
const MODULE_SCH_RE = /^modules\/([^/]+)\/schematic\.json$/;
const isOpen = (s) => s.status === 'draft' || s.status === 'in-review';
const isEditable = (s) => isOpen(s) || !!s.hotfix;

export function dropCaches() {
  libCache = null;
}

/** The owner a ref names, shaped alike for both kinds, or null. */
async function ownerOf(ref) {
  if (isInstRef(ref)) {
    const rec = await getInstallation(refSlug(ref));
    return rec ? { ref, kind: 'installation', slug: rec.slug, name: rec.name, record: rec } : null;
  }
  const m = await store.getModule(ref);
  if (!m || m.module.kind === 'software') return null;
  return { ref, kind: 'module', slug: m.module.slug, name: m.module.name, module: m.module };
}

/** What a caller wrote — a module slug, an installation slug or name, or inst:<slug>. Modules win. */
export async function resolveSchematicRef(ref) {
  ref = str(ref);
  if (!ref || isInstRef(ref)) return ref;
  if ((await store.listModules()).some((m) => m.slug === ref)) return ref;
  const slug = slugify(ref);
  const inst = (await listInstallationRecords()).find((i) => i.slug === slug || i.name === ref);
  return inst ? instRef(inst.slug) : ref;
}

async function listInstallationRecords() {
  const files = (await repo.lsFiles('main', 'installations')).filter((f) => INST_FILE_RE.test(f));
  const recs = await readJsonMany(files.map((file) => ({ ref: 'main', file })));
  return files.map((f) => recs.get(`main:${f}`)).filter(Boolean);
}

async function readLive(ref) {
  const prefix = branchPrefix(ref);
  const branch = (await repo.branches()).find((b) => b.startsWith(prefix)) || null;
  const draftState = branch ? await readJson(branch, schematicFile(ref)) : null;
  return { draft: draftState ? { state: draftState, branch } : null, main: await readJson('main', schematicFile(ref)) };
}

export async function releasedSchematicOf(slug) {
  const s = await readJson('main', schematicFile(slug));
  return s && s.status === 'released' ? s : null;
}

/** Every released module schematic on main, by slug. */
async function releasedModuleSchematics() {
  const files = (await repo.lsFiles('main', 'modules')).filter((f) => MODULE_SCH_RE.test(f));
  const recs = await readJsonMany(files.map((file) => ({ ref: 'main', file })));
  const map = new Map();
  for (const f of files) {
    const s = recs.get(`main:${f}`);
    if (s && s.status === 'released') map.set(MODULE_SCH_RE.exec(f)[1], s);
  }
  return map;
}

export async function schematicContext() {
  const [library, catalog, modules, releasedSchematics] = await Promise.all([getLibrary(), store.listHardware(), store.listModules(), releasedModuleSchematics()]);
  return { library, catalog, modules: modules.map((m) => ({ slug: m.slug, name: m.name })), releasedSchematics };
}

export async function getSchematic(ref) {
  const owner = await ownerOf(ref);
  if (!owner) return null;
  const live = await readLive(ref);
  const state = live.draft?.state || live.main;
  if (!state) return null;
  const ctx = await schematicContext();
  const released = live.main && live.main.status === 'released' ? live.main : null;
  const history = [];
  const seen = new Set();
  for (const r of [live.draft?.branch, 'main'].filter(Boolean)) {
    for (const c of await repo.log(r, schematicFile(ref), 50)) if (!seen.has(c.hash)) {
      seen.add(c.hash);
      history.push({ ...c, ref: r });
    }
  }
  history.sort((a, b) => b.date.localeCompare(a.date));
  return {
    owner: { ref: owner.ref, kind: owner.kind, slug: owner.slug, name: owner.name },
    state,
    released,
    isDraft: isOpen(state),
    editable: isEditable(state),
    branch: live.draft?.branch || null,
    validation: validateSchematic(state, ctx),
    schedule: cableSchedule(state, ctx),
    face: state.kind === 'module' ? connectorFace(state, ctx) : [],
    history: history.slice(0, 50),
  };
}

/** Write the first draft of a schematic on its own branch. Caller holds the lock. */
async function writeFirstSchematic(ref, state) {
  const branch = branchFor(ref, state.version);
  state.branch = branch;
  state.revisions = [{ rev: 'r1', date: state.createdAt, summary: 'Initial draft' }];
  await repo.checkout('main');
  await repo.createBranch(branch, 'main');
  await repo.writeFile(schematicFile(ref), json(state));
  await repo.commitAll(`${refSlug(ref)}: create schematic ${state.version} r1 (draft)`);
  await repo.checkout('main');
  return state;
}

const bumpVersion = (version, bump) => {
  const m = /^A(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`Bad version ${version}`);
  return bump === 'major' ? `A${+m[1] + 1}.0` : `A${m[1]}.${+m[2] + 1}`;
};

/** First draft when there is none; else the next version, started from the released netlist. */
export async function createSchematic(ref, { bump = 'minor' } = {}) {
  const owner = await ownerOf(ref);
  if (!owner) throw new Error(`${isInstRef(ref) ? 'Installation' : 'Module'} "${refSlug(ref)}" not found`);
  const live = await readLive(ref);
  if (live.draft) throw new Error(`Schematic ${live.draft.state.version} is already open${live.draft.state.hotfix ? ' (hotfix)' : ''} — finish or discard it first`);
  let state;
  if (!live.main) state = startingState(ref, []);
  else {
    const prev = live.main;
    const ts = now();
    state = {
      ...prev,
      version: bumpVersion(prev.version, bump),
      revision: 1,
      status: 'draft',
      branch: null,
      createdAt: ts,
      updatedAt: ts,
      releasedAt: null,
      hotfix: null,
      revisions: [],
      releaseRecord: (prev.releaseRecord || []).map((r) => ({ ...r, inherited: true })),
    };
  }
  await change(() => writeFirstSchematic(ref, state));
  return state;
}

async function loadDraft(ref) {
  const owner = await ownerOf(ref);
  if (!owner) throw new Error(`${isInstRef(ref) ? 'Installation' : 'Module'} "${refSlug(ref)}" not found`);
  const live = await readLive(ref);
  if (!live.draft) throw new Error(`${owner.name} has no open draft schematic${live.main ? ` — ${live.main.version} is ${live.main.status}; start the next version or a hotfix` : ''}`);
  if (!isEditable(live.draft.state)) throw new Error(`Schematic ${live.draft.state.version} is ${live.draft.state.status} — not editable`);
  return { owner, ...live.draft };
}

async function writeDraft(ref, branch, state, message) {
  await repo.checkout(branch);
  await repo.writeFile(schematicFile(ref), json(state));
  await repo.commitAll(message);
  await repo.checkout('main');
}

/* ---- library ops riding in a schematic's op list (chat, MCP): see library-ops.js ---- */

/** The bytes of a picture source — inline data or a URL fetched here; an attachment never reaches the server. */
async function pictureBytes(src, where) {
  if (src.dataBase64) return { buffer: Buffer.from(src.dataBase64, 'base64'), type: src.type || '' };
  if (src.url) {
    const f = await fetchFile(src.url);
    if (!(f.type || '').startsWith('image/') && !sniff(f.buffer)) throw new Error(`${where}: ${src.url} is not an image`);
    return { buffer: f.buffer, type: f.type || '' };
  }
  throw new Error(`${where}: the picture "${src.attachment}" was an attachment that did not come with the request — send it again or give a url`);
}

/** Write library ops for real, in order; every picture is fetched/decoded before the first write. Returns one line per op. */
export async function applyLibraryOps(libraryOps) {
  if (!libraryOps.length) return [];
  const lines = [];
  // resolve picture bytes first so a bad url refuses the whole change before the library moved
  const pics = await Promise.all(libraryOps.map(async (op) => {
    if (op.op === 'set_picture') return { [str(op.side) || 'front']: await pictureBytes(pictureSource(op.picture, 'set_picture'), `set_picture ${op.template}`) };
    const sources = op.op === 'create_template' || op.op === 'update_template' ? picturesOf(op, op.op) : {};
    const out = {};
    for (const [side, src] of Object.entries(sources)) out[side] = await pictureBytes(src, `${op.op} ${op.name || op.id} picture "${side}"`);
    return out;
  }));
  for (let i = 0; i < libraryOps.length; i++) {
    const op = libraryOps[i];
    const { op: _o, pictures: _p, addPorts, ...spec } = op;
    let templateId = null;
    if (op.op === 'create_connector') {
      const lib = await getLibrary();
      await saveConnectors({ connectors: [...lib.connectors, { id: str(op.id), label: str(op.label), color: str(op.color) || '#555' }], cables: lib.cables });
    } else if (op.op === 'create_cable_kind') {
      const lib = await getLibrary();
      const style = op.style && typeof op.style === 'object' ? op.style : {};
      await saveConnectors({ connectors: lib.connectors, cables: [...lib.cables, { id: str(op.id), label: str(op.label), joins: op.joins, style: { color: str(style.color) || '#555', width: Number(style.width) || 1.2, dash: str(style.dash) } }] });
    } else if (op.op === 'create_template') {
      templateId = (await createDeviceTemplate(spec)).id;
    } else if (op.op === 'update_template') {
      const cur = (await getLibrary()).devices.find((d) => d.id === str(op.id));
      if (!cur) throw new Error(`Device template "${op.id}" not found`);
      const ports = Array.isArray(spec.ports) ? spec.ports : [...cur.ports, ...(Array.isArray(addPorts) ? addPorts : [])];
      templateId = (await updateDeviceTemplate(cur.id, { ...spec, ports })).id;
    } else if (op.op === 'set_picture') {
      templateId = str(op.template);
    }
    for (const [side, pic] of Object.entries(pics[i])) await saveDevicePanel(templateId, side, pic.buffer, pic.type);
    lines.push(describeLibraryOp(op));
  }
  return lines;
}

export async function applySchematicOps(ref, ops, { summary = '', dryRun = false } = {}) {
  const { owner, state, branch } = await loadDraft(ref);
  const { libraryOps, schematicOps } = splitOps(ops);
  const base = await schematicContext();
  // everything is checked against a preview of the library before a single write — a refused add_device
  // never leaves a half-made template behind
  const ctx = libraryOps.length ? { ...base, library: previewLibrary(base.library, libraryOps) } : base;
  const applied = schematicOps.length ? applyOps(state, schematicOps, ctx) : { state, summary: [] };
  const next = applied.state;
  const validation = validateSchematic(next, ctx);
  if (dryRun) return { state: next, summary: [...libraryOps.map(describeLibraryOp), ...applied.summary], validation };
  const libLines = await applyLibraryOps(libraryOps);
  const lines = [...libLines, ...applied.summary];
  if (!schematicOps.length) return { state, summary: lines, validation: validateSchematic(state, await schematicContext()) };
  const ts = now();
  next.revision = state.revision + 1;
  const line = str(summary) || lines[0] + (lines.length > 1 ? ` (+${lines.length - 1})` : '');
  next.revisions = [...(state.revisions || []), { rev: `r${next.revision}`, date: ts, summary: line }];
  next.updatedAt = ts;
  await change(() => writeDraft(ref, branch, next, `${owner.slug} schematic ${next.version} r${next.revision}: ${line}`));
  return { state: next, summary: lines, validation };
}

export async function setSchematicStatus(ref, status) {
  if (!['draft', 'in-review'].includes(status)) throw new Error('Invalid status transition');
  const { owner, state, branch } = await loadDraft(ref);
  if (state.hotfix) throw new Error('A hotfix is published, not reviewed');
  state.status = status;
  state.updatedAt = now();
  await change(() => writeDraft(ref, branch, state, `${owner.slug} schematic ${state.version}: ${status === 'in-review' ? 'submit for review' : 'back to draft'}`));
  return state;
}

export async function releaseSchematic(ref, { note = '' } = {}) {
  const { owner, state, branch } = await loadDraft(ref);
  const summary = str(note).replace(/\s+/g, ' ');
  if (!summary) throw Object.assign(new Error('Say what this release changes for the reader — that line is printed in the revision record.'), { code: 'note-required' });
  const ctx = await schematicContext();
  const { errors } = validateSchematic(state, ctx);
  if (errors.length) throw Object.assign(new Error(`The schematic cannot be released: ${errors.map((e) => e.message).join('; ')}`), { code: 'blockers', blockers: errors });
  const ts = now();
  const line = { rev: `r${state.revision}`, version: state.version, date: ts, summary, public: true };
  const final = { ...state, status: 'released', branch: null, hotfix: null, releasedAt: ts, updatedAt: ts, releaseRecord: [] };
  await change(async () => {
    await repo.checkout('main');
    // The lines of earlier versions are main's: an author may have reworded one while this draft was
    // open (setSchematicReleaseNote), and the branch's copy predates that. This version's own lines
    // (a hotfix keeps the ones already printed) and the new line follow.
    const onMain = await readJson('main', schematicFile(ref));
    const inherited = (onMain?.releaseRecord || []).filter((r) => r.version !== state.version).map((r) => ({ ...r, inherited: true }));
    const own = (state.releaseRecord || []).filter((r) => r.version === state.version && !r.inherited);
    final.releaseRecord = [...inherited, ...own, line];
    // main may have moved the same file since the branch was cut (a release line on the previous
    // version): keep the branch as a parent and write the final record below — no conflict possible
    if (!state.hotfix) await repo.merge(branch, `Merge ${branch}: release ${owner.slug} schematic ${state.version}`, { ours: true });
    await repo.writeFile(schematicFile(ref), json(final));
    await repo.commitAll(`${owner.slug}: ${state.hotfix ? `publish schematic hotfix ${state.version} r${state.revision}` : `release schematic ${state.version}`}`);
    await repo.deleteBranch(branch);
  });
  return final;
}

export async function setSchematicReleaseNote(ref, note) {
  const owner = await ownerOf(ref);
  if (!owner) throw new Error(`Schematic owner "${refSlug(ref)}" not found`);
  const live = await readLive(ref);
  if (!live.main || live.main.status !== 'released') throw new Error('Only a released schematic takes a release line');
  if (live.draft?.state.hotfix) throw new Error(`${live.main.version} is being hotfixed — its line is given when the hotfix is published`);
  const summary = str(note).replace(/\s+/g, ' ');
  if (!summary) throw Object.assign(new Error('The release line cannot be empty'), { code: 'note-required' });
  const state = live.main;
  const idx = state.releaseRecord.findLastIndex((r) => r.version === state.version && !r.inherited);
  if (idx >= 0) state.releaseRecord[idx] = { ...state.releaseRecord[idx], summary };
  else state.releaseRecord.push({ rev: `r${state.revision}`, version: state.version, date: state.releasedAt, summary, public: true });
  state.updatedAt = now();
  await change(() => writeOnMain(schematicFile(ref), state, `${owner.slug}: schematic ${state.version} release line`));
  return state;
}

export async function startSchematicHotfix(ref) {
  const owner = await ownerOf(ref);
  if (!owner) throw new Error(`${isInstRef(ref) ? 'Installation' : 'Module'} "${refSlug(ref)}" not found`);
  const live = await readLive(ref);
  if (live.draft) throw new Error(live.draft.state.hotfix ? `${live.draft.state.version} is already being hotfixed` : `Schematic ${live.draft.state.version} is open (${live.draft.state.status}) — finish it before hotfixing`);
  if (!live.main || live.main.status !== 'released') throw new Error('A hotfix corrects a released schematic');
  const ts = now();
  const state = { ...live.main, revision: live.main.revision + 1, updatedAt: ts, branch: branchFor(ref, live.main.version), hotfix: { startedAt: ts, baseRevision: live.main.revision } };
  state.revisions = [...(state.revisions || []), { rev: `r${state.revision}`, date: ts, summary: 'Hotfix (draft)' }];
  await change(async () => {
    await repo.checkout('main');
    await repo.createBranch(state.branch, 'main');
    await repo.writeFile(schematicFile(ref), json(state));
    await repo.commitAll(`${owner.slug} schematic ${state.version}: start hotfix r${state.revision}`);
    await repo.checkout('main');
  });
  return state;
}

export async function discardSchematic(ref) {
  const { branch } = await loadDraft(ref);
  await change(async () => {
    await repo.checkout('main');
    await repo.deleteBranch(branch);
  });
  return { ok: true };
}

/** Every schematic there is, live copy each: [{ref, state}]. */
async function allSchematics() {
  const out = [];
  const refs = new Set();
  for (const f of await repo.lsFiles('main', ['modules', 'installations'])) {
    let m = MODULE_SCH_RE.exec(f);
    if (m) refs.add(m[1]);
    if ((m = /^installations\/([^/]+)\/schematic\.json$/.exec(f))) refs.add(instRef(m[1]));
  }
  for (const b of await repo.branches()) {
    let m = /^draft\/inst\/([^/]+)-schematic-a\d+\.\d+$/.exec(b);
    if (m) refs.add(instRef(m[1]));
    else if ((m = /^draft\/([^/]+)-schematic-a\d+\.\d+$/.exec(b))) refs.add(m[1]);
  }
  for (const ref of refs) {
    const live = await readLive(ref);
    const state = live.draft?.state || live.main;
    if (state) out.push({ ref, state });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Promotion: a library device becomes a module                        */
/* ------------------------------------------------------------------ */

export async function promoteDeviceToModule(templateId, { name, code = null, category = 'misc' } = {}) {
  const lib = await getLibrary();
  const t = lib.devices.find((d) => d.id === templateId);
  if (!t) throw new Error(`Device template "${templateId}" not found`);
  const moduleName = str(name) || t.name;
  const { blankContent } = await import('./docgen.js');
  const created = await store.createModuleDoc(
    {
      name: moduleName,
      code: str(code) || null,
      category,
      type: 'third-party-kit',
      softwares: [],
      hardware: t.hardwareId ? [{ id: t.hardwareId }] : [{ name: t.name, type: 'cots', manufacturer: t.manufacturer, model: t.model, notes: t.notes }],
    },
    [{ manual: 'technician', content: blankContent(moduleName, [], 'technician', []) }]
  );
  const hardwareId = created.hardware[0].id;
  if (t.hardwareId !== hardwareId) await updateDeviceTemplate(t.id, { hardwareId });
  await createSchematic(created.slug);
  const ops = [
    { op: 'add_device', id: 'unit', template: t.id, hardwareId, label: t.name },
    ...t.ports.map((p) => ({ op: 'set_external_port', id: p.id, label: p.label, device: 'unit', port: p.id })),
  ];
  const { state } = await applySchematicOps(created.slug, ops, { summary: `Promoted from library device ${t.name}` });
  return { slug: created.slug, hardwareId, schematic: state };
}

/* ------------------------------------------------------------------ */
/* What the manual build prints                                        */
/* ------------------------------------------------------------------ */

/** A module's released wiring as the generated sections print it — null when there is nothing to print. */
async function schematicForManual({ module, manual, lang = 'en' }) {
  if (!module || module.kind === 'software') return null;
  const { manualTypeOf } = await import('./docgen.js');
  if (manualTypeOf(manual).audience === 'customer') return null;
  const state = await releasedSchematicOf(module.slug);
  if (!state) return null;
  const ctx = await schematicContext();
  const face = connectorFace(state, ctx);
  const schedule = cableSchedule(state, ctx);
  return {
    svg: await renderSvg(state, ctx, { lang, title: module.name }),
    faceHtml: face.length ? faceHtml(face, lang, ctx.library) : '',
    scheduleHtml: schedule.length ? scheduleHtml(schedule, lang) : '',
    version: state.version,
    revision: state.revision,
  };
}

/**
 * The wiring chapter of an assembled manual: the released installation drawn once, then the cables
 * that touch this manual's chapter modules. Null when the manual links no installation; a draft or
 * missing installation returns {blocker} so the compile can say why nothing printed.
 */
async function installationChapterFor(manual, lang = 'en') {
  if (!manual?.installation) return null;
  const rec = await getInstallation(manual.installation);
  if (!rec) return { blocker: { reason: `installation "${manual.installation}" not found` } };
  const state = await readJson('main', schematicFile(instRef(rec.slug)));
  if (!state || state.status !== 'released') return { blocker: { reason: `installation "${rec.name}" has no released schematic` }, record: rec };
  const ctx = await schematicContext();
  const { strings } = await import('./docgen.js');
  const T = strings(lang);
  const chapterSlugs = new Set(manual.modules || []);
  const schedule = cableSchedule(state, ctx).filter((row) => {
    const c = state.cables.find((x) => x.id === row.id);
    const touches = (end) => end.block && chapterSlugs.has(state.blocks.find((b) => b.id === end.block)?.module);
    return touches(c.from) || touches(c.to);
  });
  const svg = await renderSvg(state, ctx, { lang, title: rec.name });
  return {
    record: rec,
    state,
    chapter: {
      slug: 'installation-wiring',
      installation: true,
      module: { slug: 'installation-wiring', name: T.installationWiring, code: rec.slug.toUpperCase(), hardwareIds: [], hardwareItems: [], softwares: [] },
      doc: { key: `schematic:${state.version}`, version: state.version, revision: state.revision, status: 'released', manual: manual.manual, releasedAt: state.releasedAt, updatedAt: state.updatedAt, revisionRecord: state.releaseRecord || [], covers: [] },
      title: T.installationWiring,
      generated: '',
      content: `<h2>${T.installationWiring}</h2>\n<figure class="schematic installation" data-size="full">${svg}<figcaption>${T.installationFig(escHtml(rec.name))} — ${escHtml(state.version)}</figcaption></figure>\n${schedule.length ? `<h2>${T.installationCables}</h2>\n${scheduleHtml(schedule, lang)}` : ''}`,
      checklist: null,
      isDraft: false,
      langFallback: false,
    },
  };
}

store.setSchematicProvider({ forManual: schematicForManual, installationChapter: installationChapterFor });
