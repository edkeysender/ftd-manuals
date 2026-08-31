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
const docFile = (slug, version) => `modules/${slug}/docs/${version}/doc.json`;
const contentFile = (slug, version) => `modules/${slug}/docs/${version}/content.html`;
const checklistFile = (slug, version) => `modules/${slug}/docs/${version}/checklist.json`;
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

  // slug -> { moduleRefs: Set, docs: Map(version -> Set(refs)) }
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
      m = /^modules\/([^/]+)\/docs\/([^/]+)\/doc\.json$/.exec(f);
      if (m) {
        const [, slug, version] = m;
        if (!found.has(slug)) found.set(slug, { moduleRefs: new Set(), docs: new Map() });
        const docs = found.get(slug).docs;
        if (!docs.has(version)) docs.set(version, new Set());
        docs.get(version).add(ref);
      }
    }
  }

  // Every module.json and doc.json we might need, fetched in one git process.
  const wanted = [];
  for (const [slug, info] of found) {
    const moduleRef = info.moduleRefs.has('main') ? 'main' : [...info.moduleRefs][0];
    wanted.push({ ref: moduleRef, file: moduleFile(slug) });
    for (const [version, refsSet] of info.docs) {
      for (const ref of refsSet) wanted.push({ ref, file: docFile(slug, version) });
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
    for (const [version, refsSet] of info.docs) {
      let chosen = null;
      let chosenRef = null;
      for (const ref of refsSet) {
        if (ref === 'main') continue;
        const meta = get(ref, docFile(slug, version));
        if (meta && meta.branch === ref) {
          chosen = meta;
          chosenRef = ref;
          break;
        }
      }
      if (!chosen && refsSet.has('main')) {
        chosen = get('main', docFile(slug, version));
        chosenRef = 'main';
      }
      if (!chosen) {
        const ref = [...refsSet][0];
        chosen = get(ref, docFile(slug, version));
        chosenRef = ref;
      }
      if (chosen) docs.push({ ...chosen, ref: chosenRef });
    }
    docs.sort((a, b) => compareDocVersions(b.version, a.version));
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
  if (doc.status === 'draft' || doc.status === 'in-review') return `${doc.version} draft r${doc.revision}`;
  return doc.version;
}

function moduleStatus(docs) {
  if (docs.length === 0) return 'missing';
  const latest = docs[0];
  if (latest.status === 'draft') return 'draft';
  if (latest.status === 'in-review') return 'in-review';
  if (latest.status === 'released') return 'released';
  return latest.status;
}

/** Orange dot: a linked software has a manual-affecting release not covered by
 *  any doc version, and no draft/in-review doc exists yet. */
function needsDoc(module, docs, softwareFeed) {
  if (!module.softwares || module.softwares.length === 0) return false;
  const hasOpenDraft = docs.some((d) => d.status === 'draft' || d.status === 'in-review');
  if (hasOpenDraft) return false;
  for (const sw of module.softwares) {
    const releases = softwareFeed[sw.name] || [];
    for (const rel of releases) {
      if (!rel.manualAffecting) continue;
      if (sw.fromVersion && compareSwVersions(rel.version, sw.fromVersion) < 0) continue;
      const covered = docs.some((d) => (d.covers || []).some((c) => c.name === sw.name && versionCovered(rel.version, c)));
      if (!covered) return true;
    }
  }
  return false;
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
    const latest = docs[0] || null;
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
      latestDoc: latestDocLabel(latest),
      status: moduleStatus(docs),
      updated,
      needsDoc: needsDoc(module, docs, feed),
      fat: !!(latest && latest.fat),
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
    status: moduleStatus(entry.docs),
    needsDoc: needsDoc(entry.module, entry.docs, feed),
    history: history.slice(0, 50),
    softwareFeed: Object.fromEntries(
      (entry.module.softwares || []).map((s) => [s.name, feed[s.name] || []])
    ),
  };
}

