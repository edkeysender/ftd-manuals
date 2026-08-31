import path from 'node:path';
import { GitRepo } from './git.js';
import {
  blankContent,
  generatedSections,
  hardwareLabel,
  hardwareItemsOf,
  softwareLabel,
  parseDocVersion,
  compareDocVersions,
  docBranchName,
  compareSwVersions,
  versionCovered,
  MANUAL_TYPES,
  MANUAL_ORDER,
  DEFAULT_MANUAL,
  manualTypeOf,
  docKey,
  parseDocKey,
} from './docgen.js';
import { normalizeChecklist } from './checklist.js';
import { validateAsset } from './images.js';
import * as inbox from './inbox.js';

const DATA_DIR = process.env.FTD_DATA_DIR
  ? path.resolve(process.env.FTD_DATA_DIR)
  : path.resolve('data', 'repo');
export const repo = new GitRepo(DATA_DIR);

export async function initStore() {
  await repo.init();
  warmCache();
}

export const slugify = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const now = () => new Date().toISOString();

const parseJson = (text) => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

async function readJson(ref, file) {
  return parseJson(await repo.show(ref, file));
}

/** Read many JSON files in one git process. Returns Map<"ref:file", object|null>. */
async function readJsonMany(requests) {
  const blobs = await repo.showMany(requests);
  const out = new Map();
  for (const [key, buf] of blobs) out.set(key, buf ? parseJson(buf.toString('utf8')) : null);
  return out;
}

const moduleFile = (slug) => `modules/${slug}/module.json`;
/** Folder of one doc version: modules/<slug>/docs/<manual>/<version>. Docs created before the
 *  manual split live in modules/<slug>/docs/<version> (customer manual) and are read from there —
 *  every doc record carries its `dir`, so nothing is ever moved. */
const docDir = (slug, manual, version) => `modules/${slug}/docs/${manual}/${version}`;
const docJson = (dir) => `${dir}/doc.json`;
const contentIn = (dir) => `${dir}/content.html`;
const checklistIn = (dir) => `${dir}/checklist.json`;
const VERSION_RE = /^A\d+\.\d+$/;
const LEGACY_DOC_RE = /^modules\/([^/]+)\/docs\/(A\d+\.\d+)\/doc\.json$/;
const TYPED_DOC_RE = /^modules\/([^/]+)\/docs\/([a-z][a-z-]*)\/(A\d+\.\d+)\/doc\.json$/;
const isOpen = (d) => d.status === 'draft' || d.status === 'in-review';
/** Shared hardware catalog, one file on main: {items: [{id, name, type, version|manufacturer+model, notes}]} */
const HARDWARE_FILE = 'hardware.json';

/* ------------------------------------------------------------------ */
/* Cache — every read spawns git processes, which is slow on Windows.  */
/* All reads are cached in memory and invalidated on any store write.  */
/* ------------------------------------------------------------------ */

let collectCache = null;
let feedCache = null;
const assetCache = new Map();
const historyCache = new Map();
let manualsCache = null;
let statusCache = null;

function invalidateCache() {
  collectCache = null;
  feedCache = null;
  manualsCache = null;
  statusCache = null;
  assetCache.clear();
  historyCache.clear();
}

/** Run a mutation inside the repo lock, drop caches afterwards and re-warm them in the background. */
async function mutate(fn) {
  try {
    return await repo.lock(fn);
  } finally {
    invalidateCache();
    warmCache();
  }
}

/** Rebuild the module list cache off the request path, so the UI never pays the cold cost. */
function warmCache() {
  collectAll().catch((e) => console.warn('cache warm-up failed:', e.message));
  getSoftwareFeed().catch(() => {});
  getStatus().catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/**
 * Collect every module and doc version across main and all draft branches.
 * For each doc version the authoritative copy is:
 *   - the copy on its own draft branch while that branch exists (live draft),
 *   - otherwise the copy on main (released / merged).
 */
let collectInFlight = null;

async function collectAll() {
  if (collectCache) return collectCache;
  if (!collectInFlight) {
    collectInFlight = collectAllUncached().finally(() => {
      collectInFlight = null;
    });
  }
  return collectInFlight;
}

async function collectAllUncached() {
  const branches = await repo.branches();
  const draftBranches = branches.filter((b) => b.startsWith('draft/'));
  const refs = ['main', ...draftBranches];

  // slug -> { moduleRefs: Set, docs: Map(key -> { manual, version, dir, refs: Set }) }
  const found = new Map();
  const listings = await Promise.all(refs.map((ref) => repo.lsFiles(ref, 'modules')));
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    for (const f of listings[i]) {
      let m = /^modules\/([^/]+)\/module\.json$/.exec(f);
      if (m) {
        const slug = m[1];
        if (!found.has(slug)) found.set(slug, { moduleRefs: new Set(), docs: new Map() });
        found.get(slug).moduleRefs.add(ref);
        continue;
      }
      let slug;
      let manual;
      let version;
      if ((m = TYPED_DOC_RE.exec(f))) {
        [, slug, manual, version] = m;
        if (!MANUAL_TYPES[manual]) continue; // unknown folder — not a manual type we know
      } else if ((m = LEGACY_DOC_RE.exec(f))) {
        [, slug, version] = m;
        manual = DEFAULT_MANUAL;
      } else continue;
      if (!found.has(slug)) found.set(slug, { moduleRefs: new Set(), docs: new Map() });
      const docs = found.get(slug).docs;
      const key = docKey(manual, version);
      if (!docs.has(key)) docs.set(key, { manual, version, dir: f.slice(0, -'/doc.json'.length), refs: new Set() });
      docs.get(key).refs.add(ref);
    }
  }

  // Every module.json and doc.json we might need, fetched in one git process.
  const wanted = [];
  for (const [slug, info] of found) {
    const moduleRef = info.moduleRefs.has('main') ? 'main' : [...info.moduleRefs][0];
    wanted.push({ ref: moduleRef, file: moduleFile(slug) });
    for (const d of info.docs.values()) {
      for (const ref of d.refs) wanted.push({ ref, file: docJson(d.dir) });
    }
  }
  wanted.push({ ref: 'main', file: HARDWARE_FILE });
  const json = await readJsonMany(wanted);
  const get = (ref, file) => json.get(`${ref}:${file}`) || null;
  const hardware = normalizeCatalog(get('main', HARDWARE_FILE));

  const modules = [];
  for (const [slug, info] of found) {
    const moduleRef = info.moduleRefs.has('main') ? 'main' : [...info.moduleRefs][0];
    const raw = get(moduleRef, moduleFile(slug));
    if (!raw) continue;
    const module = withHardwareItems(raw, hardware);

    const docs = [];
    for (const [key, d] of info.docs) {
      let chosen = null;
      let chosenRef = null;
      for (const ref of d.refs) {
        if (ref === 'main') continue;
        const meta = get(ref, docJson(d.dir));
        if (meta && meta.branch === ref) {
          chosen = meta;
          chosenRef = ref;
          break;
        }
      }
      if (!chosen && d.refs.has('main')) {
        chosen = get('main', docJson(d.dir));
        chosenRef = 'main';
      }
      if (!chosen) {
        const ref = [...d.refs][0];
        chosen = get(ref, docJson(d.dir));
        chosenRef = ref;
      }
      if (chosen) docs.push({ ...chosen, manual: d.manual, key, dir: d.dir, ref: chosenRef });
    }
    // newest version first within a manual type; types in their canonical order
    docs.sort(
      (a, b) => MANUAL_ORDER.indexOf(a.manual) - MANUAL_ORDER.indexOf(b.manual) || compareDocVersions(b.version, a.version)
    );
    modules.push({ module, docs, draftBranches });
  }
  modules.sort((a, b) => a.module.name.localeCompare(b.module.name));
  collectCache = { modules, draftBranches, hardware };
  return collectCache;
}

