import path from 'node:path';
import { createHash } from 'node:crypto';
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
  MODULE_TYPES,
  manualTypeOf,
  docKey,
  manualDocCode,
  parseDocKey,
  LANGUAGES,
  DEFAULT_LANG,
  langOf,
} from './docgen.js';
import { normalizeChecklist } from './checklist.js';
import { validateAsset, isImageName } from './images.js';
import { expandDocuments } from './extract.js';
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
/** Translation of the body: content.<lang>.html next to the English content.html. */
const contentLangIn = (dir, lang) => (langOf(lang) === DEFAULT_LANG ? contentIn(dir) : `${dir}/content.${langOf(lang)}.html`);
const contentHash = (html) => createHash('sha1').update(String(html || '')).digest('hex').slice(0, 12);
const checklistIn = (dir) => `${dir}/checklist.json`;
/** Review comments of a doc version: {threads: [...]} next to doc.json on the draft branch. */
const commentsIn = (dir) => `${dir}/comments.json`;
const VERSION_RE = /^A\d+\.\d+$/;
const LEGACY_DOC_RE = /^modules\/([^/]+)\/docs\/(A\d+\.\d+)\/doc\.json$/;
const TYPED_DOC_RE = /^modules\/([^/]+)\/docs\/([a-z][a-z-]*)\/(A\d+\.\d+)\/doc\.json$/;
const isOpen = (d) => d.status === 'draft' || d.status === 'in-review';
/** A released version being hotfixed edits like a draft: same version, next revision, own branch. */
const isEditable = (d) => isOpen(d) || !!d.hotfix;
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
      for (const ref of d.refs) {
        wanted.push({ ref, file: docJson(d.dir) });
        if (ref !== 'main') wanted.push({ ref, file: commentsIn(d.dir) }); // open review threads live on draft branches
      }
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
      if (chosen) {
        const threads = chosenRef !== 'main' ? get(chosenRef, commentsIn(d.dir))?.threads || [] : [];
        docs.push({ ...chosen, manual: d.manual, key, dir: d.dir, ref: chosenRef, docCode: manualDocCode(module, d.manual), openComments: threads.filter((c) => c.status === 'open').length });
      }
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
  if (doc.hotfix) return `${doc.version} hotfix r${doc.revision}`;
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

/** Orange dot: some manual type has a manual-affecting software release its open doc version
 *  has never been reviewed against, and no draft/in-review doc of that type exists yet. */
function needsDoc(module, docs, softwareFeed) {
  return uncoveredReleases(module, docs, softwareFeed).some((u) => !docsOfType(docs, u.manual).some(isOpen));
}

/** Manual-affecting releases the module's manuals have not been checked against: each manual type
 *  documents a software from one version onwards, so a breaking release is not "uncovered" but
 *  unreviewed — it either still applies (confirm it) or needs the next doc version.
 *  Entries: { manual, name, version } — the shape the modules list and the Software page read. */
function uncoveredReleases(module, docs, softwareFeed) {
  const out = [];
  for (const sw of softwareCoverage(module, docs, softwareFeed)) {
    for (const row of sw.manuals) {
      if (row.needsReviewAgainst) out.push({ manual: row.manual, name: sw.name, version: row.needsReviewAgainst });
    }
  }
  return out;
}

/**
 * How the module's manuals sit against each linked software's releases — the timeline behind the
 * Software versions tab.
 *
 * A manual type documents a software as a **chain** of doc versions: each version starts at the
 * release named in its `covers[].from` and documents everything after it until the next version of
 * that manual type takes over, so the newest version is always open ("→ latest"). A version is
 * closed by its successor's start, never by hand.
 *
 * Returns one entry per linked software:
 *   { name, fromVersion, registered, releases: [asc], manuals: [{ manual, key, version, status, hotfix,
 *     revision, from, to, open, closedBy, reviewedTo, needsReviewAgainst }] }
 */
function softwareCoverage(module, docs, softwareFeed) {
  return (module.softwares || []).map((sw) => {
    const releases = [...(softwareFeed[sw.name] || [])].sort((a, b) => compareSwVersions(a.version, b.version));
    const newest = releases.length ? releases[releases.length - 1].version : sw.fromVersion || '';
    const earliest = releases.length ? releases[0].version : sw.fromVersion || '';
    const manuals = [];

    for (const manual of manualTypesOf(docs)) {
      // Oldest doc version first: the chain reads left to right, like the releases.
      const chain = docsOfType(docs, manual)
        .filter((d) => d.status !== 'superseded' || (d.covers || []).some((c) => c.name === sw.name))
        .map((d) => {
          const cov = (d.covers || []).find((c) => c.name === sw.name) || {};
          return { doc: d, cov, from: cov.from || sw.fromVersion || earliest };
        })
        .sort((a, b) => compareDocVersions(a.doc.version, b.doc.version));

      chain.forEach((link, i) => {
        // The next version that actually starts later takes over from this one.
        const successor = chain.slice(i + 1).find((n) => compareSwVersions(n.from, link.from) > 0);
        const open = !successor;
        // Last release this version documents: the newest one before its successor starts.
        const upTo = successor
          ? [...releases].reverse().find((r) => compareSwVersions(r.version, successor.from) < 0)?.version || link.from
          : null;
        // Everything up to `reviewedTo` has been seen by an author (doc created, released, or
        // confirmed by hand); `to` on a doc written before open ranges counts as reviewed.
        const reviewedTo = [link.cov.reviewedTo, link.cov.to, link.from].filter(Boolean).sort(compareSwVersions).pop();
        const needsReviewAgainst = open
          ? [...releases]
              .reverse()
              .find((r) => r.manualAffecting && compareSwVersions(r.version, reviewedTo) > 0)?.version || null
          : null;
        manuals.push({
          manual,
          key: link.doc.key,
          version: link.doc.version,
          status: link.doc.status,
          hotfix: !!link.doc.hotfix,
          revision: link.doc.revision,
          from: link.from,
          to: upTo,
          open,
          closedBy: successor ? successor.from : null,
          reviewedTo,
          needsReviewAgainst,
        });
      });
    }

    return {
      name: sw.name,
      fromVersion: sw.fromVersion || '',
      registered: !!softwareFeed[sw.name],
      newest,
      releases,
      manuals,
    };
  });
}

/** Fold a release into a covers list: a new row starting there, or the confirmation that the
 *  version documents it too (`reviewedTo`). Ranges close by succession, so `to` is never set here. */
function addCover(covers, swName, swVersion) {
  const cov = covers.find((c) => c.name === swName);
  if (!cov) {
    covers.push({ name: swName, from: swVersion, reviewedTo: swVersion });
  } else {
    if (!cov.from || compareSwVersions(swVersion, cov.from) < 0) cov.from = swVersion;
    if (compareSwVersions(swVersion, cov.reviewedTo || cov.from) > 0) cov.reviewedTo = swVersion;
  }
  return covers;
}

/**
 * Start a covers list for a doc version taking over the chain. Per linked software the new
 * version starts at, in order: the release that asked for it (`start`), the module's link start
 * (`fromLinkStart`, the very first version of a manual), the oldest manual-affecting release the
 * version before it was never reviewed against (`after`: name → reviewedTo) — that release is why
 * a new version is being written — else the newest release there is.
 */