export async function getDoc(slug, version) {
  const { modules } = await collectAll();
  const entry = modules.find((m) => m.module.slug === slug);
  if (!entry) return null;
  const doc = entry.docs.find((d) => d.version === version);
  if (!doc) return null;
  const content = (await repo.show(doc.ref, contentFile(slug, version))) || '';
  const checklist = doc.fat ? await readJson(doc.ref, checklistFile(slug, version)) : null;
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
 * Create a new module with its first doc draft A1.0 r1 on branch draft/<slug>-a1.0.
 * `content` is the starting sections 4–7 HTML (from blank template, copy or AI).
 */
export async function createModuleDoc(input, content, revisionRecordSeed) {
  const slug = slugify(input.name);
  if (!slug) throw new Error('Module name is required');
  const existing = await readJson('main', moduleFile(slug));
  const branches = await repo.branches();
  if (existing || branches.some((b) => b.startsWith(`draft/${slug}-`))) {
    throw new Error(`A module with slug "${slug}" already exists`);
  }

  const version = 'A1.0';
  const branch = docBranchName(slug, version);
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

  const doc = {
    version,
    revision: 1,
    status: 'draft',
    branch,
    createdAt: created,
    updatedAt: created,
    releasedAt: null,
    covers: (module.softwares || []).map((s) => ({ name: s.name, from: s.fromVersion, to: s.fromVersion })),
    revisionRecord: [
      ...(revisionRecordSeed || []),
      { rev: 'r1', date: created, summary: input.startSummary || 'Initial draft' },
    ],
    copiedFrom: input.copiedFrom || null,
    fat: false,
  };
  const checklist = input.checklist ? normalizeChecklist(input.checklist) : null;
  doc.fat = !!checklist;

  await mutate(async () => {
    await commitNewHardware(catalog, hw.newItems); // the catalog lives on main; the branch is cut after it
    await repo.checkout('main');
    await repo.createBranch(branch, 'main');
    await repo.writeFile(moduleFile(slug), JSON.stringify(module, null, 2) + '\n');
    await repo.writeFile(docFile(slug, version), JSON.stringify(doc, null, 2) + '\n');
    await repo.writeFile(contentFile(slug, version), content);
    if (checklist) await repo.writeFile(checklistFile(slug, version), JSON.stringify(checklist, null, 2) + '\n');
    await repo.commitAll(`${slug}: create doc ${version} r1 (draft)${checklist ? ' + FAT checklist' : ''}`);
    await repo.checkout('main');
  });

  return { slug, version, branch, fat: doc.fat, hardware: hw.items };
}

/** Create the next doc version for an existing module, starting from the latest released content. */
export async function createNextDocVersion(slug, bump = 'minor') {
  const { modules } = await collectAll();
  const entry = modules.find((m) => m.module.slug === slug);
  if (!entry) throw new Error('Module not found');
  if (entry.docs.some((d) => d.status === 'draft' || d.status === 'in-review')) {
    throw new Error('A draft already exists for this module — release or discard it first');
  }
  const latest = entry.docs[0];
  if (!latest) throw new Error('Module has no doc to start from');
  const pv = parseDocVersion(latest.version);
  const version = bump === 'major' ? `A${pv.major + 1}.0` : `A${pv.major}.${pv.minor + 1}`;
  const branch = docBranchName(slug, version);
  const created = now();

  const content = (await repo.show('main', contentFile(slug, latest.version))) || blankContent(entry.module.name);
  const checklist = latest.fat ? await repo.show('main', checklistFile(slug, latest.version)) : null;
  const doc = {
    version,
    revision: 1,
    status: 'draft',
    branch,
    createdAt: created,
    updatedAt: created,
    releasedAt: null,
    covers: [],
    revisionRecord: [
      ...latest.revisionRecord.map((r) => ({ ...r, inherited: true })),
      { rev: 'r1', date: created, summary: `Draft based on ${latest.version}` },
    ],
    copiedFrom: { slug, version: latest.version },
    fat: !!checklist,
  };

  await mutate(async () => {
    await repo.checkout('main');
    await repo.createBranch(branch, 'main');
    await repo.writeFile(docFile(slug, version), JSON.stringify(doc, null, 2) + '\n');
    await repo.writeFile(contentFile(slug, version), content);
    if (checklist) await repo.writeFile(checklistFile(slug, version), checklist);
    await repo.commitAll(`${slug}: create doc ${version} r1 (draft)`);
    await repo.checkout('main');
  });

  return { slug, version, branch, fat: doc.fat };
}

async function loadDraftDoc(slug, version) {
  const branch = docBranchName(slug, version);
  const branches = await repo.branches();
  if (!branches.includes(branch)) throw new Error(`No draft branch ${branch}`);
  const meta = await readJson(branch, docFile(slug, version));
  if (!meta) throw new Error('Draft doc not found');
  return { branch, meta };
}

/**
 * Save draft content. When `bump` is true the revision counter increments and
 * an entry is appended to the revision record (accepted change); otherwise it
 * is a plain autosave commit on the same revision.
 */
export async function saveDraftContent(slug, version, html, { bump = false, summary = '' } = {}) {
  const { branch, meta } = await loadDraftDoc(slug, version);
  if (meta.status !== 'draft' && meta.status !== 'in-review') {
    throw new Error(`Doc ${version} is ${meta.status} — not editable`);
  }
  const ts = now();
  if (bump) {
    meta.revision += 1;
    meta.revisionRecord.push({ rev: `r${meta.revision}`, date: ts, summary: summary || 'Content update' });
  }
  meta.updatedAt = ts;

  await mutate(async () => {
    await repo.checkout(branch);
    await repo.writeFile(contentFile(slug, version), html);
    await repo.writeFile(docFile(slug, version), JSON.stringify(meta, null, 2) + '\n');
    await repo.commitAll(
      bump ? `${slug} ${version}: r${meta.revision} — ${summary || 'content update'}` : `${slug} ${version}: autosave`
    );
    await repo.checkout('main');
  });
  return meta;
}

/** The FAT checklist of a doc version (any status): { module, doc, checklist|null }, or null if the doc does not exist. */
export async function getChecklist(slug, version) {
  const { modules } = await collectAll();
  const entry = modules.find((m) => m.module.slug === slug);
  const doc = entry && entry.docs.find((d) => d.version === version);
  if (!doc) return null;
  const checklist = doc.fat ? await readJson(doc.ref, checklistFile(slug, version)) : null;
  return { module: entry.module, doc, checklist };
}

/** Save (or remove, with null) the FAT checklist of a Draft/In-review doc; bumps the revision like a content edit. */
export async function saveChecklist(slug, version, checklist, { summary = '' } = {}) {
  const { branch, meta } = await loadDraftDoc(slug, version);
  if (meta.status !== 'draft' && meta.status !== 'in-review') {
    throw new Error(`Doc ${version} is ${meta.status} — not editable`);
  }
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
    if (normalized) await repo.writeFile(checklistFile(slug, version), JSON.stringify(normalized, null, 2) + '\n');
    else if (had) await repo.removePath(checklistFile(slug, version));
    await repo.writeFile(docFile(slug, version), JSON.stringify(meta, null, 2) + '\n');
    await repo.commitAll(`${slug} ${version}: r${meta.revision} — ${text}`);
    await repo.checkout('main');
  });
  return { doc: meta, checklist: normalized };
}

