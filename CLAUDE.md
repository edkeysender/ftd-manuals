# FTD Documentation Console — instructions for AI sessions

This repo is the **Documentation Console**: one space for creating, managing and exporting
FTD.aero flight simulator manuals. Current scope is the Modules section (list, wizard, editor).
The functional spec lives in this file's history and in the Modules spec provided by Łukasz.

## Architecture

- `server/` — Express API (`index.js`), git-backed document store (`store.js` + `git.js`),
  doc templates and auto-generated sections 1–3 (`docgen.js`), OpenAI-backed assistant (`ai.js`).
- `web/` — React + Vite SPA (hash routing): `pages/ModulesList`, `pages/ModuleDetail`,
  `pages/Editor` (3 panes: outline / editor / AI chat), `components/Wizard`.
- `data/repo/` — runtime git repository holding the documents (gitignored; created by the server).
  One module = one folder. Drafts on `draft/<slug>-a<maj>.<min>` branches; release = merge to `main`.
  Never edit `data/` by hand — go through the API so every change is a commit.
- `.env` — `OPENAI_API_KEY` (never commit, never print).

## Domain rules (from the Modules spec)

- A module doc is a standalone **mini-manual**: version `A<major>.<minor>`, revisions `r1, r2…`
  while draft, own revision record. Only **Released** versions compile into simulator manuals.
- Sections 1–3 (revision record, introduction, general info) are **generated** from module data —
  they are never hand-edited; the editor stores only sections 4–7 as semantic HTML.
- Manual groups: `SIM` / `IOS` / `RACK`. Hardware: a shared catalog (`hardware.json` on `main`, items
  `{id, name, type: ftd|cots, version | manufacturer+model, notes}`); a module links **N** items via
  `hardwareIds` — pick existing or create new (wizard step 3, module → Hardware tab, MCP `list_hardware` /
  `create_hardware` / `update_hardware`, `hardware: [{id}|{name,type,…}]` on create/update). One manual may
  cover several unit types (three camera models): each gets its own `<h3>` in Installation/Operation, a row
  in section 3 and in the FAT header. Old modules with an inline `hardware` object still resolve on read. Software links: N rows of name + from-version; one doc version
  may cover a range of software releases; a **manual-affecting** release stays unlinked until a new
  doc version is released for it (orange dot on the modules list).
- Manual tone: operating-manual English, present tense, numbered procedures with expected indication,
  warnings/notes as admonitions, no invented facts — use `TODO(author): …` markers.
- Illustrations: one house style, **Technical Aviation Manual Line-Art** (`server/illustrate.js`, editable in
  Settings → `settings/illustration-style.md`, plus **style exemplar images** in `settings/illustration-style/`
  that are sent to the image model with every photo — they, not the text, define the look). Default output is
  ONE view of the photo's subject; photos are reference only — the manual gets the redrawn `<stem>-lineart.png`,
  and "Edit drawing" edits that file in place (`editOf`) instead of redrawing. Every conversion path (AI-pane
  drop target, chat `generate_images` with `style: "line-art"`, Assets tab button, MCP `convert_to_line_art`)
  goes through `convertToLineArt()`.

## Working here

- Dev: `npm run dev` (API :5179, web :5173). Check: `npm run build && npm run smoke`.
- Branch names: `console/<topic>`. Do not push to `main`.
- The store's git operations are serialized through `GitRepo.lock()` — any new store mutation must
  run inside it and leave the working tree checked out on `main`.
