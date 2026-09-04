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

- A module is documented **per audience** — up to four manuals, each its own doc stream: `customer`
  (operation), `technician` (installation / wiring / configuration / servicing) and, when the module is
  software-related, `software-customer` and `software-technician`. Manual types live in
  `MANUAL_TYPES` (`server/docgen.js`, mirrored in `web/src/api.js`); each has its own sections 4–7 template.
- A doc is addressed by its **key** `<manual>:<version>` (`technician:A1.0`) in URLs, the API, MCP and the
  editor route; a bare `A1.0` means the customer manual (docs created before the split, stored in
  `docs/<version>/`, are read as customer manuals — never migrated; new docs go to `docs/<manual>/<version>/`).
  Every doc record carries `manual`, `key`, `dir`, `branch` — use them, never recompute paths or branch names.
- MCP: every doc-scoped tool takes `slug` + `manual` (+ optional `version`; omitted = latest doc of that type,
  preferring its open draft) or a full key in `version` — `resolveDocKey()` in `server/mcp.js`; new tools must
  spread `SLUG_VER` into their schema to get this. The **Software** page (`/software`, `GET /api/software`,
  MCP `list_software`) is the software-centric view: per software, linked modules, their software manuals, releases + coverage.
- Languages: English is the **source** body (`content.html`); other languages (`LANGUAGES` in `docgen.js`, now `pl`)
  are translations in `content.<lang>.html` with `doc.languages[lang] = {translatedAt, source, basedOnRevision,
  basedOnHash}` — `stale` is computed on read when the English hash moved. `?lang=` / `lang` on doc GET/PUT, the
  chat and MCP (`get_doc`, edit tools, `translate_doc`); manuals compile with `?lang=` (English fallback flagged).
  Generated sections and the manual frame have PL strings in `docgen.js` `STRINGS`.
- UI language: `web/src/i18n.jsx` — `t('English text', vars)` / `plural(n, 'unit')`, dictionary `i18n.pl.js`
  keyed by the English string (missing key → English). Locale = top-right EN|PL switch, stored in
  localStorage `ftd-ui-lang`, else browser language. Wrap every new user-visible string in `t()` and add its
  Polish entry; the doc-body language (EN|PL in the editor / manual view) defaults to the UI locale.
- Review comments: `comments.json` next to `doc.json` on the draft branch — threads anchored by a text
  quote (`anchor.quote/section/before/lang`), re-found in the page with `findQuoteRange` (Editor.jsx) and
  highlighted via the CSS Highlight API. `/modules/:slug/docs/:key/review` is the read-only reviewer view
  (same `Editor` with `review`); the author handles threads in the editor's Comments tab — **Ask AI to
  propose** runs the chat with the comment as instruction, and accepting that pending edit resolves the thread.
  MCP: `list_comments`, `reply_comment`, `resolve_comment`. No auth: the reviewer name is a browser prompt.
- Each doc is a standalone **mini-manual**: version `A<major>.<minor>`, revisions `r1, r2…` while draft,
  own revision record, own draft branch `draft/<slug>-<manual>-a1.0` (one open draft per manual type).
  Only **Released** versions compile into simulator manuals; an assembled manual (`manuals/<slug>/manual.json`)
  has a `manual` type and takes that type's doc from every chapter module — and when a chapter module also has
  a **released software manual of the same audience** (customer → software-customer, technician →
  software-technician) it compiles as an extra chapter right after, titled after the linked software. The FAT checklist sits on the
  technician manual when the module has one, else the customer manual. Module metadata edits are written
  identically on main (when released) and on every open draft branch.
- Sections 1–3 (revision record, introduction, general info) are **generated** from module data —
  they are never hand-edited; the editor stores only sections 4–7 as semantic HTML.
- Module types (`MODULE_TYPES` in `server/docgen.js`, mirrored in `web/src/api.js`): what a module IS decides
  which manuals are drafted on creation — `own-module` / `third-party-kit` → customer + technician,
  `own-software` → the software pair (a software named after the module is auto-created when none is picked),
  `module-software` → all four. The reverse path — a software's **own manual**, documented without hardware —
  is the same thing: `createOwnSoftwareModule()` (store) makes an `own-software` module named after the software
  (Software page "Write its own manual" / new-software modal checkbox, `POST /api/software/:name/own-manual`,
  `ownManual` on `POST /api/software`, MCP `create_software {own_manual}` / `create_software_manual`); the
  Software page row carries `type` so the UI knows. There is no separate software-level doc store — never add one. Doc codes derive as `<CODE>-TECH-HW` / `<CODE>-USER-SW` (`manualDocCode`,
  `docCode` on every doc record, shown in generated section 3). "Parts" are the hardware catalog: a line with
  a trailing version ("Płyta czołowa v1") = made by FTD, without = bought COTS (`parseParts`; `parts` on
  POST /api/modules and MCP `create_module`). New-module modal is compact (no steps); groups offered: SIM, IOS.