export async function setDocStatus(slug, version, status) {
  if (!['draft', 'in-review'].includes(status)) throw new Error('Invalid status transition');
  const { branch, meta } = await loadDraftDoc(slug, version);
  meta.status = status;
  meta.updatedAt = now();
  await mutate(async () => {
    await repo.checkout(branch);
    await repo.writeFile(docFile(slug, version), JSON.stringify(meta, null, 2) + '\n');
    await repo.commitAll(`${slug} ${version}: ${status === 'in-review' ? 'submit for review' : 'back to draft'}`);
    await repo.checkout('main');
  });
  return meta;
}

/** Release: merge the draft branch into main, freeze the revision counter,
 *  supersede older released versions, delete the branch. */
export async function releaseDoc(slug, version) {
  const { branch, meta } = await loadDraftDoc(slug, version);
  const ts = now();

  await mutate(async () => {
    await repo.checkout('main');
    await repo.merge(branch, `Merge ${branch}: release ${slug} ${version}`);

    meta.status = 'released';
    meta.releasedAt = ts;
    meta.updatedAt = ts;
    meta.branch = null;
    await repo.writeFile(docFile(slug, version), JSON.stringify(meta, null, 2) + '\n');

    // Supersede older released versions of the same module.
    const files = await repo.lsFiles('main', `modules/${slug}/docs`);
    for (const f of files) {
      const m = /^modules\/[^/]+\/docs\/([^/]+)\/doc\.json$/.exec(f);
      if (!m || m[1] === version) continue;
      const other = await readJson('main', f);
      if (other && other.status === 'released' && compareDocVersions(other.version, version) < 0) {
        other.status = 'superseded';
        other.updatedAt = ts;
        await repo.writeFile(f, JSON.stringify(other, null, 2) + '\n');
      }
    }

    await repo.commitAll(`${slug}: release ${version}`);
    await repo.deleteBranch(branch);
  });
  return meta;
}

/** Discard a draft: delete its branch. A never-released module disappears entirely. */
export async function discardDraft(slug, version) {
  const branch = docBranchName(slug, version);
  const branches = await repo.branches();
  if (!branches.includes(branch)) throw new Error(`No draft branch ${branch}`);
  await mutate(async () => {
    await repo.checkout('main');
    await repo.deleteBranch(branch);
  });
}

/* ------------------------------------------------------------------ */
/* Assets (images and other files in the module folder)                */
/* ------------------------------------------------------------------ */

