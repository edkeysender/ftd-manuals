# Schematics Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A module or an installation gets a versioned connection schematic that is built from
validated operations (over HTTP, MCP or the AI chat), rendered server-side to SVG, and printed into
the technician manuals, with a read-only web page and a chat drawer to drive it.

**Architecture:** The schematic is a JSON netlist (devices with typed ports, cables, locations,
external ports) kept in the git store next to the owner's other files, drafted on a `draft/…-schematic-…`
branch and released by merge to `main` like a doc. A pure applier (`server/schematic.js`) validates
and applies operation lists; a lifecycle module (`server/schematics-store.js`) wraps it in the store's
lock and branches; a renderer (`server/schematic-render.js`) lays the netlist out with elkjs and emits
SVG; routes, MCP tools and the chat all funnel into the same operations. The manual build asks a
registered provider for the released schematic of a module, so `store.js` never imports the new module.

**Tech Stack:** Node 22 ESM, Express, `node:test`, elkjs (layout, used server-side), React 18 + Vite,
OpenAI chat completions through the existing `callOpenAI`.

**Spec:** `docs/superpowers/specs/2026-10-16-schematics-design.md` (Phase 1 = spec section 11, step 1;
the canvas is Phase 2 and has its own plan).

## Global Constraints

- Every store mutation runs inside `GitRepo.lock()` (`mutate()` in `store.js`) and leaves the working
  tree checked out on `main`.
- Never read or write `data/` by hand; every change is a commit.
- Draft branches: `draft/<slug>-schematic-a<maj>.<min>` for a module, `draft/inst/<slug>-schematic-a<maj>.<min>`
  for an installation. One open draft per owner.
- Only a **released** module schematic feeds an installation block; only a **released** installation
  compiles into an assembled manual. `releaseSchematic` requires a non-empty `note`.
- The AI never emits coordinates; it emits operations. Pending operations are validated with
  `dryRun` and written only when the user accepts.
- Every user-visible web string goes through `t()` with a Polish entry in `web/src/i18n.pl.js`;
  every printed string has `en` and `pl` entries in `STRINGS` in `server/docgen.js`.
- Technician audience only: a schematic never prints in a customer manual.
- New dependency allowed in Phase 1: `elkjs` (EPL-2.0, used as a library, no modification). Nothing else.
- Branch for the work: `console/schematics` (already exists, holds the spec). Never push to `main`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Deviations from the spec (decided while planning, spec amended in the same commit)

- Schematic files are `modules/<slug>/schematic.json` and `installations/<slug>/schematic.json`
  (one file per owner, versioned by branch and `version`/`revision` fields), not a `schematic/` folder.
  Installation metadata (name, device, serial number, operator) lives in
  `installations/<slug>/installation.json` on `main`, like `manual.json`; the schematic is the versioned part.
- The lifecycle is a dedicated module (`server/schematics-store.js`) built on `repo` and `mutate`,
  not branches inside `releaseDoc` / `setDocStatus` / `loadDraftDoc`, which assume `content.html`,
  `MANUAL_TYPES` and `doc.json` folders. The user-facing promises (draft branch, review, release note,
  hotfix, discard, next version) are the same.
- MCP gets dedicated tools (`get_schematic`, `apply_schematic_ops`, `release_schematic`, …) instead of
  teaching `resolveDocKey` a `schematic` manual type.
- The assembled manual's wiring chapter draws the whole installation and filters only the cable schedule
  to the manual's chapters (spec §9 asked for a filtered drawing too); and the chat tells the user when a
  device is not in the library instead of proposing a `create_device_template` to accept (spec §6).
  Both are deferred to Phase 2 with the canvas.

## Review Focus

1. **An operation list that is half valid** (e.g. `add_device` ok, then `connect` to an unknown port):
   nothing may be written; the error names the op index. Test in Task 3 (`applyOps` is atomic).
2. **A block whose module releases a newer schematic that drops an external port the installation
   uses**: the installation must flag the block *outdated* and validation must report the dangling
   cable as an error, never silently print it. Test in Task 3 (`validateSchematic` with a stale pin)
   and Task 5 (`getSchematic` marks `outdatedBlocks`).
3. **A device template deleted while schematics still use it**: refuse the delete and name the owners.
   Test in Task 4.
4. **Chat reply that is not JSON or carries unknown op names**: the route returns the reply text and an
   empty `ops` list with a note, never a 500. Test in Task 7 (`parseOps`).
5. **A manual compiled while the installation it links is a draft or has no schematic**: the manual
   compiles without the wiring chapter and `state.blockers` says why. Test in Task 9.

---

## File structure

| File | Responsibility |
| --- | --- |
| `server/library.js` (new) | Pure: default connectors / cables / seed templates, normalisation, `cableKindsFor` |
| `server/schematic.js` (new) | Pure: empty records, `applyOps`, `validateSchematic`, `cableSchedule`, `connectorFace` |
| `server/schematics-store.js` (new) | Git-backed: library files, installations, schematic lifecycle, promotion, provider registration |
| `server/schematic-render.js` (new) | elkjs layout + SVG, port list and cable schedule HTML |
| `server/schematic-ai.js` (new) | Prompt builder, `parseOps`, `schematicChat` with injectable model call |
| `server/schematic-routes.js` (new) | `registerSchematicRoutes(app, {wrap, auth})` |
| `server/store.js` (modify) | export `mutate`, `readJson`; `setSchematicProvider`; `installation` on manuals; wiring chapter + cover overlay in `compileManual`; schematic in `getDoc` |
| `server/docgen.js` (modify) | `STRINGS` entries, `generatedSections` Connections block, `kindBadge` for the wiring chapter, CSS for inline SVG figures |
| `server/ai.js` (modify) | export `callOpenAI` as `callModel` |
| `server/mcp.js` (modify) | schematic tools |
| `server/index.js` (modify) | import routes + schematics-store |
| `web/src/api.js`, `App.jsx`, `i18n.pl.js` (modify) | API helpers, routes, nav, strings |
| `web/src/components/SchematicPanel.jsx` (new) | Status header, SVG preview, validation, schedule, chat drawer with pending ops |
| `web/src/components/LibraryCard.jsx` (new) | Settings card: connectors JSON, device templates, promote |
| `web/src/pages/InstallationsList.jsx`, `InstallationDetail.jsx` (new) | Installations pages |
| `web/src/pages/ModuleDetail.jsx`, `ManualView.jsx`, `Settings.jsx` (modify) | Schematic tab, installation select, library card |
| `tools/smoke.mjs` (modify) | end-to-end schematic scenario |
| `CLAUDE.md`, `README.md` (modify) | document the feature |
| `server/*.test.js` (new) | `node:test` unit and store tests |

---

### Task 1: Test runner and spec amendment

**Files:**
- Modify: `package.json` (scripts)
- Modify: `docs/superpowers/specs/2026-10-16-schematics-design.md` (sections 3.2, 3.3, 4, 5)
- Create: `server/sanity.test.js`

**Interfaces:**
- Produces: `npm test` runs every `server/**/*.test.js` with `node --test`.

- [ ] **Step 1: Add the test script**

In `package.json` `scripts`, add after `"smoke"`:

```json
    "test": "node --test \"server/**/*.test.js\"",
```

- [ ] **Step 2: Write a sanity test so the runner has something to find**

`server/sanity.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

test('the test runner finds files under server/', () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 3: Run it**

Run: `npm test`
Expected: `# pass 1`, exit code 0.

- [ ] **Step 4: Amend the spec to the planned file layout and lifecycle**

In the spec, replace the first line of section 3.2 with:

```
Stored at `modules/<slug>/schematic.json`, one per module, versioned (section 4). Shape:
```

Replace the first line of section 3.3 with:

```
Stored at `installations/<slug>/schematic.json` (the versioned netlist, same lifecycle as a module
schematic) next to `installations/<slug>/installation.json` on `main` (`slug`, `name`, `device`,
`serialNumber`, `operator`, `createdAt`, `updatedAt`), a new top-level owner kind:
```

Replace the second bullet of section 4 ("Lifecycle reuses `setDocStatus`…") with:

```
- Lifecycle lives in `server/schematics-store.js` (`createSchematic`, `applySchematicOps`,
  `setSchematicStatus`, `releaseSchematic` with a required note, `setSchematicReleaseNote`,
  `startSchematicHotfix`, `discardSchematic`, `nextSchematicVersion`), built on the store's `repo`
  and `mutate`. The record keeps `revisions[]` and `releaseRecord[]` shaped like a doc's so the
  revision record prints the same way. The doc functions in `store.js` are untouched.
```

In section 5, replace the MCP paragraph with:

```
MCP tools (`slug` = module slug, installation slug or `inst:<slug>`; a module wins a tie):
`get_schematic`, `create_schematic`, `apply_schematic_ops`, `submit_schematic_for_review`,
`schematic_back_to_draft`, `release_schematic`, `set_schematic_release_note`,
`start_schematic_hotfix`, `discard_schematic`, `render_schematic` (PNG image content),
`list_installations`, `create_installation`, `list_device_templates`, `create_device_template`,
`update_device_template`, `promote_device_to_module`.
```

- [ ] **Step 5: Commit**

```bash
git add package.json server/sanity.test.js docs/superpowers/specs/2026-10-16-schematics-design.md
git commit -m "Schematics: test runner and spec amendments for phase 1

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Device library (pure)

**Files:**
- Create: `server/library.js`
- Test: `server/library.test.js`

**Interfaces:**
- Produces:
  - `DEFAULT_LIBRARY = { connectors: [...], cables: [...], devices: [...] }`
  - `normalizeLibrary(raw) → { connectors, cables, devices }` (fills defaults for missing parts)
  - `normalizeTemplate(spec, takenIds = new Set()) → template` (throws on bad input)
  - `cableKindsFor(library, connectorA, connectorB) → string[]` (cable kind ids, unordered pair)
  - `templateFor(library, id) → template | null`
  - `templateIdFor(name, takenIds) → string`
  - `CATEGORIES = ['switch','router','pc','audio-interface','power-strip','headset','display','panel','other']`
  - `SYMBOLS = ['box','switch','pc','power-strip','headset','display']`
  - `PORT_DIRECTIONS = ['in','out','bidir']`, `PORT_SIDES = ['left','right','top','bottom']`

- [ ] **Step 1: Write the failing tests**

`server/library.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIBRARY, normalizeLibrary, normalizeTemplate, cableKindsFor, templateFor, templateIdFor } from './library.js';

test('default library has the connectors and cable kinds the spec lists', () => {
  const ids = DEFAULT_LIBRARY.connectors.map((c) => c.id);
  for (const id of ['rj45', 'usb-a', 'usb-b', 'usb-c', 'iec-c13', 'iec-c14', 'schuko', 'trs-6.35', 'xlr-m', 'xlr-f', 'hdmi', 'dp', 'db9']) {
    assert.ok(ids.includes(id), `connector ${id}`);
  }
  assert.deepEqual(DEFAULT_LIBRARY.cables.map((c) => c.id).sort(), ['audio', 'ethernet', 'power', 'serial', 'usb', 'video']);
  assert.ok(DEFAULT_LIBRARY.devices.some((d) => d.id === 'behringer-umc404hd'));
});

test('cableKindsFor is unordered and empty for an impossible pair', () => {
  assert.deepEqual(cableKindsFor(DEFAULT_LIBRARY, 'rj45', 'rj45'), ['ethernet']);
  assert.deepEqual(cableKindsFor(DEFAULT_LIBRARY, 'schuko', 'iec-c14'), ['power']);
  assert.deepEqual(cableKindsFor(DEFAULT_LIBRARY, 'iec-c14', 'schuko'), ['power']);
  assert.deepEqual(cableKindsFor(DEFAULT_LIBRARY, 'rj45', 'usb-b'), []);
});

test('normalizeLibrary fills missing parts from the defaults and drops broken rows', () => {
  const lib = normalizeLibrary({ devices: [{ id: 'x', name: 'X' }, { name: 'no id' }, null] });
  assert.equal(lib.connectors.length, DEFAULT_LIBRARY.connectors.length);
  assert.equal(lib.cables.length, DEFAULT_LIBRARY.cables.length);
  assert.deepEqual(lib.devices.map((d) => d.id), ['x']);
  assert.deepEqual(lib.devices[0].ports, []);
  assert.equal(lib.devices[0].category, 'other');
});

test('normalizeTemplate derives the id, validates ports and refuses duplicates', () => {
  const t = normalizeTemplate(
    { name: 'Netgear GS724T', category: 'switch', ports: [{ id: 'p1', label: 'Port 1', connector: 'rj45' }, { label: 'Power', connector: 'iec-c14', direction: 'in' }] },
    new Set()
  );
  assert.equal(t.id, 'netgear-gs724t');
  assert.equal(t.ports[0].direction, 'bidir');
  assert.equal(t.ports[0].side, 'right');
  assert.equal(t.ports[1].id, 'power');
  assert.equal(t.heightU, 1);
  assert.throws(() => normalizeTemplate({ name: '' }), /name/i);
  assert.throws(() => normalizeTemplate({ name: 'A', category: 'spaceship' }), /category/i);
  assert.throws(() => normalizeTemplate({ name: 'A', ports: [{ id: 'p', label: 'P', connector: 'nope' }] }), /connector/i);
  assert.throws(() => normalizeTemplate({ name: 'A', ports: [{ id: 'p', label: 'P', connector: 'rj45' }, { id: 'p', label: 'Q', connector: 'rj45' }] }), /port id/i);
  assert.throws(() => normalizeTemplate({ name: 'A', ports: [{ id: 'p', label: 'P', connector: 'rj45', direction: 'sideways' }] }), /direction/i);
});

