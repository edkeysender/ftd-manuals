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

export async function applySchematicOps(ref, ops, { summary = '', dryRun = false } = {}) {
  const { owner, state, branch } = await loadDraft(ref);
  const ctx = await schematicContext();
  const applied = applyOps(state, ops, ctx);
  const next = applied.state;
  const validation = validateSchematic(next, ctx);
  if (dryRun) return { state: next, summary: applied.summary, validation };
  const ts = now();
  next.revision = state.revision + 1;
  const line = str(summary) || applied.summary[0] + (applied.summary.length > 1 ? ` (+${applied.summary.length - 1})` : '');
  next.revisions = [...(state.revisions || []), { rev: `r${next.revision}`, date: ts, summary: line }];
  next.updatedAt = ts;
  await change(() => writeDraft(ref, branch, next, `${owner.slug} schematic ${next.version} r${next.revision}: ${line}`));
  return { state: next, summary: applied.summary, validation };
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
  const final = { ...state, status: 'released', branch: null, hotfix: null, releasedAt: ts, updatedAt: ts, releaseRecord: [...(state.releaseRecord || []), line] };
  await change(async () => {
    await repo.checkout('main');
    if (!state.hotfix) await repo.merge(branch, `Merge ${branch}: release ${owner.slug} schematic ${state.version}`);
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
