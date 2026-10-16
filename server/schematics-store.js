/**
 * Git side of the schematics: the device library (two files on main), installations (a record on
 * main + a versioned schematic), and the schematic lifecycle of a module or an installation —
 * draft branch, operations as commits, review, release with a note, hotfix, discard, next version.
 * The netlist rules are in schematic.js; this file only moves files and branches, always inside
 * the store's lock, and leaves the tree on main.
 */
import * as store from './store.js';
import { repo, mutate, readJson, readJsonMany, slugify } from './store.js';
import { normalizeLibrary, normalizeTemplate, DEFAULT_LIBRARY } from './library.js';
import { emptySchematic, applyOps, validateSchematic, connectorFace, cableSchedule, SchematicError } from './schematic.js';

const now = () => new Date().toISOString();
const str = (v) => String(v ?? '').trim();
const json = (v) => JSON.stringify(v, null, 2) + '\n';

/* ------------------------------------------------------------------ */
/* Device library                                                      */
/* ------------------------------------------------------------------ */

export const LIB_CONNECTORS_FILE = 'library/connectors.json';
export const LIB_DEVICES_FILE = 'library/devices.json';

let libCache = null;

export async function getLibrary() {
  if (libCache) return libCache;
  const files = await readJsonMany([{ ref: 'main', file: LIB_CONNECTORS_FILE }, { ref: 'main', file: LIB_DEVICES_FILE }]);
  const conn = files.get(`main:${LIB_CONNECTORS_FILE}`);
  const dev = files.get(`main:${LIB_DEVICES_FILE}`);
  libCache = normalizeLibrary({ connectors: conn?.connectors, cables: conn?.cables, devices: dev?.devices });
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
  const data = { connectors, cables };
  await change(() => writeOnMain(LIB_CONNECTORS_FILE, data, 'library: connectors and cable kinds'));
  return getLibrary();
}

async function writeDevices(devices, message) {
  await writeOnMain(LIB_DEVICES_FILE, { devices }, message);
}

export async function createDeviceTemplate(spec) {
  const lib = await getLibrary();
  const taken = new Set(lib.devices.map((d) => d.id));
  const t = normalizeTemplate(spec, taken, lib.connectors);
  if (taken.has(t.id)) throw new Error(`Device template "${t.id}" already exists`);
  await change(() => writeDevices([...lib.devices, t], `library: add device ${t.name}`));
  return t;
}

export async function updateDeviceTemplate(id, patch) {
  const lib = await getLibrary();
  const idx = lib.devices.findIndex((d) => d.id === id);
  if (idx < 0) throw new Error(`Device template "${id}" not found`);
  const t = normalizeTemplate({ ...lib.devices[idx], ...patch, id }, new Set(), lib.connectors);
  const devices = lib.devices.slice();
  devices[idx] = t;
  await change(() => writeDevices(devices, `library: update device ${t.name}`));
  return t;
}

export async function deleteDeviceTemplate(id) {
  const lib = await getLibrary();
  if (!lib.devices.some((d) => d.id === id)) throw new Error(`Device template "${id}" not found`);
  const users = (await allSchematics()).filter((s) => s.state.devices.some((d) => d.template === id));
  if (users.length) throw new Error(`Device template "${id}" is used by ${users.map((s) => s.ref).join(', ')} — remove those devices first`);
  await change(() => writeDevices(lib.devices.filter((d) => d.id !== id), `library: remove device ${id}`));
  return { ok: true, id };
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
    const ops = locations.map((l) => ({ op: 'add_location', id: l.id, label: l.label, kind: l.kind, unitsU: l.unitsU }));
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

/* ---- schematic lifecycle (Task 5 fills these in) ---- */
const schematicFile = (ref) => (isInstRef(ref) ? `installations/${refSlug(ref)}/schematic.json` : `modules/${refSlug(ref)}/schematic.json`);
const branchPrefix = (ref) => `draft/${isInstRef(ref) ? `inst/${refSlug(ref)}` : refSlug(ref)}-schematic-`;
const branchFor = (ref, version) => `${branchPrefix(ref)}${String(version).toLowerCase()}`;

async function readLive(ref) {
  const prefix = branchPrefix(ref);
  const branch = (await repo.branches()).find((b) => b.startsWith(prefix)) || null;
  const draftState = branch ? await readJson(branch, schematicFile(ref)) : null;
  return { draft: draftState ? { state: draftState, branch } : null, main: await readJson('main', schematicFile(ref)) };
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

/** Every schematic there is, live copy each: [{ref, state}]. */
async function allSchematics() {
  const out = [];
  const files = await repo.lsFiles('main', ['modules', 'installations']);
  const refs = new Set();
  for (const f of files) {
    let m = /^modules\/([^/]+)\/schematic\.json$/.exec(f);
    if (m) refs.add(m[1]);
    if ((m = INST_FILE_RE.exec(f))) refs.add(instRef(m[1]));
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