test('templateIdFor and templateFor', () => {
  assert.equal(templateIdFor('Power strip 8', new Set(['power-strip-8'])), 'power-strip-8-2');
  assert.equal(templateFor(DEFAULT_LIBRARY, 'behringer-umc404hd').name, 'Behringer UMC404HD');
  assert.equal(templateFor(DEFAULT_LIBRARY, 'nope'), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test server/library.test.js`
Expected: FAIL, `Cannot find module './library.js'`.

- [ ] **Step 3: Implement `server/library.js`**

```js
/**
 * Device library: connector kinds, cable kinds (which connector pairs they join) and device
 * templates (what a device IS and what it connects: typed ports). Pure functions — persistence is
 * schematics-store.js, which keeps the library on `main` in library/connectors.json and
 * library/devices.json. The defaults below are shipped with the console and are what a store
 * without those files reads.
 */
import { slugify } from './store-utils.js';

export const CATEGORIES = ['switch', 'router', 'pc', 'audio-interface', 'power-strip', 'headset', 'display', 'panel', 'other'];
export const SYMBOLS = ['box', 'switch', 'pc', 'power-strip', 'headset', 'display'];
export const PORT_DIRECTIONS = ['in', 'out', 'bidir'];
export const PORT_SIDES = ['left', 'right', 'top', 'bottom'];
/** Default symbol per category, when a template names none. */
const SYMBOL_OF = { switch: 'switch', router: 'switch', pc: 'pc', 'power-strip': 'power-strip', headset: 'headset', display: 'display' };

const DEFAULT_CONNECTORS = [
  { id: 'rj45', label: 'RJ45', color: '#2b7bba' },
  { id: 'usb-a', label: 'USB-A', color: '#555' },
  { id: 'usb-b', label: 'USB-B', color: '#555' },
  { id: 'usb-c', label: 'USB-C', color: '#555' },
  { id: 'iec-c13', label: 'IEC C13', color: '#111' },
  { id: 'iec-c14', label: 'IEC C14', color: '#111' },
  { id: 'schuko', label: 'Schuko', color: '#111' },
  { id: 'trs-6.35', label: 'TRS 6.35 mm', color: '#2a9d4b' },
  { id: 'xlr-m', label: 'XLR male', color: '#2a9d4b' },
  { id: 'xlr-f', label: 'XLR female', color: '#2a9d4b' },
  { id: 'hdmi', label: 'HDMI', color: '#8a4bb8' },
  { id: 'dp', label: 'DisplayPort', color: '#8a4bb8' },
  { id: 'db9', label: 'DB9', color: '#b8722b' },
];

/** `joins` lists the unordered connector pairs a cable kind may terminate in; `style` is how it prints. */
const DEFAULT_CABLES = [
  { id: 'ethernet', label: 'Ethernet', joins: [['rj45', 'rj45']], style: { color: '#2b7bba', width: 1.2, dash: '' } },
  { id: 'power', label: 'Power', joins: [['iec-c14', 'schuko'], ['iec-c14', 'iec-c13']], style: { color: '#111', width: 2, dash: '' } },
  { id: 'usb', label: 'USB', joins: [['usb-a', 'usb-b'], ['usb-a', 'usb-c'], ['usb-c', 'usb-c']], style: { color: '#555', width: 1.2, dash: '2 2' } },
  { id: 'audio', label: 'Audio', joins: [['trs-6.35', 'trs-6.35'], ['xlr-m', 'xlr-f']], style: { color: '#2a9d4b', width: 1.2, dash: '6 3' } },
  { id: 'video', label: 'Video', joins: [['hdmi', 'hdmi'], ['dp', 'dp']], style: { color: '#8a4bb8', width: 1.2, dash: '' } },
  { id: 'serial', label: 'Serial', joins: [['db9', 'db9']], style: { color: '#b8722b', width: 1.2, dash: '1 3' } },
];

const SEED_DEVICES = [
  {
    id: 'behringer-umc404hd', name: 'Behringer UMC404HD', category: 'audio-interface', manufacturer: 'Behringer', model: 'UMC404HD', heightU: 1, symbol: 'box',
    ports: [
      { id: 'pwr', label: 'Power', connector: 'iec-c14', direction: 'in', side: 'left' },
      { id: 'usb', label: 'USB', connector: 'usb-b', direction: 'bidir', side: 'left' },
      { id: 'phones-1', label: 'Phones 1', connector: 'trs-6.35', direction: 'out', side: 'right' },
      { id: 'phones-2', label: 'Phones 2', connector: 'trs-6.35', direction: 'out', side: 'right' },
    ],
  },
  {
    id: 'pdu-8', name: 'Power strip 8 outlets', category: 'power-strip', manufacturer: '', model: '', heightU: 1, symbol: 'power-strip',
    ports: [
      { id: 'in', label: 'Mains in', connector: 'iec-c14', direction: 'in', side: 'left' },
      ...Array.from({ length: 8 }, (_, i) => ({ id: `out-${i + 1}`, label: `Socket ${i + 1}`, connector: 'schuko', direction: 'out', side: 'right' })),
    ],
  },
  {
    id: 'switch-24', name: 'Ethernet switch 24 ports', category: 'switch', manufacturer: '', model: '', heightU: 1, symbol: 'switch',
    ports: [
      { id: 'pwr', label: 'Power', connector: 'iec-c14', direction: 'in', side: 'left' },
      ...Array.from({ length: 24 }, (_, i) => ({ id: `p${i + 1}`, label: `Port ${i + 1}`, connector: 'rj45', direction: 'bidir', side: 'right' })),
    ],
  },
  {
    id: 'headset', name: 'Headset', category: 'headset', manufacturer: '', model: '', heightU: 0, symbol: 'headset',
    ports: [{ id: 'jack', label: 'Jack', connector: 'trs-6.35', direction: 'in', side: 'left' }],
  },
  {
    id: 'pc', name: 'PC', category: 'pc', manufacturer: '', model: '', heightU: 2, symbol: 'pc',
    ports: [
      { id: 'pwr', label: 'Power', connector: 'iec-c14', direction: 'in', side: 'left' },
      { id: 'lan', label: 'LAN', connector: 'rj45', direction: 'bidir', side: 'right' },
      ...Array.from({ length: 4 }, (_, i) => ({ id: `usb-${i + 1}`, label: `USB ${i + 1}`, connector: 'usb-a', direction: 'bidir', side: 'right' })),
      { id: 'hdmi', label: 'HDMI', connector: 'hdmi', direction: 'out', side: 'right' },
    ],
  },
];

export const DEFAULT_LIBRARY = { connectors: DEFAULT_CONNECTORS, cables: DEFAULT_CABLES, devices: SEED_DEVICES };

const str = (v) => String(v ?? '').trim();

export function templateIdFor(name, takenIds) {
  const base = slugify(name) || 'device';
  let id = base;
  for (let n = 2; takenIds.has(id); n++) id = `${base}-${n}`;
  return id;
}

function normalizePort(p, connectorIds, seen) {
  if (!p || typeof p !== 'object') throw new Error('A port must be an object {id, label, connector, direction, side}');
  const label = str(p.label) || str(p.id);
  const id = str(p.id) || slugify(label);
  if (!id) throw new Error('A port needs an id or a label');
  if (seen.has(id)) throw new Error(`Port id "${id}" is listed twice`);
  seen.add(id);
  const connector = str(p.connector);
  if (!connectorIds.has(connector)) throw new Error(`Port "${id}": unknown connector "${connector}" — one of ${[...connectorIds].join(', ')}`);
  const direction = str(p.direction) || 'bidir';
  if (!PORT_DIRECTIONS.includes(direction)) throw new Error(`Port "${id}": direction must be one of ${PORT_DIRECTIONS.join(', ')}`);
  const side = str(p.side) || (direction === 'in' ? 'left' : 'right');
  if (!PORT_SIDES.includes(side)) throw new Error(`Port "${id}": side must be one of ${PORT_SIDES.join(', ')}`);
  return { id, label, connector, direction, side };
}

/** Clean one template spec (UI, API, MCP) into a library record. `connectors` defaults to the shipped set. */
export function normalizeTemplate(spec, takenIds = new Set(), connectors = DEFAULT_CONNECTORS) {
  if (!spec || typeof spec !== 'object') throw new Error('A device template must be an object');
  const name = str(spec.name);
  if (!name) throw new Error('A device template needs a name');
  const category = str(spec.category) || 'other';
  if (!CATEGORIES.includes(category)) throw new Error(`Unknown category "${category}" — one of ${CATEGORIES.join(', ')}`);
  const symbol = str(spec.symbol) || SYMBOL_OF[category] || 'box';
  if (!SYMBOLS.includes(symbol)) throw new Error(`Unknown symbol "${symbol}" — one of ${SYMBOLS.join(', ')}`);
  const connectorIds = new Set(connectors.map((c) => c.id));
  const seen = new Set();
  const ports = Array.isArray(spec.ports) ? spec.ports.map((p) => normalizePort(p, connectorIds, seen)) : [];
  const heightU = spec.heightU === undefined || spec.heightU === null || spec.heightU === '' ? 1 : Number(spec.heightU);
  if (!Number.isFinite(heightU) || heightU < 0) throw new Error('heightU must be a number of rack units (0 for a device outside a rack)');
  return {
    id: str(spec.id) || templateIdFor(name, takenIds),
    name,
    category,
    manufacturer: str(spec.manufacturer),
    model: str(spec.model),
    heightU,
    symbol,
    ports,
    hardwareId: str(spec.hardwareId) || null,
    notes: str(spec.notes),
  };
}

/** What a stored library file resolves to: broken rows dropped, missing parts filled from the defaults. */
export function normalizeLibrary(raw) {
  const connectors = Array.isArray(raw?.connectors) && raw.connectors.length ? raw.connectors.filter((c) => c && c.id && c.label) : DEFAULT_CONNECTORS;
  const cables = Array.isArray(raw?.cables) && raw.cables.length ? raw.cables.filter((c) => c && c.id && Array.isArray(c.joins)) : DEFAULT_CABLES;
  const devices = [];
  const taken = new Set();
  for (const d of Array.isArray(raw?.devices) ? raw.devices : SEED_DEVICES) {
    if (!d || !d.id || !d.name) continue;
    try {
      const t = normalizeTemplate(d, taken, connectors);
      taken.add(t.id);
      devices.push(t);
    } catch {
      // a template that no longer parses (a connector removed under it) is left out, not fatal
    }
  }
  return { connectors, cables, devices };
}

export function cableKindsFor(library, a, b) {
  return library.cables.filter((c) => c.joins.some(([x, y]) => (x === a && y === b) || (x === b && y === a))).map((c) => c.id);
}

export const templateFor = (library, id) => library.devices.find((d) => d.id === id) || null;
export const connectorFor = (library, id) => library.connectors.find((c) => c.id === id) || null;
export const cableFor = (library, id) => library.cables.find((c) => c.id === id) || null;
```

`slugify` lives in `store.js`, which we must not import from a pure module (it opens the git repo at
import). Create `server/store-utils.js`:

```js
/** Helpers shared by the store and the pure modules that must not import it (it opens the repo on load). */
export const slugify = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
```

and in `server/store.js` replace the `export const slugify = …` definition (lines 50–54) with:

```js
import { slugify } from './store-utils.js';
export { slugify };
```

(the `import` goes with the other imports at the top of the file; the `export { slugify }` where the
old definition was).

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: all pass (`# fail 0`). Also run `npm run build` to be sure the store still imports.

- [ ] **Step 5: Commit**

```bash
git add server/library.js server/library.test.js server/store-utils.js server/store.js
git commit -m "Schematics: device library defaults and normalisation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Schematic applier and validator (pure)

**Files:**
- Create: `server/schematic.js`
- Test: `server/schematic.test.js`

**Interfaces:**
- Consumes: `cableKindsFor`, `templateFor`, `connectorFor` from `server/library.js`.
- Produces:
  - `emptySchematic({ kind: 'module'|'installation', owner }) → state`
  - `class SchematicError extends Error { code, index }` (`index` = position of the failing op, or `-1`)
  - `applyOps(state, ops, ctx) → { state, summary: string[] }` — atomic: throws `SchematicError` and
    leaves the input untouched when any op fails; `summary` is one line per applied op.
  - `validateSchematic(state, ctx) → { errors: [{code, message, ref}], warnings: [{code, message, ref}] }`
  - `connectorFace(moduleState, ctx) → [{ id, label, connector, direction, device, port }]`
  - `cableSchedule(state, ctx) → [{ id, label, kind, kindLabel, from, to, fromPort, toPort, length, notes }]`
    where `from`/`to` are display names ("Power strip 1" / "Audio system (block)").
  - `portsOf(state, endpoint, ctx) → [{ id, label, connector, direction }]` for a `{device}` or `{block}` endpoint
  - `endpointKey(end) → 'd:<id>:<port>' | 'b:<id>:<port>'`
  - `ctx` shape used everywhere: `{ library, catalog: [{id,name,type,manufacturer,model,version}],
    modules: [{slug, name}], releasedSchematics: Map<slug, moduleState> }`

State shape (both kinds):

```js
{
  kind: 'module' | 'installation', owner: '<slug>',
  version: 'A1.0', revision: 1, status: 'draft', branch: 'draft/…' | null,
  createdAt, updatedAt, releasedAt: null,
  locations: [{ id, label, kind: 'rack'|'area', unitsU }],          // installation only (module: [])
  blocks: [{ id, module, schematic: { version, revision }, location, rack }],  // installation only
  devices: [{ id, template, hardwareId, label, location, rack: { u } | null, notes }],
  cables: [{ id, kind, from: {device,port}|{block,port}, to: …, label, length, notes }],
  externalPorts: [{ id, label, device, port }],                       // module only
  layout: { nodes: {}, manual: [] },
  revisions: [{ rev, date, summary }],                                // working history
  releaseRecord: [{ rev, version, date, summary, public: true }],     // printed lines
  hotfix: null | { startedAt, baseRevision },
}
```

- [ ] **Step 1: Write the failing tests**

`server/schematic.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIBRARY } from './library.js';
import { emptySchematic, applyOps, validateSchematic, connectorFace, cableSchedule, SchematicError } from './schematic.js';

const ctx = () => ({ library: DEFAULT_LIBRARY, catalog: [], modules: [{ slug: 'audio-system', name: 'Audio system' }], releasedSchematics: new Map() });

function moduleWithUmc() {
  const { state } = applyOps(
    emptySchematic({ kind: 'module', owner: 'audio-system' }),
    [
      { op: 'add_device', id: 'umc', template: 'behringer-umc404hd', label: 'UMC404HD' },
      { op: 'add_device', id: 'hs', template: 'headset', label: 'Headset L' },
      { op: 'connect', id: 'c1', from: { device: 'umc', port: 'phones-1' }, to: { device: 'hs', port: 'jack' }, label: 'AUD-01' },
      { op: 'set_external_port', id: 'power-in', label: 'Power in', device: 'umc', port: 'pwr' },
      { op: 'set_external_port', id: 'usb-host', label: 'USB to host', device: 'umc', port: 'usb' },
    ],
    ctx()
  );
  return state;
}

test('emptySchematic', () => {
  const s = emptySchematic({ kind: 'installation', owner: 'sim-1' });
  assert.equal(s.kind, 'installation');
  assert.equal(s.version, 'A1.0');
  assert.deepEqual(s.devices, []);
  assert.deepEqual(s.layout, { nodes: {}, manual: [] });
});

test('add_device derives an id from the label and infers the cable kind on connect', () => {
  const s = moduleWithUmc();
  assert.equal(s.devices.length, 2);
  assert.equal(s.cables[0].kind, 'audio');
  const { state } = applyOps(s, [{ op: 'add_device', template: 'headset', label: 'Headset R' }], ctx());
  assert.equal(state.devices[2].id, 'headset-r');
});

test('applyOps is atomic and names the failing op', () => {
  const s = moduleWithUmc();
  const before = JSON.stringify(s);
  assert.throws(
    () => applyOps(s, [{ op: 'add_device', template: 'pc', label: 'PC' }, { op: 'connect', from: { device: 'pc', port: 'nope' }, to: { device: 'umc', port: 'usb' } }], ctx()),
    (e) => e instanceof SchematicError && e.index === 1 && /port "nope"/.test(e.message)
  );
  assert.equal(JSON.stringify(s), before);
});

test('connect refuses incompatible connectors, busy ports and out→out', () => {
  const s = moduleWithUmc();
  assert.throws(() => applyOps(s, [{ op: 'connect', from: { device: 'umc', port: 'usb' }, to: { device: 'hs', port: 'jack' } }], ctx()), /no cable kind joins/i);
  assert.throws(() => applyOps(s, [{ op: 'add_device', id: 'hs2', template: 'headset' }, { op: 'connect', from: { device: 'umc', port: 'phones-1' }, to: { device: 'hs2', port: 'jack' } }], ctx()), /already has cable/i);
  assert.throws(() => applyOps(s, [{ op: 'add_device', id: 'umc2', template: 'behringer-umc404hd' }, { op: 'connect', from: { device: 'umc', port: 'phones-2' }, to: { device: 'umc2', port: 'phones-1' } }], ctx()), /two outputs/i);
});

test('connect needs an explicit kind when several fit, and the kind must join the pair', () => {
  const lib = { ...DEFAULT_LIBRARY, cables: [...DEFAULT_LIBRARY.cables, { id: 'patch', label: 'Patch', joins: [['rj45', 'rj45']], style: {} }] };
  const c = { ...ctx(), library: lib };
  const { state } = applyOps(emptySchematic({ kind: 'module', owner: 'm' }), [{ op: 'add_device', id: 'a', template: 'pc' }, { op: 'add_device', id: 'b', template: 'switch-24' }], c);
  assert.throws(() => applyOps(state, [{ op: 'connect', from: { device: 'a', port: 'lan' }, to: { device: 'b', port: 'p1' } }], c), /ethernet, patch/);
  assert.throws(() => applyOps(state, [{ op: 'connect', kind: 'audio', from: { device: 'a', port: 'lan' }, to: { device: 'b', port: 'p1' } }], c), /audio/);
  const ok = applyOps(state, [{ op: 'connect', kind: 'patch', from: { device: 'a', port: 'lan' }, to: { device: 'b', port: 'p1' } }], c);
  assert.equal(ok.state.cables[0].kind, 'patch');
});

test('remove_device refuses while cabled unless cascade', () => {
  const s = moduleWithUmc();
  assert.throws(() => applyOps(s, [{ op: 'remove_device', id: 'hs' }], ctx()), /cable/i);
  const r = applyOps(s, [{ op: 'remove_device', id: 'hs', cascade: true }], ctx());
  assert.equal(r.state.cables.length, 0);
  assert.equal(r.state.devices.length, 1);
});

test('disconnect then update_cable of the same id fails; update ops patch fields', () => {
  const s = moduleWithUmc();
  assert.throws(() => applyOps(s, [{ op: 'disconnect', id: 'c1' }, { op: 'update_cable', id: 'c1', label: 'X' }], ctx()), (e) => e.index === 1);
  const { state } = applyOps(s, [{ op: 'update_device', id: 'hs', label: 'Headset left', notes: 'Captain' }, { op: 'update_cable', id: 'c1', label: 'AUD-99', length: 2.5 }], ctx());
  assert.equal(state.devices[1].label, 'Headset left');
  assert.equal(state.cables[0].length, 2.5);
});

test('external ports: only existing device ports, module only, unset removes', () => {
  const s = moduleWithUmc();
  assert.deepEqual(connectorFace(s, ctx()).map((p) => p.id), ['power-in', 'usb-host']);
  assert.equal(connectorFace(s, ctx())[0].connector, 'iec-c14');
  assert.throws(() => applyOps(s, [{ op: 'set_external_port', id: 'x', label: 'X', device: 'umc', port: 'nope' }], ctx()), /port "nope"/);
  const { state } = applyOps(s, [{ op: 'unset_external_port', id: 'usb-host' }], ctx());
  assert.deepEqual(state.externalPorts.map((p) => p.id), ['power-in']);
  const inst = emptySchematic({ kind: 'installation', owner: 'sim' });
  assert.throws(() => applyOps(inst, [{ op: 'set_external_port', id: 'x', label: 'X', device: 'a', port: 'b' }], ctx()), /module schematic/i);
});

test('installation: locations, blocks from released module schematics, cables to block ports', () => {
  const released = { ...moduleWithUmc(), status: 'released', revision: 3 };
  const c = { ...ctx(), releasedSchematics: new Map([['audio-system', released]]) };
  const inst = emptySchematic({ kind: 'installation', owner: 'sim' });
  assert.throws(() => applyOps(inst, [{ op: 'place_block', id: 'audio', module: 'audio-system', location: 'rack-1' }], c), /location "rack-1"/);
  assert.throws(() => applyOps(inst, [{ op: 'add_location', id: 'rack-1', label: 'Rack 1', kind: 'rack', unitsU: 42 }, { op: 'place_block', id: 'x', module: 'other', location: 'rack-1' }], c), /no released schematic/i);
  const { state, summary } = applyOps(
    inst,
    [
      { op: 'add_location', id: 'rack-1', label: 'Rack 1', kind: 'rack', unitsU: 42 },
      { op: 'add_location', label: 'Cockpit' },
      { op: 'place_block', id: 'audio', module: 'audio-system', location: 'rack-1', rack: { u: 12 } },
      { op: 'add_device', id: 'pdu-1', template: 'pdu-8', label: 'Power strip 1', location: 'rack-1' },
      { op: 'connect', from: { device: 'pdu-1', port: 'out-1' }, to: { block: 'audio', port: 'power-in' }, label: 'PWR-07' },
    ],
    c
  );
  assert.equal(state.locations[1].id, 'cockpit');
  assert.equal(state.locations[1].kind, 'area');
  assert.deepEqual(state.blocks[0].schematic, { version: 'A1.0', revision: 3 });
  assert.equal(state.cables[0].kind, 'power');
  assert.equal(summary.length, 5);
  assert.throws(() => applyOps(state, [{ op: 'connect', from: { device: 'pdu-1', port: 'out-2' }, to: { block: 'audio', port: 'nope' } }], c), /external port "nope"/);
  assert.throws(() => applyOps(state, [{ op: 'remove_location', id: 'rack-1' }], c), /still holds/i);
  assert.throws(() => applyOps(state, [{ op: 'add_device', template: 'pc', location: 'nowhere' }], c), /location "nowhere"/);
  // module-only ops are refused on an installation and vice versa
  assert.throws(() => applyOps(moduleWithUmc(), [{ op: 'add_location', label: 'X' }], c), /installation/i);
  // cable schedule names block ends with the module name
  const sched = cableSchedule(state, c);
  assert.equal(sched[0].to, 'Audio system');
  assert.equal(sched[0].toPort, 'Power in');
  assert.equal(sched[0].kindLabel, 'Power');
});

test('refresh_block re-pins the newest release and validation flags a dropped external port', () => {
  const v1 = { ...moduleWithUmc(), status: 'released', revision: 3 };
  const c1 = { ...ctx(), releasedSchematics: new Map([['audio-system', v1]]) };
  const { state } = applyOps(
    emptySchematic({ kind: 'installation', owner: 'sim' }),
    [
      { op: 'add_location', id: 'rack-1', label: 'Rack 1', kind: 'rack' },
      { op: 'place_block', id: 'audio', module: 'audio-system', location: 'rack-1' },
      { op: 'add_device', id: 'pdu-1', template: 'pdu-8', location: 'rack-1' },
      { op: 'connect', from: { device: 'pdu-1', port: 'out-1' }, to: { block: 'audio', port: 'power-in' } },
    ],
    c1
  );
  const v2 = applyOps(v1, [{ op: 'unset_external_port', id: 'power-in' }], c1).state;
  const c2 = { ...ctx(), releasedSchematics: new Map([['audio-system', { ...v2, version: 'A1.1', revision: 1, status: 'released' }]]) };
  const v = validateSchematic(state, c2);
  assert.ok(v.warnings.some((w) => w.code === 'block-outdated' && w.ref === 'audio'));
  assert.ok(v.errors.some((e) => e.code === 'port-missing' && /power-in/.test(e.message)));
  const refreshed = applyOps(state, [{ op: 'refresh_block', id: 'audio' }], c2).state;
  assert.deepEqual(refreshed.blocks[0].schematic, { version: 'A1.1', revision: 1 });
  assert.ok(validateSchematic(refreshed, c2).errors.some((e) => e.code === 'port-missing'));
  assert.ok(!validateSchematic(refreshed, c2).warnings.some((w) => w.code === 'block-outdated'));
});

test('validation warnings: unlabeled cable, unpowered device, empty location, device outside any location', () => {
  const { state } = applyOps(
    emptySchematic({ kind: 'installation', owner: 'sim' }),
    [
      { op: 'add_location', id: 'rack-1', label: 'Rack 1', kind: 'rack' },
      { op: 'add_location', id: 'ios', label: 'IOS' },
      { op: 'add_device', id: 'pc', template: 'pc', location: 'rack-1' },
      { op: 'add_device', id: 'sw', template: 'switch-24' },
      { op: 'connect', from: { device: 'pc', port: 'lan' }, to: { device: 'sw', port: 'p1' } },
    ],
    ctx()
  );
  const v = validateSchematic(state, ctx());
  assert.deepEqual(v.errors, []);
  const codes = v.warnings.map((w) => w.code).sort();
  assert.deepEqual(codes, ['cable-unlabeled', 'device-unplaced', 'device-unpowered', 'device-unpowered', 'location-empty']);
});

test('move and tidy maintain the layout, and the device list keeps hardwareId when given', () => {
  const c = { ...ctx(), catalog: [{ id: 'behringer-umc404hd', name: 'Behringer UMC404HD', type: 'cots', manufacturer: 'Behringer', model: 'UMC404HD' }] };
  const { state } = applyOps(
    emptySchematic({ kind: 'module', owner: 'm' }),
    [{ op: 'add_device', id: 'umc', template: 'behringer-umc404hd', hardwareId: 'behringer-umc404hd' }, { op: 'move', id: 'umc', x: 10, y: 20 }],
    c
  );
  assert.deepEqual(state.layout, { nodes: { umc: { x: 10, y: 20 } }, manual: ['umc'] });
  assert.equal(state.devices[0].hardwareId, 'behringer-umc404hd');
  assert.throws(() => applyOps(state, [{ op: 'add_device', id: 'x', hardwareId: 'unknown-part' }], c), /catalog/i);
  const tidy = applyOps(state, [{ op: 'tidy' }], c).state;
  assert.deepEqual(tidy.layout.manual, []);
  assert.throws(() => applyOps(state, [{ op: 'fly' }], c), /unknown op "fly"/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test server/schematic.test.js`
Expected: FAIL, `Cannot find module './schematic.js'`.

- [ ] **Step 3: Implement `server/schematic.js`**

```js
/**
 * The schematic as data: devices with typed ports, cables between ports, locations, a module's
 * external ports. Everything that changes it is an **operation**; `applyOps` validates and applies a
 * whole list or nothing. Pure — the git side is schematics-store.js, the drawing schematic-render.js.
 */
import { slugify } from './store-utils.js';
import { cableKindsFor, templateFor, connectorFor, cableFor } from './library.js';

export class SchematicError extends Error {
  constructor(message, { code = 'invalid', index = -1 } = {}) {
    super(message);
    this.code = code;
    this.index = index;
  }
}

const now = () => new Date().toISOString();
const str = (v) => String(v ?? '').trim();
const clone = (v) => JSON.parse(JSON.stringify(v));

export function emptySchematic({ kind, owner }) {
  if (kind !== 'module' && kind !== 'installation') throw new SchematicError(`kind must be module or installation, not "${kind}"`);
  const ts = now();
  return {
    kind,
    owner,
    version: 'A1.0',
    revision: 1,
    status: 'draft',
    branch: null,
    createdAt: ts,
    updatedAt: ts,
    releasedAt: null,
    locations: [],
    blocks: [],
    devices: [],
    cables: [],
    externalPorts: [],
    layout: { nodes: {}, manual: [] },
    revisions: [],
    releaseRecord: [],
    hotfix: null,
  };
}

export const endpointKey = (e) => (e.block ? `b:${e.block}:${e.port}` : `d:${e.device}:${e.port}`);

function uniqueId(base, taken) {
  base = slugify(base) || 'item';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/* ---- lookups ---- */

const deviceOf = (state, id) => state.devices.find((d) => d.id === id) || null;
const blockOf = (state, id) => state.blocks.find((b) => b.id === id) || null;
const locationOf = (state, id) => state.locations.find((l) => l.id === id) || null;
const moduleName = (ctx, slug) => ctx.modules.find((m) => m.slug === slug)?.name || slug;

/** The external ports a released module schematic exposes, typed through its devices' templates. */
export function connectorFace(moduleState, ctx) {
  return (moduleState?.externalPorts || []).map((ep) => {
    const dev = deviceOf(moduleState, ep.device);
    const tpl = dev ? templateFor(ctx.library, dev.template) : null;
    const port = tpl?.ports.find((p) => p.id === ep.port) || null;
    return { id: ep.id, label: ep.label, device: ep.device, port: ep.port, connector: port?.connector || null, direction: port?.direction || 'bidir' };
  });
}

/** Typed ports of one endpoint owner: a device (its template ports) or a block (its module's face). */
export function portsOf(state, end, ctx) {
  if (end.block) {
    const b = blockOf(state, end.block);
    if (!b) return null;
    const released = ctx.releasedSchematics.get(b.module);
    return released ? connectorFace(released, ctx) : [];
  }
  const d = deviceOf(state, end.device);
  if (!d) return null;
  const tpl = templateFor(ctx.library, d.template);
  return tpl ? tpl.ports : [];
}

function resolveEnd(state, end, ctx, who) {
  if (!end || typeof end !== 'object' || !str(end.port) || (!str(end.device) && !str(end.block)))
    throw new SchematicError(`${who} must be {device, port} or {block, port}`);
  const ports = portsOf(state, end, ctx);
  if (!ports) throw new SchematicError(`${who}: unknown ${end.block ? `block "${end.block}"` : `device "${end.device}"`}`);
  const port = ports.find((p) => p.id === end.port);
  if (!port) {
    const owner = end.block ? `block "${end.block}"` : `device "${end.device}"`;
    throw new SchematicError(`${who}: ${end.block ? 'external ' : ''}port "${end.port}" does not exist on ${owner} — it has: ${ports.map((p) => p.id).join(', ') || 'none'}`);
  }
  const norm = end.block ? { block: str(end.block), port: str(end.port) } : { device: str(end.device), port: str(end.port) };
  return { end: norm, port };
}

const endLabel = (state, end, ctx) => {
  if (end.block) {
    const b = blockOf(state, end.block);
    return b ? moduleName(ctx, b.module) : end.block;
  }
  const d = deviceOf(state, end.device);
  return d ? d.label : end.device;
};
const portLabel = (state, end, ctx) => (portsOf(state, end, ctx) || []).find((p) => p.id === end.port)?.label || end.port;

/* ---- operations ---- */

const needKind = (state, kind, op) => {
  if (state.kind !== kind) throw new SchematicError(`${op} belongs to ${kind === 'module' ? 'a module schematic' : 'an installation'}, not to ${state.kind === 'module' ? 'a module schematic' : 'an installation'}`);
};

const OPS = {
  add_device(state, op, ctx) {
    const template = str(op.template);
    const hardwareId = str(op.hardwareId) || null;
    let tpl = template ? templateFor(ctx.library, template) : null;
    if (template && !tpl) throw new SchematicError(`unknown device template "${template}" — list_device_templates names them`);
    if (hardwareId && !ctx.catalog.some((h) => h.id === hardwareId)) throw new SchematicError(`"${hardwareId}" is not in the hardware catalog`);
    if (!tpl && hardwareId) tpl = ctx.library.devices.find((d) => d.hardwareId === hardwareId) || null;
    if (!tpl) throw new SchematicError('add_device needs a template (or a hardwareId whose catalog item has a template)');
    const label = str(op.label) || (hardwareId ? ctx.catalog.find((h) => h.id === hardwareId).name : tpl.name);
    const taken = new Set([...state.devices.map((d) => d.id), ...state.blocks.map((b) => b.id)]);
    const id = str(op.id) || uniqueId(label, taken);
    if (taken.has(id)) throw new SchematicError(`id "${id}" is already used`);
    const location = str(op.location) || null;
    if (location && !locationOf(state, location)) throw new SchematicError(`unknown location "${location}" — add_location first`);
    if (location && state.kind === 'module') throw new SchematicError('a module schematic has no locations');
    state.devices.push({ id, template: tpl.id, hardwareId, label, location, rack: rackOf(op.rack), notes: str(op.notes) });
    return `Added ${label}${location ? ` in ${locationOf(state, location).label}` : ''}`;
  },
  update_device(state, op) {
    const d = deviceOf(state, str(op.id));
    if (!d) throw new SchematicError(`unknown device "${op.id}"`);
    if (op.label !== undefined) d.label = str(op.label) || d.label;
    if (op.notes !== undefined) d.notes = str(op.notes);
    if (op.rack !== undefined) d.rack = rackOf(op.rack);
    if (op.location !== undefined) {
      const loc = str(op.location) || null;
      if (loc && !locationOf(state, loc)) throw new SchematicError(`unknown location "${loc}"`);
      d.location = loc;
    }
    return `Updated ${d.label}`;
  },
  remove_device(state, op) {
    const d = deviceOf(state, str(op.id));
    if (!d) throw new SchematicError(`unknown device "${op.id}"`);
    const attached = state.cables.filter((c) => c.from.device === d.id || c.to.device === d.id);
    if (attached.length && !op.cascade) throw new SchematicError(`${d.label} still has ${attached.length} cable(s) — disconnect them or pass cascade: true`);
    state.cables = state.cables.filter((c) => !attached.includes(c));
    state.externalPorts = state.externalPorts.filter((p) => p.device !== d.id);
    state.devices = state.devices.filter((x) => x !== d);
    delete state.layout.nodes[d.id];
    state.layout.manual = state.layout.manual.filter((x) => x !== d.id);
    return `Removed ${d.label}${attached.length ? ` and ${attached.length} cable(s)` : ''}`;
  },
  connect(state, op, ctx) {
    const a = resolveEnd(state, op.from, ctx, 'from');
    const b = resolveEnd(state, op.to, ctx, 'to');
    if (endpointKey(a.end) === endpointKey(b.end)) throw new SchematicError('a cable cannot join a port to itself');
    const kinds = cableKindsFor(ctx.library, a.port.connector, b.port.connector);
    if (!kinds.length) throw new SchematicError(`no cable kind joins ${a.port.connector} to ${b.port.connector}`);
    let kind = str(op.kind);
    if (kind && !kinds.includes(kind)) throw new SchematicError(`a ${kind} cable does not join ${a.port.connector} to ${b.port.connector} — ${kinds.join(', ')} would`);
    if (!kind) {
      if (kinds.length > 1) throw new SchematicError(`several cable kinds fit (${kinds.join(', ')}) — say which with kind`);
      kind = kinds[0];
    }
    if (a.port.direction === 'out' && b.port.direction === 'out') throw new SchematicError('two outputs cannot be joined');
    if (a.port.direction === 'in' && b.port.direction === 'in') throw new SchematicError('two inputs cannot be joined');
    for (const end of [a.end, b.end]) {
      const busy = state.cables.find((c) => endpointKey(c.from) === endpointKey(end) || endpointKey(c.to) === endpointKey(end));
      if (busy) throw new SchematicError(`${endLabel(state, end, ctx)} ${portLabel(state, end, ctx)} already has cable ${busy.label || busy.id}`);
    }
    const taken = new Set(state.cables.map((c) => c.id));
    const id = str(op.id) || uniqueId(`c-${state.cables.length + 1}`, taken);
    if (taken.has(id)) throw new SchematicError(`cable id "${id}" is already used`);
    state.cables.push({ id, kind, from: a.end, to: b.end, label: str(op.label), length: numOrNull(op.length), notes: str(op.notes) });
    return `Connected ${endLabel(state, a.end, ctx)} ${portLabel(state, a.end, ctx)} → ${endLabel(state, b.end, ctx)} ${portLabel(state, b.end, ctx)} (${kind})`;
  },
  update_cable(state, op) {
    const c = state.cables.find((x) => x.id === str(op.id));
    if (!c) throw new SchematicError(`unknown cable "${op.id}"`);
    if (op.label !== undefined) c.label = str(op.label);
    if (op.length !== undefined) c.length = numOrNull(op.length);
    if (op.notes !== undefined) c.notes = str(op.notes);
    return `Updated cable ${c.label || c.id}`;
  },
  disconnect(state, op) {
    const c = state.cables.find((x) => x.id === str(op.id));
    if (!c) throw new SchematicError(`unknown cable "${op.id}"`);
    state.cables = state.cables.filter((x) => x !== c);
    return `Removed cable ${c.label || c.id}`;
  },
  set_external_port(state, op, ctx) {
    needKind(state, 'module', 'set_external_port');
    const { end, port } = resolveEnd(state, { device: op.device, port: op.port }, ctx, 'external port');
    const id = str(op.id) || uniqueId(str(op.label) || port.label, new Set(state.externalPorts.map((p) => p.id)));
    const existing = state.externalPorts.find((p) => p.id === id);
    const rec = { id, label: str(op.label) || port.label, device: end.device, port: end.port };
    if (existing) Object.assign(existing, rec);
    else state.externalPorts.push(rec);
    return `${existing ? 'Updated' : 'Declared'} external port ${rec.label}`;
  },
  unset_external_port(state, op) {
    needKind(state, 'module', 'unset_external_port');
    const before = state.externalPorts.length;
    state.externalPorts = state.externalPorts.filter((p) => p.id !== str(op.id));
    if (state.externalPorts.length === before) throw new SchematicError(`unknown external port "${op.id}"`);
    return `Removed external port ${op.id}`;
  },
  add_location(state, op) {
    needKind(state, 'installation', 'add_location');
    const label = str(op.label);
    if (!label) throw new SchematicError('add_location needs a label');
    const id = str(op.id) || uniqueId(label, new Set(state.locations.map((l) => l.id)));
    if (locationOf(state, id)) throw new SchematicError(`location "${id}" already exists`);
    const kind = str(op.kind) || 'area';
    if (!['rack', 'area'].includes(kind)) throw new SchematicError('location kind must be rack or area');
    state.locations.push({ id, label, kind, unitsU: kind === 'rack' ? Number(op.unitsU) || 42 : null });
    return `Added location ${label}`;
  },
  update_location(state, op) {
    needKind(state, 'installation', 'update_location');
    const l = locationOf(state, str(op.id));
    if (!l) throw new SchematicError(`unknown location "${op.id}"`);
    if (op.label !== undefined) l.label = str(op.label) || l.label;
    if (op.kind !== undefined) {
      if (!['rack', 'area'].includes(op.kind)) throw new SchematicError('location kind must be rack or area');
      l.kind = op.kind;
      l.unitsU = l.kind === 'rack' ? l.unitsU || 42 : null;
    }
    if (op.unitsU !== undefined && l.kind === 'rack') l.unitsU = Number(op.unitsU) || 42;
    return `Updated location ${l.label}`;
  },
  remove_location(state, op) {
    needKind(state, 'installation', 'remove_location');
    const l = locationOf(state, str(op.id));
    if (!l) throw new SchematicError(`unknown location "${op.id}"`);
    const used = [...state.devices, ...state.blocks].filter((x) => x.location === l.id);
    if (used.length) throw new SchematicError(`${l.label} still holds ${used.length} item(s) — move them first`);
    state.locations = state.locations.filter((x) => x !== l);
    return `Removed location ${l.label}`;
  },
  place_block(state, op, ctx) {
    needKind(state, 'installation', 'place_block');
    const module = str(op.module);
    const released = ctx.releasedSchematics.get(module);
    if (!released) throw new SchematicError(`module "${module}" has no released schematic — release it before placing it`);
    const location = str(op.location) || null;
    if (location && !locationOf(state, location)) throw new SchematicError(`unknown location "${location}" — add_location first`);
    const taken = new Set([...state.devices.map((d) => d.id), ...state.blocks.map((b) => b.id)]);
    const id = str(op.id) || uniqueId(module, taken);
    if (taken.has(id)) throw new SchematicError(`id "${id}" is already used`);
    state.blocks.push({ id, module, schematic: { version: released.version, revision: released.revision }, location, rack: rackOf(op.rack) });
    return `Placed ${moduleName(ctx, module)}${location ? ` in ${locationOf(state, location).label}` : ''}`;
  },
  refresh_block(state, op, ctx) {
    needKind(state, 'installation', 'refresh_block');
    const b = blockOf(state, str(op.id));
    if (!b) throw new SchematicError(`unknown block "${op.id}"`);
    const released = ctx.releasedSchematics.get(b.module);
    if (!released) throw new SchematicError(`module "${b.module}" has no released schematic`);
    b.schematic = { version: released.version, revision: released.revision };
    return `${moduleName(ctx, b.module)} now follows schematic ${released.version} r${released.revision}`;
  },
  remove_block(state, op, ctx) {
    needKind(state, 'installation', 'remove_block');
    const b = blockOf(state, str(op.id));
    if (!b) throw new SchematicError(`unknown block "${op.id}"`);
    const attached = state.cables.filter((c) => c.from.block === b.id || c.to.block === b.id);
    if (attached.length && !op.cascade) throw new SchematicError(`${moduleName(ctx, b.module)} still has ${attached.length} cable(s) — disconnect them or pass cascade: true`);
    state.cables = state.cables.filter((c) => !attached.includes(c));
    state.blocks = state.blocks.filter((x) => x !== b);
    delete state.layout.nodes[b.id];
    state.layout.manual = state.layout.manual.filter((x) => x !== b.id);
    return `Removed ${moduleName(ctx, b.module)}`;
  },
  move(state, op) {
    const id = str(op.id);
    if (!deviceOf(state, id) && !blockOf(state, id) && !locationOf(state, id)) throw new SchematicError(`unknown node "${id}"`);
    const x = Number(op.x);
    const y = Number(op.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new SchematicError('move needs numeric x and y');
    state.layout.nodes[id] = { x, y };
    if (!state.layout.manual.includes(id)) state.layout.manual.push(id);
    return `Moved ${id}`;
  },
  tidy(state, op) {
    const ids = Array.isArray(op.ids) && op.ids.length ? op.ids.map(str) : null;
    state.layout.manual = ids ? state.layout.manual.filter((id) => !ids.includes(id)) : [];
    return ids ? `Tidied ${ids.join(', ')}` : 'Tidied the layout';
  },
};

function rackOf(v) {
  if (!v || typeof v !== 'object') return null;
  const u = Number(v.u);
  return Number.isFinite(u) && u > 0 ? { u } : null;
}
const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Apply a list of operations to a copy of `state`. All or nothing: the first failing op aborts the
 * whole list with a SchematicError carrying its index, and the caller's state is untouched.
 */
export function applyOps(state, ops, ctx) {
  if (!Array.isArray(ops) || !ops.length) throw new SchematicError('ops must be a non-empty array');
  const next = clone(state);
  const summary = [];
  ops.forEach((op, index) => {
    const fn = op && OPS[op.op];
    if (!fn) throw new SchematicError(`unknown op "${op?.op}" — one of ${Object.keys(OPS).join(', ')}`, { code: 'unknown-op', index });
    try {
      summary.push(fn(next, op, ctx));
    } catch (e) {
      if (e instanceof SchematicError) {
        e.index = index;
        e.message = `op ${index + 1} (${op.op}): ${e.message}`;
      }
      throw e;
    }
  });
  next.updatedAt = now();
  return { state: next, summary };
}

/* ---- validation ---- */

/** Errors block a release; warnings do not. */
export function validateSchematic(state, ctx) {
  const errors = [];
  const warnings = [];
  const err = (code, message, ref) => errors.push({ code, message, ref });
  const warn = (code, message, ref) => warnings.push({ code, message, ref });

  for (const d of state.devices) {
    if (!templateFor(ctx.library, d.template)) err('template-missing', `${d.label}: device template "${d.template}" no longer exists`, d.id);
    if (d.hardwareId && !ctx.catalog.some((h) => h.id === d.hardwareId)) warn('catalog-missing', `${d.label}: catalog item "${d.hardwareId}" no longer exists`, d.id);
    if (state.kind === 'installation' && !d.location) warn('device-unplaced', `${d.label} is in no location`, d.id);
    if (d.location && !locationOf(state, d.location)) err('location-missing', `${d.label}: location "${d.location}" does not exist`, d.id);
  }
  for (const b of state.blocks) {
    const released = ctx.releasedSchematics.get(b.module);
    if (!released) err('block-unreleased', `${moduleName(ctx, b.module)} has no released schematic`, b.id);
    else if (released.version !== b.schematic?.version || released.revision !== b.schematic?.revision)
      warn('block-outdated', `${moduleName(ctx, b.module)} follows schematic ${b.schematic?.version} r${b.schematic?.revision}; ${released.version} r${released.revision} is released — refresh the block`, b.id);
    if (b.location && !locationOf(state, b.location)) err('location-missing', `${moduleName(ctx, b.module)}: location "${b.location}" does not exist`, b.id);
  }
  const seen = new Map();
  for (const c of state.cables) {
    const name = c.label || c.id;
    if (!c.label) warn('cable-unlabeled', `cable ${c.id} has no label`, c.id);
    const ends = [c.from, c.to].map((end) => {
      const ports = portsOf(state, end, ctx);
      if (!ports) {
        err('end-missing', `cable ${name}: ${end.block ? `block "${end.block}"` : `device "${end.device}"`} does not exist`, c.id);
        return null;
      }
      const port = ports.find((p) => p.id === end.port);
      if (!port) {
        err('port-missing', `cable ${name}: port "${end.port}" does not exist on ${endLabel(state, end, ctx)}`, c.id);
        return null;
      }
      const key = endpointKey(end);
      if (seen.has(key)) err('port-busy', `cable ${name} and ${seen.get(key)} both end on ${endLabel(state, end, ctx)} ${port.label}`, c.id);
      seen.set(key, name);
      return port;
    });
    if (ends[0] && ends[1]) {
      const kinds = cableKindsFor(ctx.library, ends[0].connector, ends[1].connector);
      if (!cableFor(ctx.library, c.kind)) err('kind-missing', `cable ${name}: cable kind "${c.kind}" no longer exists`, c.id);
      else if (!kinds.includes(c.kind)) err('kind-mismatch', `cable ${name}: a ${c.kind} cable does not join ${ends[0].connector} to ${ends[1].connector}`, c.id);
      if (ends[0].direction === 'out' && ends[1].direction === 'out') err('direction', `cable ${name} joins two outputs`, c.id);
      if (ends[0].direction === 'in' && ends[1].direction === 'in') err('direction', `cable ${name} joins two inputs`, c.id);
    }
  }
  for (const d of state.devices) {
    const tpl = templateFor(ctx.library, d.template);
    const powerIn = tpl?.ports.find((p) => p.direction === 'in' && isPowerConnector(ctx, p.connector));
    if (powerIn && !seen.has(endpointKey({ device: d.id, port: powerIn.id }))) warn('device-unpowered', `${d.label} has no power cable`, d.id);
  }
  for (const l of state.locations) {
    if (![...state.devices, ...state.blocks].some((x) => x.location === l.id)) warn('location-empty', `${l.label} holds nothing`, l.id);
  }
  return { errors, warnings };
}

/** A connector any power cable may terminate in. */
const isPowerConnector = (ctx, connector) => !!cableFor(ctx.library, 'power')?.joins.some((pair) => pair.includes(connector));

/* ---- derived tables ---- */

export function cableSchedule(state, ctx) {
  return state.cables.map((c) => ({
    id: c.id,
    label: c.label,
    kind: c.kind,
    kindLabel: cableFor(ctx.library, c.kind)?.label || c.kind,
    from: endLabel(state, c.from, ctx),
    fromPort: portLabel(state, c.from, ctx),
    to: endLabel(state, c.to, ctx),
    toPort: portLabel(state, c.to, ctx),
    length: c.length,
    notes: c.notes,
  }));
}

export const OP_NAMES = Object.keys(OPS);
export { connectorFor };
```

- [ ] **Step 4: Run the tests**

Run: `node --test server/schematic.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/schematic.js server/schematic.test.js
git commit -m "Schematics: pure operation applier, validator and cable schedule

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Library persistence and installations (git-backed)

**Files:**
- Modify: `server/store.js` (export `mutate`, `readJson`, `readJsonMany`; add `installation` to manuals)
- Create: `server/schematics-store.js` (first half: library + installations)
- Test: `server/schematics-store.test.js`

**Interfaces:**
- Consumes from `store.js`: `repo`, `mutate(fn)`, `readJson(ref, file)`, `readJsonMany([{ref,file}])`,
  `slugify`, `listHardware()`, `listModules()`, `getModule(ref)`, `listManuals()`.
- Produces (schematics-store.js):
  - `LIB_CONNECTORS_FILE = 'library/connectors.json'`, `LIB_DEVICES_FILE = 'library/devices.json'`
  - `getLibrary() → {connectors, cables, devices}`
  - `saveConnectors({connectors, cables}) → library`
  - `createDeviceTemplate(spec) → template`, `updateDeviceTemplate(id, patch) → template`,
    `deleteDeviceTemplate(id) → {ok, id}` (refused while a schematic uses it)
  - `listInstallations() → [{slug, name, device, serialNumber, operator, createdAt, updatedAt, schematic: {version, status} | null}]`
  - `getInstallation(slug) → record | null`
  - `createInstallation({name, device, serialNumber, operator, locations}) → record` (also writes the
    first schematic draft through `writeFirstSchematic`, whose minimal version is in this task and whose
    final one is Task 5's)
  - `updateInstallation(slug, patch) → record`, `deleteInstallation(slug) → {slug, branchesDeleted}`
  - `instRef(slug) → 'inst:<slug>'`, `isInstRef(ref)`, `refSlug(ref)`

- [ ] **Step 1: Export the store internals the new module needs**

In `server/store.js`:
- change `async function mutate(fn) {` to `export async function mutate(fn) {`
- change `async function readJson(ref, file) {` to `export async function readJson(ref, file) {`
- change `async function readJsonMany(requests) {` to `export async function readJsonMany(requests) {`

In `createManual` (store.js ~line 2720) add `installation` to the destructured argument and to the
record right after `operator`:

```js
export async function createManual({ name, code, group, modules, manual: type, device, serialNumber, operator, installation }) {
  …
    operator: String(operator || '').trim() || null,
    // the installation whose wiring this manual prints and whose device / serial / operator its cover names
    installation: String(installation || '').trim() || null,
```

In `updateManual` after the `for (const k of ['device', 'serialNumber', 'operator'])` line add:

```js
  if (patch.installation !== undefined) manual.installation = String(patch.installation || '').trim() || null;
```

- [ ] **Step 2: Write the failing tests**

`server/schematics-store.test.js` (this file grows in Task 5; start it like this):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.FTD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ftd-schematics-'));
const store = await import('./store.js');
await store.initStore();
const sch = await import('./schematics-store.js');
const { blankContent } = await import('./docgen.js');
const { SchematicError } = await import('./schematic.js');

test.after(() => fs.rmSync(process.env.FTD_DATA_DIR, { recursive: true, force: true }));

test('library reads the defaults until something is saved, then the saved file', async () => {
  const lib = await sch.getLibrary();
  assert.ok(lib.devices.some((d) => d.id === 'behringer-umc404hd'));
  const t = await sch.createDeviceTemplate({ name: 'Netgear GS724T', category: 'switch', ports: [{ id: 'p1', label: 'Port 1', connector: 'rj45' }] });
  assert.equal(t.id, 'netgear-gs724t');
  assert.ok((await sch.getLibrary()).devices.some((d) => d.id === 'netgear-gs724t'));
  assert.ok((await sch.getLibrary()).devices.some((d) => d.id === 'behringer-umc404hd'), 'seed templates are kept when the first custom one is saved');
  await assert.rejects(sch.createDeviceTemplate({ name: 'Netgear GS724T', id: 'netgear-gs724t' }), /already exists/);
  const u = await sch.updateDeviceTemplate('netgear-gs724t', { model: 'GS724T', ports: [{ id: 'p1', label: 'Port 1', connector: 'rj45' }, { id: 'pwr', label: 'Power', connector: 'iec-c14', direction: 'in' }] });
  assert.equal(u.ports.length, 2);
  assert.equal(u.model, 'GS724T');
  await assert.rejects(sch.updateDeviceTemplate('nope', {}), /not found/);
});

test('connectors: saved set must be consistent', async () => {
  const lib = await sch.getLibrary();
  await assert.rejects(sch.saveConnectors({ connectors: lib.connectors, cables: [{ id: 'x', label: 'X', joins: [['rj45', 'nope']] }] }), /nope/);
  await assert.rejects(sch.saveConnectors({ connectors: [{ id: 'rj45', label: 'A' }, { id: 'rj45', label: 'B' }], cables: [] }), /twice/);
  const saved = await sch.saveConnectors({ connectors: [...lib.connectors, { id: 'rj12', label: 'RJ12', color: '#999' }], cables: [...lib.cables, { id: 'phone', label: 'Phone', joins: [['rj12', 'rj12']], style: {} }] });
  assert.ok(saved.connectors.some((c) => c.id === 'rj12'));
  assert.ok((await sch.getLibrary()).cables.some((c) => c.id === 'phone'));
});

test('installations: create, list, update, delete', async () => {
  const inst = await sch.createInstallation({ name: 'B737 NG FTD #001', device: 'B737 NG FTD', serialNumber: 'FTD-2026-001', operator: 'Example Academy' });
  assert.equal(inst.slug, 'b737-ng-ftd-001');
  await assert.rejects(sch.createInstallation({ name: 'B737 NG FTD #001' }), /already exists/);
  await assert.rejects(sch.createInstallation({ name: '' }), /name/i);
  const list = await sch.listInstallations();
  assert.equal(list.length, 1);
  assert.equal(list[0].serialNumber, 'FTD-2026-001');
  const upd = await sch.updateInstallation(inst.slug, { operator: 'Other Academy', serialNumber: '' });
  assert.equal(upd.operator, 'Other Academy');
  assert.equal(upd.serialNumber, null);
  assert.equal((await sch.getInstallation(inst.slug)).operator, 'Other Academy');
  assert.equal(await sch.getInstallation('nope'), null);
  const del = await sch.deleteInstallation(inst.slug);
  assert.equal(del.slug, inst.slug);
  assert.equal(await sch.getInstallation(inst.slug), null);
  await assert.rejects(sch.deleteInstallation(inst.slug), /not found/);
});

test('a manual can link an installation', async () => {
  const inst = await sch.createInstallation({ name: 'Linked sim' });
  const m = await store.createManual({ name: 'Linked manual', manual: 'technician', modules: [], installation: inst.slug });
  assert.equal(m.installation, 'linked-sim');
  await assert.rejects(sch.deleteInstallation(inst.slug), /Linked manual/);
  await store.updateManual(m.slug, { installation: '' });
  assert.equal((await store.getManual(m.slug)).installation, null);
  await sch.deleteInstallation(inst.slug);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test server/schematics-store.test.js`
Expected: FAIL, `Cannot find module './schematics-store.js'`.

- [ ] **Step 4: Implement the first half of `server/schematics-store.js`**

```js
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
```

The functions `readLive`, `branchPrefix`, `writeFirstSchematic` and `allSchematics` are Task 5's; for
this task's tests to pass add these minimal versions at the end of the file (Task 5 replaces them):

```js
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
```

- [ ] **Step 5: Run the tests**

Run: `node --test server/schematics-store.test.js`
Expected: all pass. Then `npm test` for the whole set.

- [ ] **Step 6: Commit**

```bash
git add server/store.js server/schematics-store.js server/schematics-store.test.js
git commit -m "Schematics: device library files, installations, manual link

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Schematic lifecycle (draft, ops, review, release, hotfix, discard, next version, promotion)

**Files:**
- Modify: `server/schematics-store.js` (second half)
- Modify: `server/store.js` (`setSchematicProvider` hook, used in Task 9)
- Test: `server/schematics-store.test.js` (append)

**Interfaces:**
- Produces:
  - `schematicContext() → ctx` (`{library, catalog, modules, releasedSchematics}` as Task 3 defines)
  - `releasedSchematicOf(slug) → moduleState | null` (the `main` copy when released)
  - `resolveSchematicRef(ref) → ref` (module slug wins; else installation slug or name → `inst:<slug>`)
  - `getSchematic(ref) → null | { owner: {ref, kind: 'module'|'installation', slug, name}, state, released, isDraft,
    editable, branch, validation: {errors, warnings}, schedule, face, history: [{hash,date,author,subject}] }`
  - `createSchematic(ref, {bump = 'minor'}) → state` (first draft, or the next version from the released one)
  - `applySchematicOps(ref, ops, {summary = '', dryRun = false}) → {state, summary: string[], validation}`
  - `setSchematicStatus(ref, 'draft'|'in-review') → state`
  - `releaseSchematic(ref, {note}) → state` (throws `{code: 'note-required'}` / `{code: 'blockers', blockers}`)
  - `setSchematicReleaseNote(ref, note) → state`
  - `startSchematicHotfix(ref) → state`, `discardSchematic(ref) → {ok}`
  - `promoteDeviceToModule(templateId, {name, code, category}) → {slug, hardwareId, schematic}`
- `store.js` gains `export function setSchematicProvider(fn)` and `schematicProvider` is called in Task 9.

- [ ] **Step 1: Append the failing tests**

Append to `server/schematics-store.test.js`:

```js
async function makeModule(name, hardware = []) {
  const r = await store.createModuleDoc({ name, hardware, softwares: [] }, [{ manual: 'technician', content: blankContent(name, [], 'technician', []) }]);
  return r.slug;
}

test('module schematic: create, ops as commits, review, release with note, next version', async () => {
  const slug = await makeModule('Audio system', [{ name: 'Behringer UMC404HD', type: 'cots', manufacturer: 'Behringer', model: 'UMC404HD' }]);
  assert.equal(await sch.getSchematic(slug), null, 'no schematic yet');
  assert.equal(await sch.getSchematic('no-such-module'), null);
  const created = await sch.createSchematic(slug);
  assert.equal(created.version, 'A1.0');
  assert.equal(created.branch, `draft/${slug}-schematic-a1.0`);
  await assert.rejects(sch.createSchematic(slug), /already open/);

  const hwId = (await store.listHardware()).find((h) => h.name === 'Behringer UMC404HD').id;
  const dry = await sch.applySchematicOps(slug, [{ op: 'add_device', id: 'umc', hardwareId: hwId, template: 'behringer-umc404hd' }], { dryRun: true });
  assert.equal(dry.state.devices.length, 1);
  assert.equal((await sch.getSchematic(slug)).state.devices.length, 0, 'dry run writes nothing');

  const r = await sch.applySchematicOps(
    slug,
    [
      { op: 'add_device', id: 'umc', hardwareId: hwId, template: 'behringer-umc404hd', label: 'UMC404HD' },
      { op: 'add_device', id: 'hs', template: 'headset', label: 'Headset L' },
      { op: 'connect', id: 'c1', from: { device: 'umc', port: 'phones-1' }, to: { device: 'hs', port: 'jack' }, label: 'AUD-01' },
      { op: 'set_external_port', id: 'power-in', label: 'Power in', device: 'umc', port: 'pwr' },
    ],
    { summary: 'First wiring' }
  );
  assert.equal(r.state.revision, 2);
  assert.equal(r.summary.length, 4);
  await assert.rejects(sch.applySchematicOps(slug, [{ op: 'connect', from: { device: 'umc', port: 'nope' }, to: { device: 'hs', port: 'jack' } }]), (e) => e instanceof SchematicError && e.index === 0);

  let g = await sch.getSchematic(slug);
  assert.equal(g.owner.kind, 'module');
  assert.equal(g.owner.name, 'Audio system');
  assert.equal(g.isDraft, true);
  assert.equal(g.face.length, 1);
  assert.equal(g.schedule[0].kindLabel, 'Audio');
  assert.ok(g.history.length >= 2);
  assert.ok(g.validation.warnings.some((w) => w.code === 'device-unpowered'));

  await assert.rejects(sch.releaseSchematic(slug, { note: '' }), (e) => e.code === 'note-required');
  assert.equal((await sch.setSchematicStatus(slug, 'in-review')).status, 'in-review');
  const rel = await sch.releaseSchematic(slug, { note: 'Initial wiring of the audio system.' });
  assert.equal(rel.status, 'released');
  assert.equal(rel.branch, null);
  assert.equal(rel.releaseRecord.at(-1).summary, 'Initial wiring of the audio system.');
  assert.ok(rel.releaseRecord.at(-1).public);
  assert.ok(!(await store.repo.branches()).includes(`draft/${slug}-schematic-a1.0`));
  g = await sch.getSchematic(slug);
  assert.equal(g.isDraft, false);
  assert.equal(g.released.version, 'A1.0');
  assert.equal((await sch.releasedSchematicOf(slug)).revision, rel.revision);
  await assert.rejects(sch.applySchematicOps(slug, [{ op: 'tidy' }]), /no open draft/i);

  const next = await sch.createSchematic(slug, { bump: 'minor' });
  assert.equal(next.version, 'A1.1');
  assert.equal(next.revision, 1);
  assert.equal(next.devices.length, 2, 'the next version starts from the released netlist');
  assert.equal((await sch.releasedSchematicOf(slug)).version, 'A1.0', 'main still holds the release');
  g = await sch.getSchematic(slug);
  assert.equal(g.state.version, 'A1.1');
  assert.equal(g.released.version, 'A1.0');
  await sch.discardSchematic(slug);
  assert.equal((await sch.getSchematic(slug)).state.version, 'A1.0');
  await assert.rejects(sch.discardSchematic(slug), /no open draft/i);
});

test('hotfix: branch reopens the released version, publish writes it back, release note can be rewritten', async () => {
  const slug = await makeModule('Hotfix module');
  await sch.createSchematic(slug);
  await sch.applySchematicOps(slug, [{ op: 'add_device', id: 'hs', template: 'headset', label: 'Headset' }]);
  await sch.releaseSchematic(slug, { note: 'First.' });
  const released = await sch.releasedSchematicOf(slug);
  await assert.rejects(sch.startSchematicHotfix('no-such'), /not found/);
  const hf = await sch.startSchematicHotfix(slug);
  assert.equal(hf.revision, released.revision + 1);
  assert.ok(hf.hotfix);
  assert.equal(hf.status, 'released');
  await assert.rejects(sch.createSchematic(slug), /hotfix|open/i);
  await assert.rejects(sch.startSchematicHotfix(slug), /already/);
  const g = await sch.getSchematic(slug);
  assert.equal(g.editable, true);
  await sch.applySchematicOps(slug, [{ op: 'update_device', id: 'hs', label: 'Headset (captain)' }]);
  assert.equal((await sch.releasedSchematicOf(slug)).devices[0].label, 'Headset', 'main keeps compiling the released copy');
  const pub = await sch.releaseSchematic(slug, { note: 'Renamed the headset.' });
  assert.equal(pub.hotfix, null);
  assert.equal(pub.version, 'A1.0');
  assert.equal((await sch.releasedSchematicOf(slug)).devices[0].label, 'Headset (captain)');
  const noted = await sch.setSchematicReleaseNote(slug, 'Renamed the captain headset.');
  assert.equal(noted.releaseRecord.at(-1).summary, 'Renamed the captain headset.');
});

test('installation: blocks follow released module schematics, outdated blocks are reported, resolveSchematicRef', async () => {
  const slug = await makeModule('Rack audio');
  await sch.createSchematic(slug);
  await sch.applySchematicOps(slug, [{ op: 'add_device', id: 'umc', template: 'behringer-umc404hd' }, { op: 'set_external_port', id: 'power-in', label: 'Power in', device: 'umc', port: 'pwr' }]);
  await assert.rejects(sch.applySchematicOps(instRefOf(await sch.createInstallation({ name: 'Sim A' })), [{ op: 'place_block', id: 'audio', module: slug, location: 'rack-1' }]), /no released schematic/);
  await sch.releaseSchematic(slug, { note: 'Released.' });
  const ref = sch.instRef('sim-a');
  assert.equal(await sch.resolveSchematicRef('Sim A'), ref);
  assert.equal(await sch.resolveSchematicRef('sim-a'), ref);
  assert.equal(await sch.resolveSchematicRef(slug), slug);
  const g0 = await sch.getSchematic(ref);
  assert.equal(g0.owner.kind, 'installation');
  assert.equal(g0.state.locations.length, 3, 'default locations');
  await sch.applySchematicOps(ref, [
    { op: 'place_block', id: 'audio', module: slug, location: 'rack-1' },
    { op: 'add_device', id: 'pdu-1', template: 'pdu-8', label: 'Power strip 1', location: 'rack-1' },
    { op: 'connect', from: { device: 'pdu-1', port: 'out-1' }, to: { block: 'audio', port: 'power-in' }, label: 'PWR-01' },
  ]);
  let g = await sch.getSchematic(ref);
  assert.deepEqual(g.validation.errors, []);
  assert.equal(g.schedule[0].to, 'Rack audio');
  // the module releases a new schematic version: the block is outdated until refreshed
  await sch.createSchematic(slug);
  await sch.applySchematicOps(slug, [{ op: 'add_device', id: 'hs', template: 'headset' }]);
  await sch.releaseSchematic(slug, { note: 'Added the headset.' });
  g = await sch.getSchematic(ref);
  assert.ok(g.validation.warnings.some((w) => w.code === 'block-outdated'));
  await sch.applySchematicOps(ref, [{ op: 'refresh_block', id: 'audio' }]);
  g = await sch.getSchematic(ref);
  assert.ok(!g.validation.warnings.some((w) => w.code === 'block-outdated'));
  assert.equal(g.state.blocks[0].schematic.version, 'A1.1');
  const rel = await sch.releaseSchematic(ref, { note: 'Installation wiring issue 1.' });
  assert.equal(rel.status, 'released');
  const list = await sch.listInstallations();
  assert.equal(list.find((i) => i.slug === 'sim-a').schematic.status, 'released');
});

function instRefOf(rec) {
  return sch.instRef(rec.slug);
}

test('promoteDeviceToModule creates the module, its catalog item and a schematic exposing every port', async () => {
  const t = await sch.createDeviceTemplate({ name: 'Cisco SG350', category: 'switch', manufacturer: 'Cisco', model: 'SG350-10', ports: [{ id: 'pwr', label: 'Power', connector: 'iec-c14', direction: 'in' }, { id: 'p1', label: 'Port 1', connector: 'rj45' }] });
  const r = await sch.promoteDeviceToModule(t.id, { name: 'Core switch', code: 'CSW' });
  assert.equal(r.slug, 'core-switch');
  const m = await store.getModule('core-switch');
  assert.equal(m.module.hardwareItems[0].manufacturer, 'Cisco');
  assert.equal((await sch.getLibrary()).devices.find((d) => d.id === t.id).hardwareId, r.hardwareId);
  const g = await sch.getSchematic('core-switch');
  assert.equal(g.state.devices.length, 1);
  assert.deepEqual(g.face.map((p) => p.port), ['pwr', 'p1']);
  await assert.rejects(sch.promoteDeviceToModule('nope', { name: 'X' }), /not found/);
});
```

Also add this test, which pins the release blockers and the used-template rule:

```js
test('release is refused while validation has errors, and a used template cannot be deleted', async () => {
  const slug = await makeModule('Broken module');
  await sch.createSchematic(slug);
  await sch.applySchematicOps(slug, [{ op: 'add_device', id: 'sw', template: 'switch-24' }]);
  await assert.rejects(sch.deleteDeviceTemplate('switch-24'), /broken-module/);
  // an error that only validation sees: the device's template vanishes from the library file
  const lib = await sch.getLibrary();
  await store.mutate(async () => {
    await store.repo.checkout('main');
    await store.repo.writeFile(sch.LIB_DEVICES_FILE, JSON.stringify({ devices: lib.devices.filter((d) => d.id !== 'switch-24') }, null, 2) + '\n');
    await store.repo.commitAll('test: drop switch-24');
  });
  sch.dropCaches();
  await assert.rejects(sch.releaseSchematic(slug, { note: 'x' }), (e) => e.code === 'blockers' && /template-missing/.test(JSON.stringify(e.blockers)));
  await store.mutate(async () => {
    await store.repo.checkout('main');
    await store.repo.writeFile(sch.LIB_DEVICES_FILE, JSON.stringify({ devices: lib.devices }, null, 2) + '\n');
    await store.repo.commitAll('test: restore switch-24');
  });
  sch.dropCaches();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test server/schematics-store.test.js`
Expected: the new tests FAIL with `sch.createSchematic is not a function`.

- [ ] **Step 3: Implement the lifecycle (replace the Task 4 stub block at the end of `schematics-store.js`)**

```js
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
```

In `server/store.js`, near `getAiGuidelines` (any top-level spot after the imports), add the hook that
Task 9 uses:

```js
/* ------------------------------------------------------------------ */
/* Schematics hook — schematics-store.js registers how a module's       */
/* released wiring is rendered; the store never imports that module.   */
/* ------------------------------------------------------------------ */
let schematicProvider = null;
/** fn({ module, manual, lang, installation? }) → { svg, face, schedule, state } | null */
export function setSchematicProvider(fn) {
  schematicProvider = fn;
}
export const schematicFor = (args) => (schematicProvider ? schematicProvider(args) : Promise.resolve(null));
```

- [ ] **Step 4: Run the tests**

Run: `node --test server/schematics-store.test.js`
Expected: all pass. Note: `Array.prototype.findLastIndex` needs Node 18+, fine on 22.

- [ ] **Step 5: Commit**

```bash
git add server/store.js server/schematics-store.js server/schematics-store.test.js
git commit -m "Schematics: draft, ops, review, release, hotfix and promotion lifecycle

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Server-side layout and SVG render

**Files:**
- Create: `server/schematic-render.js`
- Modify: `package.json` (add `elkjs`)
- Test: `server/schematic-render.test.js`

**Interfaces:**
- Consumes: `ctx` (Task 3), `cableSchedule`, `connectorFace`, `portsOf` from `schematic.js`,
  `templateFor`, `cableFor`, `connectorFor` from `library.js`, `strings(lang)` from `docgen.js` (Task 9
  adds the keys; until then the render uses the English fallbacks below).
- Produces:
  - `layoutSchematic(state, ctx) → Promise<{ nodes: {id: {x,y,w,h}}, frames: {id: {x,y,w,h}}, edges: {id: [{x,y}, …]}, width, height }>`
    (positions in `state.layout.nodes` for nodes marked manual win; everything else from elk)
  - `renderSvg(state, ctx, { lang = 'en', title = '' } = {}) → Promise<string>` (a complete `<svg>` element)
  - `scheduleHtml(schedule, lang) → string` (the Cable schedule `<table>`), `faceHtml(face, lang) → string` (Port list `<table>`)
  - `schematicCsv(schedule) → string`
  - Geometry constants `NODE_W = 160`, `PORT_PITCH = 14`, `FRAME_PAD = 24`.

- [ ] **Step 1: Install elkjs**

Run: `npm install elkjs@0.9.3`
Expected: `package.json` gains `"elkjs": "^0.9.3"` under dependencies; `node -e "import('elkjs/lib/elk.bundled.js').then(m => console.log(typeof m.default))"` prints `function`.

- [ ] **Step 2: Write the failing tests**

`server/schematic-render.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIBRARY } from './library.js';
import { emptySchematic, applyOps, cableSchedule, connectorFace } from './schematic.js';
import { layoutSchematic, renderSvg, scheduleHtml, faceHtml, schematicCsv } from './schematic-render.js';

const ctx = () => ({ library: DEFAULT_LIBRARY, catalog: [], modules: [{ slug: 'audio-system', name: 'Audio system' }], releasedSchematics: new Map() });

function fixture() {
  return applyOps(
    emptySchematic({ kind: 'installation', owner: 'sim' }),
    [
      { op: 'add_location', id: 'rack-1', label: 'Rack 1', kind: 'rack' },
      { op: 'add_location', id: 'cockpit', label: 'Cockpit' },
      { op: 'add_device', id: 'pdu-1', template: 'pdu-8', label: 'Power strip 1', location: 'rack-1' },
      { op: 'add_device', id: 'umc', template: 'behringer-umc404hd', label: 'UMC404HD', location: 'rack-1' },
      { op: 'add_device', id: 'hs', template: 'headset', label: 'Headset L', location: 'cockpit' },
      { op: 'connect', id: 'pwr', from: { device: 'pdu-1', port: 'out-1' }, to: { device: 'umc', port: 'pwr' }, label: 'PWR-01' },
      { op: 'connect', id: 'aud', from: { device: 'umc', port: 'phones-1' }, to: { device: 'hs', port: 'jack' }, label: 'AUD-01', length: 3 },
    ],
    ctx()
  ).state;
}

test('layout places every node inside its frame and routes every cable', async () => {
  const s = fixture();
  const l = await layoutSchematic(s, ctx());
  for (const id of ['pdu-1', 'umc', 'hs']) assert.ok(l.nodes[id] && l.nodes[id].w > 0, `node ${id}`);
  for (const id of ['rack-1', 'cockpit']) assert.ok(l.frames[id] && l.frames[id].w > 0, `frame ${id}`);
  const inside = (n, f) => n.x >= f.x && n.y >= f.y && n.x + n.w <= f.x + f.w && n.y + n.h <= f.y + f.h;
  assert.ok(inside(l.nodes.umc, l.frames['rack-1']));
  assert.ok(inside(l.nodes.hs, l.frames.cockpit));
  assert.ok(l.edges.pwr.length >= 2 && l.edges.aud.length >= 2);
  assert.ok(l.width > 0 && l.height > 0);
});

test('a hand-moved node keeps its position', async () => {
  const s = applyOps(fixture(), [{ op: 'move', id: 'hs', x: 900, y: 40 }], ctx()).state;
  const l = await layoutSchematic(s, ctx());
  assert.equal(l.nodes.hs.x, 900);
  assert.equal(l.nodes.hs.y, 40);
});

test('renderSvg emits one svg with a group per device, a frame per location, a path per cable, and port labels', async () => {
  const svg = await renderSvg(fixture(), ctx(), { title: 'Sim wiring' });
  assert.match(svg, /^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.equal((svg.match(/class="sch-device"/g) || []).length, 3);
  assert.equal((svg.match(/class="sch-frame/g) || []).length, 2);
  assert.equal((svg.match(/class="sch-cable/g) || []).length, 2);
  assert.match(svg, />Socket 1</);
  assert.match(svg, />PWR-01</);
  assert.match(svg, /font-family="Verdana/);
  assert.match(svg, /stroke-dasharray="6 3"/, 'audio prints dashed');
  assert.doesNotMatch(svg, /<script/);
});

test('a module schematic renders its external ports as a connector face', async () => {
  const m = applyOps(
    emptySchematic({ kind: 'module', owner: 'audio-system' }),
    [{ op: 'add_device', id: 'umc', template: 'behringer-umc404hd' }, { op: 'set_external_port', id: 'power-in', label: 'Power in', device: 'umc', port: 'pwr' }],
    ctx()
  ).state;
  const svg = await renderSvg(m, ctx());
  assert.match(svg, /class="sch-external"/);
  assert.match(svg, />Power in \(IEC C14\)</);
});

test('tables and csv', () => {
  const s = fixture();
  const html = scheduleHtml(cableSchedule(s, ctx()), 'en');
  assert.match(html, /<table class="cable-schedule">/);
  assert.match(html, /<th>Cable<\/th><th>Kind<\/th><th>From<\/th><th>Port<\/th><th>To<\/th><th>Port<\/th><th>Length<\/th>/);
  assert.match(html, /PWR-01/);
  assert.match(html, /3 m/);
  const pl = scheduleHtml(cableSchedule(s, ctx()), 'pl');
  assert.match(pl, /<th>Kabel<\/th>/);
  const face = faceHtml(connectorFace(applyOps(emptySchematic({ kind: 'module', owner: 'm' }), [{ op: 'add_device', id: 'umc', template: 'behringer-umc404hd' }, { op: 'set_external_port', id: 'p', label: 'Power in', device: 'umc', port: 'pwr' }], ctx()).state, ctx()), 'en');
  assert.match(face, /<table class="port-list">/);
  assert.match(face, /IEC C14/);
  const csv = schematicCsv(cableSchedule(s, ctx()));
  assert.equal(csv.split('\n')[0], 'label,kind,from,from_port,to,to_port,length_m,notes');
  assert.match(csv, /PWR-01,Power,Power strip 1,Socket 1,UMC404HD,Power,,/);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test server/schematic-render.test.js`
Expected: FAIL, `Cannot find module './schematic-render.js'`.

- [ ] **Step 4: Implement `server/schematic-render.js`**

```js
/**
 * The drawing of a schematic: elk lays the netlist out (devices and blocks inside location frames,
 * ports on the declared side), and the SVG is written by hand so the export never needs a browser.
 * Verdana, black lines; cable kinds differ by dash pattern as well as colour so a monochrome print
 * still reads. Positions an author moved by hand (`layout.manual`) are kept.
 */
import ELK from 'elkjs/lib/elk.bundled.js';
import { cableSchedule, connectorFace, portsOf } from './schematic.js';
import { templateFor, cableFor, connectorFor } from './library.js';

export const NODE_W = 160;
export const PORT_PITCH = 14;
export const FRAME_PAD = 24;
const HEAD_H = 22;
const STUB = 10;
const FONT = 'Verdana, Geneva, sans-serif';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** English fallbacks; docgen's STRINGS override these once Task 9 adds the keys. */
const WORDS = {
  en: { cable: 'Cable', kind: 'Kind', from: 'From', port: 'Port', to: 'To', length: 'Length', notes: 'Notes', connector: 'Connector', inside: 'Inside', externalPorts: 'External ports', m: 'm', block: 'module' },
  pl: { cable: 'Kabel', kind: 'Rodzaj', from: 'Z', port: 'Port', to: 'Do', length: 'Długość', notes: 'Uwagi', connector: 'Złącze', inside: 'Wewnątrz', externalPorts: 'Porty zewnętrzne', m: 'm', block: 'moduł' },
};
const words = (lang) => WORDS[lang] || WORDS.en;

/* ---- node geometry ---- */

/** The ports a node shows, by side. A block shows its module's connector face. */
function nodePorts(state, node, ctx) {
  const ports = portsOf(state, node.block ? { block: node.id } : { device: node.id }, ctx) || [];
  const by = { left: [], right: [], top: [], bottom: [] };
  for (const p of ports) (by[p.side] || by.right).push(p);
  if (node.block) for (const p of ports) if (!p.side) by.left.push(p); // a face has no side: all on the left
  return by;
}

function nodeSize(by) {
  const rows = Math.max(by.left.length, by.right.length, 1);
  const cols = Math.max(by.top.length, by.bottom.length, 0);
  return { w: Math.max(NODE_W, cols * PORT_PITCH + 40), h: HEAD_H + rows * PORT_PITCH + 10 };
}

/** Where a port's stub ends, in node-local coordinates. */
function portPoint(by, size, portId) {
  for (const side of ['left', 'right', 'top', 'bottom']) {
    const i = by[side].findIndex((p) => p.id === portId);
    if (i < 0) continue;
    if (side === 'left') return { x: 0, y: HEAD_H + 7 + i * PORT_PITCH, side };
    if (side === 'right') return { x: size.w, y: HEAD_H + 7 + i * PORT_PITCH, side };
    if (side === 'top') return { x: 20 + i * PORT_PITCH, y: 0, side };
    return { x: 20 + i * PORT_PITCH, y: size.h, side };
  }
  return { x: size.w / 2, y: size.h / 2, side: 'right' };
}

const nodesOf = (state) => [...state.devices.map((d) => ({ ...d, kind: 'device' })), ...state.blocks.map((b) => ({ ...b, id: b.id, block: true, kind: 'block', label: null }))];
const endNode = (e) => e.block || e.device;

export async function layoutSchematic(state, ctx) {
  const elk = new ELK();
  const nodes = nodesOf(state);
  const meta = new Map(nodes.map((n) => {
    const by = nodePorts(state, n, ctx);
    return [n.id, { by, size: nodeSize(by) }];
  }));
  const manual = new Set(state.layout?.manual || []);
  const childOf = (n) => {
    const { size } = meta.get(n.id);
    const fixed = manual.has(n.id) && state.layout.nodes[n.id];
    return { id: n.id, width: size.w, height: size.h, ...(fixed ? { x: fixed.x, y: fixed.y, layoutOptions: { 'elk.position': `(${fixed.x},${fixed.y})` } } : {}) };
  };
  const frames = state.locations.map((l) => ({
    id: l.id,
    layoutOptions: { 'elk.padding': `[top=${FRAME_PAD + 10},left=${FRAME_PAD},bottom=${FRAME_PAD},right=${FRAME_PAD}]`, 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT' },
    children: nodes.filter((n) => n.location === l.id).map(childOf),
  }));
  const loose = nodes.filter((n) => !n.location || !state.locations.some((l) => l.id === n.location)).map(childOf);
  const graph = {
    id: 'root',
    layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.spacing.nodeNode': '30', 'elk.layered.spacing.nodeNodeBetweenLayers': '60', 'elk.hierarchyHandling': 'INCLUDE_CHILDREN' },
    children: [...frames, ...loose],
    edges: state.cables.map((c) => ({ id: c.id, sources: [endNode(c.from)], targets: [endNode(c.to)] })),
  };
  const out = await elk.layout(graph);
  const abs = { nodes: {}, frames: {}, edges: {} };
  const walk = (n, ox, oy, isFrame) => {
    const x = ox + (n.x || 0);
    const y = oy + (n.y || 0);
    (isFrame ? abs.frames : abs.nodes)[n.id] = { x, y, w: n.width || 0, h: n.height || 0 };
    for (const c of n.children || []) walk(c, x, y, false);
  };
  for (const c of out.children || []) walk(c, 0, 0, state.locations.some((l) => l.id === c.id));
  // a manual position is absolute: overwrite what elk did with it
  for (const id of manual) if (state.layout.nodes[id] && abs.nodes[id]) Object.assign(abs.nodes[id], state.layout.nodes[id]);
  // cables go port to port: straight stubs out of each port, then an orthogonal dog-leg
  for (const c of state.cables) {
    const a = portAbs(state, abs, meta, c.from);
    const b = portAbs(state, abs, meta, c.to);
    if (!a || !b) continue;
    const a2 = { x: a.x + (a.side === 'left' ? -STUB : a.side === 'right' ? STUB : 0), y: a.y + (a.side === 'top' ? -STUB : a.side === 'bottom' ? STUB : 0) };
    const b2 = { x: b.x + (b.side === 'left' ? -STUB : b.side === 'right' ? STUB : 0), y: b.y + (b.side === 'top' ? -STUB : b.side === 'bottom' ? STUB : 0) };
    const midX = (a2.x + b2.x) / 2;
    abs.edges[c.id] = [a, a2, { x: midX, y: a2.y }, { x: midX, y: b2.y }, b2, b];
  }
  const all = [...Object.values(abs.nodes), ...Object.values(abs.frames)];
  return { ...abs, width: Math.max(out.width || 0, ...all.map((n) => n.x + n.w)) + 20, height: Math.max(out.height || 0, ...all.map((n) => n.y + n.h)) + 20 };
}

function portAbs(state, abs, meta, end) {
  const id = endNode(end);
  const n = abs.nodes[id];
  const m = meta.get(id);
  if (!n || !m) return null;
  const p = portPoint(m.by, m.size, end.port);
  return { x: n.x + p.x, y: n.y + p.y, side: p.side };
}

/* ---- SVG ---- */

export async function renderSvg(state, ctx, { lang = 'en', title = '' } = {}) {
  const W = words(lang);
  const l = await layoutSchematic(state, ctx);
  const nodes = nodesOf(state);
  const parts = [];
  for (const loc of state.locations) {
    const f = l.frames[loc.id];
    if (!f) continue;
    parts.push(`<g class="sch-frame sch-frame-${esc(loc.kind)}"><rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" rx="6" fill="none" stroke="#000" stroke-width="0.8" stroke-dasharray="${loc.kind === 'rack' ? '' : '4 3'}"/><text x="${f.x + 8}" y="${f.y + 15}" font-size="11" font-weight="bold">${esc(loc.label)}</text></g>`);
  }
  for (const n of nodes) {
    const box = l.nodes[n.id];
    if (!box) continue;
    const by = nodePorts(state, n, ctx);
    const size = { w: box.w, h: box.h };
    const label = n.block ? ctx.modules.find((m) => m.slug === n.module)?.name || n.module : n.label;
    const sub = n.block ? `${W.block} · ${n.schematic?.version || ''}` : templateFor(ctx.library, n.template)?.model || '';
    const ports = ['left', 'right', 'top', 'bottom'].flatMap((side) =>
      by[side].map((p) => {
        const pt = portPoint(by, size, p.id);
        const col = connectorFor(ctx.library, p.connector)?.color || '#000';
        const x2 = pt.x + (side === 'left' ? -STUB : side === 'right' ? STUB : 0);
        const y2 = pt.y + (side === 'top' ? -STUB : side === 'bottom' ? STUB : 0);
        const tx = side === 'left' ? pt.x + 4 : side === 'right' ? pt.x - 4 : pt.x;
        const anchor = side === 'left' ? 'start' : side === 'right' ? 'end' : 'middle';
        return `<g class="sch-port" data-port="${esc(p.id)}"><line x1="${box.x + pt.x}" y1="${box.y + pt.y}" x2="${box.x + x2}" y2="${box.y + y2}" stroke="${col}" stroke-width="1.5"/><text x="${box.x + tx}" y="${box.y + pt.y + 3}" font-size="7" text-anchor="${anchor}">${esc(p.label)}</text></g>`;
      })
    );
    parts.push(`<g class="sch-${n.block ? 'block' : 'device'}" data-id="${esc(n.id)}"><rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="#fff" stroke="#000" stroke-width="${n.block ? 1.6 : 1}"/><text x="${box.x + box.w / 2}" y="${box.y + 13}" font-size="9" font-weight="bold" text-anchor="middle">${esc(label)}</text>${sub ? `<text x="${box.x + box.w / 2}" y="${box.y + HEAD_H - 2}" font-size="6.5" text-anchor="middle" fill="#444">${esc(sub)}</text>` : ''}${ports.join('')}</g>`);
  }
  for (const c of state.cables) {
    const pts = l.edges[c.id];
    if (!pts) continue;
    const kind = cableFor(ctx.library, c.kind);
    const st = kind?.style || {};
    const mid = pts[Math.floor(pts.length / 2)];
    parts.push(`<g class="sch-cable sch-cable-${esc(c.kind)}" data-id="${esc(c.id)}"><polyline points="${pts.map((p) => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="${st.color || '#000'}" stroke-width="${st.width || 1.2}"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''}/>${c.label ? `<text x="${mid.x + 3}" y="${mid.y - 3}" font-size="7" fill="#000">${esc(c.label)}</text>` : ''}</g>`);
  }
  // a module's connector face: its external ports as a column on the left edge
  if (state.kind === 'module' && state.externalPorts.length) {
    const face = connectorFace(state, ctx);
    face.forEach((p, i) => {
      const y = 30 + i * 18;
      parts.push(`<g class="sch-external" data-id="${esc(p.id)}"><rect x="4" y="${y - 9}" width="90" height="14" fill="#f3f3f3" stroke="#000" stroke-width="0.6"/><text x="8" y="${y + 1}" font-size="7">${esc(p.label)}${p.connector ? ` (${esc(connectorFor(ctx.library, p.connector)?.label || p.connector)})` : ''}</text></g>`);
    });
  }
  const width = Math.max(l.width, 300);
  const height = Math.max(l.height, 120, state.kind === 'module' ? 40 + state.externalPorts.length * 18 : 0);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="${FONT}" class="schematic" role="img"${title ? ` aria-label="${esc(title)}"` : ''}>${title ? `<title>${esc(title)}</title>` : ''}<rect width="${width}" height="${height}" fill="#fff"/>${parts.join('')}</svg>`;
}

/* ---- tables ---- */

const fmtLen = (n, W) => (n === null || n === undefined ? '' : `${n} ${W.m}`);

export function scheduleHtml(schedule, lang = 'en') {
  const W = words(lang);
  const rows = schedule.map((r) => `<tr><td>${esc(r.label || r.id)}</td><td>${esc(r.kindLabel)}</td><td>${esc(r.from)}</td><td>${esc(r.fromPort)}</td><td>${esc(r.to)}</td><td>${esc(r.toPort)}</td><td>${fmtLen(r.length, W)}</td></tr>`).join('\n');
  return `<table class="cable-schedule">\n<thead><tr><th>${W.cable}</th><th>${W.kind}</th><th>${W.from}</th><th>${W.port}</th><th>${W.to}</th><th>${W.port}</th><th>${W.length}</th></tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table>`;
}

export function faceHtml(face, lang = 'en', library = null) {
  const W = words(lang);
  const rows = face.map((p) => `<tr><td>${esc(p.label)}</td><td>${esc((library && connectorFor(library, p.connector)?.label) || CONNECTOR_LABELS[p.connector] || p.connector || '—')}</td><td>${esc(p.device)} · ${esc(p.port)}</td></tr>`).join('\n');
  return `<table class="port-list">\n<thead><tr><th>${W.port}</th><th>${W.connector}</th><th>${W.inside}</th></tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table>`;
}
import { DEFAULT_LIBRARY } from './library.js';
const CONNECTOR_LABELS = Object.fromEntries(DEFAULT_LIBRARY.connectors.map((c) => [c.id, c.label]));

export function schematicCsv(schedule) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = 'label,kind,from,from_port,to,to_port,length_m,notes';
  return [head, ...schedule.map((r) => [r.label || r.id, r.kindLabel, r.from, r.fromPort, r.to, r.toPort, r.length ?? '', r.notes].map(cell).join(','))].join('\n');
}
```

(Move the `import { DEFAULT_LIBRARY }` line up to the other imports; it is shown next to its use only
for reading.)

- [ ] **Step 5: Run the tests**

Run: `node --test server/schematic-render.test.js`
Expected: all pass. If elk puts a fixed node outside its frame in the "hand-moved" test, that is
expected: the assertion only checks the position is kept.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json server/schematic-render.js server/schematic-render.test.js
git commit -m "Schematics: elk layout and server-side SVG render, schedule and port-list tables

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: AI chat for schematics

**Files:**
- Modify: `server/ai.js` (export `callOpenAI` as `callModel`)
- Create: `server/schematic-ai.js`
- Test: `server/schematic-ai.test.js`

**Interfaces:**
- Consumes: `OP_NAMES`, `applyOps`, `validateSchematic` from `schematic.js`; `ctx`.
- Produces:
  - `describeState(state, ctx) → string` (compact text of the netlist for the prompt)
  - `describeLibrary(ctx) → string`
  - `buildPrompt({ state, ctx, guidelines, lang }) → string` (system prompt)
  - `parseOps(raw) → { reply, ops, note }` (never throws; unknown op names are dropped into `note`)
  - `schematicChat({ state, ctx, messages, guidelines = '', lang = 'en', callModel = ai.callModel })
    → { reply, ops, validation: {errors, warnings} | null, preview: state | null, note }`
    (ops are dry-run through `applyOps`; an op list the applier refuses comes back with `ops: []`
    and the refusal in `note`, so the user never accepts something that cannot be written)

- [ ] **Step 1: Export the model call**

In `server/ai.js` change `async function callOpenAI(messages, { json = false } = {}) {` to
`export async function callOpenAI(messages, { json = false } = {}) {` and add at the end of the file:

```js
/** The chat-completions call other modules build on (schematic chat). */
export const callModel = callOpenAI;
```

- [ ] **Step 2: Write the failing tests**

`server/schematic-ai.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIBRARY } from './library.js';
import { emptySchematic, applyOps } from './schematic.js';
import { describeState, buildPrompt, parseOps, schematicChat } from './schematic-ai.js';

const ctx = () => ({ library: DEFAULT_LIBRARY, catalog: [], modules: [{ slug: 'audio-system', name: 'Audio system' }], releasedSchematics: new Map() });
const inst = () =>
  applyOps(
    emptySchematic({ kind: 'installation', owner: 'sim' }),
    [
      { op: 'add_location', id: 'rack-1', label: 'Rack 1', kind: 'rack' },
      { op: 'add_device', id: 'pdu-1', template: 'pdu-8', label: 'Power strip 1', location: 'rack-1' },
      { op: 'add_device', id: 'umc', template: 'behringer-umc404hd', label: 'UMC404HD', location: 'rack-1' },
      { op: 'connect', from: { device: 'pdu-1', port: 'out-1' }, to: { device: 'umc', port: 'pwr' }, label: 'PWR-01' },
    ],
    ctx()
  ).state;

test('describeState lists locations, devices with free/used ports, and cables', () => {
  const text = describeState(inst(), ctx());
  assert.match(text, /LOCATIONS:\n- rack-1 "Rack 1" \(rack\)/);
  assert.match(text, /- pdu-1 "Power strip 1" \[pdu-8\] in rack-1: in\(iec-c14, in\), out-1\(schuko, out, used by PWR-01\), out-2\(schuko, out\)/);
  assert.match(text, /CABLES:\n- c-1 "PWR-01" power: pdu-1\.out-1 -> umc\.pwr/);
});

test('buildPrompt carries the op schema, the library and the rules', () => {
  const p = buildPrompt({ state: inst(), ctx: ctx(), guidelines: 'Never invent part numbers.', lang: 'en' });
  assert.match(p, /add_device/);
  assert.match(p, /behringer-umc404hd/);
  assert.match(p, /Never invent part numbers/);
  assert.match(p, /never emit coordinates/i);
  assert.match(p, /"reply"/);
});

test('parseOps is forgiving', () => {
  assert.deepEqual(parseOps('not json'), { reply: 'not json', ops: [], note: '' });
  const r = parseOps('{"reply":"ok","ops":[{"op":"add_device","template":"pc"},{"op":"explode"},"junk"]}');
  assert.equal(r.reply, 'ok');
  assert.deepEqual(r.ops, [{ op: 'add_device', template: 'pc' }]);
  assert.match(r.note, /explode/);
  assert.deepEqual(parseOps('{"reply":"","ops":[]}'), { reply: 'Done.', ops: [], note: '' });
});

test('schematicChat dry-runs the ops and returns a preview', async () => {
  const callModel = async (messages) => {
    assert.equal(messages[0].role, 'system');
    assert.match(messages.at(-1).content, /headphones/);
    return JSON.stringify({ reply: 'Connected the headset.', ops: [{ op: 'add_device', id: 'hs', template: 'headset', label: 'Headset L', location: 'rack-1' }, { op: 'connect', from: { device: 'umc', port: 'phones-1' }, to: { device: 'hs', port: 'jack' }, label: 'AUD-01' }] });
  };
  const r = await schematicChat({ state: inst(), ctx: ctx(), messages: [{ role: 'user', content: 'connect the headphones to phones 1' }], callModel });
  assert.equal(r.ops.length, 2);
  assert.equal(r.preview.devices.length, 3);
  assert.deepEqual(r.validation.errors, []);
});

test('schematicChat returns no ops when the applier refuses them', async () => {
  const callModel = async () => JSON.stringify({ reply: 'Done', ops: [{ op: 'connect', from: { device: 'umc', port: 'nope' }, to: { device: 'pdu-1', port: 'out-2' } }] });
  const r = await schematicChat({ state: inst(), ctx: ctx(), messages: [{ role: 'user', content: 'x' }], callModel });
  assert.deepEqual(r.ops, []);
  assert.equal(r.preview, null);
  assert.match(r.note, /port "nope"/);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test server/schematic-ai.test.js`
Expected: FAIL, `Cannot find module './schematic-ai.js'`.

- [ ] **Step 4: Implement `server/schematic-ai.js`**

```js
/**
 * The schematic chat: the model reads the netlist as text and answers with operations, never with
 * a drawing. Its ops are dry-run through the applier here, so what the user is offered to accept is
 * exactly what will be written. The model call is injectable for tests.
 */
import * as ai from './ai.js';
import { applyOps, validateSchematic, OP_NAMES, SchematicError, endpointKey } from './schematic.js';
import { templateFor } from './library.js';

export function describeState(state, ctx) {
  const used = new Map();
  for (const c of state.cables) {
    used.set(endpointKey(c.from), c.label || c.id);
    used.set(endpointKey(c.to), c.label || c.id);
  }
  const portLine = (ownerKey, ports) =>
    ports.map((p) => {
      const u = used.get(`${ownerKey}:${p.id}`);
      return `${p.id}(${p.connector}, ${p.direction}${u ? `, used by ${u}` : ''})`;
    }).join(', ');
  const lines = [];
  if (state.kind === 'installation') {
    lines.push('LOCATIONS:');
    for (const l of state.locations) lines.push(`- ${l.id} "${l.label}" (${l.kind})`);
    if (!state.locations.length) lines.push('- none yet');
  }
  lines.push('DEVICES:');
  for (const d of state.devices) {
    const tpl = templateFor(ctx.library, d.template);
    lines.push(`- ${d.id} "${d.label}" [${d.template}]${d.location ? ` in ${d.location}` : ''}: ${portLine(`d:${d.id}`, tpl?.ports || [])}`);
  }
  if (!state.devices.length) lines.push('- none yet');
  if (state.kind === 'installation') {
    lines.push('MODULE BLOCKS (external ports only):');
    for (const b of state.blocks) {
      const rel = ctx.releasedSchematics.get(b.module);
      const face = (rel?.externalPorts || []).map((ep) => {
        const dev = rel.devices.find((x) => x.id === ep.device);
        const port = templateFor(ctx.library, dev?.template)?.ports.find((p) => p.id === ep.port);
        return { id: ep.id, connector: port?.connector || '?', direction: port?.direction || 'bidir' };
      });
      lines.push(`- ${b.id} module "${ctx.modules.find((m) => m.slug === b.module)?.name || b.module}" [${b.module}]${b.location ? ` in ${b.location}` : ''}: ${portLine(`b:${b.id}`, face)}`);
    }
    if (!state.blocks.length) lines.push('- none yet');
  } else {
    lines.push('EXTERNAL PORTS (leave the module):');
    for (const p of state.externalPorts) lines.push(`- ${p.id} "${p.label}" = ${p.device}.${p.port}`);
    if (!state.externalPorts.length) lines.push('- none yet');
  }
  lines.push('CABLES:');
  for (const c of state.cables) lines.push(`- ${c.id} "${c.label}" ${c.kind}: ${c.from.block ? `block ${c.from.block}` : c.from.device}.${c.from.port} -> ${c.to.block ? `block ${c.to.block}` : c.to.device}.${c.to.port}`);
  if (!state.cables.length) lines.push('- none yet');
  return lines.join('\n');
}

export function describeLibrary(ctx) {
  const dev = ctx.library.devices.map((d) => `- ${d.id} "${d.name}" (${d.category}): ${d.ports.map((p) => `${p.id}:${p.connector}/${p.direction}`).join(' ')}`).join('\n');
  const cables = ctx.library.cables.map((c) => `- ${c.id}: joins ${c.joins.map((j) => j.join('↔')).join(', ')}`).join('\n');
  const mods = [...ctx.releasedSchematics.keys()].map((slug) => `- ${slug} "${ctx.modules.find((m) => m.slug === slug)?.name || slug}"`).join('\n');
  return `DEVICE TEMPLATES (template id "name" (category): port:connector/direction …):\n${dev || '- none'}\nCABLE KINDS:\n${cables}\nMODULES WITH A RELEASED SCHEMATIC (placeable as blocks in an installation):\n${mods || '- none'}`;
}

const OP_SCHEMA = `OPERATIONS (JSON objects, "op" plus fields):
- {"op":"add_device","id"?,"template","hardwareId"?,"label"?,"location"?,"rack"?:{"u":n}}
- {"op":"update_device","id","label"?,"location"?,"rack"?,"notes"?}
- {"op":"remove_device","id","cascade"?:true}
- {"op":"connect","id"?,"kind"?,"from":{"device","port"}|{"block","port"},"to":…,"label"?,"length"?,"notes"?}  — kind is inferred when only one cable kind joins the two connectors
- {"op":"update_cable","id","label"?,"length"?,"notes"?}
- {"op":"disconnect","id"}
- module schematic only: {"op":"set_external_port","id"?,"label","device","port"} · {"op":"unset_external_port","id"}
- installation only: {"op":"add_location","id"?,"label","kind":"rack"|"area","unitsU"?} · {"op":"update_location",…} · {"op":"remove_location","id"} · {"op":"place_block","id"?,"module","location"?,"rack"?} · {"op":"refresh_block","id"} · {"op":"remove_block","id","cascade"?}`;

export function buildPrompt({ state, ctx, guidelines = '', lang = 'en' }) {
  const kind = state.kind === 'module' ? `the wiring schematic of module "${state.owner}"` : `the installation schematic "${state.owner}"`;
  return `You are the schematic assistant of the FTD.aero Documentation Console, editing ${kind} (version ${state.version} r${state.revision}, ${state.status}).
The schematic is DATA: devices with typed ports, cables between ports, locations (racks and areas), and — for a module — the external ports that leave it. You change it ONLY through operations; the console validates, applies and draws them. You never emit coordinates, sizes or drawing instructions.

${OP_SCHEMA}

RULES:
- Reuse what exists: match devices by label or id ("power strip 1" → pdu-1, "first socket" → out-1, "rack 1" → rack-1). Add a device only when the sentence names one that is not placed yet; take its template from DEVICE TEMPLATES by name or model.
- A device that is a module with a released schematic is placed as a block (place_block), and cables end on its external ports.
- Never invent a template, a port or a module. If the user names a device that is not in the library, say so in "reply" and return no ops for it — the user adds it with its ports first.
- A port takes one cable. Outputs feed inputs. Pick the cable kind that joins the two connectors; name it with "kind" when several fit.
- Give every cable a short label when the user does not ("PWR-03", "NET-12", "AUD-01"), numbered after the existing ones of that kind.
- When a sentence is ambiguous (which socket, which headset), ask in "reply" and return no ops. One clear question beats a guess.
- Answer questions about the schematic from CURRENT STATE; return no ops for a question.
- Reply in ${lang === 'pl' ? 'Polish' : 'English'}, one to three sentences.
${guidelines.trim() ? `\nHOUSE GUIDELINES:\n${guidelines.trim()}\n` : ''}
${describeLibrary(ctx)}

CURRENT STATE:
${describeState(state, ctx)}

Respond with a JSON object: {"reply": "<short answer>", "ops": [ …operations in order… ]} — "ops" empty when nothing changes.`;
}

export function parseOps(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { reply: String(raw || '').slice(0, 2000), ops: [], note: '' };
  }
  const dropped = [];
  const ops = (Array.isArray(parsed.ops) ? parsed.ops : []).filter((o) => {
    const ok = o && typeof o === 'object' && OP_NAMES.includes(o.op);
    if (!ok) dropped.push(o && typeof o === 'object' ? String(o.op) : typeof o);
    return ok;
  });
  return { reply: typeof parsed.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim() : 'Done.', ops, note: dropped.length ? `Ignored unknown operation(s): ${dropped.join(', ')}.` : '' };
}

export async function schematicChat({ state, ctx, messages, guidelines = '', lang = 'en', callModel = ai.callModel }) {
  const sys = buildPrompt({ state, ctx, guidelines, lang });
  const convo = (messages || []).slice(-12).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }));
  const raw = await callModel([{ role: 'system', content: sys }, ...convo], { json: true });
  const parsed = parseOps(raw);
  if (!parsed.ops.length) return { ...parsed, validation: null, preview: null };
  try {
    const { state: preview } = applyOps(state, parsed.ops, ctx);
    return { ...parsed, validation: validateSchematic(preview, ctx), preview };
  } catch (e) {
    if (!(e instanceof SchematicError)) throw e;
    return { reply: parsed.reply, ops: [], preview: null, validation: null, note: [parsed.note, `The proposed change was refused: ${e.message}`].filter(Boolean).join(' ') };
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `node --test server/schematic-ai.test.js`
Expected: all pass. The `describeState` regexes are exact: `c-1` is the id the applier derives for a
first cable without an id, and `in(iec-c14, in)` is the pdu-8 template's first port.

- [ ] **Step 6: Commit**

```bash
git add server/ai.js server/schematic-ai.js server/schematic-ai.test.js
git commit -m "Schematics: chat that answers with validated operations

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: HTTP routes

**Files:**
- Create: `server/schematic-routes.js`
- Modify: `server/index.js` (import + register, before the `/* ---------- manuals ---------- */` block)
- Test: covered by the smoke test in Task 12 (routes are thin); a unit test for `schematicRef` is included here.

**Interfaces:**
- Consumes: everything exported by `schematics-store.js`, `renderSvg`, `schematicCsv` from
  `schematic-render.js`, `schematicChat` from `schematic-ai.js`, `getAiGuidelines` from `store.js`,
  `aiAvailable` from `ai.js`.
- Produces: `registerSchematicRoutes(app, { wrap, auth })` and the routes below. All errors go through
  `wrap` (400 JSON `{error, code?}`); a `SchematicError` adds `{code, index}`.

| Method & path | Body / query | Returns |
| --- | --- | --- |
| `GET /api/library` | | `{connectors, cables, devices}` |
| `PUT /api/library/connectors` | `{connectors, cables}` | library |
| `POST /api/library/devices` | template spec | template |
| `PUT /api/library/devices/:id` | patch | template |
| `DELETE /api/library/devices/:id` | | `{ok, id}` (admin, by the global DELETE guard) |
| `POST /api/library/devices/:id/promote` | `{name, code, category}` | `{slug, hardwareId, schematic}` |
| `GET /api/installations` | | list |
| `POST /api/installations` | `{name, device, serialNumber, operator, locations?}` | record |
| `GET /api/installations/:slug` | | `{installation, schematic: getSchematic result or null, manuals: [{slug,name}]}` |
| `PUT /api/installations/:slug` | patch | record |
| `DELETE /api/installations/:slug` | | `{slug, branchesDeleted}` |
| `GET <owner>/schematic` | | `getSchematic` result, 404 when none |
| `POST <owner>/schematic` | `{bump?}` | state (first draft or next version) |
| `POST <owner>/schematic/ops` | `{ops, summary?, dryRun?}` | `{state, summary, validation}` |
| `POST <owner>/schematic/submit-review` · `/back-to-draft` | | state |
| `POST <owner>/schematic/release` | `{note}` | state |
| `PUT <owner>/schematic/release-note` | `{note}` | state |
| `POST <owner>/schematic/hotfix` | | state |
| `POST <owner>/schematic/discard` | | `{ok}` (admin) |
| `POST <owner>/schematic/chat` | `{messages, lang?}` | `{reply, ops, validation, preview, note}` |
| `GET <owner>/schematic/render.svg` | `?released=1` `?lang=` | `image/svg+xml` |
| `GET <owner>/schematic/cables.csv` | `?released=1` | `text/csv` |

`<owner>` is `/api/modules/:slug` or `/api/installations/:slug`.

- [ ] **Step 1: Write the route module**

`server/schematic-routes.js`:

```js
/**
 * HTTP surface of the schematics. Thin: every handler calls schematics-store.js and returns what it
 * gets. The owner is read from the route: /api/modules/:slug/… is a module, /api/installations/:slug/…
 * an installation (`inst:<slug>` to the store).
 */
import * as sch from './schematics-store.js';
import { renderSvg, schematicCsv } from './schematic-render.js';
import { schematicChat } from './schematic-ai.js';
import { SchematicError } from './schematic.js';
import * as store from './store.js';
import * as ai from './ai.js';
import { DEFAULT_LANG, langOf } from './docgen.js';

/** Routes are registered with a path array, so `req.route.path` is that array — the URL says which owner it is. */
export const schematicRef = (req) => (String(req.originalUrl || req.url || '').startsWith('/api/installations/') ? sch.instRef(req.params.slug) : req.params.slug);
const paths = (suffix = '') => [`/api/modules/:slug/schematic${suffix}`, `/api/installations/:slug/schematic${suffix}`];

export function registerSchematicRoutes(app, { wrap, auth }) {
  // a refused op list is a 400 with the op index, so the UI can point at it
  const wrapOps = (fn) => wrap((req, res) =>
    Promise.resolve(fn(req, res)).catch((e) => {
      if (e instanceof SchematicError) throw Object.assign(e, { code: e.code || 'invalid-op' });
      throw e;
    })
  );

  /* ---- library ---- */
  app.get('/api/library', wrap(async (req, res) => res.json(await sch.getLibrary())));
  app.put('/api/library/connectors', wrap(async (req, res) => res.json(await sch.saveConnectors(req.body || {}))));
  app.post('/api/library/devices', wrap(async (req, res) => res.json(await sch.createDeviceTemplate(req.body || {}))));
  app.put('/api/library/devices/:id', wrap(async (req, res) => res.json(await sch.updateDeviceTemplate(req.params.id, req.body || {}))));
  app.delete('/api/library/devices/:id', wrap(async (req, res) => res.json(await sch.deleteDeviceTemplate(req.params.id))));
  app.post('/api/library/devices/:id/promote', wrap(async (req, res) => res.json(await sch.promoteDeviceToModule(req.params.id, req.body || {}))));

  /* ---- installations ---- */
  app.get('/api/installations', wrap(async (req, res) => res.json(await sch.listInstallations())));
  app.post('/api/installations', wrap(async (req, res) => res.json(await sch.createInstallation(req.body || {}))));
  app.get('/api/installations/:slug', wrap(async (req, res) => {
    const installation = await sch.getInstallation(req.params.slug);
    if (!installation) return res.status(404).json({ error: 'Installation not found' });
    const manuals = (await store.listManuals()).filter((m) => m.installation === req.params.slug).map((m) => ({ slug: m.slug, name: m.name }));
    res.json({ installation, schematic: await sch.getSchematic(sch.instRef(req.params.slug)), manuals });
  }));
  app.put('/api/installations/:slug', wrap(async (req, res) => res.json(await sch.updateInstallation(req.params.slug, req.body || {}))));
  app.delete('/api/installations/:slug', wrap(async (req, res) => res.json(await sch.deleteInstallation(req.params.slug))));

  /* ---- schematic of an owner ---- */
  app.post(paths('/discard'), auth.requireAdmin);
  app.get(paths(), wrap(async (req, res) => {
    const s = await sch.getSchematic(schematicRef(req));
    if (!s) return res.status(404).json({ error: 'No schematic', code: 'no-schematic' });
    res.json(s);
  }));
  app.post(paths(), wrap(async (req, res) => res.json(await sch.createSchematic(schematicRef(req), { bump: req.body?.bump || 'minor' }))));
  app.post(paths('/ops'), wrapOps(async (req, res) => {
    const { ops, summary, dryRun } = req.body || {};
    res.json(await sch.applySchematicOps(schematicRef(req), ops, { summary, dryRun: !!dryRun }));
  }));
  app.post(paths('/submit-review'), wrap(async (req, res) => res.json(await sch.setSchematicStatus(schematicRef(req), 'in-review'))));
  app.post(paths('/back-to-draft'), wrap(async (req, res) => res.json(await sch.setSchematicStatus(schematicRef(req), 'draft'))));
  app.post(paths('/release'), wrap(async (req, res) => res.json(await sch.releaseSchematic(schematicRef(req), { note: req.body?.note }))));
  app.put(paths('/release-note'), wrap(async (req, res) => res.json(await sch.setSchematicReleaseNote(schematicRef(req), req.body?.note))));
  app.post(paths('/hotfix'), wrap(async (req, res) => res.json(await sch.startSchematicHotfix(schematicRef(req)))));
  app.post(paths('/discard'), wrap(async (req, res) => res.json(await sch.discardSchematic(schematicRef(req)))));

  app.post(paths('/chat'), wrap(async (req, res) => {
    if (!ai.aiAvailable()) throw new Error('OPENAI_API_KEY is not set — the schematic chat is unavailable');
    const s = await sch.getSchematic(schematicRef(req));
    if (!s) throw new Error('No schematic — create one first');
    if (!s.editable) throw new Error(`Schematic ${s.state.version} is ${s.state.status} — start the next version or a hotfix to change it`);
    const ctx = await sch.schematicContext();
    res.json(await schematicChat({ state: s.state, ctx, messages: req.body?.messages || [], guidelines: await store.getAiGuidelines(), lang: langOf(req.body?.lang || DEFAULT_LANG) }));
  }));

  const pick = async (req) => {
    const s = await sch.getSchematic(schematicRef(req));
    if (!s) return null;
    return req.query.released ? s.released : s.state;
  };
  app.get(paths('/render.svg'), wrap(async (req, res) => {
    const state = await pick(req);
    if (!state) return res.status(404).json({ error: 'No schematic' });
    const ctx = await sch.schematicContext();
    res.set('Content-Type', 'image/svg+xml; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(await renderSvg(state, ctx, { lang: langOf(req.query.lang || DEFAULT_LANG), title: `${state.owner} ${state.version}` }));
  }));
  app.get(paths('/cables.csv'), wrap(async (req, res) => {
    const s = await sch.getSchematic(schematicRef(req));
    if (!s) return res.status(404).json({ error: 'No schematic' });
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${s.owner.slug}-cables.csv"`);
    res.send(schematicCsv(s.schedule));
  }));
}
```

- [ ] **Step 2: Register the routes in `server/index.js`**

Add to the imports:

```js
import { registerSchematicRoutes } from './schematic-routes.js';
import './schematics-store.js'; // registers the manual build's schematic provider (Task 9)
```

Right before the line `/* ---------- manuals ---------- */` add:

```js
/* ---------- schematics, installations, device library ---------- */
registerSchematicRoutes(app, { wrap, auth });
```

- [ ] **Step 3: Write a small unit test for the owner resolution**

`server/schematic-routes.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { schematicRef } from './schematic-routes.js';

test('schematicRef reads the owner kind from the request URL', () => {
  assert.equal(schematicRef({ originalUrl: '/api/modules/audio/schematic', params: { slug: 'audio' } }), 'audio');
  assert.equal(schematicRef({ originalUrl: '/api/installations/sim-a/schematic/ops?x=1', params: { slug: 'sim-a' } }), 'inst:sim-a');
});
```

Note: importing `schematic-routes.js` imports `schematics-store.js`, which imports `store.js`, which
opens the repo at `FTD_DATA_DIR` (default `data/repo`). Set `process.env.FTD_DATA_DIR` to a temp dir at
the top of this test as the store test does.

- [ ] **Step 4: Run tests and boot the server**

Run: `npm test` → all pass.
Run: `FTD_DATA_DIR=$(mktemp -d)/repo node server/index.js &` then
`curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5179/api/library` → `401` (login required,
route exists). Kill the server.

- [ ] **Step 5: Commit**

```bash
git add server/schematic-routes.js server/schematic-routes.test.js server/index.js
git commit -m "Schematics: HTTP routes for library, installations and schematic lifecycle

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Into the manuals (generated Connections section, wiring chapter, cover overlay, `data-schematic` figures)

**Files:**
- Modify: `server/docgen.js` (`STRINGS`, `generatedSections`, `kindBadge`, `MANUAL_CSS`)
- Modify: `server/store.js` (`getDoc`, `compileManual`, `compileDocPreview`)
- Modify: `server/schematics-store.js` (register the provider)
- Test: `server/docgen-schematic.test.js`, append to `server/schematics-store.test.js`

**Interfaces:**
- `generatedSections(module, doc, lang, { …, schematic })` where
  `schematic = { svg, faceHtml, scheduleHtml, version, revision } | null`; a technician-audience doc
  with one prints `<h3>` *Connections* at the end of section 3 (both standalone and assembled).
- `store.schematicFor({ module, manual, lang }) → { svg, faceHtml, scheduleHtml, version, revision } | null`
  (the provider; returns null for customer audience, software owners, or no released schematic).
- `store.installationChapter(manualRecord, lang) → chapter | null` used by `compileManual`.
- `compileManual` result gains `installation: { slug, name, version, revision, released: bool } | null`
  and `state.blockers` gains `'installation-unreleased'` / `'installation-missing'` strings when a
  linked installation cannot print.

- [ ] **Step 1: Write the failing docgen test**

`server/docgen-schematic.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test server/docgen-schematic.test.js`
Expected: FAIL on the `Connections` assertion.

- [ ] **Step 3: Extend docgen**

In `STRINGS.en` add (after the `relatedHardware` line):

```js
    connections: 'Connections', portList: 'External ports', cableSchedule: 'Cable schedule', wiringOf: (name, code) => `Wiring of ${name} — ${code}`,
    installationWiring: 'Installation wiring', installationFig: (name) => `Installation wiring — ${name}`, installationCables: 'Cables of this manual’s chapters',
```

and in `STRINGS.pl`:

```js
    connections: 'Połączenia', portList: 'Porty zewnętrzne', cableSchedule: 'Zestawienie kabli', wiringOf: (name, code) => `Okablowanie ${name} — ${code}`,
    installationWiring: 'Okablowanie instalacji', installationFig: (name) => `Okablowanie instalacji — ${name}`, installationCables: 'Kable rozdziałów tej instrukcji',
```

In `generatedSections`, extend the options:

```js
  { revisionHistory = true, relatedHardware = [], assembled = false, schematic = null } = {}
```

and right after `const hasRelated = …` add:

```js
  // A module's wiring: its released schematic, the ports that leave it and its cables. The
  // technician's business, never the operator's. The build numbers the figure like any other.
  const hasSchematic = !ownedBySoftware && type.audience !== 'customer' && schematic && schematic.svg;
  const schematicBlock = !hasSchematic
    ? ''
    : `<h3>${T.connections}</h3>
<figure class="schematic" data-schematic="${esc(module.slug)}" data-size="full">${schematic.svg}<figcaption>${esc(T.wiringOf(module.name, `${manualDocCode(module, type.id).replace(/-[A-Z]+-[A-Z]+$/, '')}-SCH ${schematic.version}`))}</figcaption></figure>
${schematic.faceHtml ? `<h4>${T.portList}</h4>\n${schematic.faceHtml}` : ''}
${schematic.scheduleHtml ? `<h4>${T.cableSchedule}</h4>\n${schematic.scheduleHtml}` : ''}`;
```

In the `if (assembled)` branch add `schematicBlock` as the last entry of `tables` (before
`].filter(Boolean)`). In the standalone return, add `${schematicBlock}` right before the closing
`</section>` of section 3 (after the software-relation table).

In `kindBadge`, first line: `if (c.installation) return '';`.

In `MANUAL_CSS`, after the `.manual-doc figure img { min-width: 60%; … }` rule add:

```css
.manual-doc figure.schematic svg { width: 100%; height: auto; max-height: 230mm; border: 1px solid #dde3ea; }
.manual-doc table.cable-schedule td, .manual-doc table.port-list td { font-size: 8.5pt; }
```

- [ ] **Step 4: Run the docgen test**

Run: `node --test server/docgen-schematic.test.js` → pass.

- [ ] **Step 5: Append the store-level tests**

Append to `server/schematics-store.test.js`:

```js
test('the technician manual and the assembled manual carry the released wiring', async () => {
  const slug = await makeModule('Wired module');
  const m = await store.getModule(slug);
  const techKey = m.docs.find((d) => d.manual === 'technician').key;
  assert.doesNotMatch((await store.getDoc(slug, techKey)).generated, /Connections/, 'no schematic yet');
  await sch.createSchematic(slug);
  await sch.applySchematicOps(slug, [{ op: 'add_device', id: 'hs', template: 'headset', label: 'Headset' }, { op: 'set_external_port', id: 'jack', label: 'Headset jack', device: 'hs', port: 'jack' }]);
  assert.doesNotMatch((await store.getDoc(slug, techKey)).generated, /Connections/, 'a draft schematic does not print');
  await sch.releaseSchematic(slug, { note: 'Wired.' });
  const d = await store.getDoc(slug, techKey);
  assert.match(d.generated, /<h3>Connections<\/h3>/);
  assert.match(d.generated, /Headset jack/);

  await store.releaseDoc(slug, techKey, { force: true, note: 'Released for the test.' });
  const inst = await sch.createInstallation({ name: 'Wired sim', device: 'FNPT II', serialNumber: 'SN-7', operator: 'Op' });
  const ref = sch.instRef(inst.slug);
  await sch.applySchematicOps(ref, [
    { op: 'place_block', id: 'wm', module: slug, location: 'cockpit' },
    { op: 'add_device', id: 'pdu', template: 'pdu-8', label: 'PDU', location: 'rack-1' },
    { op: 'add_device', id: 'umc', template: 'behringer-umc404hd', label: 'UMC', location: 'rack-1' },
    { op: 'connect', from: { device: 'umc', port: 'phones-1' }, to: { block: 'wm', port: 'jack' }, label: 'AUD-01' },
  ]);
  const manual = await store.createManual({ name: 'Wired manual', manual: 'technician', modules: [slug], installation: inst.slug, serialNumber: 'IGNORED' });
  let compiled = await store.compileManual(manual.slug);
  assert.equal(compiled.manual.serialNumber, 'SN-7', 'the cover reads the installation');
  assert.equal(compiled.manual.device, 'FNPT II');
  assert.ok(!compiled.chapters.some((c) => c.installation), 'a draft installation does not print');
  assert.ok(compiled.state.blockers.some((b) => /installation/i.test(b)), 'and the state says why');
  await sch.releaseSchematic(ref, { note: 'Issue 1.' });
  compiled = await store.compileManual(manual.slug);
  const ch = compiled.chapters.find((c) => c.installation);
  assert.ok(ch, 'wiring chapter present');
  assert.match(ch.content, /<figure class="schematic installation"/);
  assert.match(ch.content, /cable-schedule/);
  assert.equal(compiled.installation.released, true);
  const html = (await import('./docgen.js')).manualBodyHtml(compiled);
  assert.match(html, /Installation wiring/);
});
```

- [ ] **Step 6: Implement the provider and the compile changes**

In `server/schematics-store.js` add (bottom of the file):

```js
/* ------------------------------------------------------------------ */
/* What the manual build prints                                        */
/* ------------------------------------------------------------------ */
import { renderSvg, scheduleHtml, faceHtml } from './schematic-render.js';

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
      doc: { version: state.version, revision: state.revision, status: 'released', manual: manual.manual, releasedAt: state.releasedAt, updatedAt: state.updatedAt, revisionRecord: state.releaseRecord || [], covers: [] },
      title: T.installationWiring,
      generated: '',
      content: `<h2>${T.installationWiring}</h2>\n<figure class="schematic installation" data-size="full">${svg}<figcaption>${T.installationFig(rec.name)} — ${state.version}</figcaption></figure>\n${schedule.length ? `<h2>${T.installationCables}</h2>\n${scheduleHtml(schedule, lang)}` : ''}`,
      checklist: null,
      isDraft: false,
      langFallback: false,
    },
  };
}

store.setSchematicProvider({ forManual: schematicForManual, installationChapter: installationChapterFor });
```

and change the hook in `server/store.js` to take that object:

```js
let schematicProvider = null;
/** { forManual({module, manual, lang}), installationChapter(manualRecord, lang) } — set by schematics-store.js */
export function setSchematicProvider(p) {
  schematicProvider = p;
}
const schematicFor = (args) => (schematicProvider ? schematicProvider.forManual(args) : Promise.resolve(null));
const installationChapter = (manual, lang) => (schematicProvider ? schematicProvider.installationChapter(manual, lang) : Promise.resolve(null));
```

In `getDoc` (store.js), replace the `generated:` line with:

```js
    generated: generatedSections(entry.module, doc, lang, { relatedHardware: hardware, schematic: await schematicFor({ module: entry.module, manual: doc.manual, lang }) }),
```

In `compileDocPreview`, find its `generatedSections(` call and add the same `schematic:` option.

In `compileManual`:
1. After `const manual = await getManual(slug); if (!manual) return null;` add the cover overlay:

```js
  // A manual that belongs to an installation names that installation's device, serial and operator.
  const instInfo = await installationChapter(manual, lang);
  if (instInfo?.record) Object.assign(manual, { device: instInfo.record.device, serialNumber: instInfo.record.serialNumber, operator: instInfo.record.operator });
```

2. In `chapterOf`, add `schematic: await schematicFor({ module: entry.module, manual: doc.manual, lang })`
   to the `generatedSections(entry.module, doc, lang, { assembled: true, … })` options.
3. After the `for (const mslug of manual.modules)` loop, before the missing-assets scan:

```js
  if (instInfo?.chapter) chapters.push(instInfo.chapter);
```

4. In the return, add `installation:` and extend the state:

```js
  const state = manualState(manual, chapters, missingAssets);
  if (instInfo?.blocker) state.blockers = [...(state.blockers || []), instInfo.blocker.reason];
  return {
    manual, chapters, lang, missingAssets, missingRefs, state,
    installation: instInfo?.record ? { slug: instInfo.record.slug, name: instInfo.record.name, version: instInfo.state?.version || null, revision: instInfo.state?.revision || null, released: !!instInfo.chapter } : null,
  };
```

`manualState` keeps `blockers` as plain strings (it joins them with `; ` in the release refusal),
so the installation reason is pushed as a string. Also check the missing-assets scan tolerates a chapter with no
`module.slug` in the catalog: it only reads `c.content`, so the inline SVG passes (no `/api/…/assets/`
URL in it).

In `manualBodyHtml`, the wiring chapter has a `doc.manual` equal to the manual's type and
`c.installation` set, so `kindBadge` returns nothing and `docEffectivity(c.doc)` reads the installation
version. Nothing else to change there.

- [ ] **Step 7: Run everything**

Run: `npm test` → all pass. Run `npm run build && npm run smoke` → smoke still passes (nothing new
exercised yet).

- [ ] **Step 8: Commit**

```bash
git add server/docgen.js server/store.js server/schematics-store.js server/docgen-schematic.test.js server/schematics-store.test.js
git commit -m "Schematics: Connections section in technician manuals, wiring chapter and cover from the installation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: MCP tools

**Files:**
- Modify: `server/mcp.js` (tool definitions in `TOOLS`, cases in `callTool`)
- Test: smoke (Task 12) calls each tool once; `server/mcp-schematic.test.js` checks the definitions.

**Interfaces:**
- Consumes: `schematics-store.js`, `renderSvg`, `images.rasterize(buffer) → PNG Buffer` (exists, used
  for the favicon), `richContent` (exists in mcp.js).
- Produces the tools below. `slug` on schematic tools is resolved with `resolveSchematicRef` (module
  slug wins; else installation slug or name).

| Tool | Input | Output |
| --- | --- | --- |
| `list_installations` | | `listInstallations()` |
| `create_installation` | `name, device?, serial_number?, operator?, locations?` | record |
| `list_device_templates` | `query?` | templates (+ `connectors`, `cables` when `include_rules`) |
| `create_device_template` | `name, category?, manufacturer?, model?, height_u?, ports: [{id?, label, connector, direction?, side?}], hardware_id?` | template |
| `update_device_template` | `id` + same fields | template |
| `promote_device_to_module` | `id, name?, code?, category?` | `{slug, hardwareId, schematic}` |
| `get_schematic` | `slug` | `getSchematic` (without `history` unless `include_history`) |
| `create_schematic` | `slug, bump?` | state |
| `apply_schematic_ops` | `slug, ops, summary?, dry_run?` | `{state, summary, validation}` |
| `submit_schematic_for_review` / `schematic_back_to_draft` | `slug` | state |
| `release_schematic` | `slug, note` | state |
| `set_schematic_release_note` | `slug, note` | state |
| `start_schematic_hotfix` | `slug` | state |
| `discard_schematic` | `slug` | `{ok}` |
| `render_schematic` | `slug, released?, lang?` | image content (PNG) + text `{width, height}` |

- [ ] **Step 1: Write the definitions test**

`server/mcp-schematic.test.js` (set `FTD_DATA_DIR` to a temp dir first, like the store test, since
`mcp.js` imports the store):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.FTD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ftd-mcp-'));
const { TOOLS } = await import('./mcp.js');
test.after(() => fs.rmSync(process.env.FTD_DATA_DIR, { recursive: true, force: true }));

test('schematic tools are defined with annotations and the op list in the description', () => {
  const names = ['list_installations', 'create_installation', 'list_device_templates', 'create_device_template', 'update_device_template', 'promote_device_to_module', 'get_schematic', 'create_schematic', 'apply_schematic_ops', 'submit_schematic_for_review', 'schematic_back_to_draft', 'release_schematic', 'set_schematic_release_note', 'start_schematic_hotfix', 'discard_schematic', 'render_schematic'];
  for (const n of names) {
    const t = TOOLS.find((x) => x.name === n);
    assert.ok(t, n);
    assert.ok(t.annotations && t.inputSchema, `${n} has annotations and a schema`);
  }
  const apply = TOOLS.find((x) => x.name === 'apply_schematic_ops');
  assert.match(apply.description, /add_device/);
  assert.deepEqual(apply.inputSchema.required, ['slug', 'ops']);
  assert.ok(!TOOLS.find((x) => x.name === 'apply_schematic_ops').inputSchema.properties.manual, 'schematic tools are not doc-scoped');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test server/mcp-schematic.test.js` → FAIL (`list_installations` missing).

- [ ] **Step 3: Add the tools to `TOOLS` in `server/mcp.js`**

Add the imports:

```js
import * as sch from './schematics-store.js';
import { renderSvg } from './schematic-render.js';
import { OP_NAMES } from './schematic.js';
```

Append to the `TOOLS` array (before its closing `];`):

```js
  /* ---- schematics ---- */
  {
    name: 'list_installations',
    description: 'List installations (one simulator delivery each): name, device, serial number, operator, and the state of its wiring schematic. An installation is the owner of the installation-level schematic that assembled manuals print.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'List installations', ...RO },
  },
  {
    name: 'create_installation',
    description: 'Create an installation with its first schematic draft (locations Rack 1, Instructor station, Cockpit unless `locations` is given). Its device / serial number / operator print on the cover of every manual that links it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, device: { type: 'string' }, serial_number: { type: 'string' }, operator: { type: 'string' },
        locations: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, kind: { type: 'string', enum: ['rack', 'area'] }, unitsU: { type: 'number' } }, required: ['label'] } },
      },
      required: ['name'],
    },
    annotations: { title: 'Create installation', ...RW },
  },
  {
    name: 'list_device_templates',
    description: 'The device library: templates (id, name, category, manufacturer/model, ports with connector and direction) that schematics place. With include_rules also the connector kinds and which connector pairs each cable kind joins.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Filter on id, name, manufacturer, model, category' }, include_rules: { type: 'boolean' } } },
    annotations: { title: 'List device templates', ...RO },
  },
  {
    name: 'create_device_template',
    description: 'Add a device to the library. Ports: [{id?, label, connector, direction: in|out|bidir (default bidir), side: left|right|top|bottom}]. Connector ids come from list_device_templates {include_rules: true}. hardware_id links it to a hardware catalog item.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, category: { type: 'string' }, manufacturer: { type: 'string' }, model: { type: 'string' }, height_u: { type: 'number' }, symbol: { type: 'string' }, hardware_id: { type: 'string' }, notes: { type: 'string' },
        ports: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, connector: { type: 'string' }, direction: { type: 'string', enum: ['in', 'out', 'bidir'] }, side: { type: 'string', enum: ['left', 'right', 'top', 'bottom'] } }, required: ['label', 'connector'] } },
      },
      required: ['name', 'ports'],
    },
    annotations: { title: 'Create device template', ...RW },
  },
  {
    name: 'update_device_template',
    description: 'Change a library device: any field of create_device_template; `ports` replaces the whole port list.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, category: { type: 'string' }, manufacturer: { type: 'string' }, model: { type: 'string' }, height_u: { type: 'number' }, symbol: { type: 'string' }, hardware_id: { type: 'string' }, notes: { type: 'string' }, ports: { type: 'array', items: { type: 'object' } } }, required: ['id'] },
    annotations: { title: 'Update device template', ...RW },
  },
  {
    name: 'promote_device_to_module',
    description: 'Turn a library device into a module of its own (third-party kit with a technician manual, a catalog item, and a module schematic that exposes every port as an external port). Installation devices using the template are not converted.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string', description: 'Module name (default the template name)' }, code: { type: 'string' }, category: { type: 'string', enum: ['ios', 'cockpit', 'misc'] } }, required: ['id'] },
    annotations: { title: 'Promote device to module', ...RW },
  },
  {
    name: 'get_schematic',
    description: 'The schematic of a module (its internal wiring and external ports) or of an installation (locations, module blocks, free devices, cables): the live state (open draft, else the released one), the released copy, validation errors/warnings, the cable schedule and, for a module, its connector face.',
    inputSchema: { type: 'object', properties: { slug: SCH_SLUG, include_history: { type: 'boolean' } }, required: ['slug'] },
    annotations: { title: 'Get schematic', ...RO },
  },
  {
    name: 'create_schematic',
    description: 'Start the first schematic draft (A1.0) of a module or installation, or — when one is released and none is open — the next version from it (bump minor → A1.1, major → A2.0).',
    inputSchema: { type: 'object', properties: { slug: SCH_SLUG, bump: { type: 'string', enum: ['minor', 'major'] } }, required: ['slug'] },
    annotations: { title: 'Create schematic', ...RW },
  },
  {
    name: 'apply_schematic_ops',
    description: `Change an open schematic with a list of operations — all applied as one commit, or none when any fails (the error names the op). Ops: ${OP_NAMES.join(', ')}. Shapes: {op:"add_device", id?, template, hardwareId?, label?, location?, rack?:{u}} · {op:"connect", id?, kind?, from:{device,port}|{block,port}, to:…, label?, length?} (kind inferred when one cable kind joins the connectors) · {op:"set_external_port", id?, label, device, port} (module) · {op:"add_location", id?, label, kind:"rack"|"area", unitsU?} · {op:"place_block", id?, module, location?, rack?} (module with a released schematic) · {op:"refresh_block", id} · {op:"remove_device"|"remove_block", id, cascade?} · {op:"disconnect"|"unset_external_port"|"remove_location", id} · {op:"update_device"|"update_cable"|"update_location", id, …fields} · {op:"move", id, x, y} · {op:"tidy", ids?}. dry_run validates and returns the would-be state without writing.`,
    inputSchema: { type: 'object', properties: { slug: SCH_SLUG, ops: { type: 'array', items: { type: 'object' } }, summary: { type: 'string', description: 'One line for the revision history' }, dry_run: { type: 'boolean' } }, required: ['slug', 'ops'] },
    annotations: { title: 'Apply schematic operations', ...RW },
  },
  { name: 'submit_schematic_for_review', description: 'Mark the open schematic draft as In review.', inputSchema: { type: 'object', properties: { slug: SCH_SLUG }, required: ['slug'] }, annotations: { title: 'Submit schematic for review', ...RW } },
  { name: 'schematic_back_to_draft', description: 'Put an In-review schematic back to Draft.', inputSchema: { type: 'object', properties: { slug: SCH_SLUG }, required: ['slug'] }, annotations: { title: 'Schematic back to draft', ...RW } },
  {
    name: 'release_schematic',
    description: 'Release the open schematic (merge to main) with the line the revision record prints. Refused while validation reports errors. On a hotfix it publishes the correction into the same version.',
    inputSchema: { type: 'object', properties: { slug: SCH_SLUG, note: { type: 'string' } }, required: ['slug', 'note'] },
    annotations: { title: 'Release schematic', ...RW },
  },
  { name: 'set_schematic_release_note', description: 'Write or correct the printed revision line of the released schematic.', inputSchema: { type: 'object', properties: { slug: SCH_SLUG, note: { type: 'string' } }, required: ['slug', 'note'] }, annotations: { title: 'Set schematic release note', ...RW } },
  { name: 'start_schematic_hotfix', description: 'Reopen the released schematic for a correction (same version, next revision); release_schematic publishes it.', inputSchema: { type: 'object', properties: { slug: SCH_SLUG }, required: ['slug'] }, annotations: { title: 'Start schematic hotfix', ...RW } },
  { name: 'discard_schematic', description: 'Drop the open schematic draft or hotfix. Irreversible from the API.', inputSchema: { type: 'object', properties: { slug: SCH_SLUG }, required: ['slug'] }, annotations: { title: 'Discard schematic', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } },
  {
    name: 'render_schematic',
    description: 'The schematic as a picture (PNG) — the live state, or the released one with released: true.',
    inputSchema: { type: 'object', properties: { slug: SCH_SLUG, released: { type: 'boolean' }, lang: LANG_PROP }, required: ['slug'] },
    annotations: { title: 'Render schematic', ...RO },
  },
```

and define, next to `SLUG_VER`:

```js
/** Schematic tools address a module (by slug) or an installation (by slug, name, or inst:<slug>). */
const SCH_SLUG = { type: 'string', description: 'Module slug, or installation slug / name (or inst:<slug>). A module wins a tie. list_installations and search_modules name them.' };
```

- [ ] **Step 4: Add the cases to `callTool`**

The resolver at the top of `callTool` rewrites `args.slug` through `store.resolveOwnerRef`; schematic
tools must not go through that. Change the two lines:

```js
  if (args && args.slug) args = { ...args, slug: await store.resolveOwnerRef(args.slug) };
  if (DOC_SCOPED.has(name)) args = { ...args, version: await resolveDocKey(args) };
```

to:

```js
  if (SCHEMATIC_TOOLS.has(name)) {
    if (args && args.slug) args = { ...args, slug: await sch.resolveSchematicRef(args.slug) };
  } else {
    if (args && args.slug) args = { ...args, slug: await store.resolveOwnerRef(args.slug) };
    if (DOC_SCOPED.has(name)) args = { ...args, version: await resolveDocKey(args) };
  }
```

with, next to `DOC_SCOPED`:

```js
const SCHEMATIC_TOOLS = new Set(TOOLS.filter((t) => t.inputSchema.properties?.slug === SCH_SLUG).map((t) => t.name));
```

Add the cases inside the `switch`:

```js
    case 'list_installations':
      return await sch.listInstallations();
    case 'create_installation':
      return await sch.createInstallation({ name: args.name, device: args.device, serialNumber: args.serial_number, operator: args.operator, locations: args.locations });
    case 'list_device_templates': {
      const lib = await sch.getLibrary();
      const q = (args.query || '').toLowerCase().trim();
      const devices = q ? lib.devices.filter((d) => [d.id, d.name, d.manufacturer, d.model, d.category].some((s) => String(s || '').toLowerCase().includes(q))) : lib.devices;
      return args.include_rules ? { devices, connectors: lib.connectors, cables: lib.cables } : devices;
    }
    case 'create_device_template':
      return await sch.createDeviceTemplate({ ...args, heightU: args.height_u, hardwareId: args.hardware_id });
    case 'update_device_template': {
      const { id, height_u, hardware_id, ...rest } = args;
      const patch = { ...rest };
      if (height_u !== undefined) patch.heightU = height_u;
      if (hardware_id !== undefined) patch.hardwareId = hardware_id;
      return await sch.updateDeviceTemplate(id, patch);
    }
    case 'promote_device_to_module':
      return await sch.promoteDeviceToModule(args.id, { name: args.name, code: args.code, category: args.category });
    case 'get_schematic': {
      const s = await sch.getSchematic(args.slug);
      if (!s) throw new Error(`"${args.slug}" has no schematic — create_schematic starts one (or the owner does not exist)`);
      if (!args.include_history) delete s.history;
      return s;
    }
    case 'create_schematic':
      return await sch.createSchematic(args.slug, { bump: args.bump || 'minor' });
    case 'apply_schematic_ops':
      return await sch.applySchematicOps(args.slug, args.ops, { summary: args.summary, dryRun: !!args.dry_run });
    case 'submit_schematic_for_review':
      return await sch.setSchematicStatus(args.slug, 'in-review');
    case 'schematic_back_to_draft':
      return await sch.setSchematicStatus(args.slug, 'draft');
    case 'release_schematic':
      return await sch.releaseSchematic(args.slug, { note: args.note });
    case 'set_schematic_release_note':
      return await sch.setSchematicReleaseNote(args.slug, args.note);
    case 'start_schematic_hotfix':
      return await sch.startSchematicHotfix(args.slug);
    case 'discard_schematic':
      return await sch.discardSchematic(args.slug);
    case 'render_schematic': {
      const s = await sch.getSchematic(args.slug);
      if (!s) throw new Error(`"${args.slug}" has no schematic`);
      const state = args.released ? s.released : s.state;
      if (!state) throw new Error('No released schematic yet');
      const svg = await renderSvg(state, await sch.schematicContext(), { lang: langOf(args.lang || DEFAULT_LANG), title: s.owner.name });
      const png = await images.rasterizeWide(svg, 1600);
      const info = images.sniff(png);
      return richContent([{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: JSON.stringify({ owner: s.owner, version: state.version, revision: state.revision, status: state.status, width: info?.width, height: info?.height }) }]);
    }
```

`images.rasterize` makes a square, letter-boxed PNG (the favicon). Add to `server/images.js`:

```js
/** PNG of an SVG at the given width, aspect kept (schematics for MCP clients). */
export async function rasterizeWide(svg, width = 1600) {
  return sharp(Buffer.isBuffer(svg) ? svg : Buffer.from(svg), { density: 220 }).resize({ width }).png().toBuffer();
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test` → all pass.

- [ ] **Step 6: Commit**

```bash
git add server/mcp.js server/images.js server/mcp-schematic.test.js
git commit -m "Schematics: MCP tools for the library, installations and the schematic lifecycle

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Web — API helpers, Installations pages, Schematic panel, module tab, library settings, manual link

**Files:**
- Modify: `web/src/api.js`, `web/src/App.jsx`, `web/src/i18n.pl.js`, `web/src/styles.css`
- Create: `web/src/components/SchematicPanel.jsx`, `web/src/components/LibraryCard.jsx`,
  `web/src/pages/InstallationsList.jsx`, `web/src/pages/InstallationDetail.jsx`
- Modify: `web/src/pages/ModuleDetail.jsx` (Schematic tab), `web/src/pages/Settings.jsx` (library card),
  `web/src/pages/ManualView.jsx` (installation select in Edit manual)

**Interfaces:**
- `api.js` gains (all return the JSON the routes in Task 8 return):
  `schematicPath(owner)` (`owner` = module slug or `inst:<slug>`), `library()`, `saveConnectors(body)`,
  `createDeviceTemplate(body)`, `updateDeviceTemplate(id, body)`, `deleteDeviceTemplate(id)`,
  `promoteDevice(id, body)`, `installations()`, `createInstallation(body)`, `installation(slug)`,
  `updateInstallation(slug, body)`, `deleteInstallation(slug)`, `schematic(owner)`,
  `createSchematic(owner, bump)`, `schematicOps(owner, ops, {summary, dryRun})`,
  `schematicAction(owner, action)` (`submit-review` | `back-to-draft` | `hotfix` | `discard`),
  `releaseSchematic(owner, note)`, `schematicReleaseNote(owner, note)`, `schematicChat(owner, messages, lang)`.
- `SchematicPanel({ owner, canEdit, isAdmin, onChanged })` — the whole read-only schematic UI; used by
  the module page tab and the installation page.
- No new npm dependency (React Flow is Phase 2).

- [ ] **Step 1: API helpers**

Append inside the `api` object in `web/src/api.js`:

```js
  // ----- schematics, installations, device library -----
  library: () => request('/api/library'),
  saveConnectors: (body) => request('/api/library/connectors', { method: 'PUT', body }),
  createDeviceTemplate: (body) => request('/api/library/devices', { method: 'POST', body }),
  updateDeviceTemplate: (id, body) => request(`/api/library/devices/${encodeURIComponent(id)}`, { method: 'PUT', body }),
  deleteDeviceTemplate: (id) => request(`/api/library/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  promoteDevice: (id, body) => request(`/api/library/devices/${encodeURIComponent(id)}/promote`, { method: 'POST', body }),
  installations: () => request('/api/installations'),
  createInstallation: (body) => request('/api/installations', { method: 'POST', body }),
  installation: (slug) => request(`/api/installations/${slug}`),
  updateInstallation: (slug, body) => request(`/api/installations/${slug}`, { method: 'PUT', body }),
  deleteInstallation: (slug) => request(`/api/installations/${slug}`, { method: 'DELETE' }),
  schematic: (owner) => request(schematicPath(owner)),
  createSchematic: (owner, bump = 'minor') => request(schematicPath(owner), { method: 'POST', body: { bump } }),
  schematicOps: (owner, ops, { summary = '', dryRun = false } = {}) => request(`${schematicPath(owner)}/ops`, { method: 'POST', body: { ops, summary, dryRun } }),
  schematicAction: (owner, action) => request(`${schematicPath(owner)}/${action}`, { method: 'POST' }),
  releaseSchematic: (owner, note) => request(`${schematicPath(owner)}/release`, { method: 'POST', body: { note } }),
  schematicReleaseNote: (owner, note) => request(`${schematicPath(owner)}/release-note`, { method: 'PUT', body: { note } }),
  schematicChat: (owner, messages, lang = 'en') => request(`${schematicPath(owner)}/chat`, { method: 'POST', body: { messages, lang } }),
```

and above the `api` object:

```js
/** Where an owner's schematic lives: a module by slug, an installation as `inst:<slug>`. */
export const schematicPath = (owner) =>
  String(owner).startsWith('inst:') ? `/api/installations/${encodeURIComponent(String(owner).slice(5))}/schematic` : `/api/modules/${owner}/schematic`;
export const schematicSvgUrl = (owner, { released = false, lang = 'en', v = '' } = {}) =>
  `${schematicPath(owner)}/render.svg?${new URLSearchParams({ ...(released ? { released: '1' } : {}), ...(lang !== 'en' ? { lang } : {}), v }).toString()}`;
```

- [ ] **Step 2: The schematic panel**

`web/src/components/SchematicPanel.jsx`:

```jsx
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, schematicSvgUrl, askReleaseNote } from '../api.js';
import ActionMenu from './ActionMenu.jsx';
import { useToast } from '../App.jsx';
import { t, plural, locale } from '../i18n.jsx';

/** One line of an operation, for the pending list and the history. */
export function describeOp(op) {
  const end = (e) => (e?.block ? `${e.block}.${e.port}` : `${e?.device}.${e?.port}`);
  switch (op.op) {
    case 'add_device': return t('Add device {label}', { label: op.label || op.template });
    case 'update_device': return t('Update device {id}', { id: op.id });
    case 'remove_device': return t('Remove device {id}', { id: op.id });
    case 'connect': return t('Connect {from} → {to}{kind}', { from: end(op.from), to: end(op.to), kind: op.kind ? ` (${op.kind})` : '' });
    case 'update_cable': return t('Update cable {id}', { id: op.id });
    case 'disconnect': return t('Remove cable {id}', { id: op.id });
    case 'set_external_port': return t('External port {label} = {dev}.{port}', { label: op.label || op.id, dev: op.device, port: op.port });
    case 'unset_external_port': return t('Remove external port {id}', { id: op.id });
    case 'add_location': return t('Add location {label}', { label: op.label });
    case 'update_location': return t('Update location {id}', { id: op.id });
    case 'remove_location': return t('Remove location {id}', { id: op.id });
    case 'place_block': return t('Place module {module}', { module: op.module });
    case 'refresh_block': return t('Refresh block {id}', { id: op.id });
    case 'remove_block': return t('Remove block {id}', { id: op.id });
    case 'move': return t('Move {id}', { id: op.id });
    case 'tidy': return t('Tidy the layout');
    default: return op.op;
  }
}

/**
 * The schematic of one owner, read-only in this phase: status and actions, the drawing rendered by the
 * server, validation, the cable schedule, and the chat drawer whose operations are accepted or rejected.
 */
export default function SchematicPanel({ owner, canEdit = false, isAdmin = false, onChanged }) {
  const toast = useToast();
  const [data, setData] = useState(undefined); // undefined loading, null none
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('drawing');
  const [v, setV] = useState(0);

  const load = useCallback(() => api.schematic(owner).then(setData).catch((e) => (e.code === 'no-schematic' || e.status === 404 ? setData(null) : toast(e.message, 'err'))), [owner]);
  useEffect(() => { load(); }, [load]);
  const changed = () => { setV((x) => x + 1); load(); onChanged?.(); };

  const run = async (fn, okMsg) => {
    setBusy(true);
    try {
      await fn();
      if (okMsg) toast(okMsg);
      changed();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  if (data === undefined) return <div className="empty">{t('Loading…')}</div>;
  if (data === null) {
    return (
      <div className="empty">
        <p>{t('No schematic yet.')}</p>
        <p className="small">{t('A schematic is the wiring as data: devices with typed ports, cables, locations. Build it by telling the chat what is connected to what, or over MCP.')}</p>
        {canEdit && <button className="btn btn-primary" disabled={busy} onClick={() => run(() => api.createSchematic(owner), t('Schematic draft created'))}>{t('+ Create schematic')}</button>}
      </div>
    );
  }

  const { state, released, isDraft, editable, validation, schedule, face } = data;
  const errors = validation.errors.length;
  const warnings = validation.warnings.length;

  const release = () => {
    const note = askReleaseNote({ hotfix: !!state.hotfix, first: !released });
    if (note === null) return;
    run(() => api.releaseSchematic(owner, note), t('Schematic released'));
  };
  const releaseNote = () => {
    const note = askReleaseNote({ current: (released?.releaseRecord || []).at(-1)?.summary || '' });
    if (note === null) return;
    run(() => api.schematicReleaseNote(owner, note), t('Revision record line saved'));
  };

  return (
    <div className="schematic-panel">
      <div className="schematic-head">
        <div>
          <span className={`badge badge-${state.hotfix ? 'in-review' : state.status}`}>{state.hotfix ? t('Hotfix') : t(state.status)}</span>{' '}
          <strong>{state.version}</strong> <span className="muted">r{state.revision}</span>
          {released && released.version !== state.version && <span className="muted"> · {t('released {v}', { v: released.version })}</span>}
          {errors > 0 && <span className="chip chip-err" title={validation.errors.map((e) => e.message).join('\n')}> {plural(errors, 'error')}</span>}
          {warnings > 0 && <span className="chip chip-warn" title={validation.warnings.map((w) => w.message).join('\n')}> {plural(warnings, 'warning')}</span>}
        </div>
        {canEdit && (
          <div className="btn-row">
            {editable && !state.hotfix && state.status === 'draft' && <button className="btn btn-sm" disabled={busy} onClick={() => run(() => api.schematicAction(owner, 'submit-review'), t('Submitted for review'))}>{t('Submit for review')}</button>}
            {editable && state.status === 'in-review' && <button className="btn btn-sm" disabled={busy} onClick={() => run(() => api.schematicAction(owner, 'back-to-draft'))}>{t('Back to draft')}</button>}
            {editable && <button className="btn btn-sm btn-primary" disabled={busy || errors > 0} title={errors ? t('Fix the errors first') : ''} onClick={release}>{state.hotfix ? t('Publish hotfix') : t('Release…')}</button>}
            {!editable && <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.createSchematic(owner), t('Next version started'))}>{t('New version')}</button>}
            <ActionMenu
              items={[
                !editable && { label: t('Hotfix'), onClick: () => run(() => api.schematicAction(owner, 'hotfix'), t('Hotfix started')) },
                !editable && released && { label: t('Revision record line…'), onClick: releaseNote },
                { label: t('Download cable schedule (CSV)'), onClick: () => window.open(`${schematicSvgUrl(owner).replace('/render.svg', '/cables.csv').split('?')[0]}`, '_blank') },
                editable && isAdmin && { label: t('Discard draft'), danger: true, onClick: () => window.confirm(t('Discard this draft? The released version stays.')) && run(() => api.schematicAction(owner, 'discard'), t('Draft discarded')) },
              ].filter(Boolean)}
            />
          </div>
        )}
      </div>

      <div className="tabs">
        <button className={tab === 'drawing' ? 'active' : ''} onClick={() => setTab('drawing')}>{t('Drawing')}</button>
        <button className={tab === 'cables' ? 'active' : ''} onClick={() => setTab('cables')}>{t('Cable schedule')}{schedule.length ? ` (${schedule.length})` : ''}</button>
        {face.length > 0 && <button className={tab === 'face' ? 'active' : ''} onClick={() => setTab('face')}>{t('External ports')} ({face.length})</button>}
        <button className={tab === 'checks' ? 'active' : ''} onClick={() => setTab('checks')}>{t('Checks')}{errors + warnings ? ` (${errors + warnings})` : ''}</button>
      </div>

      {tab === 'drawing' && (
        <div className="schematic-drawing">
          <img src={schematicSvgUrl(owner, { lang: locale(), v })} alt={t('Schematic')} />
        </div>
      )}
      {tab === 'cables' && (
        schedule.length === 0 ? <div className="empty">{t('No cables yet.')}</div> : (
          <table className="table">
            <thead><tr><th>{t('Cable')}</th><th>{t('Kind')}</th><th>{t('From')}</th><th>{t('Port')}</th><th>{t('To')}</th><th>{t('Port')}</th><th>{t('Length')}</th></tr></thead>
            <tbody>{schedule.map((r) => <tr key={r.id}><td>{r.label || r.id}</td><td>{r.kindLabel}</td><td>{r.from}</td><td>{r.fromPort}</td><td>{r.to}</td><td>{r.toPort}</td><td>{r.length != null ? `${r.length} m` : ''}</td></tr>)}</tbody>
          </table>
        )
      )}
      {tab === 'face' && (
        <table className="table">
          <thead><tr><th>{t('Port')}</th><th>{t('Connector')}</th><th>{t('Inside')}</th></tr></thead>
          <tbody>{face.map((p) => <tr key={p.id}><td>{p.label}</td><td>{p.connector || '—'}</td><td>{p.device} · {p.port}</td></tr>)}</tbody>
        </table>
      )}
      {tab === 'checks' && (
        errors + warnings === 0 ? <div className="empty">{t('No problems found.')}</div> : (
          <ul className="check-list">
            {validation.errors.map((e, i) => <li key={`e${i}`} className="check-err"><strong>{t('Error')}</strong> {e.message}</li>)}
            {validation.warnings.map((w, i) => <li key={`w${i}`} className="check-warn"><strong>{t('Warning')}</strong> {w.message}</li>)}
          </ul>
        )
      )}

      {canEdit && editable && <SchematicChat owner={owner} onApplied={changed} />}
      {canEdit && !editable && <p className="hint">{t('This version is released — start a new version or a hotfix to change it.')}</p>}
    </div>
  );
}

/** The chat drawer: a sentence in, operations out, accepted as one commit or rejected. */
function SchematicChat({ owner, onApplied }) {
  const toast = useToast();
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(null); // { ops, validation, reply }
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [messages, pending]);

  async function send() {
    const content = text.trim();
    if (!content || busy) return;
    const next = [...messages, { role: 'user', content }];
    setMessages(next);
    setText('');
    setBusy(true);
    try {
      const r = await api.schematicChat(owner, next, locale());
      setMessages([...next, { role: 'assistant', content: [r.reply, r.note].filter(Boolean).join('\n') }]);
      setPending(r.ops.length ? { ops: r.ops, validation: r.validation, reply: r.reply } : null);
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  }
  async function accept() {
    setBusy(true);
    try {
      await api.schematicOps(owner, pending.ops, { summary: `AI edit: ${pending.reply}`.slice(0, 120) });
      setPending(null);
      toast(t('Change applied'));
      onApplied();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  }
  const dropOp = (i) => setPending((p) => {
    const ops = p.ops.filter((_, k) => k !== i);
    return ops.length ? { ...p, ops } : null;
  });

  return (
    <div className="schematic-chat">
      <h3>{t('Build with chat')}</h3>
      <div className="chat-log">
        {messages.length === 0 && <p className="hint">{t('Example: “Behringer UMC404HD in rack 1, powered from power strip 1 socket 1, Phones 1 to the captain headset in the cockpit.”')}</p>}
        {messages.map((m, i) => <div key={i} className={`chat-msg ${m.role}`}>{m.content}</div>)}
        {pending && (
          <div className="pending-ops">
            <div className="pending-title">{t('Proposed change')} · {plural(pending.ops.length, 'operation')}
              {pending.validation?.errors?.length ? <span className="chip chip-err"> {plural(pending.validation.errors.length, 'error')}</span> : null}
              {pending.validation?.warnings?.length ? <span className="chip chip-warn"> {plural(pending.validation.warnings.length, 'warning')}</span> : null}
            </div>
            <ol>{pending.ops.map((op, i) => <li key={i}>{describeOp(op)} <button className="btn-icon" title={t('Leave this one out')} onClick={() => dropOp(i)}>×</button></li>)}</ol>
            <div className="btn-row">
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={accept}>{t('Accept')}</button>
              <button className="btn btn-sm" disabled={busy} onClick={() => setPending(null)}>{t('Reject')}</button>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div className="chat-input">
        <textarea rows={2} value={text} placeholder={t('What is connected to what?')} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button className="btn btn-primary" disabled={busy || !text.trim()} onClick={send}>{busy ? t('Thinking…') : t('Send')}</button>
      </div>
    </div>
  );
}
```

`askReleaseNote` exists in `api.js` (it prompts and returns `null` on cancel) — read its signature
there before use; `ActionMenu` takes `items: [{label, onClick, danger?}]` — confirm in
`components/ActionMenu.jsx` and adapt the prop name if it differs.

- [ ] **Step 3: Installations pages**

`web/src/pages/InstallationsList.jsx`:

```jsx
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, timeAgo } from '../api.js';
import { useToast, useAuth } from '../App.jsx';
import { t } from '../i18n.jsx';

export default function InstallationsList() {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();
  const { canEdit } = useAuth();
  const load = () => api.installations().then(setRows).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); }, []);
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('Installations')}</h1>
        {canEdit && <button className="btn btn-primary" onClick={() => setOpen(true)}>{t('+ New installation')}</button>}
      </div>
      {rows === null ? <div className="empty">{t('Loading…')}</div> : rows.length === 0 ? (
        <div className="empty">
          <p>{t('No installations yet.')}</p>
          <p>{t('An installation is one simulator delivery: its racks, instructor station and cockpit, the modules placed in them and the cables between them. Assembled manuals print its wiring and take the device, serial number and operator from it.')}</p>
        </div>
      ) : (
        <table className="table">
          <thead><tr><th>{t('Installation')}</th><th>{t('Device')}</th><th>{t('Serial number')}</th><th>{t('Operator')}</th><th>{t('Schematic')}</th><th>{t('Updated')}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.slug} className="row-link" onClick={() => navigate(`/installations/${r.slug}`)}>
                <td><strong>{r.name}</strong></td><td>{r.device || '—'}</td><td>{r.serialNumber || '—'}</td><td>{r.operator || '—'}</td>
                <td>{r.schematic ? <><span className={`badge badge-${r.schematic.hotfix ? 'in-review' : r.schematic.status}`}>{r.schematic.hotfix ? t('Hotfix') : t(r.schematic.status)}</span> {r.schematic.version}</> : '—'}</td>
                <td className="muted">{timeAgo(r.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && <NewInstallation onClose={() => setOpen(false)} onCreated={(rec) => { setOpen(false); navigate(`/installations/${rec.slug}`); }} />}
    </div>
  );
}

function NewInstallation({ onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', device: '', serialNumber: '', operator: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  async function create() {
    setBusy(true);
    try { onCreated(await api.createInstallation(form)); } catch (e) { toast(e.message, 'err'); setBusy(false); }
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>{t('New installation')}</h2></div>
        <div className="modal-body">
          <label>{t('Name')}<input autoFocus value={form.name} onChange={set('name')} placeholder={t('e.g. B737 NG FTD #001')} /></label>
          <label>{t('Device')}<input value={form.device} onChange={set('device')} placeholder={t('e.g. B737-800 FNPT II MCC')} /></label>
          <div className="pair">
            <label>{t('Serial number')}<input value={form.serialNumber} onChange={set('serialNumber')} /></label>
            <label>{t('Operator')}<input value={form.operator} onChange={set('operator')} placeholder={t('Training organisation')} /></label>
          </div>
          <p className="hint">{t('It starts with three locations: Rack 1, Instructor station, Cockpit. Add more in the chat.')}</p>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn btn-primary" disabled={busy || !form.name.trim()} onClick={create}>{busy ? t('Creating…') : t('Create')}</button>
        </div>
      </div>
    </div>
  );
}
```

`web/src/pages/InstallationDetail.jsx`:

```jsx
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import SchematicPanel from '../components/SchematicPanel.jsx';
import { useToast, useAuth } from '../App.jsx';
import { t } from '../i18n.jsx';

export default function InstallationDetail() {
  const { slug } = useParams();
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();
  const { canEdit, isAdmin } = useAuth();
  const load = useCallback(() => api.installation(slug).then(setData).catch((e) => toast(e.message, 'err')), [slug]);
  useEffect(() => { load(); }, [load]);
  if (!data) return <div className="page"><div className="empty">{t('Loading…')}</div></div>;
  const { installation, manuals } = data;
  async function remove() {
    if (!window.confirm(t('Delete this installation and its schematic? This cannot be undone.'))) return;
    try { await api.deleteInstallation(slug); navigate('/installations'); } catch (e) { toast(e.message, 'err'); }
  }
  return (
    <div className="page page-wide">
      <div className="crumbs"><Link to="/installations">{t('Installations')}</Link> / {installation.name}</div>
      <div className="page-head">
        <div>
          <h1>{installation.name}</h1>
          <div className="muted">
            {[installation.device, installation.serialNumber && `${t('S/N')} ${installation.serialNumber}`, installation.operator].filter(Boolean).join(' · ') || t('No device, serial number or operator yet')}
          </div>
          {manuals.length > 0 && <div className="small">{t('Printed by')}: {manuals.map((m, i) => <span key={m.slug}>{i ? ', ' : ''}<Link to={`/manuals/${m.slug}`}>{m.name}</Link></span>)}</div>}
        </div>
        {canEdit && (
          <div className="btn-row">
            <button className="btn" onClick={() => setEditing(true)}>{t('Edit')}</button>
            {isAdmin && <button className="btn btn-danger" onClick={remove}>{t('Delete')}</button>}
          </div>
        )}
      </div>
      <SchematicPanel owner={`inst:${slug}`} canEdit={canEdit} isAdmin={isAdmin} onChanged={load} />
      {editing && <EditInstallation installation={installation} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} />}
    </div>
  );
}

function EditInstallation({ installation, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: installation.name, device: installation.device || '', serialNumber: installation.serialNumber || '', operator: installation.operator || '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  async function save() {
    setBusy(true);
    try { await api.updateInstallation(installation.slug, form); onSaved(); } catch (e) { toast(e.message, 'err'); setBusy(false); }
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>{t('Edit installation')}</h2></div>
        <div className="modal-body">
          <label>{t('Name')}<input value={form.name} onChange={set('name')} /></label>
          <label>{t('Device')}<input value={form.device} onChange={set('device')} /></label>
          <div className="pair">
            <label>{t('Serial number')}<input value={form.serialNumber} onChange={set('serialNumber')} /></label>
            <label>{t('Operator')}<input value={form.operator} onChange={set('operator')} /></label>
          </div>
          <p className="hint">{t('Manuals linked to this installation print these on their cover.')}</p>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn btn-primary" disabled={busy || !form.name.trim()} onClick={save}>{busy ? t('Saving…') : t('Save')}</button>
        </div>
      </div>
    </div>
  );
}
```

Check the modal class names used elsewhere (`modal-body`, `modal-foot`, `pair`) in `ManualView.jsx`'s
`EditManual` and reuse exactly those.

- [ ] **Step 4: Routes and navigation in `App.jsx`**

Imports:

```jsx
import InstallationsList from './pages/InstallationsList.jsx';
import InstallationDetail from './pages/InstallationDetail.jsx';
```

Nav, after the Manuals link:

```jsx
              <NavLink to="/installations">{t('Installations')}</NavLink>
```

Routes, after `/manuals/:slug`:

```jsx
              <Route path="/installations" element={<InstallationsList />} />
              <Route path="/installations/:slug" element={<InstallationDetail />} />
```

- [ ] **Step 5: Module page — Schematic tab**

In `web/src/pages/ModuleDetail.jsx`:
- add `'schematic'` to the allowed tab list on line 22;
- import `SchematicPanel from '../components/SchematicPanel.jsx'` and `useAuth` if not imported;
- after the Schema tab button add:

```jsx
        {!ownSoftware && (
          <button className={tab === 'schematic' ? 'active' : ''} onClick={() => setTab('schematic')}>
            {t('Schematic')}
          </button>
        )}
```

- after the `{tab === 'schema' && …}` line add:

```jsx
      {tab === 'schematic' && !ownSoftware && <SchematicPanel owner={slug} canEdit={canEdit} isAdmin={isAdmin} onChanged={load} />}
```

(`canEdit` / `isAdmin` come from `useAuth()`; the component already calls it for other actions — reuse.)

- [ ] **Step 6: Edit manual — installation select**

In `EditManual` (`ManualView.jsx`):

```jsx
  const [installation, setInstallation] = useState(manual.installation || '');
  const [installations, setInstallations] = useState([]);
  useEffect(() => { api.installations().then(setInstallations).catch(() => {}); }, []);
```

add `installation` to the `api.updateManual(…)` body, and above the Device / Serial / Operator `pair`:

```jsx
            <label>
              {t('Installation')}
              <select value={installation} onChange={(e) => setInstallation(e.target.value)}>
                <option value="">{t('— none (cover fields below) —')}</option>
                {installations.map((i) => <option key={i.slug} value={i.slug}>{i.name}{i.serialNumber ? ` · ${i.serialNumber}` : ''}</option>)}
              </select>
            </label>
```

and disable the three inputs when `installation` is set, with a hint:
`{installation && <p className="hint">{t('Device, serial number and operator are taken from the installation.')}</p>}`.

On the manual page itself, where `missingRefs` badges are shown, add when `data.installation`:

```jsx
      {data.installation && (
        <div className={`hint ${data.installation.released ? '' : 'warn'}`}>
          {t('Installation')}: <Link to={`/installations/${data.installation.slug}`}>{data.installation.name}</Link>
          {data.installation.released ? ` · ${t('wiring {v} printed', { v: data.installation.version })}` : ` · ${t('no released wiring yet — the wiring chapter is left out')}`}
        </div>
      )}
```

- [ ] **Step 7: Settings — device library card**

`web/src/components/LibraryCard.jsx`:

```jsx
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../App.jsx';
import { t, plural } from '../i18n.jsx';

const CATEGORIES = ['switch', 'router', 'pc', 'audio-interface', 'power-strip', 'headset', 'display', 'panel', 'other'];
const DIRECTIONS = ['in', 'out', 'bidir'];
const SIDES = ['left', 'right', 'top', 'bottom'];

export default function LibraryCard() {
  const toast = useToast();
  const [lib, setLib] = useState(null);
  const [hardware, setHardware] = useState([]);
  const [editing, setEditing] = useState(null); // template or {} for new
  const [rulesOpen, setRulesOpen] = useState(false);
  const load = () => api.library().then(setLib).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); api.hardware().then(setHardware).catch(() => {}); }, []);
  if (!lib) return null;
  async function remove(d) {
    if (!window.confirm(t('Remove device template {name}?', { name: d.name }))) return;
    try { await api.deleteDeviceTemplate(d.id); load(); } catch (e) { toast(e.message, 'err'); }
  }
  async function promote(d) {
    const name = window.prompt(t('Module name'), d.name);
    if (!name) return;
    try { const r = await api.promoteDevice(d.id, { name }); toast(t('Module {slug} created with its schematic', { slug: r.slug })); load(); } catch (e) { toast(e.message, 'err'); }
  }
  return (
    <section className="settings-card">
      <h2>{t('Device library')}</h2>
      <p className="muted">{t('Devices a schematic places — what each one is and which ports it has. Connector and cable kinds decide which ports a cable may join.')}</p>
      <table className="table">
        <thead><tr><th>{t('Device')}</th><th>{t('Category')}</th><th>{t('Ports')}</th><th>{t('Catalog item')}</th><th></th></tr></thead>
        <tbody>
          {lib.devices.map((d) => (
            <tr key={d.id}>
              <td><strong>{d.name}</strong><div className="small muted">{[d.manufacturer, d.model].filter(Boolean).join(' ')} · {d.id}</div></td>
              <td>{d.category}</td>
              <td title={d.ports.map((p) => `${p.label} (${p.connector}, ${p.direction})`).join('\n')}>{plural(d.ports.length, 'port')}</td>
              <td>{d.hardwareId ? hardware.find((h) => h.id === d.hardwareId)?.name || d.hardwareId : '—'}</td>
              <td className="btn-row">
                <button className="btn btn-sm" onClick={() => setEditing(d)}>{t('Edit')}</button>
                <button className="btn btn-sm" onClick={() => promote(d)} title={t('Create a module of its own from this device')}>{t('Promote to module')}</button>
                <button className="btn btn-sm btn-danger" onClick={() => remove(d)}>{t('Remove')}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="btn-row">
        <button className="btn btn-primary" onClick={() => setEditing({})}>{t('+ Add device')}</button>
        <button className="btn" onClick={() => setRulesOpen((o) => !o)}>{rulesOpen ? t('Hide connector rules') : t('Connector rules…')}</button>
      </div>
      {rulesOpen && <RulesEditor lib={lib} onSaved={load} />}
      {editing && <TemplateEditor lib={lib} hardware={hardware} template={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </section>
  );
}

function TemplateEditor({ lib, hardware, template, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !template.id;
  const [form, setForm] = useState({ name: template.name || '', category: template.category || 'other', manufacturer: template.manufacturer || '', model: template.model || '', heightU: template.heightU ?? 1, hardwareId: template.hardwareId || '', notes: template.notes || '', ports: template.ports?.length ? template.ports.map((p) => ({ ...p })) : [{ id: '', label: '', connector: lib.connectors[0].id, direction: 'bidir', side: 'right' }] });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setPort = (i, k, v) => setForm((f) => ({ ...f, ports: f.ports.map((p, k2) => (k2 === i ? { ...p, [k]: v } : p)) }));
  const addPort = () => setForm((f) => ({ ...f, ports: [...f.ports, { id: '', label: '', connector: lib.connectors[0].id, direction: 'bidir', side: 'right' }] }));
  const dropPort = (i) => setForm((f) => ({ ...f, ports: f.ports.filter((_, k) => k !== i) }));
  async function save() {
    setBusy(true);
    try {
      const body = { ...form, heightU: Number(form.heightU), hardwareId: form.hardwareId || null, ports: form.ports.filter((p) => p.label.trim() || p.id.trim()) };
      if (isNew) await api.createDeviceTemplate(body); else await api.updateDeviceTemplate(template.id, body);
      onSaved();
    } catch (e) { toast(e.message, 'err'); setBusy(false); }
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>{isNew ? t('New device template') : t('Edit device template')}</h2></div>
        <div className="modal-body">
          <div className="pair">
            <label style={{ flex: 2 }}>{t('Name')}<input autoFocus value={form.name} onChange={set('name')} /></label>
            <label>{t('Category')}<select value={form.category} onChange={set('category')}>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
          </div>
          <div className="pair">
            <label>{t('Manufacturer')}<input value={form.manufacturer} onChange={set('manufacturer')} /></label>
            <label>{t('Model')}<input value={form.model} onChange={set('model')} /></label>
            <label style={{ flex: 0.5 }}>{t('Height (U)')}<input type="number" min="0" step="1" value={form.heightU} onChange={set('heightU')} /></label>
          </div>
          <label>{t('Hardware catalog item')}
            <select value={form.hardwareId} onChange={set('hardwareId')}>
              <option value="">{t('— none —')}</option>
              {hardware.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </label>
          <div className="field">
            <span className="field-label">{t('Ports')}</span>
            <table className="table ports-edit">
              <thead><tr><th>{t('Id')}</th><th>{t('Label')}</th><th>{t('Connector')}</th><th>{t('Direction')}</th><th>{t('Side')}</th><th></th></tr></thead>
              <tbody>
                {form.ports.map((p, i) => (
                  <tr key={i}>
                    <td><input value={p.id} placeholder={t('auto')} onChange={(e) => setPort(i, 'id', e.target.value)} /></td>
                    <td><input value={p.label} onChange={(e) => setPort(i, 'label', e.target.value)} /></td>
                    <td><select value={p.connector} onChange={(e) => setPort(i, 'connector', e.target.value)}>{lib.connectors.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></td>
                    <td><select value={p.direction} onChange={(e) => setPort(i, 'direction', e.target.value)}>{DIRECTIONS.map((d) => <option key={d} value={d}>{d}</option>)}</select></td>
                    <td><select value={p.side} onChange={(e) => setPort(i, 'side', e.target.value)}>{SIDES.map((s) => <option key={s} value={s}>{s}</option>)}</select></td>
                    <td><button className="btn-icon" onClick={() => dropPort(i)}>×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn btn-sm" onClick={addPort}>{t('+ Port')}</button>
          </div>
          <label>{t('Notes')}<input value={form.notes} onChange={set('notes')} /></label>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn btn-primary" disabled={busy || !form.name.trim()} onClick={save}>{busy ? t('Saving…') : t('Save')}</button>
        </div>
      </div>
    </div>
  );
}

/** Connector and cable kinds as JSON — a short list the technician edits once, so a form would be more than it is worth in this phase. */
function RulesEditor({ lib, onSaved }) {
  const toast = useToast();
  const [text, setText] = useState(() => JSON.stringify({ connectors: lib.connectors, cables: lib.cables }, null, 2));
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await api.saveConnectors(JSON.parse(text)); toast(t('Connector rules saved')); onSaved(); } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  }
  return (
    <div className="rules-editor">
      <p className="hint">{t('connectors: [{id, label, color}] · cables: [{id, label, joins: [[connectorA, connectorB], …], style: {color, width, dash}}]. Every join must name existing connectors.')}</p>
      <textarea className="guidelines-edit" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? t('Saving…') : t('Save connector rules')}</button>
    </div>
  );
}
```

`api.hardware()` — check the name of the existing catalog list helper in `api.js` (grep `'/api/hardware'`)
and use that one.

In `Settings.jsx` import `LibraryCard from '../components/LibraryCard.jsx'` and render `<LibraryCard />`
after `<IllustrationStyleCard />`.

- [ ] **Step 8: Styles**

Append to `web/src/styles.css`:

```css
/* ---- schematics ---- */
.schematic-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.schematic-drawing { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 12px; overflow: auto; }
.schematic-drawing img { max-width: 100%; display: block; margin: 0 auto; }
.chip-err { background: var(--red-soft); color: var(--red); }
.chip-warn { background: var(--amber-soft); color: var(--amber-ink); }
.check-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
.check-list li { padding: 8px 12px; border-radius: 8px; background: var(--panel); border: 1px solid var(--line); }
.check-list li.check-err { border-color: var(--red); }
.schematic-chat { margin-top: 18px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); padding: 12px 14px; }
.schematic-chat h3 { margin: 0 0 8px; font-size: 14px; }
.chat-log { max-height: 320px; overflow: auto; display: grid; gap: 8px; margin-bottom: 10px; }
.chat-msg { padding: 8px 10px; border-radius: 8px; white-space: pre-wrap; max-width: 80%; }
.chat-msg.user { background: var(--accent-soft-2); justify-self: end; }
.chat-msg.assistant { background: var(--soft); }
.pending-ops { border: 1px dashed var(--amber-ink); border-radius: 8px; padding: 8px 12px; background: var(--amber-soft); }
.pending-ops ol { margin: 6px 0 8px; padding-left: 20px; }
.pending-title { font-weight: 600; }
.chat-input { display: flex; gap: 8px; align-items: flex-end; }
.chat-input textarea { flex: 1; resize: vertical; }
.modal-wide { width: 860px; }
.ports-edit input, .ports-edit select { width: 100%; }
.rules-editor { margin-top: 12px; }
```

- [ ] **Step 9: Polish strings**

Add to `web/src/i18n.pl.js` every new `t()` key. Plural forms first:

```js
  '#error': 'błąd|błędy|błędów',
  '#warning': 'ostrzeżenie|ostrzeżenia|ostrzeżeń',
  '#operation': 'operacja|operacje|operacji',
  '#port': 'port|porty|portów',
```

Then the sentences, e.g.:

```js
  Installations: 'Instalacje', Installation: 'Instalacja', '+ New installation': '+ Nowa instalacja', 'New installation': 'Nowa instalacja', 'Edit installation': 'Edytuj instalację',
  'No installations yet.': 'Brak instalacji.',
  'An installation is one simulator delivery: its racks, instructor station and cockpit, the modules placed in them and the cables between them. Assembled manuals print its wiring and take the device, serial number and operator from it.': 'Instalacja to jedna dostawa symulatora: jej szafy rack, stanowisko instruktora i kokpit, umieszczone w nich moduły i kable między nimi. Instrukcje zbiorcze drukują jej okablowanie i biorą z niej urządzenie, numer seryjny i operatora.',
  Schematic: 'Schemat', 'No schematic yet.': 'Brak schematu.', '+ Create schematic': '+ Utwórz schemat', 'Schematic draft created': 'Utworzono roboczy schemat',
  'A schematic is the wiring as data: devices with typed ports, cables, locations. Build it by telling the chat what is connected to what, or over MCP.': 'Schemat to okablowanie jako dane: urządzenia z typowanymi portami, kable, lokalizacje. Zbuduj go, mówiąc czatowi, co jest z czym połączone, albo przez MCP.',
  Drawing: 'Rysunek', 'Cable schedule': 'Zestawienie kabli', 'External ports': 'Porty zewnętrzne', Checks: 'Kontrole', 'No cables yet.': 'Brak kabli.', 'No problems found.': 'Nie znaleziono problemów.',
  Cable: 'Kabel', Kind: 'Rodzaj', From: 'Z', To: 'Do', Port: 'Port', Length: 'Długość', Connector: 'Złącze', Inside: 'Wewnątrz', Error: 'Błąd', Warning: 'Ostrzeżenie',
  'Build with chat': 'Buduj przez czat', 'What is connected to what?': 'Co jest z czym połączone?', 'Proposed change': 'Proponowana zmiana', Accept: 'Zatwierdź', Reject: 'Odrzuć', 'Change applied': 'Zmiana zastosowana', 'Thinking…': 'Myślę…', Send: 'Wyślij', 'Leave this one out': 'Pomiń tę',
  'Example: “Behringer UMC404HD in rack 1, powered from power strip 1 socket 1, Phones 1 to the captain headset in the cockpit.”': 'Przykład: „Behringer UMC404HD w szafie 1, zasilany z listwy 1 gniazdo 1, Phones 1 do słuchawek kapitana w kokpicie.”',
  'Release…': 'Wydaj…', 'Publish hotfix': 'Opublikuj poprawkę', 'New version': 'Nowa wersja', 'Next version started': 'Rozpoczęto nową wersję', 'Schematic released': 'Schemat wydany', 'Fix the errors first': 'Najpierw usuń błędy',
  'Download cable schedule (CSV)': 'Pobierz zestawienie kabli (CSV)', 'Discard this draft? The released version stays.': 'Odrzucić tę wersję roboczą? Wydana wersja zostaje.',
  'This version is released — start a new version or a hotfix to change it.': 'Ta wersja jest wydana — aby ją zmienić, rozpocznij nową wersję lub poprawkę.',
  'released {v}': 'wydana {v}', 'Device library': 'Biblioteka urządzeń', 'Promote to module': 'Zamień w moduł', '+ Add device': '+ Dodaj urządzenie', 'Connector rules…': 'Reguły złączy…', 'Hide connector rules': 'Ukryj reguły złączy',
  'Add device {label}': 'Dodaj urządzenie {label}', 'Connect {from} → {to}{kind}': 'Połącz {from} → {to}{kind}', 'Place module {module}': 'Umieść moduł {module}', 'Add location {label}': 'Dodaj lokalizację {label}', 'Tidy the layout': 'Uporządkuj układ',
```

Every other string introduced above (`'Module name'`, `'Height (U)'`, `'Catalog item'`, `'Printed by'`,
`'S/N'`, `'wiring {v} printed'`, `'no released wiring yet — the wiring chapter is left out'`, and the
rest) gets its line too — grep the four new files and the three edited ones for `t('` and `t("` and
make sure each key has an entry.

- [ ] **Step 10: Build and look**

Run: `npm run build` → no errors. Run `npm run dev`, sign in, open Settings (library card lists the
seed devices), Installations (create one, open it: drawing shows the three empty frames, Checks lists
three `location-empty` warnings), a module's Schematic tab (create, chat is present when a key is set).

- [ ] **Step 11: Commit**

```bash
git add web/src
git commit -m "Schematics: installations pages, schematic panel with chat, module tab, device library settings, manual link

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Smoke scenario and documentation

**Files:**
- Modify: `tools/smoke.mjs`, `CLAUDE.md`, `README.md`

- [ ] **Step 1: Add the smoke scenario**

Before the `// module delete:` block in `tools/smoke.mjs` add (it uses the `req`, `ok`, `mcpCall`
helpers already in the file; `mcpCall` is defined inside the MCP section — move the scenario after it
or lift `mcpCall` to file scope):

```js
  // ---- schematics: library → module schematic → installation → manual ----
  const lib = await req('GET', '/api/library');
  ok(lib.devices.some((d) => d.id === 'behringer-umc404hd') && lib.cables.length >= 6, 'device library ships with seed templates and cable kinds');
  const tpl = await req('POST', '/api/library/devices', { name: 'Smoke switch', category: 'switch', ports: [{ id: 'pwr', label: 'Power', connector: 'iec-c14', direction: 'in' }, { id: 'p1', label: 'Port 1', connector: 'rj45' }] });
  ok(tpl.id === 'smoke-switch' && tpl.ports.length === 2, 'device template created');
  const badTpl = await req('POST', '/api/library/devices', { name: 'Bad', ports: [{ label: 'X', connector: 'nope' }] }).catch((e) => e);
  ok(badTpl instanceof Error && /connector/.test(badTpl.message), 'unknown connector is refused');

  const schMod = await req('POST', '/api/modules', { name: 'Smoke audio', type: 'own-module', category: 'cockpit', hardware: [{ name: 'Behringer UMC404HD', type: 'cots', manufacturer: 'Behringer', model: 'UMC404HD' }], softwares: [], start: { mode: 'blank' }, checklist: { mode: 'none' } });
  const noSch = await req('GET', `/api/modules/${schMod.slug}/schematic`).catch((e) => e);
  ok(noSch instanceof Error && noSch.status === 404, 'module without schematic → 404');
  const sch1 = await req('POST', `/api/modules/${schMod.slug}/schematic`);
  ok(sch1.version === 'A1.0' && sch1.status === 'draft', 'module schematic draft A1.0');
  const hwId = schMod.hardware[0].id;
  const opsRes = await req('POST', `/api/modules/${schMod.slug}/schematic/ops`, {
    ops: [
      { op: 'add_device', id: 'umc', template: 'behringer-umc404hd', hardwareId: hwId, label: 'UMC404HD' },
      { op: 'add_device', id: 'hs', template: 'headset', label: 'Captain headset' },
      { op: 'connect', from: { device: 'umc', port: 'phones-1' }, to: { device: 'hs', port: 'jack' }, label: 'AUD-01', length: 3 },
      { op: 'set_external_port', id: 'power-in', label: 'Power in', device: 'umc', port: 'pwr' },
      { op: 'set_external_port', id: 'usb-host', label: 'USB to host PC', device: 'umc', port: 'usb' },
    ],
    summary: 'Smoke wiring',
  });
  ok(opsRes.state.revision === 2 && opsRes.summary.length === 5 && opsRes.validation.errors.length === 0, 'ops applied as one commit');
  const badOps = await req('POST', `/api/modules/${schMod.slug}/schematic/ops`, { ops: [{ op: 'connect', from: { device: 'umc', port: 'phones-2' }, to: { device: 'hs', port: 'jack' } }] }).catch((e) => e);
  ok(badOps instanceof Error && /already has cable/.test(badOps.message), 'busy port refused');
  const dry = await req('POST', `/api/modules/${schMod.slug}/schematic/ops`, { ops: [{ op: 'add_device', template: 'pc', label: 'Host PC' }], dryRun: true });
  ok(dry.state.devices.length === 3 && (await req('GET', `/api/modules/${schMod.slug}/schematic`)).state.devices.length === 2, 'dry run writes nothing');
  const svg = await fetch(`${BASE}/api/modules/${schMod.slug}/schematic/render.svg`).then((r) => r.text());
  ok(svg.startsWith('<svg') && (svg.match(/class="sch-device"/g) || []).length === 2 && /sch-external/.test(svg), 'server-side SVG renders devices and the connector face');
  const csv = await fetch(`${BASE}/api/modules/${schMod.slug}/schematic/cables.csv`).then((r) => r.text());
  ok(csv.split('\n')[1].startsWith('AUD-01,Audio,UMC404HD,Phones 1,Captain headset,Jack,3'), 'cable schedule CSV');
  const noNote = await req('POST', `/api/modules/${schMod.slug}/schematic/release`, { note: '' }).catch((e) => e);
  ok(noNote instanceof Error && /revision record/.test(noNote.message), 'schematic release needs a note');
  const schRel = await req('POST', `/api/modules/${schMod.slug}/schematic/release`, { note: 'Smoke wiring released.' });
  ok(schRel.status === 'released' && schRel.releaseRecord.at(-1).public, 'module schematic released');
  const techDoc = await req('GET', `/api/modules/${schMod.slug}/docs/technician:A1.0`);
  ok(/<h3>Connections<\/h3>/.test(techDoc.generated) && /port-list/.test(techDoc.generated), 'technician manual prints the Connections block');

  const inst = await req('POST', '/api/installations', { name: 'Smoke sim', device: 'FNPT II', serialNumber: 'SMK-1', operator: 'Smoke Academy' });
  ok(inst.slug === 'smoke-sim', 'installation created');
  const instDetail = await req('GET', `/api/installations/${inst.slug}`);
  ok(instDetail.schematic.state.locations.length === 3 && instDetail.schematic.validation.warnings.filter((w) => w.code === 'location-empty').length === 3, 'installation starts with three empty locations');
  const instOps = await req('POST', `/api/installations/${inst.slug}/schematic/ops`, {
    ops: [
      { op: 'place_block', id: 'audio', module: schMod.slug, location: 'rack-1', rack: { u: 12 } },
      { op: 'add_device', id: 'pdu-1', template: 'pdu-8', label: 'Power strip 1', location: 'rack-1' },
      { op: 'add_device', id: 'sw-1', template: 'smoke-switch', label: 'Switch 1', location: 'rack-1' },
      { op: 'connect', from: { device: 'pdu-1', port: 'out-1' }, to: { block: 'audio', port: 'power-in' }, label: 'PWR-01' },
      { op: 'connect', from: { device: 'pdu-1', port: 'out-2' }, to: { device: 'sw-1', port: 'pwr' }, label: 'PWR-02' },
    ],
  });
  ok(instOps.state.blocks.length === 1 && instOps.state.cables.length === 2 && instOps.validation.errors.length === 0, 'installation wired to the module block');
  const tplInUse = await req('DELETE', '/api/library/devices/smoke-switch').catch((e) => e);
  ok(tplInUse instanceof Error && /smoke-sim/.test(tplInUse.message), 'a template in use cannot be deleted');

  await req('POST', `/api/modules/${schMod.slug}/docs/technician:A1.0/release`, { force: true, note: 'Smoke.' });
  const schManual = await req('POST', '/api/manuals', { name: 'Smoke wiring manual', manual: 'technician', modules: [schMod.slug], installation: inst.slug });
  let compiledSch = await req('GET', `/api/manuals/${schManual.slug}`);
  ok(compiledSch.manual.serialNumber === 'SMK-1' && compiledSch.manual.operator === 'Smoke Academy', 'manual cover reads the installation');
  ok(!compiledSch.chapters.some((c) => c.installation) && compiledSch.state.blockers.some((b) => /installation/.test(b)), 'draft installation does not print and blocks the manual release');
  await req('POST', `/api/installations/${inst.slug}/schematic/release`, { note: 'Smoke installation issue 1.' });
  compiledSch = await req('GET', `/api/manuals/${schManual.slug}`);
  ok(compiledSch.chapters.some((c) => c.installation) && /Installation wiring/.test(compiledSch.html) && /cable-schedule/.test(compiledSch.html), 'released installation prints the wiring chapter');
  ok(compiledSch.installation?.released === true, 'compile reports the installation');

  // hotfix round trip on the installation
  const hf = await req('POST', `/api/installations/${inst.slug}/schematic/hotfix`);
  ok(hf.hotfix && hf.revision === instOps.state.revision + 1, 'installation hotfix opened');
  await req('POST', `/api/installations/${inst.slug}/schematic/ops`, { ops: [{ op: 'update_cable', id: 'c-1', label: 'PWR-01A' }] });
  const pub = await req('POST', `/api/installations/${inst.slug}/schematic/release`, { note: 'Relabelled PWR-01.' });
  ok(!pub.hotfix && pub.version === 'A1.0' && pub.cables[0].label === 'PWR-01A', 'hotfix published into the same version');

  // MCP: the schematic tools answer
  const mcpSch = await mcpCall({ jsonrpc: '2.0', id: 50, method: 'tools/call', params: { name: 'get_schematic', arguments: { slug: 'Smoke sim' } } });
  ok(!mcpSch.isError && /"kind": "installation"/.test(mcpSch.content[0].text), 'MCP get_schematic resolves an installation by name');
  const mcpTpl = await mcpCall({ jsonrpc: '2.0', id: 51, method: 'tools/call', params: { name: 'list_device_templates', arguments: { query: 'smoke' } } });
  ok(/smoke-switch/.test(mcpTpl.content[0].text), 'MCP list_device_templates filters');
  const mcpRender = await mcpCall({ jsonrpc: '2.0', id: 52, method: 'tools/call', params: { name: 'render_schematic', arguments: { slug: schMod.slug, released: true } } });
  ok(mcpRender.content[0].type === 'image' && mcpRender.content[0].mimeType === 'image/png', 'MCP render_schematic returns a PNG');
  const mcpInst = await mcpCall({ jsonrpc: '2.0', id: 53, method: 'tools/call', params: { name: 'create_installation', arguments: { name: 'MCP sim', serial_number: 'MCP-1' } } });
  ok(/"slug": "mcp-sim"/.test(mcpInst.content[0].text), 'MCP create_installation');
  const mcpNext = await mcpCall({ jsonrpc: '2.0', id: 54, method: 'tools/call', params: { name: 'create_schematic', arguments: { slug: schMod.slug, bump: 'major' } } });
  ok(/"version": "A2.0"/.test(mcpNext.content[0].text), 'MCP create_schematic bumps to A2.0');
  const mcpDiscard = await mcpCall({ jsonrpc: '2.0', id: 55, method: 'tools/call', params: { name: 'discard_schematic', arguments: { slug: schMod.slug } } });
  ok(!mcpDiscard.isError, 'MCP discard_schematic');
  const promoted = await req('POST', '/api/library/devices/smoke-switch/promote', { name: 'Smoke core switch' });
  ok(promoted.slug === 'smoke-core-switch' && promoted.schematic.externalPorts.length === 2, 'promote: module + schematic with every port external');
  const delInstLinked = await req('DELETE', `/api/installations/${inst.slug}`).catch((e) => e);
  ok(delInstLinked instanceof Error && /Smoke wiring manual/.test(delInstLinked.message), 'an installation linked by a manual cannot be deleted');
  // viewers only read (the first viewer was deleted earlier in this run — make another)
  const schViewer = await req('POST', '/api/users', { email: 'view2@ftd.aero', name: 'Vi2', password: 'viewpass123', role: 'viewer' });
  const schViewerCookie = await login('view2@ftd.aero', 'viewpass123');
  const viewerSch = await req('POST', `/api/installations/${inst.slug}/schematic/ops`, { ops: [{ op: 'tidy' }] }, { cookie: schViewerCookie }).catch((e) => e);
  ok(viewerSch instanceof Error && viewerSch.status === 403, 'viewer cannot change a schematic');
  ok((await req('GET', `/api/installations/${inst.slug}`, undefined, { cookie: schViewerCookie })).schematic.state.version === 'A1.0', 'viewer can read a schematic');
  await req('DELETE', `/api/users/${schViewer.id}`);
```

`viewerCookie` is defined near the top of the smoke file; keep this block after it. The cable id `c-1`
is what the applier derives for the first cable with no id — if the hotfix step fails on it, read the
id from `instOps.state.cables[0].id` instead.

- [ ] **Step 2: Run the whole check**

Run: `npm test && npm run build && npm run smoke`
Expected: tests pass, build clean, `SMOKE: ALL PASS`.

- [ ] **Step 3: Document**

Append to the `## Domain rules` section of `CLAUDE.md`:

```markdown
- **Schematics** (`server/schematic.js` pure applier/validator, `server/schematics-store.js` lifecycle,
  `server/schematic-render.js` elk + SVG, `server/schematic-ai.js` chat, `server/schematic-routes.js`):
  a schematic is a netlist — devices from the **device library** (`library/devices.json`, ports typed by
  `library/connectors.json`; Settings → Device library, MCP `list_device_templates` …), cables between
  ports, locations. It is changed only by **operations** (`applyOps`: `add_device`, `connect`,
  `set_external_port`, `place_block`, …) applied as one commit or refused as a whole; the chat answers with
  operations that are dry-run and shown as pending until accepted. A **module schematic**
  (`modules/<slug>/schematic.json`) wires the module's parts and declares its **external ports**; an
  **installation** (`installations/<slug>/installation.json` on main + `schematic.json`, `/installations`,
  owner ref `inst:<slug>`) places modules as **blocks** (pinned to a released module schematic, flagged
  outdated when a newer one is released) and free library devices in locations. Lifecycle like a doc:
  `draft/<slug>-schematic-a1.0` / `draft/inst/<slug>-schematic-a1.0`, review, release with a note, hotfix,
  discard, next version — refused while validation has errors. Only released schematics print: the
  *Connections* block (figure, External ports, Cable schedule) in a technician manual's section 3, and
  for an assembled manual with `manual.installation` the *Installation wiring* chapter plus the cover's
  device / serial / operator from the installation. Infrastructure (switches, PDUs) are library devices;
  `promoteDeviceToModule` turns one into a module when it deserves a manual. No React Flow canvas yet
  (Phase 2) — the web shows the server-rendered SVG.
```

In `README.md`, under the product description, add one paragraph: installations and schematics exist,
are built from chat or MCP, print into technician manuals, and the interactive canvas is the next phase.

- [ ] **Step 4: Commit**

```bash
git add tools/smoke.mjs CLAUDE.md README.md
git commit -m "Schematics: smoke scenario and documentation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Out of scope for this plan (Phase 2 and later)

Interactive canvas (React Flow + elkjs in the browser, palette, drag-connect, property panel, Tidy,
review view with comments anchored on nodes), rack elevation view, version diff, cable labels for a
label printer, *Replace with module block* after promotion, review comments on schematics, and resolving
an author-typed `<figure data-schematic="…">` inside a doc body (the generated Connections block already
prints the module's own wiring, so nothing is lost until an author wants another module's drawing).