function coversFrom(module, feed, { start = null, fromLinkStart = false, after = {} } = {}) {
  return (module.softwares || []).map((s) => {
    const releases = [...(feed[s.name] || [])].sort((a, b) => compareSwVersions(a.version, b.version));
    const newest = releases.length ? releases[releases.length - 1].version : '';
    const seen = after[s.name];
    const breaking = seen ? releases.find((r) => r.manualAffecting && compareSwVersions(r.version, seen) > 0) : null;
    const from =
      (start && start.name === s.name && start.version) ||
      (fromLinkStart && s.fromVersion) ||
      breaking?.version ||
      newest ||
      s.fromVersion ||
      '';
    return { name: s.name, from, reviewedTo: newest || from };
  });
}

export async function getSoftwareFeed() {
  if (feedCache) return feedCache;
  feedCache = (await readJson('main', 'softwares.json')) || {};
  return feedCache;
}

const notRegistered = (name) => new Error(`Software "${name}" not found — create it on the Software page first`);

/**
 * A software manual relates to a software and its versions: every link a module carries must name a
 * software created on the Software page (the release feed), and its from-version must be one of that
 * software's registered releases (empty only while the software has no release yet). Links that were
 * already there unchanged (`prev`) are not re-judged, so editing a module's other metadata never fails
 * on a link made before this rule.
 */
async function assertSoftwareLinks(softwares, prev = []) {
  const feed = await getSoftwareFeed();
  for (const s of softwares || []) {
    const name = cleanSwName(s?.name);
    if (!name) throw new Error('Software name is required');
    const from = String(s.fromVersion || '').trim();
    if ((prev || []).some((p) => p.name === name && String(p.fromVersion || '').trim() === from)) continue;
    const releases = feed[name];
    if (!releases) throw notRegistered(name);
    if (from && !releases.some((r) => r.version === from)) {
      throw new Error(
        `${name} ${from} is not a registered release${releases.length ? ` — one of ${releases.map((r) => r.version).join(', ')}` : ''}; register it on the Software page first`
      );
    }
  }
}

/** A software named after its module (the modal's "no software selected" path) is created on the
 *  Software page like any other — with no release yet. Returns true when it was added. */
export async function ensureSoftware(name) {
  name = cleanSwName(name);
  if (!name) throw new Error('Software name is required');
  const feed = await getSoftwareFeed();
  if (feed[name]) return false;
  feed[name] = [];
  await mutate(async () => {
    await repo.checkout('main');
    await repo.writeFile('softwares.json', JSON.stringify(feed, null, 2) + '\n');
    await repo.commitAll(`softwares: add ${name} (named after its module)`);
  });
  return true;
}

/**
 * Repair: a software linked under a name that was never created on the Software page (data from
 * before the rule above) is merged into a registered one. Every module link and every doc's covered
 * range is renamed; a from-version that is not a release of the target is cleared. The target's
 * releases are untouched — register the versions the docs cover afterwards.
 */
export async function mergeSoftware(oldName, newName) {
  oldName = cleanSwName(oldName);
  newName = cleanSwName(newName);
  if (!oldName || !newName) throw new Error('Software name and the software to merge into are required');
  if (oldName === newName) throw new Error('Pick a different software to merge into');
  const feed = await getSoftwareFeed();
  if (!feed[newName]) throw notRegistered(newName);
  if (feed[oldName]) throw new Error(`"${oldName}" is a registered software — delete it (delete_software) or unlink it from modules instead of merging`);
  const { modules } = await collectAll();
  const linked = modules.filter(({ module }) => (module.softwares || []).some((s) => s.name === oldName));
  if (!linked.length) throw new Error(`No module links "${oldName}"`);
  // "1.0" and "v1.0" are the same release — keep the from-version spelled as the target registers it
  const matchRelease = (v) => (v ? feed[newName].find((r) => compareSwVersions(r.version, v) === 0)?.version || '' : '');
  const renamed = [];
  await mutate(async () => {
    for (const { module, docs } of linked) {
      const slug = module.slug;
      const { hardwareItems, ...m } = module;
      const kept = (m.softwares || []).filter((s) => s.name !== oldName);
      if (!kept.some((s) => s.name === newName)) {
        const old = m.softwares.find((s) => s.name === oldName);
        kept.push({ ...old, name: newName, fromVersion: matchRelease(old.fromVersion) });
      }
      m.softwares = kept;
      const onMain = !!(await readJson('main', moduleFile(slug)));
      const refs = [...(onMain ? ['main'] : []), ...docs.filter((d) => isOpen(d) && d.branch).map((d) => d.branch)];
      for (const ref of refs) {
        await repo.checkout(ref);
        await repo.writeFile(moduleFile(slug), JSON.stringify(m, null, 2) + '\n');
        // the docs living on this ref: open drafts on their branch, released ones on main
        for (const d of docs) {
          if (d.ref !== ref) continue;
          const dj = await readJson(ref, docJson(d.dir));
          if (!dj || !(dj.covers || []).some((c) => c.name === oldName)) continue;
          dj.covers = dj.covers.map((c) => (c.name === oldName ? { ...c, name: newName } : c));
          await repo.writeFile(docJson(d.dir), JSON.stringify(dj, null, 2) + '\n');
        }
        await repo.commitAll(`${slug}: software ${oldName} → ${newName}`);
      }
      renamed.push(slug);
    }
    await repo.checkout('main');
  });
  return { from: oldName, to: newName, modules: renamed };
}

/**
 * Software-centric view for the Software page and MCP: one row per software name known
 * from module links or the release feed — the modules linked to it, their software manuals
 * (software-customer / software-technician) and the releases with the docs covering each.
 */