const assetFile = (slug, name) => `modules/${slug}/assets/${name}`;

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
  const saved = [];
  await mutate(async () => {
    await repo.checkout(branch);
    for (const f of files) {
      const name = sanitizeAssetName(f.name);
      await repo.writeFile(assetFile(slug, name), f.buffer);
      saved.push(name);
    }
    await repo.commitAll(`${slug} ${version}: add asset${saved.length > 1 ? 's' : ''} ${saved.join(', ')}`);
    await repo.checkout('main');
  });
  return saved.map((n) => ({ name: n, url: assetUrl(slug, n) }));
}

/** Remove an asset from a draft's branch (git rm + commit). */
export async function deleteAsset(slug, version, name) {
  const { branch } = await loadDraftDoc(slug, version);
  const file = assetFile(slug, sanitizeAssetName(name));
  if (!(await repo.show(branch, file))) throw new Error(`Asset "${name}" not found on ${branch}`);
  await mutate(async () => {
    await repo.checkout(branch);
    await repo.removePath(file);
    await repo.commitAll(`${slug} ${version}: remove asset ${path.basename(file)}`);
    await repo.checkout('main');
  });
  return { name: path.basename(file), removed: true };
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

export async function listAssets(slug) {
  const branches = await repo.branches();
  const refs = [...branches.filter((b) => b.startsWith(`draft/${slug}-`)), 'main'];
  const names = new Set();
  for (const ref of refs) {
    for (const f of await repo.lsFiles(ref, `modules/${slug}/assets`)) {
      names.add(f.split('/').pop());
    }
  }
  return [...names].map((n) => ({ name: n, url: assetUrl(slug, n) }));
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

/** Extend a released doc's covered range to include a (non-manual-affecting) software release. */
export async function linkReleaseToDoc(slug, docVersion, swName, swVersion) {
  const file = docFile(slug, docVersion);
  const meta = await readJson('main', file);
  if (!meta) throw new Error('Doc version not found on main');
  if (meta.status !== 'released') throw new Error('Releases can only be linked to a Released doc version');
  const covers = meta.covers || [];
  let cov = covers.find((c) => c.name === swName);
  if (!cov) {
    cov = { name: swName, from: swVersion, to: swVersion };
    covers.push(cov);
  } else {
    if (compareSwVersions(swVersion, cov.from) < 0) cov.from = swVersion;
    if (compareSwVersions(swVersion, cov.to || cov.from) > 0) cov.to = swVersion;
  }
  meta.covers = covers;
  meta.updatedAt = now();
  await mutate(async () => {
    await repo.checkout('main');
    await repo.writeFile(file, JSON.stringify(meta, null, 2) + '\n');
    await repo.commitAll(`${slug} ${docVersion}: cover ${swName} ${swVersion}`);
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

export async function createManual({ name, code, group, modules }) {
  const slug = slugify(name);
  if (!slug) throw new Error('Manual name is required');
  if (await getManual(slug)) throw new Error(`A manual with slug "${slug}" already exists`);
  const ts = now();
  const manual = {
    slug,
    name,
    code: code || null,
    group: group || null,
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
 * Assemble a manual: one chapter per selected module, using its latest
 * Released doc version, or — flagged — its latest draft when nothing is
 * released yet.
 */
export async function compileManual(slug) {
  const manual = await getManual(slug);
  if (!manual) return null;
  const { modules } = await collectAll();
  const chapters = [];
  for (const mslug of manual.modules) {
    const entry = modules.find((m) => m.module.slug === mslug);
    if (!entry) {
      chapters.push({ slug: mslug, missing: true });
      continue;
    }
    const doc = entry.docs.find((d) => d.status === 'released') || entry.docs[0] || null;
    if (!doc) {
      chapters.push({ slug: mslug, module: entry.module, missing: true });
      continue;
    }
    const content = (await repo.show(doc.ref, contentFile(mslug, doc.version))) || '';
    const checklist = doc.fat ? await readJson(doc.ref, checklistFile(mslug, doc.version)) : null;
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

/** Update module.json fields. Written on the module's open draft branch when
 *  one exists (it reaches main at release), otherwise directly on main. */
export async function updateModule(slug, patch) {
  const { modules } = await collectAll();
  const entry = modules.find((m) => m.module.slug === slug);
  if (!entry) throw new Error(`Module "${slug}" not found`);
  const draft = entry.docs.find((d) => d.status === 'draft' || d.status === 'in-review');
  const ref = draft ? draft.branch : 'main';
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
    await repo.checkout(ref);
    await repo.writeFile(moduleFile(slug), JSON.stringify(module, null, 2) + '\n');
    await repo.commitAll(`${slug}: update module metadata`);
    await repo.checkout('main');
  });
  return { ...module, hardwareItems: hw.items };
}