/* ------------------------------------------------------------------ */
/* Hardware catalog                                                    */
/* ------------------------------------------------------------------ */

function normalizeCatalog(raw) {
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : [];
  return items.filter((i) => i && i.id && i.name);
}

/** Attach resolved `hardwareItems` to a module.json record. New modules store
 *  `hardwareIds`; modules created before the catalog keep their inline relation. */
function withHardwareItems(module, catalog) {
  const byId = new Map(catalog.map((i) => [i.id, i]));
  const items = Array.isArray(module.hardwareIds)
    ? module.hardwareIds.map((id) => byId.get(id) || { id, name: id, type: 'cots', missing: true })
    : hardwareItemsOf(module.hardware);
  return { ...module, hardwareItems: items };
}

function hardwareIdFor(name, taken) {
  const base = slugify(name) || 'hardware';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** Clean one hardware item spec (from the UI, API or MCP) into a catalog record without id. */
function normalizeHardwareSpec(spec, fallbackName = '') {
  const type = spec.type === 'ftd' ? 'ftd' : 'cots';
  const name = String(spec.name || '').trim() || fallbackName;
  if (!name) throw new Error('Hardware name is required');
  const item = { name, type, notes: String(spec.notes || '').trim() };
  if (type === 'ftd') item.version = String(spec.version || '').trim() || 'v1';
  else {
    item.manufacturer = String(spec.manufacturer || '').trim();
    item.model = String(spec.model || '').trim();
  }
  return item;
}

const hwIdentity = (i) =>
  [i.name, i.type, i.version, i.manufacturer, i.model].map((x) => String(x || '').trim().toLowerCase()).join('|');

/**
 * Resolve a module's hardware input against the catalog.
 * Accepts `hardwareIds: [id]` and/or `hardware`: an array of `{id}` (existing item) or
 * `{name, type, version | manufacturer, model, notes}` (new item), or the legacy single
 * relation object `{type:'ftd'|'cots'|'none', …}`. Returns { ids, items, newItems } —
 * the caller writes newItems to the catalog.
 */
function resolveHardwareInput(input, catalog, moduleName = '') {
  const specs = [];
  if (Array.isArray(input.hardwareIds)) for (const id of input.hardwareIds) specs.push({ id });
  const hw = input.hardware;
  if (Array.isArray(hw)) specs.push(...hw);
  else if (hw && typeof hw === 'object' && hw.type && hw.type !== 'none') specs.push(hw);

  const byId = new Map(catalog.map((i) => [i.id, i]));
  const taken = new Set(byId.keys());
  const ids = [];
  const items = [];
  const newItems = [];
  const use = (item) => {
    if (ids.includes(item.id)) return;
    ids.push(item.id);
    items.push(item);
  };
  for (const spec of specs) {
    if (!spec || typeof spec !== 'object') continue;
    if (spec.id && byId.has(spec.id)) {
      use(byId.get(spec.id));
      continue;
    }
    if (spec.id && !spec.name) throw new Error(`Hardware "${spec.id}" is not in the catalog`);
    if (spec.type === 'none') continue;
    const fallback =
      spec.type === 'cots' ? [spec.manufacturer, spec.model].filter(Boolean).join(' ') || moduleName : moduleName;
    const item = normalizeHardwareSpec(spec, fallback);
    const same = [...catalog, ...newItems].find((i) => hwIdentity(i) === hwIdentity(item));
    if (same) {
      use(same);
      continue;
    }
    item.id = hardwareIdFor(item.name, taken);
    taken.add(item.id);
    item.createdAt = now();
    newItems.push(item);
    use(item);
  }
  return { ids, items, newItems };
}

/** Catalog + which modules use each item. */
export async function listHardware() {
  const { modules, hardware } = await collectAll();
  return hardware.map((item) => ({
    ...item,
    usedBy: modules
      .filter(({ module }) => (module.hardwareItems || []).some((h) => h.id === item.id))
      .map(({ module }) => ({ slug: module.slug, name: module.name })),
  }));
}

/** What a hardware input would resolve to, without writing anything (for previews, templates, AI drafts). */
export async function previewHardware(input, moduleName = '') {
  const { hardware } = await collectAll();
  return resolveHardwareInput(input, hardware, moduleName).items;
}

const catalogJson = (items) => JSON.stringify({ items }, null, 2) + '\n';

/** Append new catalog items on main. Must run inside the repo lock; leaves main checked out. */
async function commitNewHardware(catalog, newItems) {
  if (!newItems.length) return catalog;
  const next = [...catalog, ...newItems];
  await repo.checkout('main');
  await repo.writeFile(HARDWARE_FILE, catalogJson(next));
  await repo.commitAll(`hardware: add ${newItems.map((i) => i.name).join(', ')}`);
  return next;
}

export async function createHardware(spec) {
  const { hardware } = await collectAll();
  const { newItems, items } = resolveHardwareInput({ hardware: [{ ...spec, id: undefined }] }, hardware);
  if (!newItems.length) throw new Error(`"${items[0]?.name}" is already in the catalog`);
  await mutate(() => commitNewHardware(hardware, newItems));
  return newItems[0];
}

export async function updateHardware(id, patch) {
  const { hardware } = await collectAll();
  const idx = hardware.findIndex((i) => i.id === id);
  if (idx < 0) throw new Error(`Hardware "${id}" not found`);
  const merged = normalizeHardwareSpec({ ...hardware[idx], ...patch });
  const item = { ...hardware[idx], ...merged, id, updatedAt: now() };
  if (item.type === 'ftd') {
    delete item.manufacturer;
    delete item.model;
  } else delete item.version;
  const next = hardware.map((i, k) => (k === idx ? item : i));
  await mutate(async () => {
    await repo.checkout('main');
    await repo.writeFile(HARDWARE_FILE, catalogJson(next));
    await repo.commitAll(`hardware: update ${item.name}`);
  });
  return item;
}

export async function deleteHardware(id) {
  const rows = await listHardware();
  const item = rows.find((i) => i.id === id);
  if (!item) throw new Error(`Hardware "${id}" not found`);
  if (item.usedBy.length) {
    throw new Error(`"${item.name}" is assigned to ${item.usedBy.map((m) => m.name).join(', ')} — unassign it first`);
  }
  const next = rows.filter((i) => i.id !== id).map(({ usedBy, ...i }) => i);
  await mutate(async () => {
    await repo.checkout('main');
    await repo.writeFile(HARDWARE_FILE, catalogJson(next));
    await repo.commitAll(`hardware: remove ${item.name}`);
  });
  return { ok: true };
}

function latestDocLabel(doc) {
  if (!doc) return null;
  if (isOpen(doc)) return `${doc.version} draft r${doc.revision}`;
  return doc.version;
}

/** Docs of one manual type, newest version first (docs are already sorted that way). */
const docsOfType = (docs, manual) => docs.filter((d) => d.manual === manual);

/** Manual types this module has at least one doc version of, in canonical order. */
const manualTypesOf = (docs) => MANUAL_ORDER.filter((t) => docs.some((d) => d.manual === t));

/** Status of one manual type: that of its latest version. */
function typeStatus(docs) {
  if (docs.length === 0) return 'missing';
  return docs[0].status;
}

/** Aggregate status of a module: any manual type still open → draft / in-review,
 *  everything released → released, no manual at all → missing. */
function moduleStatus(docs) {
  if (docs.length === 0) return 'missing';
  const statuses = manualTypesOf(docs).map((t) => typeStatus(docsOfType(docs, t)));
  if (statuses.includes('draft')) return 'draft';
  if (statuses.includes('in-review')) return 'in-review';
  if (statuses.includes('released')) return 'released';
  return statuses[0];
}

/** Per-type summary for list rows and manual assembly: { customer: {key, version, revision, status, label, fat}, … } */
function manualsSummary(docs) {
  const out = {};
  for (const t of manualTypesOf(docs)) {
    const latest = docsOfType(docs, t)[0];
    out[t] = {
      key: latest.key,
      version: latest.version,
      revision: latest.revision,
      status: latest.status,
      label: latestDocLabel(latest),
      fat: !!latest.fat,
      released: docsOfType(docs, t).find((d) => d.status === 'released')?.version || null,
      updatedAt: latest.updatedAt,
    };
  }
  return out;
}

/** Orange dot: some manual type has a manual-affecting software release not covered by
 *  any of its doc versions, and no draft/in-review doc of that type exists yet. */
function needsDoc(module, docs, softwareFeed) {
  return uncoveredReleases(module, docs, softwareFeed).some((u) => !docsOfType(docs, u.manual).some(isOpen));
}

/** Manual-affecting releases of the module's softwares (at/after the linked from-version)
 *  that no doc version of a manual type covers yet — each one needs its own doc version
 *  of every manual the module maintains. Entries: { manual, name, version }. */
function uncoveredReleases(module, docs, softwareFeed) {
  const out = [];
  for (const manual of manualTypesOf(docs)) {
    const typed = docsOfType(docs, manual);
    for (const sw of module.softwares || []) {
      for (const rel of softwareFeed[sw.name] || []) {
        if (!rel.manualAffecting) continue;
        if (sw.fromVersion && compareSwVersions(rel.version, sw.fromVersion) < 0) continue;
        const covered = typed.some((d) => (d.covers || []).some((c) => c.name === sw.name && versionCovered(rel.version, c)));
        if (!covered) out.push({ manual, name: sw.name, version: rel.version });
      }
    }
  }
  return out;
}

/** Fold a release into a covers list: new row, or widen the existing range. */
function addCover(covers, swName, swVersion) {
  const cov = covers.find((c) => c.name === swName);
  if (!cov) {
    covers.push({ name: swName, from: swVersion, to: swVersion });
  } else {
    if (compareSwVersions(swVersion, cov.from) < 0) cov.from = swVersion;
    if (compareSwVersions(swVersion, cov.to || cov.from) > 0) cov.to = swVersion;
  }
  return covers;
}

export async function getSoftwareFeed() {
  if (feedCache) return feedCache;
  feedCache = (await readJson('main', 'softwares.json')) || {};
  return feedCache;
}

export async function listModules() {
  const { modules } = await collectAll();
  const feed = await getSoftwareFeed();
  return modules.map(({ module, docs }) => {
    const manuals = manualsSummary(docs);
    // "latest doc" of the row: the customer manual when there is one, else the first manual type
    const primary = manuals[DEFAULT_MANUAL] || manuals[manualTypesOf(docs)[0]] || null;
    const updated =
      docs.reduce((acc, d) => (d.updatedAt > acc ? d.updatedAt : acc), module.createdAt || '') || null;
    return {
      slug: module.slug,
      name: module.name,
      code: module.code || null,
      category: module.category,
      group: module.group,
      hardware: module.hardwareItems,
      hardwareLabel: hardwareLabel(module),
      softwares: module.softwares || [],
      softwareLabel: softwareLabel(module.softwares),
      manuals,
      latestDoc: primary ? primary.label : null,
      status: moduleStatus(docs),
      updated,
      needsDoc: needsDoc(module, docs, feed),
      fat: !!(primary && primary.fat),
    };
  });
}

export async function getModule(slug) {
  const { modules } = await collectAll();
  const entry = modules.find((m) => m.module.slug === slug);
  if (!entry) return null;
  const feed = await getSoftwareFeed();

  // History: commits touching this module's folder across main + its draft branches.
  let history = historyCache.get(slug);
  if (!history) {
    const seen = new Set();
    history = [];
    const refs = ['main', ...entry.docs.filter((d) => d.ref !== 'main').map((d) => d.ref)];
    for (const ref of refs) {
      for (const c of await repo.log(ref, `modules/${slug}`, 50)) {
        if (!seen.has(c.hash)) {
          seen.add(c.hash);
          history.push({ ...c, ref });
        }
      }
    }
    history.sort((a, b) => b.date.localeCompare(a.date));
    historyCache.set(slug, history);
  }

  return {
    module: entry.module,
    docs: entry.docs,
    manuals: manualsSummary(entry.docs),
    status: moduleStatus(entry.docs),
    needsDoc: needsDoc(entry.module, entry.docs, feed),
    uncovered: uncoveredReleases(entry.module, entry.docs, feed),
    history: history.slice(0, 50),
    staleAssets: (await listAssets(slug)).filter((a) => a.stale.length).length,
    softwareFeed: Object.fromEntries(
      (entry.module.softwares || []).map((s) => [s.name, feed[s.name] || []])
    ),
  };
}

/** Find one doc record by key ("technician:A1.0", or bare "A1.0" = customer manual).
 *  Returns { entry, doc } or null. */
async function findDoc(slug, key) {
  const { modules } = await collectAll();
  const entry = modules.find((m) => m.module.slug === slug);
  if (!entry) return null;
  const { manual, version } = parseDocKey(key);
  const doc = entry.docs.find((d) => d.manual === manual && d.version === version);
  return doc ? { entry, doc } : null;
}

export async function getDoc(slug, key) {
  const hit = await findDoc(slug, key);
  if (!hit) return null;
  const { entry, doc } = hit;
  const content = (await repo.show(doc.ref, contentIn(doc.dir))) || '';
  const checklist = doc.fat ? await readJson(doc.ref, checklistIn(doc.dir)) : null;
  return {
    module: entry.module,
    doc,
    content,
    generated: generatedSections(entry.module, doc),
    checklist,
  };
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Write the first version (A1.0 r1) of one manual type on its own draft branch.
 * Must run inside the repo lock with main checked out; leaves main checked out.
 * spec: { manual, content, checklist|null, revisionSeed, startSummary, copiedFrom }
 * `module` is written onto the branch when it is not on main yet (never-released module).
 */
async function writeFirstDoc(module, spec, moduleOnMain) {
  const slug = module.slug;
  const manual = manualTypeOf(spec.manual).id;
  const version = 'A1.0';
  const branch = docBranchName(slug, manual, version);
  const dir = docDir(slug, manual, version);
  const created = now();
  const checklist = spec.checklist ? normalizeChecklist(spec.checklist) : null;
  const doc = {
    version,
    manual,
    revision: 1,
    status: 'draft',
    branch,
    createdAt: created,
    updatedAt: created,
    releasedAt: null,
    covers: (module.softwares || []).map((s) => ({ name: s.name, from: s.fromVersion, to: s.fromVersion })),
    revisionRecord: [...(spec.revisionSeed || []), { rev: 'r1', date: created, summary: spec.startSummary || 'Initial draft' }],
    copiedFrom: spec.copiedFrom || null,
    fat: !!checklist,
  };
  await repo.checkout('main');
  await repo.createBranch(branch, 'main');
  if (!moduleOnMain) await repo.writeFile(moduleFile(slug), JSON.stringify(module, null, 2) + '\n');
  await repo.writeFile(docJson(dir), JSON.stringify(doc, null, 2) + '\n');
  await repo.writeFile(contentIn(dir), spec.content);
  if (checklist) await repo.writeFile(checklistIn(dir), JSON.stringify(checklist, null, 2) + '\n');
  await repo.commitAll(`${slug}: create ${MANUAL_TYPES[manual].label.toLowerCase()} ${version} r1 (draft)${checklist ? ' + FAT checklist' : ''}`);
  await repo.checkout('main');
  return { manual, key: docKey(manual, version), version, branch, fat: doc.fat };
}

/**
 * Create a new module with the first draft (A1.0 r1) of every requested manual type,
 * each on its own draft/<slug>-<manual>-a1.0 branch.
 * manuals: [{ manual, content, checklist, revisionSeed, startSummary, copiedFrom }] — at least one.
 */
export async function createModuleDoc(input, manuals) {
  const slug = slugify(input.name);
  if (!slug) throw new Error('Module name is required');
  if (!Array.isArray(manuals) || !manuals.length) throw new Error('At least one manual type is required');
  const seen = new Set();
  for (const m of manuals) {
    const id = manualTypeOf(m.manual).id;
    if (seen.has(id)) throw new Error(`Manual type "${id}" listed twice`);
    seen.add(id);
    if (MANUAL_TYPES[id].kind === 'software' && !(input.softwares || []).length) {
      throw new Error(`${MANUAL_TYPES[id].label}: link the module to a software first`);
    }
  }
  const existing = await readJson('main', moduleFile(slug));
  const branches = await repo.branches();
  if (existing || branches.some((b) => b.startsWith(`draft/${slug}-`))) {
    throw new Error(`A module with slug "${slug}" already exists`);
  }

  const created = now();
  const { hardware: catalog } = await collectAll();
  const hw = resolveHardwareInput(input, catalog, input.name);

  const module = {
    slug,
    name: input.name,
    code: input.code || null,
    category: input.category || 'software',
    group: input.group,
    hardwareIds: hw.ids,
    softwares: input.softwares || [],
    createdAt: created,
  };

  const docs = [];
  await mutate(async () => {
    await commitNewHardware(catalog, hw.newItems); // the catalog lives on main; the branches are cut after it
    for (const spec of manuals) docs.push(await writeFirstDoc(module, spec, false));
  });

  const first = docs[0];
  return { slug, docs, manual: first.manual, key: first.key, version: first.version, branch: first.branch, fat: first.fat, hardware: hw.items };
}

/** Add a manual type to an existing module: its first version A1.0 r1 on a new draft branch.
 *  spec: { manual, content, checklist, revisionSeed, startSummary, copiedFrom } */
export async function addManual(slug, spec) {
  const entry = await moduleOf(slug);
  if (!entry) throw new Error(`Module "${slug}" not found`);
  const type = manualTypeOf(spec.manual);
  if (docsOfType(entry.docs, type.id).length) throw new Error(`${type.label} already exists for this module — create a new version instead`);
  if (type.kind === 'software' && !(entry.module.softwares || []).length) {
    throw new Error(`${type.label}: link the module to a software first (Module → Software)`);
  }
  const { hardwareItems, ...module } = entry.module;
  const onMain = !!(await readJson('main', moduleFile(slug)));
  let doc;
  await mutate(async () => {
    doc = await writeFirstDoc(module, spec, onMain);
  });
  return { slug, ...doc };
}

/** Create the next doc version of one manual type, starting from its latest released content. */
export async function createNextDocVersion(slug, manual = DEFAULT_MANUAL, bump = 'minor') {
  const entry = await moduleOf(slug);
  if (!entry) throw new Error('Module not found');
  const type = manualTypeOf(manual);
  const typed = docsOfType(entry.docs, type.id);
  if (!typed.length) throw new Error(`This module has no ${type.label.toLowerCase()} yet — create one first`);
  if (typed.some(isOpen)) {
    throw new Error(`A ${type.label.toLowerCase()} draft already exists — release or discard it first`);
  }
  const latest = typed[0];
  const pv = parseDocVersion(latest.version);
  const version = bump === 'major' ? `A${pv.major + 1}.0` : `A${pv.major}.${pv.minor + 1}`;
  const branch = docBranchName(slug, type.id, version);
  const dir = docDir(slug, type.id, version);
  const created = now();

  const content =
    (await repo.show('main', contentIn(latest.dir))) ||
    blankContent(entry.module.name, entry.module.hardwareItems, type.id, entry.module.softwares);
  const checklist = latest.fat ? await repo.show('main', checklistIn(latest.dir)) : null;
  // The new version is the manual for every manual-affecting release this manual type does not cover yet.
  const covers = uncoveredReleases(entry.module, entry.docs, await getSoftwareFeed())
    .filter((r) => r.manual === type.id)
    .reduce((acc, r) => addCover(acc, r.name, r.version), []);
  const coversLabel = covers
    .map((c) => `${c.name} ${c.to && c.to !== c.from ? `${c.from}–${c.to}` : c.from}`)
    .join(', ');
  const doc = {
    version,
    manual: type.id,
    revision: 1,
    status: 'draft',
    branch,
    createdAt: created,
    updatedAt: created,
    releasedAt: null,
    covers,
    revisionRecord: [
      ...latest.revisionRecord.map((r) => ({ ...r, inherited: true })),
      { rev: 'r1', date: created, summary: `Draft based on ${latest.version}${coversLabel ? ` for ${coversLabel}` : ''}` },
    ],
    copiedFrom: { slug, manual: type.id, version: latest.version },
    fat: !!checklist,
  };

  await mutate(async () => {
    await repo.checkout('main');
    await repo.createBranch(branch, 'main');
    await repo.writeFile(docJson(dir), JSON.stringify(doc, null, 2) + '\n');
    await repo.writeFile(contentIn(dir), content);
    if (checklist) await repo.writeFile(checklistIn(dir), checklist);
    await repo.commitAll(`${slug}: create ${type.label.toLowerCase()} ${version} r1 (draft)${coversLabel ? ` for ${coversLabel}` : ''}`);
    await repo.checkout('main');
  });

  return { slug, manual: type.id, key: docKey(type.id, version), version, branch, fat: doc.fat, covers };
}

/** The live copy of an open draft: its branch, folder and doc.json as on the branch. */
async function loadDraftDoc(slug, key) {
  const hit = await findDoc(slug, key);
  if (!hit) throw new Error(`Doc ${slug} ${key} not found`);
  const { doc } = hit;
  const branch = doc.branch;
  if (!branch) throw new Error(`Doc ${doc.version} (${MANUAL_TYPES[doc.manual].label}) is ${doc.status} — it has no draft branch`);
  const branches = await repo.branches();
  if (!branches.includes(branch)) throw new Error(`No draft branch ${branch}`);
  const meta = await readJson(branch, docJson(doc.dir));
  if (!meta) throw new Error('Draft doc not found');
  return { branch, dir: doc.dir, meta, manual: doc.manual, key: doc.key };
}

/**
 * Save draft content. When `bump` is true the revision counter increments and
 * an entry is appended to the revision record (accepted change); otherwise it
 * is a plain autosave commit on the same revision.
 */
export async function saveDraftContent(slug, key, html, { bump = false, summary = '' } = {}) {
  const { branch, dir, meta } = await loadDraftDoc(slug, key);
  if (!isOpen(meta)) throw new Error(`Doc ${meta.version} is ${meta.status} — not editable`);
  const version = meta.version;
  const ts = now();
  if (bump) {
    meta.revision += 1;
    meta.revisionRecord.push({ rev: `r${meta.revision}`, date: ts, summary: summary || 'Content update' });
  }
  meta.updatedAt = ts;

  await mutate(async () => {
    await repo.checkout(branch);
    await repo.writeFile(contentIn(dir), html);
    await repo.writeFile(docJson(dir), JSON.stringify(meta, null, 2) + '\n');
    await repo.commitAll(
      bump ? `${slug} ${version}: r${meta.revision} — ${summary || 'content update'}` : `${slug} ${version}: autosave`
    );
    await repo.checkout('main');
  });
  return meta;
}

/** The FAT checklist of a doc version (any status): { module, doc, checklist|null }, or null if the doc does not exist. */
export async function getChecklist(slug, key) {
  const hit = await findDoc(slug, key);
  if (!hit) return null;
  const { entry, doc } = hit;
  const checklist = doc.fat ? await readJson(doc.ref, checklistIn(doc.dir)) : null;
  return { module: entry.module, doc, checklist };
}

/** Save (or remove, with null) the FAT checklist of a Draft/In-review doc; bumps the revision like a content edit. */
export async function saveChecklist(slug, key, checklist, { summary = '' } = {}) {
  const { branch, dir, meta } = await loadDraftDoc(slug, key);
  if (!isOpen(meta)) throw new Error(`Doc ${meta.version} is ${meta.status} — not editable`);
  const version = meta.version;
  const normalized = checklist ? normalizeChecklist(checklist) : null;
  const ts = now();
  const text = summary || (normalized ? 'FAT checklist update' : 'FAT checklist removed');
  meta.revision += 1;
  meta.revisionRecord.push({ rev: `r${meta.revision}`, date: ts, summary: text });
  meta.updatedAt = ts;
  const had = !!meta.fat;
  meta.fat = !!normalized;
  await mutate(async () => {
    await repo.checkout(branch);
    if (normalized) await repo.writeFile(checklistIn(dir), JSON.stringify(normalized, null, 2) + '\n');
    else if (had) await repo.removePath(checklistIn(dir));
    await repo.writeFile(docJson(dir), JSON.stringify(meta, null, 2) + '\n');
    await repo.commitAll(`${slug} ${version}: r${meta.revision} — ${text}`);
    await repo.checkout('main');
  });
  return { doc: meta, checklist: normalized };
}

export async function setDocStatus(slug, key, status) {
  if (!['draft', 'in-review'].includes(status)) throw new Error('Invalid status transition');
  const { branch, dir, meta } = await loadDraftDoc(slug, key);
  meta.status = status;
  meta.updatedAt = now();
  await mutate(async () => {
    await repo.checkout(branch);
    await repo.writeFile(docJson(dir), JSON.stringify(meta, null, 2) + '\n');
    await repo.commitAll(`${slug} ${meta.version}: ${status === 'in-review' ? 'submit for review' : 'back to draft'}`);
    await repo.checkout('main');
  });
  return meta;
}

/** Release: merge the draft branch into main, freeze the revision counter,
 *  supersede older released versions of the same manual type, delete the branch. */
export async function releaseDoc(slug, key) {
  const { branch, dir, meta, manual } = await loadDraftDoc(slug, key);
  const entry = await moduleOf(slug);
  const version = meta.version;
  const ts = now();

  await mutate(async () => {
    await repo.checkout('main');
    await repo.merge(branch, `Merge ${branch}: release ${slug} ${MANUAL_TYPES[manual].label.toLowerCase()} ${version}`);

    meta.status = 'released';
    meta.releasedAt = ts;
    meta.updatedAt = ts;
    meta.branch = null;
    await repo.writeFile(docJson(dir), JSON.stringify(meta, null, 2) + '\n');

    // Supersede older released versions of the same manual type.
    for (const other of docsOfType(entry.docs, manual)) {
      if (other.version === version || other.status !== 'released' || compareDocVersions(other.version, version) >= 0) continue;
      const onMain = await readJson('main', docJson(other.dir));
      if (!onMain || onMain.status !== 'released') continue;
      onMain.status = 'superseded';
      onMain.updatedAt = ts;
      await repo.writeFile(docJson(other.dir), JSON.stringify(onMain, null, 2) + '\n');
    }

    await repo.commitAll(`${slug}: release ${MANUAL_TYPES[manual].label.toLowerCase()} ${version}`);
    await repo.deleteBranch(branch);
  });
  return meta;
}

/** Discard a draft: delete its branch. A never-released module with no other draft disappears entirely. */
export async function discardDraft(slug, key) {
  const { branch } = await loadDraftDoc(slug, key);
  await mutate(async () => {
    await repo.checkout('main');
    await repo.deleteBranch(branch);
  });
}

/* ------------------------------------------------------------------ */
/* Assets (images and other files in the module folder)                */
/* ------------------------------------------------------------------ */

const assetFile = (slug, name) => `modules/${slug}/assets/${name}`;
/** Sidecar next to the assets folder: {fileName: stamp}. A stamp records what the image
 *  showed when it was added — doc version, each linked software's newest release, each
 *  hardware unit's version — plus `appliesTo` (subset of the module's hardware ids; [] = all). */
const assetMetaFile = (slug) => `modules/${slug}/assets.json`;

const hwVersionOf = (h) => (h.type === 'ftd' ? h.version || '' : [h.manufacturer, h.model].filter(Boolean).join(' '));

/** What "current" means right now for a module: newest registered release of every linked
 *  software (else its from-version) and the catalog version of every linked hardware unit. */
function currentStamp(module, feed) {
  const software = (module.softwares || []).map((sw) => {
    let version = sw.fromVersion || '';
    for (const rel of feed[sw.name] || []) if (compareSwVersions(rel.version, version) > 0) version = rel.version;
    return { name: sw.name, version };
  });
  const hardware = hardwareItemsOf(module)
    .filter((h) => h.id && !h.missing)
    .map((h) => ({ id: h.id, name: h.name, version: hwVersionOf(h) }));
  return { software, hardware };
}

/** Why a stamped asset may be out of date: a manual-affecting software release newer than
 *  the stamp, or a hardware unit whose catalog version changed since. Unstamped → []. */
function assetStaleness(meta, module, feed) {
  if (!meta) return [];
  const reasons = [];
  for (const sw of module.softwares || []) {
    const stamped = (meta.software || []).find((s) => s.name === sw.name);
    if (!stamped) continue;
    let newest = null;
    for (const rel of feed[sw.name] || []) {
      if (!rel.manualAffecting || compareSwVersions(rel.version, stamped.version) <= 0) continue;
      if (!newest || compareSwVersions(rel.version, newest) > 0) newest = rel.version;
    }
    if (newest) reasons.push(`${sw.name} ${newest}`);
  }
  const applies = Array.isArray(meta.appliesTo) && meta.appliesTo.length ? new Set(meta.appliesTo) : null;
  for (const h of hardwareItemsOf(module)) {
    if (!h.id || h.missing || (applies && !applies.has(h.id))) continue;
    const stamped = (meta.hardware || []).find((x) => x.id === h.id);
    if (stamped && stamped.version !== hwVersionOf(h)) reasons.push(`${h.name} ${hwVersionOf(h)}`);
  }
  return reasons;
}

/** One-line version note for prompts and tooltips. */
export function describeAssetVersion(asset) {
  const m = asset.meta;
  if (!m) return 'no version stamp';
  const parts = [m.verifiedIn ? `verified in ${m.verifiedIn}` : `added in ${m.addedIn}`];
  for (const s of m.software || []) if (s.version) parts.push(`${s.name} ${s.version}`);
  for (const h of m.hardware || []) if (!m.appliesTo?.length || m.appliesTo.includes(h.id)) parts.push(`${h.name}${h.version ? ' ' + h.version : ''}`);
  let note = parts.join(' · ');
  if (asset.stale?.length) note += ` — OUT OF DATE, newer: ${asset.stale.join(', ')}`;
  return note;
}

async function moduleOf(slug) {
  const { modules } = await collectAll();
  return modules.find((m) => m.module.slug === slug) || null;
}

/** Sidecar merged across refs; later refs win, so pass main first and the live draft last. */
async function readAssetMeta(slug, refs) {
  const json = await readJsonMany(refs.map((ref) => ({ ref, file: assetMetaFile(slug) })));
  const out = {};
  for (const ref of refs) Object.assign(out, json.get(`${ref}:${assetMetaFile(slug)}`) || {});
  return out;
}

export function sanitizeAssetName(name) {
  const base = String(name).split(/[\\/]/).pop() || 'file';
  const dot = base.lastIndexOf('.');
  const stem =
    (dot > 0 ? base.slice(0, dot) : base)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'file';
  const ext = dot > 0 ? base.slice(dot).toLowerCase().replace(/[^a-z0-9.]/g, '') : '';
  return stem + ext;
}

export const assetUrl = (slug, name) => `/api/modules/${slug}/assets/${encodeURIComponent(name)}`;

/** Commit files into the draft's assets folder. files: [{name, buffer}] */
export async function saveAssets(slug, version, files) {
  const { branch } = await loadDraftDoc(slug, version);
  if (!files.length) throw new Error('No files to save');
  for (const f of files) validateAsset(f.name, f.buffer); // reject truncated / mislabelled files before anything is committed
  const entry = await moduleOf(slug);
  const stamp = currentStamp(entry?.module || {}, await getSoftwareFeed());
  const ts = now();
  const saved = [];
  await mutate(async () => {
    await repo.checkout(branch);
    const meta = (await readJson(branch, assetMetaFile(slug))) || {};
    for (const f of files) {
      const name = sanitizeAssetName(f.name);
      await repo.writeFile(assetFile(slug, name), f.buffer);
      // A re-upload under the same name is a new picture: fresh stamp, same "applies to".
      meta[name] = { addedIn: version, addedAt: ts, ...stamp, appliesTo: meta[name]?.appliesTo || [] };
      saved.push(name);
    }
    await repo.writeFile(assetMetaFile(slug), JSON.stringify(meta, null, 2) + '\n');
    await repo.commitAll(`${slug} ${version}: add asset${saved.length > 1 ? 's' : ''} ${saved.join(', ')}`);
    await repo.checkout('main');
  });
  return saved.map((n) => ({ name: n, url: assetUrl(slug, n) }));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Released/superseded doc versions on main whose body embeds this asset. The assets folder
 *  is shared by every version of a module, so removing such a file would break a manual
 *  that has already been released. */
async function releasedDocsUsingAsset(slug, name, exceptKey) {
  const entry = await moduleOf(slug);
  const re = new RegExp(`/assets/${escapeRe(encodeURIComponent(name))}(?=["'?\\s>)])`);
  const users = [];
  for (const d of entry?.docs || []) {
    if (d.key === exceptKey || !(d.status === 'released' || d.status === 'superseded')) continue;
    const html = await repo.show('main', contentIn(d.dir));
    if (html && re.test(html)) users.push(`${MANUAL_TYPES[d.manual].label.toLowerCase()} ${d.version}`);
  }
  return users;
}

/** Remove an asset from a draft's branch (git rm + commit). Refuses when a released doc still embeds it. */
export async function deleteAsset(slug, version, name) {
  const { branch, key } = await loadDraftDoc(slug, version);
  const base = sanitizeAssetName(name);
  const file = assetFile(slug, base);
  if (!(await repo.show(branch, file))) throw new Error(`Asset "${name}" not found on ${branch}`);
  const users = await releasedDocsUsingAsset(slug, base, key);
  if (users.length) {
    throw new Error(
      `"${base}" is embedded in released ${users.join(', ')} — released manuals must keep rendering. Upload the replacement under a new name and re-point the figure instead.`
    );
  }
  await mutate(async () => {
    await repo.checkout(branch);
    await repo.removePath(file);
    const meta = (await readJson(branch, assetMetaFile(slug))) || {};
    if (meta[base]) {
      delete meta[base];
      await repo.writeFile(assetMetaFile(slug), JSON.stringify(meta, null, 2) + '\n');
    }
    await repo.commitAll(`${slug} ${version}: remove asset ${base}`);
    await repo.checkout('main');
  });
  return { name: base, removed: true };
}

/**
 * Edit an asset's version stamp on the draft branch.
 *  - `appliesTo`: hardware ids (subset of the module's) this picture shows; [] = every unit.
 *  - `verify`: re-stamp with today's software releases / hardware versions — the author has
 *    checked the picture is still right (or replaced it) after a manual-affecting change.
 */
export async function setAssetMeta(slug, version, name, { appliesTo, verify = false } = {}) {
  const { branch } = await loadDraftDoc(slug, version);
  const base = sanitizeAssetName(name);
  if (!(await getAsset(slug, base))) throw new Error(`Asset "${name}" not found`);
  const entry = await moduleOf(slug);
  const module = entry?.module || {};
  const feed = await getSoftwareFeed();
  const ids = hardwareItemsOf(module).map((h) => h.id).filter(Boolean);
  if (appliesTo !== undefined) {
    if (!Array.isArray(appliesTo)) throw new Error('appliesTo must be an array of hardware ids');
    const bad = appliesTo.find((id) => !ids.includes(id));
    if (bad) throw new Error(`Hardware "${bad}" is not linked to this module`);
  }
  if (appliesTo === undefined && !verify) throw new Error('Nothing to change');
  const ts = now();
  let stamp = null;
  await mutate(async () => {
    await repo.checkout(branch);
    const meta = (await readJson(branch, assetMetaFile(slug))) || {};
    stamp = meta[base] || { addedIn: version, addedAt: ts, software: [], hardware: [], appliesTo: [] };
    const changes = [];
    if (appliesTo !== undefined) {
      stamp.appliesTo = [...new Set(appliesTo)];
      changes.push(stamp.appliesTo.length ? `applies to ${stamp.appliesTo.join(', ')}` : 'applies to all hardware');
    }
    if (verify) {
      Object.assign(stamp, currentStamp(module, feed), { verifiedIn: version, verifiedAt: ts });
      const what = [...stamp.software.map((s) => `${s.name} ${s.version}`), ...stamp.hardware.map((h) => `${h.name} ${h.version}`)].filter(Boolean);
      changes.push(`verified for ${what.join(', ') || 'current versions'}`);
    }
    meta[base] = stamp;
    await repo.writeFile(assetMetaFile(slug), JSON.stringify(meta, null, 2) + '\n');
    await repo.commitAll(`${slug} ${version}: asset ${base} ${changes.join('; ')}`);
    await repo.checkout('main');
  });
  return { name: base, url: assetUrl(slug, base), meta: stamp, stale: assetStaleness(stamp, module, feed) };
}

/** Move files from the inbox into a draft's assets (validated on the way in). */
export async function importFromInbox(slug, version, names, { keep = false } = {}) {
  const files = [];
  for (const n of names) {
    const f = await inbox.readInbox(n);
    if (!f) throw new Error(`"${n}" is not in the inbox — see the inbox list`);
    files.push(f);
  }
  const saved = await saveAssets(slug, version, files);
  if (!keep) for (const f of files) await inbox.deleteInbox(f.name);
  return saved;
}

/** Read an asset, preferring the module's live draft branches over main. */
export async function getAsset(slug, name) {
  const key = `${slug}/${name}`;
  if (assetCache.has(key)) return assetCache.get(key);
  const branches = await repo.branches();
  const refs = [...branches.filter((b) => b.startsWith(`draft/${slug}-`)), 'main'];
  for (const ref of refs) {
    const buf = await repo.showBinary(ref, assetFile(slug, name));
    if (buf && buf.length) {
      assetCache.set(key, buf);
      return buf;
    }
  }
  return null;
}

/** Every asset of a module with its version stamp (`meta`, null for files added before
 *  stamping) and `stale`: reasons it may be out of date (see assetStaleness). */
export async function listAssets(slug) {
  const branches = await repo.branches();
  const drafts = branches.filter((b) => b.startsWith(`draft/${slug}-`));
  const names = new Set();
  for (const ref of [...drafts, 'main']) {
    for (const f of await repo.lsFiles(ref, `modules/${slug}/assets`)) {
      names.add(f.split('/').pop());
    }
  }
  const [meta, entry, feed] = await Promise.all([readAssetMeta(slug, ['main', ...drafts]), moduleOf(slug), getSoftwareFeed()]);
  const module = entry?.module || {};
  return [...names].map((n) => {
    const m = meta[n] || null;
    return { name: n, url: assetUrl(slug, n), meta: m, stale: assetStaleness(m, module, feed) };
  });
}

/* ------------------------------------------------------------------ */
/* Software release feed                                               */
/* ------------------------------------------------------------------ */

export async function registerSoftwareRelease({ name, version, manualAffecting, note }) {
  if (!name || !version) throw new Error('Software name and version are required');
  const feed = await getSoftwareFeed();
  const releases = feed[name] || [];
  if (releases.some((r) => r.version === version)) throw new Error(`${name} ${version} is already registered`);
  releases.push({ version, date: now(), manualAffecting: !!manualAffecting, note: note || '' });
  releases.sort((a, b) => compareSwVersions(a.version, b.version));
  feed[name] = releases;
  await mutate(async () => {
    await repo.checkout('main');
    await repo.writeFile('softwares.json', JSON.stringify(feed, null, 2) + '\n');
    await repo.commitAll(`softwares: ${name} ${version}${manualAffecting ? ' (manual-affecting)' : ''}`);
  });
  return feed;
}

/** Make a doc version the manual for a software release: widen a Released doc's covered
 *  range (non-manual-affecting releases), or assign the release to an open draft /
 *  in-review doc (a manual-affecting release that got its own doc version). */
export async function linkReleaseToDoc(slug, docKeyOrVersion, swName, swVersion) {
  const hit = await findDoc(slug, docKeyOrVersion);
  if (!hit) throw new Error('Doc version not found');
  const { entry, doc } = hit;
  if (!(entry.module.softwares || []).some((s) => s.name === swName)) {
    throw new Error(`${swName} is not linked to this module`);
  }
  if (doc.status === 'superseded') throw new Error('A superseded doc version cannot take new releases');
  const ref = doc.status === 'released' ? 'main' : doc.branch;
  const file = docJson(doc.dir);
  const meta = await readJson(ref, file);
  if (!meta) throw new Error('Doc version not found');
  meta.covers = addCover(meta.covers || [], swName, swVersion);
  meta.updatedAt = now();
  await mutate(async () => {
    await repo.checkout(ref);
    await repo.writeFile(file, JSON.stringify(meta, null, 2) + '\n');
    await repo.commitAll(`${slug} ${MANUAL_TYPES[doc.manual].label.toLowerCase()} ${doc.version}: cover ${swName} ${swVersion}`);
    await repo.checkout('main');
  });
  return meta;
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const AI_GUIDELINES_FILE = 'settings/ai-guidelines.md';

export async function getAiGuidelines() {
  return (await repo.show('main', AI_GUIDELINES_FILE)) || '';
}

export async function saveAiGuidelines(text) {
  await mutate(async () => {
    await repo.checkout('main');
    await repo.writeFile(AI_GUIDELINES_FILE, String(text ?? ''));
    await repo.commitAll('settings: update AI agent guidelines');
  });
  return text;
}

/* Illustration house style (Technical Aviation Manual Line-Art). The built-in
   default lives in illustrate.js; an edited copy is versioned here. */
const ILLUSTRATION_STYLE_FILE = 'settings/illustration-style.md';

/** Saved style text, or null when the built-in default applies. */
export async function getIllustrationStyle() {
  const saved = await repo.show('main', ILLUSTRATION_STYLE_FILE);
  return saved && saved.trim() ? saved : null;
}

export async function saveIllustrationStyle(text) {
  await mutate(async () => {
    await repo.checkout('main');
    await repo.writeFile(ILLUSTRATION_STYLE_FILE, String(text ?? ''));
    await repo.commitAll('settings: update illustration style');
  });
  return text;
}

/* ------------------------------------------------------------------ */

export async function getStatus() {
  if (!statusCache) {
    statusCache = getStatusUncached().catch((e) => {
      statusCache = null;
      throw e;
    });
  }
  return statusCache;
}

async function getStatusUncached() {
  const branches = await repo.branches();
  const last = await repo.lastCommit('main');
  return {
    repo: 'local',
    branch: 'main',
    drafts: branches.filter((b) => b.startsWith('draft/')).length,
    lastCommit: last,
  };
}

export { blankContent };

/* ------------------------------------------------------------------ */
/* Manuals — assembled from module docs                                */
/* ------------------------------------------------------------------ */

const manualFile = (slug) => `manuals/${slug}/manual.json`;

export async function listManuals() {
  if (manualsCache) return manualsCache;
  const files = await repo.lsFiles('main', 'manuals');
  const out = [];
  for (const f of files) {
    if (!/^manuals\/[^/]+\/manual\.json$/.test(f)) continue;
    const m = await readJson('main', f);
    if (m) out.push(m);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  manualsCache = out;
  return out;
}

export async function getManual(slug) {
  return (await listManuals()).find((m) => m.slug === slug) || null;
}

export async function createManual({ name, code, group, modules, manual: type }) {
  const slug = slugify(name);
  if (!slug) throw new Error('Manual name is required');
  if (await getManual(slug)) throw new Error(`A manual with slug "${slug}" already exists`);
  const ts = now();
  const manual = {
    slug,
    name,
    code: code || null,
    group: group || null,
    manual: manualTypeOf(type).id, // which manual type of each module is compiled
    modules: Array.isArray(modules) ? modules : [],
    createdAt: ts,
    updatedAt: ts,
  };
  await mutate(async () => {
    await repo.checkout('main');
    await repo.writeFile(manualFile(slug), JSON.stringify(manual, null, 2) + '\n');
    await repo.commitAll(`manuals: create ${slug}`);
  });
  return manual;
}

export async function updateManual(slug, patch) {
  const existing = await getManual(slug);
  if (!existing) throw new Error(`Manual "${slug}" not found`);
  const manual = { ...existing };
  if (patch.name !== undefined) manual.name = patch.name;
  if (patch.code !== undefined) manual.code = patch.code || null;
  if (patch.group !== undefined) manual.group = patch.group || null;
  if (patch.manual !== undefined) manual.manual = manualTypeOf(patch.manual).id;
  if (patch.modules !== undefined) manual.modules = patch.modules;
  manual.updatedAt = now();
  await mutate(async () => {
    await repo.checkout('main');
    await repo.writeFile(manualFile(slug), JSON.stringify(manual, null, 2) + '\n');
    await repo.commitAll(`manuals: update ${slug}`);
  });
  return manual;
}

export async function deleteManual(slug) {
  if (!(await getManual(slug))) throw new Error(`Manual "${slug}" not found`);
  await mutate(async () => {
    await repo.checkout('main');
    await repo.removePath(`manuals/${slug}`);
    await repo.commitAll(`manuals: delete ${slug}`);
  });
}

/**
 * Assemble a manual: one chapter per selected module, using the latest
 * Released doc version of the manual's type (customer / technician / …),
 * or — flagged — its latest draft when nothing is released yet. A module
 * without that manual type is a missing chapter.
 */
export async function compileManual(slug) {
  const manual = await getManual(slug);
  if (!manual) return null;
  const type = manualTypeOf(manual.manual).id;
  manual.manual = type;
  const { modules } = await collectAll();
  const chapters = [];
  for (const mslug of manual.modules) {
    const entry = modules.find((m) => m.module.slug === mslug);
    if (!entry) {
      chapters.push({ slug: mslug, missing: true });
      continue;
    }
    const typed = docsOfType(entry.docs, type);
    const doc = typed.find((d) => d.status === 'released') || typed[0] || null;
    if (!doc) {
      chapters.push({ slug: mslug, module: entry.module, missing: true, reason: `no ${MANUAL_TYPES[type].label.toLowerCase()}` });
      continue;
    }
    const content = (await repo.show(doc.ref, contentIn(doc.dir))) || '';
    const checklist = doc.fat ? await readJson(doc.ref, checklistIn(doc.dir)) : null;
    chapters.push({
      slug: mslug,
      module: entry.module,
      doc,
      generated: generatedSections(entry.module, doc),
      content,
      checklist,
      isDraft: doc.status !== 'released',
    });
  }
  return { manual, chapters };
}

/* ------------------------------------------------------------------ */
/* Branding: logo (settings/logo.*) and manual covers (manuals/x/cover.*) */
/* ------------------------------------------------------------------ */

const IMAGE_EXT = /\.(png|jpe?g|svg|webp|gif)$/i;

async function findSingleton(dir, base) {
  const files = await repo.lsFiles('main', dir);
  return files.find((f) => new RegExp(`^${dir}/${base}\\.(png|jpe?g|svg|webp|gif)$`, 'i').test(f)) || null;
}

async function readSingleton(dir, base) {
  const key = `__${dir}/${base}`;
  if (assetCache.has(key)) return assetCache.get(key);
  const file = await findSingleton(dir, base);
  if (!file) return null;
  const buffer = await repo.showBinary('main', file);
  const result = buffer && buffer.length ? { name: file.split('/').pop(), buffer } : null;
  if (result) assetCache.set(key, result);
  return result;
}

async function saveSingleton(dir, base, name, buffer, message) {
  const ext = (String(name).match(IMAGE_EXT) || [])[0];
  if (!ext) throw new Error('Image must be png, jpg, svg, webp or gif');
  const existing = await findSingleton(dir, base);
  const target = `${dir}/${base}${ext.toLowerCase()}`;
  await mutate(async () => {
    await repo.checkout('main');
    if (existing && existing !== target) await repo.removePath(existing);
    await repo.writeFile(target, buffer);
    await repo.commitAll(message);
  });
  return { name: target.split('/').pop() };
}

/* Illustration style exemplars: finished house-style drawings that are sent
   to the image model together with every photo (settings/illustration-style/). */
const STYLE_DIR = 'settings/illustration-style';
export const styleExemplarUrl = (name) => `/api/settings/illustration-style/exemplars/${encodeURIComponent(name)}`;

export async function listStyleExemplars() {
  const files = await repo.lsFiles('main', STYLE_DIR);
  return files
    .filter((f) => IMAGE_EXT.test(f))
    .map((f) => f.split('/').pop())
    .sort()
    .map((name) => ({ name, url: styleExemplarUrl(name) }));
}

export async function getStyleExemplar(name) {
  const clean = sanitizeAssetName(name);
  const key = `__${STYLE_DIR}/${clean}`;
  if (assetCache.has(key)) return assetCache.get(key);
  const buffer = await repo.showBinary('main', `${STYLE_DIR}/${clean}`);
  const result = buffer && buffer.length ? { name: clean, buffer } : null;
  if (result) assetCache.set(key, result);
  return result;
}

/** All exemplars with their bytes, in list order. */
export async function readStyleExemplars() {
  const out = [];
  for (const e of await listStyleExemplars()) {
    const f = await getStyleExemplar(e.name);
    if (f) out.push(f);
  }
  return out;
}

export async function saveStyleExemplars(files) {
  const saved = [];
  await mutate(async () => {
    await repo.checkout('main');
    for (const f of files) {
      const name = sanitizeAssetName(f.name);
      if (!IMAGE_EXT.test(name)) throw new Error(`${f.name}: exemplars must be png, jpg, webp or gif`);
      await repo.writeFile(`${STYLE_DIR}/${name}`, f.buffer);
      saved.push(name);
    }
    await repo.commitAll(`settings: add illustration style exemplar${saved.length > 1 ? 's' : ''} ${saved.join(', ')}`);
  });
  return saved.map((name) => ({ name, url: styleExemplarUrl(name) }));
}

export async function deleteStyleExemplar(name) {
  const clean = sanitizeAssetName(name);
  const files = await repo.lsFiles('main', STYLE_DIR);
  if (!files.includes(`${STYLE_DIR}/${clean}`)) throw new Error(`Exemplar "${clean}" not found`);
  await mutate(async () => {
    await repo.checkout('main');
    await repo.removePath(`${STYLE_DIR}/${clean}`);
    await repo.commitAll(`settings: remove illustration style exemplar ${clean}`);
  });
}

export const getBrandLogo = () => readSingleton('settings', 'logo');
export const saveBrandLogo = (name, buffer) => saveSingleton('settings', 'logo', name, buffer, 'settings: update logo');
export const getManualCover = (slug) => readSingleton(`manuals/${slug}`, 'cover');
export const saveManualCover = (slug, name, buffer) =>
  saveSingleton(`manuals/${slug}`, 'cover', name, buffer, `manuals: ${slug} cover image`);

/* ------------------------------------------------------------------ */
/* Module metadata edits                                               */
/* ------------------------------------------------------------------ */

/** Update module.json fields. Written identically on main (when the module is
 *  released there) and on every open draft branch — each manual type has its own
 *  branch, and identical changes on both sides keep every later merge clean. */
export async function updateModule(slug, patch) {
  const { modules } = await collectAll();
  const entry = modules.find((m) => m.module.slug === slug);
  if (!entry) throw new Error(`Module "${slug}" not found`);
  const onMain = !!(await readJson('main', moduleFile(slug)));
  const refs = [...(onMain ? ['main'] : []), ...entry.docs.filter((d) => isOpen(d) && d.branch).map((d) => d.branch)];
  if (!refs.length) throw new Error('Module has no draft branch and is not released — nothing to write to');
  const { hardwareItems, ...module } = entry.module;
  for (const k of ['name', 'code', 'category', 'group', 'softwares']) {
    if (patch[k] !== undefined) module[k] = patch[k];
  }
  const { hardware: catalog } = await collectAll();
  let hw = { ids: null, items: hardwareItems, newItems: [] };
  if (patch.hardware !== undefined || patch.hardwareIds !== undefined) {
    hw = resolveHardwareInput(patch, catalog, module.name);
    module.hardwareIds = hw.ids;
    delete module.hardware; // legacy inline relation replaced by catalog links
  }
  await mutate(async () => {
    await commitNewHardware(catalog, hw.newItems);
    for (const ref of refs) {
      await repo.checkout(ref);
      await repo.writeFile(moduleFile(slug), JSON.stringify(module, null, 2) + '\n');
      await repo.commitAll(`${slug}: update module metadata`);
    }
    await repo.checkout('main');
  });
  return { ...module, hardwareItems: hw.items };
}