- Manual groups: `SIM` / `IOS` / `RACK` (RACK legacy). Hardware: a shared catalog (`hardware.json` on `main`, items
  `{id, name, type: ftd|cots, version | manufacturer+model, notes}`); a module links **N** items via
  `hardwareIds` — pick existing or create new (wizard step 3, module → Hardware tab, MCP `list_hardware` /
  `create_hardware` / `update_hardware`, `hardware: [{id}|{name,type,…}]` on create/update). One manual may
  cover several unit types (three camera models): each gets its own `<h3>` in Installation/Operation, a row
  in section 3 and in the FAT header. Old modules with an inline `hardware` object still resolve on read. Software links: N rows of name + from-version; one doc version
  may cover a range of software releases; a **manual-affecting** release stays unlinked until a new
  doc version is released for it (orange dot on the modules list).
- Manual tone: operating-manual English, present tense, numbered procedures with expected indication,
  warnings/notes as admonitions, no invented facts — use `TODO(author): …` markers.
- Images over MCP: bytes never go through the model. Agents look at assets (`get_asset` → image content,
  `list_assets {thumbnails}`, MCP resources `ftd://modules/<slug>/assets/<file>`), fetch server-side
  (`upload_photo_from_url`; optional per-host credentials `FTD_URL_CREDENTIALS` in `server/sources.js`), or
  hand the user the Assets-tab drop link (`request_upload` → inbox → `import_local_files`), or find what the user
  saved on the console machine themselves (`find_local_files` searches `FTD_IMPORT_ROOTS`, then `import_local_files`
  by path). Documents are a
  source of pictures: every drop point runs `expandDocuments()` (`server/extract.js`) so Word / PowerPoint /
  PDF / zip files become the pictures inside them (+ `<doc>.html` with the Word content as semantic HTML —
  headings, inline formatting, lists, tables, `[figure: …]` markers naming the extracted pictures — so an
  agent can recreate the document over MCP; `read_inbox_text`). The console never
  logs into Confluence/Jira itself — the agent reads those through its own connector and pictures come via
  the inbox. `attach_figure` places `<figure>`s; `describe_asset` is the vision model. Resizing is `sharp`
  (`server/images.js` `preview`/`resizeSameFormat`, asset route `?w=`). There is no base64 upload tool any
  more — do not add one.
- Illustrations: one house style, **Technical Aviation Manual Line-Art** (`server/illustrate.js`, editable in
  Settings → `settings/illustration-style.md`, plus **style exemplar images** in `settings/illustration-style/`
  that are sent to the image model with every photo — they, not the text, define the look). Default output is
  ONE view of the photo's subject; photos are reference only — the manual gets the redrawn `<stem>-lineart.png`,
  and "Edit drawing" edits that file in place (`editOf`) instead of redrawing. Every conversion path (AI-pane
  drop target, chat `generate_images` with `style: "line-art"`, Assets tab button, MCP `convert_to_line_art`)
  goes through `convertToLineArt()`.

## Working here

- Dev: `npm run dev` (API :5179, web :5173). Check: `npm run build && npm run smoke`.
- Login: `server/auth.js` — users in `data/users.json` (scrypt, seeded admin `l.wicenciak@ftd.aero`), signed
  session cookie. Roles: `admin` (everything incl. DELETE + discard), `moderator` (writes, MCP), `viewer`
  (read + review comments only — `viewerGuard`; the editor always renders the review view). `/mcp` takes
  OAuth access tokens from `server/oauth.js` (authorize-code + PKCE + dynamic registration; consent page
  requires admin/moderator; refresh tokens rotate in `data/oauth.json`); env `MCP_TOKEN` = master fallback.
  `tools/smoke.mjs` signs in and does the OAuth dance to set `mcpToken`.
- Branch names: `console/<topic>`. Do not push to `main`.
- The store's git operations are serialized through `GitRepo.lock()` — any new store mutation must
  run inside it and leave the working tree checked out on `main`.