export async function listSoftware() {
  const { modules } = await collectAll();
  const feed = await getSoftwareFeed();
  const names = new Set(Object.keys(feed));
  for (const { module } of modules) for (const s of module.softwares || []) if (s?.name) names.add(s.name);
  const SW_TYPES = MANUAL_ORDER.filter((t) => MANUAL_TYPES[t].kind === 'software');
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const linked = modules.filter(({ module }) => (module.softwares || []).some((s) => s.name === name));
      const rows = linked.map(({ module, docs }) => {
        const link = module.softwares.find((s) => s.name === name);
        const summary = manualsSummary(docs);
        const manuals = {};
        for (const t of SW_TYPES) if (summary[t]) manuals[t] = summary[t];
        return {
          slug: module.slug,
          name: module.name,
          code: module.code || null,
          type: module.type || null, // own-software = the software's own manual (no hardware)
          fromVersion: link.fromVersion || '',
          softwareCount: (module.softwares || []).length,
          manuals,
          allManuals: Object.keys(summary),
          docs: docs
            .filter((d) => SW_TYPES.includes(d.manual))
            .map((d) => ({ key: d.key, manual: d.manual, version: d.version, revision: d.revision, status: d.status, branch: d.branch, covers: d.covers || [], updatedAt: d.updatedAt })),
          uncovered: uncoveredReleases(module, docs, feed).filter((u) => u.name === name),
        };
      });
      const releases = (feed[name] || []).map((rel) => ({
        ...rel,
        coveredBy: linked.flatMap(({ module, docs }) =>
          docs
            .filter((d) => (d.covers || []).some((c) => c.name === name && versionCovered(rel.version, c)))
            .map((d) => ({ slug: module.slug, key: d.key, manual: d.manual, version: d.version, status: d.status }))
        ),
      }));
      // The same timeline the module tab draws, with every linked module’s manuals on it: each row
      // carries the module it belongs to so the page can label and link it.
      const coverage = {
        name,
        registered: !!feed[name],
        fromVersion: rows.map((r) => r.fromVersion).filter(Boolean).sort(compareSwVersions)[0] || '',
        releases: [...(feed[name] || [])].sort((a, b) => compareSwVersions(a.version, b.version)),
        manuals: linked.flatMap(({ module, docs }) =>
          (softwareCoverage(module, docs, feed).find((c) => c.name === name)?.manuals || []).map((row) => ({
            ...row,
            slug: module.slug,
            moduleName: module.name,
          }))
        ),
      };
      return {
        name,
        registered: !!feed[name], // false: known from module links only (made before software had to be created here)
        modules: rows,
        releases,
        coverage,
        manualCount: rows.reduce((n, r) => n + Object.keys(r.manuals).length, 0),
        uncoveredCount: rows.reduce((n, r) => n + r.uncovered.length, 0),
      };
    });
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
      hardware: module.hardwareItems,
      hardwareLabel: hardwareLabel(module),
      softwares: module.softwares || [],
      softwareLabel: softwareLabel(module.softwares),
      manuals,
      type: module.type || null,
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
    coverage: softwareCoverage(entry.module, entry.docs, feed),
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

/**
 * Language status of a doc: for every non-source language whether a translation exists,
 * what it is based on and whether the English body changed since (`stale`).
 * enHash is the hash of the current English body.
 */
function languageStatus(doc, enHash) {
  const out = {};
  for (const code of Object.keys(LANGUAGES)) {
    if (code === DEFAULT_LANG) {
      out[code] = { code, exists: true, source: true, stale: false };
      continue;
    }
    const m = (doc.languages || {})[code];
    out[code] = m
      ? { code, exists: true, source: false, ...m, stale: !!m.basedOnHash && m.basedOnHash !== enHash }
      : { code, exists: false, source: false, stale: false };
  }
  return out;
}

/**
 * Read a doc version. `lang` selects the body: English (source) or a translation —
 * `content` is '' when that translation does not exist yet (see `languages[lang].exists`).
 * Generated sections 1–3 come out in the requested language.
 */
export async function getDoc(slug, key, { lang = DEFAULT_LANG } = {}) {
  lang = langOf(lang);
  const hit = await findDoc(slug, key);
  if (!hit) return null;
  const { entry, doc } = hit;
  const enContent = (await repo.show(doc.ref, contentIn(doc.dir))) || '';
  const content = lang === DEFAULT_LANG ? enContent : (await repo.show(doc.ref, contentLangIn(doc.dir, lang))) || '';
  const checklist = doc.fat ? await readJson(doc.ref, checklistIn(doc.dir)) : null;
  return {
    module: entry.module,
    doc,
    lang,
    languages: languageStatus(doc, contentHash(enContent)),
    content,
    generated: generatedSections(entry.module, doc, lang),
    checklist,
  };
}

/**
 * Store a translation of a Draft/In-review doc body (from the AI or pasted by hand) and
 * record what English revision/body it was made from, so later English edits mark it stale.
 */
export async function saveTranslation(slug, key, lang, html, { source = 'ai', summary = '' } = {}) {
  lang = langOf(lang);
  if (lang === DEFAULT_LANG) throw new Error('English is the source language — edit it as content');
  const { branch, dir, meta } = await loadDraftDoc(slug, key);
  if (!isEditable(meta)) throw new Error(`Doc ${meta.version} is ${meta.status} — not editable`);
  const enContent = (await repo.show(branch, contentIn(dir))) || '';
  const ts = now();
  meta.languages = meta.languages || {};
  meta.languages[lang] = {
    translatedAt: ts,
    source,
    basedOnRevision: meta.revision,
    basedOnHash: contentHash(enContent),
    updatedAt: ts,
  };
  meta.revision += 1;
  const text = summary || `${LANGUAGES[lang].label} translation${source === 'ai' ? ' (AI)' : ''}`;
  meta.revisionRecord.push({ rev: `r${meta.revision}`, date: ts, summary: text });
  meta.updatedAt = ts;
  await mutate(async () => {
    await repo.checkout(branch);
    await repo.writeFile(contentLangIn(dir, lang), html);
    await repo.writeFile(docJson(dir), JSON.stringify(meta, null, 2) + '\n');
    await repo.commitAll(`${slug} ${meta.version}: r${meta.revision} — ${text}`);
    await repo.checkout('main');
  });
  return meta;
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
async function writeFirstDoc(module, spec, moduleOnMain, feed = {}) {
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
    covers: coversFrom(module, feed, { fromLinkStart: true }),
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
  await assertSoftwareLinks(input.softwares); // a manual relates to a software created on the Software page
  const feed = await getSoftwareFeed();
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
    type: input.type || null, // own-module | third-party-kit | own-software | module-software
    hardwareIds: hw.ids,
    softwares: input.softwares || [],
    createdAt: created,
  };

  const docs = [];
  await mutate(async () => {
    await commitNewHardware(catalog, hw.newItems); // the catalog lives on main; the branches are cut after it
    for (const spec of manuals) docs.push(await writeFirstDoc(module, spec, false, feed));
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
    doc = await writeFirstDoc(module, spec, onMain, await getSoftwareFeed());
  });
  return { slug, ...doc };
}

/**
 * Create the next doc version of one manual type, on its own draft branch, starting from its
 * latest released content. It takes over the coverage chain from the version before it: from
 * `fromRelease` ({name, version}) when a manual-affecting release asks for a new version, else
 * from each linked software's newest release. The version before it is closed at that point —
 * nothing is written on it, the chain derives it (see softwareCoverage).
 */
