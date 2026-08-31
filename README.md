# FTD Documentation Console

One space for creating, managing and exporting FTD.aero flight simulator manuals.
Current scope: the **Modules** section — modules list, new-module-doc wizard, and the manual editor
(rich text ↔ HTML source, AI assistant, git-backed drafts and releases).

## Run

```bash
npm install
npm run dev        # API on :5179 + Vite dev server on :5173
```

Production style:

```bash
npm run build      # builds web/dist
npm start          # serves UI + API on :5179
```

`.env` (kept out of git):

```
OPENAI_API_KEY=…   # enables the AI assistant + AI first drafts
OPENAI_MODEL=gpt-5 # optional override
```

## How documents are stored

`data/repo/` is a real git repository managed by the server (created on first start) and mirrors the
target layout of `github.com/ftd-aero/docs` — one module = one folder:

```
modules/<slug>/module.json                          # identity + hardware/software relations
modules/<slug>/docs/<manual>/A1.0/doc.json          # one doc stream per manual type (see below)
modules/<slug>/docs/<manual>/A1.0/content.html      # sections 4–7 (semantic HTML)
modules/<slug>/docs/<manual>/A1.0/checklist.json    # optional FAT checklist
modules/<slug>/assets/                              # images, shared by every manual of the module
manuals/<slug>/manual.json                          # assembled manual: modules + which manual type
hardware.json                                       # shared hardware catalog
softwares.json                                      # software release feed (manual-affecting flags)
```

### Manual types — one module, two audiences

A module is documented for the **customer** (the operator of the simulator) and for the **technician**
(installation, wiring, configuration, servicing). When the module is linked to a software, the software
gets the same split. Each manual is its own doc stream with its own versions, revision record, draft
branch and section template:

| type | audience | sections 4–7 |
| --- | --- | --- |
| `customer` | operator | Description · Operation · Maintenance · Appendixes |
| `technician` | installer / service | Installation · Configuration · Maintenance · Appendixes |
| `software-customer` | operator | Overview · Operation · Troubleshooting · Appendixes |
| `software-technician` | installer / service | Installation · Configuration · Administration · Appendixes |

A doc is addressed by its key `<manual>:<version>` — `technician:A1.0` — in URLs, the API and MCP.
A bare `A1.0` means the customer manual; docs created before the split (`modules/<slug>/docs/A1.0/`)
are read as customer manuals and never moved. Over MCP every doc tool (edit, assets, illustrations,
checklist, review/release) takes `manual` + `version` (or just `manual` for its latest open draft).

The **Software** page lists every linked software with its modules, their software customer / technician
manuals (create, edit, new version) and the release feed with coverage; `list_software`,
`register_software_release` and `cover_release` expose the same over MCP.

- Drafts live on `draft/<slug>-<manual>-a1.0` branches (one open draft per manual type); every save is a
  commit; accepted changes bump `r1 → r2 …`.
- **Submit for review** flags the doc In review; **Approve & release** merges the branch into `main`,
  freezes the revision counter, supersedes older released versions of the same manual type and deletes
  the branch.
- Only Released doc versions are compiled into simulator manuals. An assembled manual has a manual type:
  an *IOS technician manual* takes the technician manual of every chapter module.
- A manual-affecting software release must be covered by every manual type the module maintains
  (orange dot until each has a version for it).
- Sections 1–3 (revision record, introduction, general information) are generated from module data —
  never hand-edited.

## Layout

```
server/   Express API: store (git), docgen (templates + auto sections), ai (OpenAI)
web/      React + Vite frontend (modules list, wizard, 3-pane editor)
data/     runtime document store (gitignored)
tools/    smoke.mjs — end-to-end API exercise
```
