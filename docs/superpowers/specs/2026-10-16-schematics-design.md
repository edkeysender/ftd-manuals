# Schematics — design

Date: 2026-10-16. Status: draft for review.

A 2D connection schematic for a simulator installation and for each module, drawn in the
Documentation Console, built from chat sentences or by drag and drop, versioned like a doc,
printed into the technician manuals. The nearest thing it resembles is a very small EPLAN.

## 1. Goal and scope

- Technicians need, on site, a plan of what is connected to what: racks, instructor station (IOS),
  cockpit; network, power, audio, USB and serial cabling; the devices in between (switches, routers,
  audio interfaces, power strips, PCs).
- Two levels, mirroring how manuals already compose:
  - a **module schematic** — the internal wiring of one module and the connectors that leave it;
  - an **installation schematic** — one simulator delivery: locations, the chapter modules as blocks,
    free-standing library devices (a switch is not a module today), and the cables between them.
- An author builds either one by telling the chat ("the Behringer UMC404HD sits in rack 1, powered
  from power strip 1 socket 1, headphone outputs go to the cockpit headsets") or by dragging from a
  palette and connecting ports. Both produce the same data.
- The drawing is a **logical connection diagram** first (symbols with port stubs inside location frames).
  The data keeps an optional rack position per device so a **rack elevation** view can be rendered from
  the same data later. Both views are read from one model; nothing is drawn twice.
- Out of scope for the first delivery: rack elevation rendering, cable-label printing, version diff
  view, wire gauge / power budget calculations, importing EPLAN or other CAD files.

## 2. Principle: netlist first, canvas second

The schematic is **data, not a picture**: devices with typed ports, cables as port-to-port
connections, locations as groups, plus a saved layout. The drawing is a rendering of that data.

This is what makes the chat reliable and the versions diffable: the AI never draws and never emits
coordinates. It emits **operations** (`add_device`, `connect`, …) that the console validates, applies
and commits — the same pattern the manual editor already uses, where the model returns JSON and the
server turns it into a commit.

## 3. Data model

All JSON files in the git store (`data/repo`), written through the store, never by hand.

### 3.1 Device library (on `main`)

`library/connectors.json` — connector and cable kinds, editable in Settings and over MCP:

```json
{
  "connectors": [
    {"id": "rj45", "label": "RJ45", "color": "#2b7bba"},
    {"id": "usb-a", "label": "USB-A"}, {"id": "usb-b", "label": "USB-B"}, {"id": "usb-c", "label": "USB-C"},
    {"id": "iec-c13", "label": "IEC C13"}, {"id": "iec-c14", "label": "IEC C14"}, {"id": "schuko", "label": "Schuko"},
    {"id": "trs-6.35", "label": "TRS 6.35 mm"}, {"id": "xlr-m", "label": "XLR male"}, {"id": "xlr-f", "label": "XLR female"},
    {"id": "hdmi", "label": "HDMI"}, {"id": "dp", "label": "DisplayPort"}, {"id": "db9", "label": "DB9"}
  ],
  "cables": [
    {"id": "ethernet", "label": "Ethernet", "joins": [["rj45", "rj45"]], "style": {"color": "#2b7bba"}},
    {"id": "power", "label": "Power", "joins": [["iec-c14", "schuko"], ["iec-c14", "iec-c13"]], "style": {"color": "#111", "width": 2}},
    {"id": "usb", "label": "USB", "joins": [["usb-a", "usb-b"], ["usb-a", "usb-c"], ["usb-c", "usb-c"]]},
    {"id": "audio", "label": "Audio", "joins": [["trs-6.35", "trs-6.35"], ["xlr-m", "xlr-f"]], "style": {"color": "#2a9d4b"}},
    {"id": "video", "label": "Video", "joins": [["hdmi", "hdmi"], ["dp", "dp"]]},
    {"id": "serial", "label": "Serial", "joins": [["db9", "db9"]]}
  ]
}
```

`joins` lists the unordered connector pairs a cable kind may terminate in. A console-shipped default
is seeded on first start (`initStore`) and is the fallback when the file is missing.

`library/devices.json` — device **templates**:

```json
{"devices": [{
  "id": "behringer-umc404hd",
  "name": "Behringer UMC404HD",
  "category": "audio-interface",
  "manufacturer": "Behringer", "model": "UMC404HD",
  "heightU": 1,
  "symbol": "box",
  "ports": [
    {"id": "pwr", "label": "Power", "connector": "iec-c14", "direction": "in", "side": "left"},
    {"id": "usb", "label": "USB", "connector": "usb-b", "direction": "bidir", "side": "left"},
    {"id": "phones-1", "label": "Phones 1", "connector": "trs-6.35", "direction": "out", "side": "right"},
    {"id": "phones-2", "label": "Phones 2", "connector": "trs-6.35", "direction": "out", "side": "right"}
  ],
  "hardwareId": "behringer-umc404hd",
  "notes": ""
}]}
```

- `category` is a free string from a short suggested list (`switch`, `router`, `pc`, `audio-interface`,
  `power-strip`, `headset`, `display`, `panel`, `other`); it picks the default symbol and the palette group.
- `symbol` is a key into a small SVG symbol set shipped with the console (`box`, `switch`, `pc`,
  `power-strip`, `headset`, `display`); nothing user-drawn in the first delivery.
- `side` is a layout hint (`left` / `right` / `top` / `bottom`), where the port stub is drawn.
- `hardwareId` links the template to a catalog item in `hardware.json` when one exists. The
  **catalog item** stays the source of what a part *is*; the **template** says what it *connects*. A
  catalog item with no template gets a generic one (category `other`, no ports) until an author adds ports.
- A template carries the same fields a module's hardware item does, so **promote to module**
  (section 6) creates the module and its catalog item with nothing re-typed.

### 3.2 Module schematic

Stored at `modules/<slug>/schematic.json`, one per module, versioned (section 4). Shape:

```json
{
  "owner": "<slug>", "kind": "module",
  "version": "A1.0", "revision": 3, "status": "draft",
  "devices": [
    {"id": "umc", "template": "behringer-umc404hd", "hardwareId": "behringer-umc404hd", "label": "UMC404HD",
     "rack": {"u": 12}}
  ],
  "cables": [
    {"id": "c1", "kind": "audio", "from": {"device": "umc", "port": "phones-1"}, "to": {"device": "hs-l", "port": "jack"},
     "label": "AUD-01", "length": 3.0, "notes": ""}
  ],
  "externalPorts": [
    {"id": "power-in", "label": "Power in", "device": "umc", "port": "pwr"},
    {"id": "usb-host", "label": "USB to host PC", "device": "umc", "port": "usb"}
  ],
  "layout": {"nodes": {"umc": {"x": 120, "y": 80}}, "manual": ["umc"]},
  "revisions": [], "releaseRecord": []
}
```

- `devices[].template` is a library template id; `hardwareId` is set when the instance is one of the
  module's catalog hardware items (the palette offers those first). A device with neither is refused.
- `externalPorts` is the module's **connector face**: the instance ports that leave the module. An
  installation block exposes exactly these.
- `layout.nodes` holds positions; `layout.manual` lists nodes the author moved by hand, which *Tidy*
  (section 7) leaves alone. `rack.u` is the optional U position for the elevation view.
- Document code: `<CODE>-SCH` (`manualDocCode` pattern), shown on the printed figure's caption.

### 3.3 Installation

Stored at `installations/<slug>/schematic.json` (the versioned netlist, same lifecycle as a module
schematic) next to `installations/<slug>/installation.json` on `main` (`slug`, `name`, `device`,
`serialNumber`, `operator`, `createdAt`, `updatedAt`), a new top-level owner kind:

```json
{
  "slug": "b737-ng-001", "name": "B737 NG FTD #001",
  "device": "B737 NG FTD", "serialNumber": "FTD-2026-001", "operator": "Example Flight Academy",
  "version": "A1.0", "revision": 7, "status": "draft",
  "locations": [
    {"id": "rack-1", "label": "Rack 1", "kind": "rack", "unitsU": 42},
    {"id": "ios", "label": "Instructor station", "kind": "area"},
    {"id": "cockpit", "label": "Cockpit", "kind": "area"}
  ],
  "blocks": [
    {"id": "audio", "module": "audio-system", "schematic": {"version": "A1.0", "revision": 3}, "location": "rack-1", "rack": {"u": 12}}
  ],
  "devices": [
    {"id": "sw-1", "template": "netgear-gs724t", "label": "Switch 1", "location": "rack-1", "rack": {"u": 40}},
    {"id": "pdu-1", "template": "pdu-8", "label": "Power strip 1", "location": "rack-1"}
  ],
  "cables": [
    {"id": "c7", "kind": "power", "from": {"device": "pdu-1", "port": "out-1"}, "to": {"block": "audio", "port": "power-in"}, "label": "PWR-07"}
  ],
  "layout": {"nodes": {}, "manual": []},
  "revisions": [], "releaseRecord": []
}
```

- A cable end is `{device, port}` (an installation device) or `{block, port}` (a module's external port).
- `blocks[].schematic` pins the **released** module schematic version whose connector face the block
  shows. When the module releases a newer schematic the block is flagged *outdated* and the author
  updates it with one click (`refresh_block`); nothing changes silently.
- `device`, `serialNumber`, `operator` move here from `manual.json`. An assembled manual gets
  `installation: "<slug>"`; while it has one, its cover reads those three fields from the installation
  and *Edit manual* shows them read-only with a link. Manuals without an installation keep their own
  fields (never migrated).

## 4. Storage and versioning

A schematic is a doc in the store's sense. It is addressed by a **key** like docs are, with manual
type `schematic`: a module schematic is `schematic:A1.0` on the module owner; an installation is its
own owner (`inst:<slug>`, resolved by `ownerOf()` beside `sw:<slug>`), key `schematic:A1.0`.

- Draft branch `draft/<slug>-schematic-a1.0` (module) and `draft/inst/<slug>-schematic-a1.0`
  (installation), built by the existing `ownerBranch` rules. One open draft per owner. Release = merge
  to `main`. Every applied operation list is one commit on the draft branch.
- Lifecycle lives in `server/schematics-store.js` (`createSchematic`, `applySchematicOps`,
  `setSchematicStatus`, `releaseSchematic` with a required note, `setSchematicReleaseNote`,
  `startSchematicHotfix`, `discardSchematic`, `nextSchematicVersion`), built on the store's `repo`
  and `mutate`. The record keeps `revisions[]` and `releaseRecord[]` shaped like a doc's so the
  revision record prints the same way. The doc functions in `store.js` are untouched.
- Presence (`item = doc:<owner>:schematic:A1.0`) and review comments work unchanged: a comment
  anchors on a device or cable id instead of a text quote (`anchor.node`).
- Rules carried over: only a **released** module schematic feeds an installation block; only a
  **released** installation compiles into an assembled manual; a release is refused while validation
  (section 8) reports an error.
- All mutations run inside `GitRepo.lock()` and leave the tree on `main`.

## 5. Operations, API, MCP

Every change is an operation. The applier (`server/schematic.js`, pure functions over the JSON,
no git) validates the whole list against the current state and the library, then returns the new
state or the first error. The store wraps it: load → apply → write → commit.

Operations:

| op | fields | notes |
| --- | --- | --- |
| `add_device` | `id?`, `template` or `hardwareId`, `label?`, `location?`, `rack?` | id derived from the label when omitted |
| `update_device` | `id`, patch of `label`, `location`, `rack`, `notes` | |
| `remove_device` | `id` | refused while cables end on it unless `cascade: true` |
| `connect` | `id?`, `kind`, `from`, `to`, `label?`, `length?`, `notes?` | `kind` inferred when exactly one cable kind joins the two connectors |
| `update_cable` | `id`, patch | |
| `disconnect` | `id` | |
| `set_external_port` / `unset_external_port` | `id`, `label`, `device`, `port` | module schematic only |
| `add_location` / `update_location` / `remove_location` | `id`, `label`, `kind`, `unitsU?` | installation only |
| `place_block` / `remove_block` / `refresh_block` | `id`, `module`, `location`, `rack?` | installation only; `refresh_block` re-pins the latest released module schematic |
| `move` | `id`, `x`, `y` | marks the node manual |
| `tidy` | `ids?` | clears the manual mark; layout is recomputed on read |

HTTP, all behind the existing auth (`viewerGuard` for writes):

- `GET /api/library/connectors`, `PUT /api/library/connectors` (admin/moderator)
- `GET /api/library/devices`, `POST /api/library/devices`, `PUT /api/library/devices/:id`, `DELETE …`
- `POST /api/library/devices/:id/promote` → creates module + catalog item (section 6)
- `GET /api/installations`, `POST /api/installations`, `GET /api/installations/:slug`,
  `PUT /api/installations/:slug` (name, device, serialNumber, operator), `DELETE …`
- Doc-scoped routes reuse `docPaths()` / `ownerPaths()` with the owner `inst:<slug>` added to
  `ownerRef()`: `GET …/docs/schematic:A1.0`, `POST …/docs/schematic:A1.0/ops {ops: [...]}`,
  `GET …/docs/schematic:A1.0/render.svg?view=logical|rack`, `GET …/docs/schematic:A1.0/cables.csv`,
  plus the existing submit-review / release / release-note / hotfix / discard routes.
- `POST …/docs/schematic:A1.0/chat {messages}` → `{reply, ops, applied: false}` (section 6)

MCP tools (`slug` = module slug, installation slug or `inst:<slug>`; a module wins a tie):
`get_schematic`, `create_schematic`, `apply_schematic_ops`, `submit_schematic_for_review`,
`schematic_back_to_draft`, `release_schematic`, `set_schematic_release_note`,
`start_schematic_hotfix`, `discard_schematic`, `render_schematic` (PNG image content),
`list_installations`, `create_installation`, `list_device_templates`, `create_device_template`,
`update_device_template`, `promote_device_to_module`.

## 6. AI chat and promotion

`ai.schematicChat({state, library, messages, lang})` on `callOpenAI` with JSON output
`{"reply": "...", "ops": [...]}`.

- The prompt carries: the current state as compact text (one line per device with its ports and
  free/used state, one per cable, the locations, the external ports), the library templates (id, name,
  category, ports), the connector rules, and the operation schema. No coordinates in or out.
- The model is told to reuse existing devices by label ("power strip 1" → `pdu-1`), to add a library
  device when the sentence names one that is not placed, to pick ports by label ("first socket" →
  `out-1`), to ask in `reply` when a sentence is ambiguous instead of guessing, and to never invent a
  template: an unknown device becomes `reply: "I don't have <X> in the library — add it with its ports
  first"` and a proposed `create_device_template` the user can accept.
- The route applies the ops as **pending**: it validates them (so the user never accepts something the
  applier will refuse) and returns them without writing. The canvas draws pending devices and cables
  highlighted; *Accept all* posts them to `/ops` (one commit, summary "AI edit: …"), *Reject* drops them,
  and single pending items can be removed before accepting. Chat replies that carry no ops are answers.
- Guidelines: `getAiGuidelines()` is appended as today.

**Promote to module** (`promoteDeviceToModule(templateId, {name, code, type, category})`): creates a
module via `createModuleDoc` with one catalog hardware item built from the template (COTS, manufacturer
+ model), writes the template's `hardwareId`, and creates the module's first schematic draft containing
that one device with every template port declared as an external port. Installation devices that use the
template are **not** converted automatically; the installation page offers *Replace with module block*
per device, which swaps the device for a block and re-points its cables to the matching external ports.

## 7. Canvas and pages

Web, React 18 + Vite, two new dependencies: `@xyflow/react` (React Flow, MIT) for nodes, port
handles, edges, selection, minimap and zoom; `elkjs` (EPL-2.0, used as a library) for layout.

Pages:

- `/installations` — list (name, device, serial, status, last release). *New installation* modal:
  name, device, serial number, operator, starting locations (Rack 1, IOS, Cockpit prefilled).
- `/installations/:slug` — the canvas page. Header with the installation's version / status / release
  actions as the manual page has. Left palette with three groups: *Modules* (hardware modules with a
  released schematic; others shown grey with "no released schematic"), *Devices* (library templates by
  category, search), *Locations*. Right property panel for the selection (device: label, location,
  U position, template ports with what is plugged in; cable: kind, label, length, ends; location:
  label, kind). Chat in a bottom drawer. Toolbar: Tidy, view *Logical* / *Rack*, Validate, Export SVG,
  Cable schedule.
- Module page → new **Schematic** tab: the same canvas component with `kind: module`; the palette's
  first group is the module's catalog hardware items; the property panel for a port has *Mark as
  external*. The Manuals tab lists the schematic's versions beside the manuals.
- Review view: `…/review` renders the canvas read-only with the comments sidebar; comments anchor on
  the selected node or cable.

Canvas behaviour:

- Location frames are React Flow parent nodes; dropping a device into a frame sets its `location`.
- A device node draws its symbol with port handles on the declared side; dragging from a handle to
  another handle posts `connect` (kind inferred, or a small picker when several kinds fit). Incompatible
  targets do not accept the drop and the reason shows on hover.
- Cables are edges coloured by cable kind, labelled with `label`; selecting one highlights both ports.
- Positions: elk computes the layout for every node not in `layout.manual` (layered, left-to-right
  inside each frame, frames arranged by location order); a hand-moved node is saved by `move`. *Tidy*
  on a selection or on everything clears the manual marks.
- Pending (AI) items render dashed with an orange outline and an Accept / Reject bar on top.
- Rack view (second phase): frames of kind `rack` draw as a front view of `unitsU` units, devices and
  blocks with `rack.u` sit at their row with `heightU`; cables are listed, not drawn.
- Every string through `t()` with Polish entries.

## 8. Validation

Run by the applier on every op list and by *Validate* / release. Errors block a release; warnings do not.

Errors:
- cable ends on an unknown device, block or port; a connector pair no cable kind joins; a port with
  two cables; an `out` port connected to an `out` port, or `in` to `in`;
- a block whose module has no released schematic, or an external port the pinned version does not declare;
- a device with neither a template nor a catalog item; a location referenced by nothing that exists.

Warnings:
- a cable without a label; a device with a power `in` port and no power cable; a block marked
  *outdated*; a location with nothing in it; a device placed in no location (installation only).

## 9. Into the manuals

`server/schematic-render.js` renders a schematic to SVG server-side (plain SVG strings, the same symbol
set and elk layout as the canvas, positions taken from the saved layout) so the export never depends on
a browser. Verdana, black lines, cable kinds told apart by line style as well as colour (power thick,
Ethernet solid, audio dashed, USB dotted) so a monochrome print still reads.

- **Technician manual of a module**: when the module has a released schematic, generated section 3
  gains *3.x Connections*: the figure (`<figure data-schematic="<slug>">`, caption "Wiring of <module>,
  <CODE>-SCH A1.0"), the **Port list** (external ports: label, connector, device/port inside) and the
  **Cable schedule** (label, kind, from, to, length). Never in a customer manual.
- **Assembled manual** whose `installation` is set and released: a generated chapter *Installation
  wiring* after the module chapters: the installation figure filtered to the manual's chapter modules
  and the devices cabled to them, per location, then the cable schedule for those cables. The front
  matter's chapter table lists it; the LEP covers it like any chapter.
- `data-schematic` is resolved at compile time (`resolveSchematics` beside `resolveXrefs`): the
  released SVG is inlined for export and served as an asset for the web view, so a manual compiled
  tomorrow shows tomorrow's released schematic and the revision record says which.
- `cables.csv` is the same schedule as a download for the installer.

## 10. Testing

- Unit (node:test, `server/schematic.test.js`): the applier for every op (happy path and each refusal),
  cable-kind inference, validation errors and warnings, external-port exposure on a block, `refresh_block`
  against a newer release, the filter used by the assembled manual.
- Store (`server/store.schematic.test.js`): draft → ops → commits on the draft branch → release → main;
  hotfix; discard; the installation owner resolves through `ownerOf`; a manual's cover reads the
  installation's fields.
- Render: snapshot of the SVG for a two-device fixture (structure, not pixels).
- Smoke (`tools/smoke.mjs`): create a module with a catalog item, add a template with ports, build the
  module schematic over `/ops`, release it; create an installation, place the block, a power strip and a
  switch, connect them, chat once with a stubbed model reply, accept, release; compile an assembled
  manual that lists the module and check the wiring chapter and the cable schedule are present; call
  the MCP tools once each.

## 11. Delivery phases

1. **Data and chat**: library files + Settings editor, applier + validation, module and installation
   owners in the store, HTTP + MCP, chat with pending ops, server-side SVG render, generated sections in
   both manual kinds, installation list page with a *read-only* rendered SVG and the chat drawer.
   Outcome: a schematic can be built from sentences and printed.
2. **Canvas**: React Flow page and module tab, palette, drag/connect, property panel, Tidy, review view.
3. **Later**: rack elevation view, version diff (ops between two releases), cable labels for a label
   printer, promote-to-module's *Replace with module block*.

## 12. Decisions taken

- Netlist-first over drawing-first (draw.io / Excalidraw): port semantics, validation, cable lists and
  diffs need data; the AI is far more reliable emitting operations than diagram XML.
- Installations as a top-level owner rather than a schematic per assembled manual: several manuals of
  one simulator share one wiring; it is written once.
- Infrastructure (switches, routers, power strips) as library devices, not modules, with a promotion
  path when one deserves a manual.
- Logical diagram first; rack position kept in the data so an elevation view is a renderer, not a
  migration.
- React Flow + elkjs over extending the hand-rolled SVG in `RelationsSchema.jsx`: port handles,
  edge routing, selection and group nodes are the bulk of the work and are solved there.