export async function createNextDocVersion(slug, manual = DEFAULT_MANUAL, bump = 'minor', { fromRelease = null } = {}) {
  const entry = await moduleOf(slug);
  if (!entry) throw new Error('Module not found');
  const type = manualTypeOf(manual);
  const typed = docsOfType(entry.docs, type.id);
  if (!typed.length) throw new Error(`This module has no ${type.label.toLowerCase()} yet — create one first`);
  if (typed.some(isOpen)) {
    throw new Error(`A ${type.label.toLowerCase()} draft already exists — release or discard it first`);
  }
  const hotfixed = typed.find((d) => d.hotfix);
  if (hotfixed) {
    throw new Error(
      `${type.label} ${hotfixed.version} is being hotfixed — publish or discard the hotfix before starting a new version`
    );
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
  // Translations travel with the content: the new version starts with the same English body, so
  // their basedOnHash still matches and they are not stale until English is edited again.
  const translations = [];
  for (const code of Object.keys(latest.languages || {})) {
    const html = await repo.show('main', contentLangIn(latest.dir, code));
    if (html) translations.push({ code, html });
  }
  // The new version documents each software from where it takes over, onwards: the release that
  // asked for it, else the breaking release the version before it never answered.
  const feed = await getSoftwareFeed();
  const after = Object.fromEntries(
    softwareCoverage(entry.module, entry.docs, feed).map((sw) => [
      sw.name,
      sw.manuals.filter((r) => r.manual === type.id).pop()?.reviewedTo || '',
    ])
  );
  const covers = coversFrom(entry.module, feed, { start: fromRelease, after });
  const coversLabel = covers.filter((c) => c.from).map((c) => `${c.name} ${c.from}+`).join(', ');
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
    languages: Object.fromEntries(translations.map((t) => [t.code, { ...latest.languages[t.code], basedOnRevision: 1 }])),
  };

  await mutate(async () => {
    await repo.checkout('main');
    await repo.createBranch(branch, 'main');
    await repo.writeFile(docJson(dir), JSON.stringify(doc, null, 2) + '\n');
    await repo.writeFile(contentIn(dir), content);
    for (const t of translations) await repo.writeFile(contentLangIn(dir, t.code), t.html);
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
export async function saveDraftContent(slug, key, html, { bump = false, summary = '', lang = DEFAULT_LANG } = {}) {
  lang = langOf(lang);
  const { branch, dir, meta } = await loadDraftDoc(slug, key);
  if (!isEditable(meta)) throw new Error(`Doc ${meta.version} is ${meta.status} — not editable`);
  const version = meta.version;
  const ts = now();
  const tag = lang === DEFAULT_LANG ? '' : ` (${LANGUAGES[lang].short})`;
  if (bump) {
    meta.revision += 1;
    meta.revisionRecord.push({ rev: `r${meta.revision}`, date: ts, summary: (summary || 'Content update') + tag });
  }
  meta.updatedAt = ts;
  if (lang !== DEFAULT_LANG) {
    // A hand-edited translation: keep what it was based on (staleness still tracks English edits).
    meta.languages = meta.languages || {};
    const prev = meta.languages[lang];
    meta.languages[lang] = prev
      ? { ...prev, updatedAt: ts, edited: true }
      : { translatedAt: ts, source: 'manual', basedOnRevision: meta.revision, basedOnHash: contentHash((await repo.show(branch, contentIn(dir))) || ''), updatedAt: ts };
  }

  await mutate(async () => {
    await repo.checkout(branch);
    await repo.writeFile(contentLangIn(dir, lang), html);
    await repo.writeFile(docJson(dir), JSON.stringify(meta, null, 2) + '\n');
    await repo.commitAll(
      bump ? `${slug} ${version}: r${meta.revision} — ${summary || 'content update'}${tag}` : `${slug} ${version}: autosave${tag}`
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
  if (!isEditable(meta)) throw new Error(`Doc ${meta.version} is ${meta.status} — not editable`);
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

/* ------------------------------------------------------------------ */
/* Review comments                                                     */
/* Viewers select text in a draft and comment on it; the author        */
/* resolves, replies, or has the AI propose the change. Threads are    */
/* committed on the draft branch (no revision bump) and merge to main  */
/* with the release as the review record of that version.              */
/* ------------------------------------------------------------------ */

const commentId = () => `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const cleanText = (s, max = 4000) => String(s ?? '').trim().slice(0, max);

async function readThreads(ref, dir) {
  return (await readJson(ref, commentsIn(dir)))?.threads || [];
}

/** All review threads of a doc version (any status), open first, newest first. */
export async function listComments(slug, key) {
  const hit = await findDoc(slug, key);
  if (!hit) return null;
  const threads = await readThreads(hit.doc.ref, hit.doc.dir);
  threads.sort((a, b) => (a.status === b.status ? b.createdAt.localeCompare(a.createdAt) : a.status === 'open' ? -1 : 1));
  return { doc: hit.doc, threads };
}

async function writeThreads(slug, key, mutateThreads, message) {
  const { branch, dir, meta } = await loadDraftDoc(slug, key);
  if (!isEditable(meta)) throw new Error(`Doc ${meta.version} is ${meta.status} — comments are made on a Draft, In-review or hotfixed doc`);
  let result = null;
  await mutate(async () => {
    await repo.checkout(branch);
    const threads = await readThreads(branch, dir);
    result = mutateThreads(threads);
    await repo.writeFile(commentsIn(dir), JSON.stringify({ threads }, null, 2) + '\n');
    await repo.commitAll(`${slug} ${meta.version}: ${message(result)}`);
    await repo.checkout('main');
  });
  return result;
}

/**
 * Add a review thread. anchor: { quote (selected text), section (<h2> title it sits in),
 * before/after (a few chars of context to disambiguate), lang } — the quote is how the
 * comment is re-found in the document; it stays valid as long as the text does.
 */
export async function addComment(slug, key, { author, text, anchor = {} }) {
  const body = cleanText(text);
  if (!body) throw new Error('Comment text is required');
  const thread = {
    id: commentId(),
    status: 'open',
    author: cleanText(author, 80) || 'Reviewer',
    text: body,
    createdAt: now(),
    anchor: {
      quote: cleanText(anchor.quote, 600),
      section: cleanText(anchor.section, 200),
      before: cleanText(anchor.before, 80),
      after: cleanText(anchor.after, 80),
      lang: langOf(anchor.lang || DEFAULT_LANG),
    },
    replies: [],
  };
  return writeThreads(slug, key, (threads) => (threads.push(thread), thread), (c) => `comment by ${c.author}`);
}

export async function replyComment(slug, key, id, { author, text }) {
  const body = cleanText(text);
  if (!body) throw new Error('Reply text is required');
  return writeThreads(
    slug,
    key,
    (threads) => {
      const c = threads.find((x) => x.id === id);
      if (!c) throw new Error(`Comment ${id} not found`);
      c.replies.push({ id: commentId(), author: cleanText(author, 80) || 'Author', text: body, createdAt: now() });
      return c;
    },
    (c) => `reply on comment ${c.id}`
  );
}

/** Resolve or reopen a thread; `note` becomes a reply (e.g. "applied in r4"). */
export async function setCommentStatus(slug, key, id, status, { author, note, revision } = {}) {
  if (!['open', 'resolved'].includes(status)) throw new Error('status must be open or resolved');
  return writeThreads(
    slug,
    key,
    (threads) => {
      const c = threads.find((x) => x.id === id);
      if (!c) throw new Error(`Comment ${id} not found`);
      c.status = status;
      if (status === 'resolved') {
        c.resolvedAt = now();
        c.resolvedBy = cleanText(author, 80) || 'Author';
        if (revision) c.resolvedIn = `r${revision}`;
      } else {
        delete c.resolvedAt;
        delete c.resolvedBy;
        delete c.resolvedIn;
      }
      const n = cleanText(note);
      if (n) c.replies.push({ id: commentId(), author: cleanText(author, 80) || 'Author', text: n, createdAt: now() });
      return c;
    },
    (c) => `comment ${c.id} ${status}`
  );
}

export async function deleteComment(slug, key, id) {
  return writeThreads(
    slug,
    key,
    (threads) => {
      const i = threads.findIndex((x) => x.id === id);
      if (i < 0) throw new Error(`Comment ${id} not found`);
      const [c] = threads.splice(i, 1);
      return c;
    },
    (c) => `comment ${c.id} deleted`
  );
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
 *  supersede older released versions of the same manual type, delete the branch.
 *  On a hotfix branch it publishes the correction instead: same version, the revision it was
 *  edited to, nothing superseded. */
export async function releaseDoc(slug, key) {
  const { branch, dir, meta, manual } = await loadDraftDoc(slug, key);
  const entry = await moduleOf(slug);
  const feed = await getSoftwareFeed();
  const version = meta.version;
  const ts = now();
  if (meta.hotfix) return await publishHotfix({ slug, branch, dir, meta, manual, version, ts });

  await mutate(async () => {
    await repo.checkout('main');
    await repo.merge(branch, `Merge ${branch}: release ${slug} ${MANUAL_TYPES[manual].label.toLowerCase()} ${version}`);

    meta.status = 'released';
    meta.releasedAt = ts;
    meta.updatedAt = ts;
    meta.branch = null;
    // Releasing it is the author saying it documents every release out today.
    for (const cov of meta.covers || []) {
      const newest = [...(feed[cov.name] || [])].sort((a, b) => compareSwVersions(a.version, b.version)).pop();
      if (newest && compareSwVersions(newest.version, cov.reviewedTo || cov.from || '') > 0) cov.reviewedTo = newest.version;
    }
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

/** Merge a hotfix back into the version it corrects: main takes the corrected content at the new
 *  revision, the version stays Released, the branch goes. */
async function publishHotfix({ slug, branch, dir, meta, manual, version, ts }) {
  const rev = `r${meta.revision}`;
  const last = meta.revisionRecord[meta.revisionRecord.length - 1];
  if (last && last.rev === rev && last.summary === 'Hotfix (draft)') last.summary = 'Hotfix';
  meta.hotfix = null;
  meta.branch = null;
  meta.updatedAt = ts;
  await mutate(async () => {
    await repo.checkout('main');
    await repo.merge(branch, `Merge ${branch}: hotfix ${slug} ${MANUAL_TYPES[manual].label.toLowerCase()} ${version} ${rev}`);
    await repo.writeFile(docJson(dir), JSON.stringify(meta, null, 2) + '\n');
    await repo.commitAll(`${slug}: publish ${MANUAL_TYPES[manual].label.toLowerCase()} ${version} ${rev} (hotfix)`);
    await repo.deleteBranch(branch);
  });
  return meta;
}

/**
 * Hotfix a released version: reopen its draft branch off main so the same version can be corrected
 * in place (A1.0 r1 → r2) without a new version and without leaving the released manual — on main
 * the doc stays Released and compiles as before, so what readers get only changes when the hotfix is
 * published. One hotfix at a time, and none while a newer version of that manual type is open.
 */
export async function startHotfix(slug, key) {
  const hit = await findDoc(slug, key);
  if (!hit) throw new Error(`Doc ${slug} ${key} not found`);
  const { entry, doc } = hit;
  const type = manualTypeOf(doc.manual);
  if (doc.hotfix) throw new Error(`${doc.version} is already being hotfixed — edit or publish it`);
  if (doc.status !== 'released') {
    throw new Error(
      `${type.label} ${doc.version} is ${doc.status} — a hotfix corrects a released version` +
        (isOpen(doc) ? '; edit the draft instead' : '')
    );
  }
  const open = docsOfType(entry.docs, doc.manual).find(isOpen);
  if (open) throw new Error(`${type.label} ${open.version} is open (${open.status}) — finish it before hotfixing ${doc.version}`);
  const branch = docBranchName(slug, doc.manual, doc.version);
  if ((await repo.branches()).includes(branch)) throw new Error(`Branch ${branch} already exists`);
  const meta = await readJson('main', docJson(doc.dir));
  if (!meta) throw new Error('Doc version not found');
  const ts = now();
  meta.branch = branch;
  meta.revision += 1;
  meta.updatedAt = ts;
  meta.hotfix = { startedAt: ts, baseRevision: meta.revision - 1 };
  meta.revisionRecord.push({ rev: `r${meta.revision}`, date: ts, summary: 'Hotfix (draft)' });
  await mutate(async () => {
    await repo.checkout('main');
    await repo.createBranch(branch, 'main');
    await repo.writeFile(docJson(doc.dir), JSON.stringify(meta, null, 2) + '\n');
    await repo.commitAll(`${slug} ${doc.version}: start hotfix r${meta.revision}`);
    await repo.checkout('main');
  });
  return { slug, manual: doc.manual, key: doc.key, version: doc.version, revision: meta.revision, branch };
}

/** Discard a draft: delete its branch. A never-released module with no other draft disappears entirely.
 *  On a hotfix this drops the correction; the released version on main is untouched. */
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

/** Kind of an asset by name: a picture the manual embeds, a PDF, or an attachment — a file the
 *  reader downloads from the manual (ready-to-use configuration, firmware, spreadsheet…). */
export const assetKind = (name) => (isImageName(name) ? 'image' : /\.pdf$/i.test(String(name)) ? 'pdf' : 'attachment');

const ATTACHMENT_MAX = 25 * 1024 * 1024;

function validateAttachment(name, buffer) {
  if (!buffer || !buffer.length) throw new Error(`${name}: file is empty`);
  if (buffer.length > ATTACHMENT_MAX) throw new Error(`${name}: attachments are limited to 25 MB`);
  if (!/\.[a-z0-9]+$/i.test(sanitizeAssetName(name))) throw new Error(`${name}: an attachment needs a file extension`);
}

/** Commit files into the draft's assets folder. files: [{name, buffer}].
 *  attachments: true stores every file as it is (a zip or PDF stays a download instead of
 *  being expanded into its pictures) — the editor's paste / drop of non-image files. */
export async function saveAssets(slug, key, files, { attachments = false } = {}) {
  const { branch, meta: docMeta, manual } = await loadDraftDoc(slug, key);
  const version = docMeta.version;
  if (!files.length) throw new Error('No files to save');
  if (!attachments) {
    // Word / PowerPoint / PDF / zip → the pictures inside (a Word text sidecar is not an asset)
    files = (await expandDocuments(files)).filter((f) => !f.text);
    if (!files.length) throw new Error('No pictures to save');
  }
  // reject truncated / mislabelled files before anything is committed; non-image files are attachments
  for (const f of files) validateAsset(f.name, f.buffer) || validateAttachment(f.name, f.buffer);
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
      meta[name] = { addedIn: version, addedManual: manual, addedAt: ts, ...stamp, appliesTo: meta[name]?.appliesTo || [] };
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
export async function setAssetMeta(slug, key, name, { appliesTo, verify = false } = {}) {
  const { branch, meta: docMeta, manual } = await loadDraftDoc(slug, key);
  const version = docMeta.version;
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
    stamp = meta[base] || { addedIn: version, addedManual: manual, addedAt: ts, software: [], hardware: [], appliesTo: [] };
    const changes = [];
    if (appliesTo !== undefined) {
      stamp.appliesTo = [...new Set(appliesTo)];
      changes.push(stamp.appliesTo.length ? `applies to ${stamp.appliesTo.join(', ')}` : 'applies to all hardware');
    }
    if (verify) {
      Object.assign(stamp, currentStamp(module, feed), { verifiedIn: version, verifiedManual: manual, verifiedAt: ts });
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
    return { name: n, url: assetUrl(slug, n), kind: assetKind(n), meta: m, stale: assetStaleness(m, module, feed) };
  });
}

/* ------------------------------------------------------------------ */
/* Software release feed                                               */
/* ------------------------------------------------------------------ */

const cleanSwName = (name) => String(name || '').trim();

/**
 * Create a software: a new name in the release feed (softwares.json on main), optionally with
 * its first release and linked to modules right away. Software manuals of a module become
 * available once the module is linked to a software.
 * { name, version?, manualAffecting?, note?, modules?: [{slug, fromVersion?}], ownManual?: {} }
 * ownManual: the software also gets its OWN manual — an own-software module named after it
 * (see createOwnSoftwareModule), so an application without hardware is documented in the
 * same editor as everything else.
 */
export async function createSoftware({ name, version, manualAffecting, note, modules = [], ownManual = null }) {
  name = cleanSwName(name);
  if (!name) throw new Error('Software name is required');
  const feed = await getSoftwareFeed();
  if (feed[name]) throw new Error(`Software "${name}" already exists — register a release or link it to a module instead`);
  // A name only known from module links (data from before software had to be created here) is
  // created now — that is the repair for such links.
  if (ownManual) await assertNoModule(name); // fail before the feed is touched
  const releases = version ? [{ version: String(version).trim(), date: now(), manualAffecting: !!manualAffecting, note: note || '' }] : [];
  feed[name] = releases;
  await mutate(async () => {
    await repo.checkout('main');
    await repo.writeFile('softwares.json', JSON.stringify(feed, null, 2) + '\n');
    await repo.commitAll(`softwares: add ${name}${version ? ` ${version}` : ''}`);
  });
  const links = [];
  for (const m of modules || []) {
    if (!m || !m.slug) continue;
    links.push(await linkSoftware(m.slug, name, m.fromVersion || version || ''));
  }
  const ownModule = ownManual ? await createOwnSoftwareModule(name, { ...ownManual, fromVersion: version || '' }) : null;
  return { name, releases, modules: links, ownModule };
}

/**
 * What stands where a software's own-manual module would go. A module of that name written as an
 * own manual, not currently documenting another software, is the same thing under a lost link —
 * `adopt` says so, and the own-manual paths link it back instead of refusing (that is how a module
 * whose software was deleted, or detached, finds its way home). Anything else is someone's module.
 */
async function ownModuleInTheWay(name) {
  const slug = slugify(name);
  if (!slug) throw new Error('Software name is required');
  // Whole-repo view: a module never released lives only on its draft branches.
  const entry = (await collectAll()).modules.find((m) => m.module.slug === slug);
  if (!entry) return null;
  const softwares = entry.module.softwares || [];
  const adopt = entry.module.type === 'own-software' && (!softwares.length || softwares.some((s) => s.name === name));
  return { slug, existing: entry.module, adopt };
}

/** Refuse when a module of that name is in the way and is not this software’s own manual. */
async function assertNoModule(name) {
  const hit = await ownModuleInTheWay(name);
  if (!hit || hit.adopt) return hit;
  throw new Error(`A module "${hit.slug}" already exists (${hit.existing.name}) — link the software to it on the Software page instead`);
}

/**
 * A software's OWN manual: an own-software module named after the software, linked to it,
 * with blank drafts of the software customer + technician manuals. Everything else (editor,
 * revisions, review, releases, translations, assembled manuals) is the module machinery.
 * { fromVersion?, startSummary? } → createModuleDoc result.
 */
export async function createOwnSoftwareModule(name, { fromVersion = '', startSummary } = {}) {
  name = cleanSwName(name);
  if (!name) throw new Error('Software name is required');
  const feed = await getSoftwareFeed();
  if (!feed[name]) throw notRegistered(name);
  const inTheWay = await assertNoModule(name);
  if (!fromVersion) fromVersion = feed[name].at(-1)?.version || '';
  if (inTheWay?.adopt) {
    // Its manuals are already written — the software just lost its link to them.
    const linked = await linkSoftware(inTheWay.slug, name, fromVersion);
    const entry = await moduleOf(inTheWay.slug);
    const docs = entry.docs.filter((d) => MANUAL_TYPES[d.manual].kind === 'software');
    return {
      slug: inTheWay.slug,
      adopted: true,
      softwares: linked.softwares,
      docs: docs.map((d) => ({ manual: d.manual, key: d.key, version: d.version, status: d.status })),
      key: docs[0]?.key || null,
    };
  }
  // The manual covers the software from the given version (defaulted above to its newest release).
  const softwares = [{ name, fromVersion: String(fromVersion || '').trim() }];
  const input = { name, code: null, category: 'software', type: 'own-software', hardware: [], softwares };
  const specs = MODULE_TYPES['own-software'].manuals.map((manual) => ({
    manual,
    content: blankContent(name, [], manual, softwares),
    checklist: null,
    startSummary: startSummary || `Own manual of the ${name} software`,
  }));
  return await createModuleDoc(input, specs);
}

/** Link a software to a module (appends to module.softwares; updates from-version when already linked).
 *  Written like any metadata edit: on main and on every open draft branch. */
export async function linkSoftware(slug, name, fromVersion = '') {
  name = cleanSwName(name);
  if (!name) throw new Error('Software name is required');
  const entry = await moduleOf(slug);
  if (!entry) throw new Error(`Module "${slug}" not found`);
  const softwares = (entry.module.softwares || []).map((s) => ({ ...s }));
  const existing = softwares.find((s) => s.name === name);
  if (existing) existing.fromVersion = String(fromVersion || existing.fromVersion || '').trim();
  else softwares.push({ name, fromVersion: String(fromVersion || '').trim() });
  const updated = await updateModule(slug, { softwares });
  return { slug, name: entry.module.name, softwares: updated.softwares, linked: !existing };
}

/** Remove a software link from a module. Its docs keep their covered ranges. */
/** Unlink a software from a module. `force` is for deleteSoftware, which is removing the software
 *  itself and has already dealt with the manuals — everywhere else a module's software manuals
 *  must keep something to document. */
export async function unlinkSoftware(slug, name, { force = false } = {}) {
  name = cleanSwName(name);
  const entry = await moduleOf(slug);
  if (!entry) throw new Error(`Module "${slug}" not found`);
  if (!(entry.module.softwares || []).some((s) => s.name === name)) throw new Error(`${name} is not linked to ${slug}`);
  const swDocs = entry.docs.filter((d) => MANUAL_TYPES[d.manual].kind === 'software');
  if (!force && swDocs.length && (entry.module.softwares || []).length === 1) {
    throw new Error(
      `${entry.module.name} keeps ${swDocs.map((d) => d.key).join(', ')} and ${name} is its only software — a software manual has to relate to a software version. Link the module to another software first, or delete the manual.`
    );
  }
  const updated = await updateModule(slug, { softwares: entry.module.softwares.filter((s) => s.name !== name) });
  return { slug, name: entry.module.name, softwares: updated.softwares };
}

/**
 * Delete a software: unlink it from every module and drop it, with its releases, from the feed
 * (softwares.json on main). Existing docs keep their covered ranges as history. A software
 * manual draft cannot outlive its module's only software relation, so open software manual
 * drafts on such modules are **released** first (their work is kept, not discarded).
 */
export async function deleteSoftware(name) {
  name = cleanSwName(name);
  if (!name) throw new Error('Software name is required');
  const feed = await getSoftwareFeed();
  const linked = (await collectAll()).modules.filter(({ module }) => (module.softwares || []).some((s) => s.name === name));
  if (!feed[name] && !linked.length) throw new Error(`Software "${name}" not found`);
  const released = [];
  for (const { module, docs } of linked) {
    if ((module.softwares || []).length !== 1) continue;
    for (const d of docs.filter((d) => isOpen(d) && MANUAL_TYPES[d.manual].kind === 'software')) {
      await releaseDoc(module.slug, d.key);
      released.push(`${module.slug} ${d.key}`);
    }
  }
  const unlinked = [];
  for (const { module } of linked) {
    await unlinkSoftware(module.slug, name, { force: true });
    unlinked.push(module.slug);
  }
  const releases = (feed[name] || []).length;
  if (feed[name]) {
    await mutate(async () => {
      const fresh = (await readJson('main', 'softwares.json')) || {};
      delete fresh[name];
      await repo.checkout('main');
      await repo.writeFile('softwares.json', JSON.stringify(fresh, null, 2) + '\n');
      await repo.commitAll(`softwares: delete ${name}${unlinked.length ? ` (unlinked from ${unlinked.join(', ')})` : ''}`);
    });
  }
  return { name, unlinked, released, releases };
}

/** Register a new version (release) of a software in the feed. */
export async function registerSoftwareRelease({ name, version, manualAffecting, note }) {
  name = cleanSwName(name);
  version = String(version || '').trim();
  if (!name || !version) throw new Error('Software name and version are required');
  const feed = await getSoftwareFeed();
  const releases = feed[name];
  if (!releases) throw notRegistered(name);
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

/**
 * Delete one release from the feed (a version registered by mistake, or a build that never
 * shipped). A release a manual is anchored to is refused rather than silently rewriting the
 * manuals: a module link starting at it would stop naming a registered release, and a doc
 * version starting at it would lose the point its coverage runs from. Released manuals keep
 * their history either way — `reviewedTo` is only a comparison point, so it survives.
 */
export async function deleteSoftwareRelease(name, version) {
  name = cleanSwName(name);
  version = String(version || '').trim();
  if (!name || !version) throw new Error('Software name and version are required');
  const feed = await getSoftwareFeed();
  const releases = feed[name];
  if (!releases) throw notRegistered(name);
  if (!releases.some((r) => r.version === version)) {
    throw new Error(`${name} ${version} is not a registered release${releases.length ? ` — one of ${releases.map((r) => r.version).join(', ')}` : ''}`);
  }
  const { modules } = await collectAll();
  // Only modules still linked to the software: a detached one keeps its covers as history, and
  // history is not a reason to refuse.
  const linked = modules.filter(({ module }) => (module.softwares || []).some((s) => s.name === name));
  const links = linked.filter(({ module }) => module.softwares.some((s) => s.name === name && s.fromVersion === version));
  if (links.length) {
    throw new Error(
      `${name} ${version} is where ${links.map((m) => m.module.name).join(', ')} ${links.length > 1 ? 'link' : 'links'} to the software — point the link at another release first`
    );
  }
  const anchored = linked.flatMap(({ module, docs }) =>
    docs
      .filter((d) => (d.covers || []).some((c) => c.name === name && c.from === version))
      .map((d) => `${module.name} ${MANUAL_TYPES[d.manual].short} ${d.version}`)
  );
  if (anchored.length) {
    throw new Error(`${name} ${version} is where ${anchored.join(', ')} ${anchored.length > 1 ? 'start' : 'starts'} — delete or re-version those manuals first`);
  }
  feed[name] = releases.filter((r) => r.version !== version);
  await mutate(async () => {
    await repo.checkout('main');
    await repo.writeFile('softwares.json', JSON.stringify(feed, null, 2) + '\n');
    await repo.commitAll(`softwares: delete ${name} ${version}`);
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

/** An assembled manual is built from a customer or a technician manual — the software manual of the
 *  same audience joins as its own chapter, so it is never the type of the document itself. */
function assemblyTypeOf(id) {
  const t = manualTypeOf(id);
  if (t.kind !== 'hardware') {
    throw new Error(
      `A manual is assembled from a customer or technician manual, not from ${t.label.toLowerCase()} — each module's software manual of the same audience is compiled as its own chapter`
    );
  }
  return t;
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
    manual: assemblyTypeOf(type).id, // which manual type of each module is compiled
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
  if (patch.manual !== undefined) manual.manual = assemblyTypeOf(patch.manual).id;
  if (patch.modules !== undefined) manual.modules = patch.modules;
  manual.updatedAt = now();
  await mutate(async () => {
    await repo.checkout('main');
    await repo.writeFile(manualFile(slug), JSON.stringify(manual, null, 2) + '\n');
    await repo.commitAll(`manuals: update ${slug}`);
  });
  return manual;
}

/**
 * Delete a module: every draft branch of its docs, its folder on main (module.json, docs,
 * assets) and its chapter in every assembled manual. The hardware catalog and the software
 * release feed are untouched. Irreversible from the API — the commits remain in git history.
 */
export async function deleteModule(slug) {
  const entry = await moduleOf(slug);
  if (!entry) throw new Error(`Module "${slug}" not found`);
  const branches = [...new Set(entry.docs.map((d) => d.branch).filter(Boolean))];
  const onMain = !!(await readJson('main', moduleFile(slug)));
  const inManuals = (await listManuals()).filter((m) => (m.modules || []).includes(slug));
  await mutate(async () => {
    await repo.checkout('main');
    const existing = await repo.branches();
    for (const b of branches) if (existing.includes(b)) await repo.deleteBranch(b);
    if (onMain) await repo.removePath(`modules/${slug}`);
    for (const m of inManuals) {
      const manual = { ...m, modules: m.modules.filter((s) => s !== slug), updatedAt: now() };
      await repo.writeFile(manualFile(m.slug), JSON.stringify(manual, null, 2) + '\n');
    }
    if (onMain || inManuals.length) {
      await repo.commitAll(`modules: delete ${slug}${inManuals.length ? ` (removed from ${inManuals.map((m) => m.slug).join(', ')})` : ''}`);
    }
  });
  return { slug, name: entry.module.name, docs: entry.docs.length, branchesDeleted: branches, manualsUpdated: inManuals.map((m) => m.slug) };
}

/* ------------------------------------------------------------------ */
/* Manual import from a simulator configuration file                    */
/* ------------------------------------------------------------------ */

/** The sections of a configuration file and the manual group each one produces. */
export const CONFIG_SECTIONS = [
  { key: 'simulator', group: 'SIM', defaultName: 'Simulator Manual' },
  { key: 'ios', group: 'IOS', defaultName: 'IOS Manual' },
];

/**
 * Resolve one module reference from a configuration file. A reference is a module slug,
 * a module name, or an object carrying either — whatever the configuring system happens
 * to export. Returns the slug, or null when nothing matches.
 */
function resolveModuleRef(ref, modules) {
  const raw = typeof ref === 'string' ? ref : ref && (ref.slug || ref.module || ref.name);
  const key = String(raw ?? '').trim();
  if (!key) return null;
  const lower = key.toLowerCase();
  const bySlug = modules.find((m) => m.slug.toLowerCase() === lower);
  if (bySlug) return bySlug.slug;
  const byName = modules.find((m) => m.name.toLowerCase() === lower);
  if (byName) return byName.slug;
  const slugged = slugify(key);
  const bySlugged = modules.find((m) => m.slug === slugged);
  return bySlugged ? bySlugged.slug : null;
}

/**
 * Plan the manuals a configuration file asks for, without writing anything. Returns one
 * entry per section present in the config, each with its resolved module slugs, the
 * modules it could not resolve, and whether a manual with that slug already exists.
 */
export async function planManualImport(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('The configuration must be a JSON object');
  }
  const present = CONFIG_SECTIONS.filter((s) => config[s.key] !== undefined && config[s.key] !== null);
  if (!present.length) {
    throw new Error(`The configuration has no "${CONFIG_SECTIONS.map((s) => s.key).join('" or "')}" section`);
  }
  const modules = await listModules();
  const defaultType = manualTypeOf(config.manual).id;
  const prefix = String(config.name || config.simulatorName || '').trim();

  return present.map((section) => {
    const raw = config[section.key];
    const body = Array.isArray(raw) ? { modules: raw } : raw;
    if (typeof body !== 'object') throw new Error(`Section "${section.key}" must be an object or an array of modules`);
    const refs = Array.isArray(body.modules) ? body.modules : [];
    const resolved = [];
    const unknown = [];
    for (const ref of refs) {
      const slug = resolveModuleRef(ref, modules);
      if (!slug) unknown.push(typeof ref === 'string' ? ref : JSON.stringify(ref));
      else if (!resolved.includes(slug)) resolved.push(slug);
    }
    const name =
      String(body.name || '').trim() || (prefix ? `${prefix} — ${section.defaultName}` : section.defaultName);
    return {
      section: section.key,
      name,
      slug: slugify(name),
      code: String(body.code || '').trim().toUpperCase() || null,
      group: section.group,
      manual: manualTypeOf(body.manual === undefined ? defaultType : body.manual).id,
      modules: resolved,
      unknownModules: unknown,
    };
  });
}

/**
 * Create (or, with replace, update) one manual per section of a simulator configuration
 * file. Everything is validated first: a config naming a module that does not exist, or
 * an existing manual when replace is off, is rejected before any manual is written.
 */
export async function importManuals(config, { replace = false } = {}) {
  const plan = await planManualImport(config);

  const badRefs = plan.filter((p) => p.unknownModules.length);
  if (badRefs.length) {
    const detail = badRefs.map((p) => `${p.section}: ${p.unknownModules.join(', ')}`).join('; ');
    throw new Error(`The configuration names modules that do not exist — ${detail}. Create them first, or remove them from the file.`);
  }
  const empty = plan.filter((p) => !p.modules.length);
  if (empty.length === plan.length) throw new Error('The configuration lists no modules');
  if (!plan.every((p) => p.slug)) throw new Error('Every section needs a manual name');

  const existing = await listManuals();
  const clashes = plan.filter((p) => existing.some((m) => m.slug === p.slug));
  if (clashes.length && !replace) {
    throw new Error(
      `These manuals already exist: ${clashes.map((p) => p.slug).join(', ')}. Import again with "replace" to overwrite their chapters.`
    );
  }

  const results = [];
  for (const p of plan) {
    const spec = { name: p.name, code: p.code, group: p.group, manual: p.manual, modules: p.modules };
    const wasThere = existing.some((m) => m.slug === p.slug);
    const manual = wasThere ? await updateManual(p.slug, spec) : await createManual(spec);
    results.push({ ...manual, section: p.section, action: wasThere ? 'updated' : 'created' });
  }
  return { manuals: results };
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
 * without that manual type is a missing chapter. A module that also has a
 * RELEASED software manual of the same audience (customer → software-customer,
 * technician → software-technician) contributes a second chapter right after
 * its hardware one, titled after the linked software.
 */
export async function compileManual(slug, { lang = DEFAULT_LANG } = {}) {
  lang = langOf(lang);
  const manual = await getManual(slug);
  if (!manual) return null;
  const type = manualTypeOf(manual.manual).id;
  manual.manual = type;
  const swType = { customer: 'software-customer', technician: 'software-technician' }[type] || null;
  const { modules } = await collectAll();
  const chapters = [];
  const chapterOf = async (entry, doc, extra = {}) => {
    // An unpublished hotfix lives on a branch; the manual keeps compiling the released copy on main.
    const ref = doc.hotfix ? 'main' : doc.ref;
    // Translation when the manual is compiled in another language; English (flagged) when there is none.
    let content = lang === DEFAULT_LANG ? null : await repo.show(ref, contentLangIn(doc.dir, lang));
    const langFallback = lang !== DEFAULT_LANG && !content;
    if (!content) content = (await repo.show(ref, contentIn(doc.dir))) || '';
    const checklist = doc.fat ? await readJson(ref, checklistIn(doc.dir)) : null;
    return {
      slug: entry.module.slug,
      module: entry.module,
      doc,
      // An assembled manual has one consolidated revision record in chapter 1, so the
      // per-chapter history is dropped — the chapter states only the version in effect.
      generated: generatedSections(entry.module, doc, lang, { revisionHistory: false }),
      content,
      checklist,
      isDraft: doc.status !== 'released',
      langFallback,
      ...extra,
    };
  };
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
    chapters.push(await chapterOf(entry, doc));
    // released software manual of the same audience → additional chapter
    const swDoc = swType ? docsOfType(entry.docs, swType).find((d) => d.status === 'released') : null;
    if (swDoc) {
      const swNames = (entry.module.softwares || []).map((s) => s.name).join(' · ');
      chapters.push(await chapterOf(entry, swDoc, { slug: `${mslug}--software`, title: swNames || `${entry.module.name} — software`, software: true }));
    }
  }
  return { manual, chapters, lang };
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
  for (const k of ['name', 'code', 'category', 'softwares']) {
    if (patch[k] !== undefined) module[k] = patch[k];
  }
  if (patch.softwares !== undefined) await assertSoftwareLinks(module.softwares, entry.module.softwares);
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
