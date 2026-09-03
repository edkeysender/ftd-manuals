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
OPENAI_API_KEY=…   # enables the AI assistant, AI first drafts, translations, describe_asset (vision)
OPENAI_MODEL=gpt-5 # optional override
FTD_URL_CREDENTIALS=host=basic:user:pass;other.host=bearer:TOKEN   # optional: protected image hosts (NAS share links)
FTD_PUBLIC_URL=https://…trycloudflare.com   # optional: base of links handed to users (request_upload)
FTD_ADMIN_EMAIL=… / FTD_ADMIN_PASSWORD=…     # optional: the administrator seeded on first start (defaults below)
FTD_SECURE_COOKIE=1                          # optional: mark the session cookie Secure (HTTPS only)
```

## Login

The console requires a sign-in. Users live in `data/users.json` (scrypt-hashed passwords, next to the
document repo — not inside it) and sessions are an HMAC-signed cookie (`data/auth-secret`, 30 days).
On first start, when there are no users yet, the default administrator is created:

```
l.wicenciak@ftd.aero / Simulation01
```

Change that password in Settings → *Your password*. Two roles: **administrator** — everything, including
deleting (manuals, drafts, assets, inbox files, comment threads, users); **editor** — everything except
deleting. Every `DELETE` route and the draft *discard* answer `403` for editors, and the UI hides those buttons.
Administrators manage accounts in Settings → *Users* (add, change role, reset password, delete; the last
administrator cannot be removed). Roles: **admin** (everything, incl. deleting), **moderator** (writes
manuals, may connect MCP agents), **viewer** (reads and comments in reviews — no MCP, no editing).

The **/mcp endpoint is authorized with OAuth** (authorization code + PKCE, dynamic client registration):
when an MCP client connects it opens the console's sign-in/consent page and gets short-lived access
tokens (1 h) plus a rotating refresh token — approve as admin or moderator. `MCP_TOKEN` in `.env`
stays honoured as a master token for local tooling.

Connecting clients (endpoint = `http://localhost:5179/mcp`, or `https://<tunnel>/mcp` from `npm run tunnel`):

- **Claude Code**: `claude mcp add --transport http ftd-docs <endpoint>` — the browser opens the sign-in page on first use.
- **Claude (claude.ai)**: Settings → Connectors → *Add custom connector* → paste the endpoint → Authorize.
- **ChatGPT**: Settings → Apps & Connectors → *Advanced settings* → enable **Developer mode**, then
  *Create* a connector with the endpoint as MCP server URL and **OAuth** authentication (Plus/Pro/Business/
  Enterprise plans; enable it per chat under Developer mode / Deep research tools).
- **OpenAI API (Responses)**: no interactive sign-in there — set `MCP_TOKEN` in `.env` and pass
  `tools: [{ "type": "mcp", "server_label": "ftd_docs", "server_url": "<endpoint>", "authorization": "<MCP_TOKEN>" }]`.

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

### Languages

English is the source language of every doc. A Polish translation is optional and lives next to it
(`content.pl.html`): in the editor switch **EN | PL**, then **Translate to Polski with AI** (OpenAI, keeps the
HTML structure) or copy the English text and translate by hand; PL is edited like any body (autosave, revisions
tagged `(PL)`, AI chat answers in Polish). When the English body changes the translation is flagged **stale**
until re-translated. Sections 1–3 and the assembled-manual frame render in the chosen language; a manual can
be viewed/exported in PL (`?lang=pl`) with untranslated chapters falling back to English and flagged. MCP:
`lang` on `get_doc` and the edit tools, `translate_doc`.

### Images over MCP — bytes never pass through the model

Agents **see** assets (`get_asset` returns a downscaled JPEG as image content, `list_assets {thumbnails}`
a strip of thumbnails, assets are also MCP resources `ftd://modules/<slug>/assets/<file>`) and get pictures
in without bytes in the chat: `upload_photo_from_url` (public links; hosts in `FTD_URL_CREDENTIALS`
`host=basic:user:pass;host=bearer:TOKEN` are fetched with credentials), `request_upload` hands the user
the Assets-tab drop link for files on their own device or behind a login (then `list_inbox` +
`import_local_files`), `generate_illustration` / `convert_to_line_art` draw them. **Documents are a source
of pictures:** a Word / PowerPoint / PDF / zip file dropped anywhere (inbox, Assets tab, chat attachment,
`import_local_files` path) is expanded into the pictures inside it (`server/extract.js` — OOXML media,
PDF image XObjects: JPEG as-is, Flate + PNG predictor, Indexed palettes) and a Word file also leaves
`<doc>.html` — its content as semantic HTML: headings (custom heading styles resolved via `styles.xml`),
strong/em/u/sup/sub, hyperlinks, nested lists, tables with col/rowspans and `th` header rows, text boxes,
and `[figure: …]` markers naming the extracted pictures (`read_inbox_text`) — so an agent can recreate
the document faithfully over MCP: write the sections from the HTML, `import_local_files` the pictures,
`attach_figure` each one at its marker. Point `FTD_IMPORT_ROOTS` at the
document share and no dropping is needed at all. `attach_figure` inserts a
proper `<figure>` after a phrase in a section and stamps `applies_to`; `describe_asset` asks the vision
model for caption / alt / visible text / which unit is shown. The asset route serves `?w=<px>` resized
variants (thumbnails in the Assets tab).

### Review comments

**Review link** in the editor gives reviewers a read-only view of a draft (`…/review`): they select text,
click **Comment** and leave a thread (name asked once per browser). Threads are committed on the draft
branch (`comments.json`) and highlighted in the document. In the editor's **Comments** tab the author
replies, resolves, or clicks **Ask AI to propose** — the AI applies the requested change as a pending edit;
accepting it commits a revision and resolves the thread with a note. MCP agents see threads with
`list_comments` and close them with `resolve_comment` after editing the quoted passage.

The **Software** page lists every linked software with its modules, their software customer / technician
manuals (create, edit, new version), the release feed with coverage and a **Delete** per software
(unlinks it from every module and drops it with its releases from the feed; docs keep their covered
ranges; open software-manual drafts on a module with no other software are released first);
`list_software`, `register_software_release`, `cover_release` and `delete_software` expose the same
over MCP. A module can be deleted from its detail page (`DELETE /api/modules/:slug`, MCP
`delete_module`): draft branches, folder on main and its chapter in every manual go; the hardware
catalog and the release feed stay. Both deletes are meant for administrators once login lands.

- Drafts live on `draft/<slug>-<manual>-a1.0` branches (one open draft per manual type); every save is a
  commit; accepted changes bump `r1 → r2 …`.
- **Submit for review** flags the doc In review; **Approve & release** merges the branch into `main`,
  freezes the revision counter, supersedes older released versions of the same manual type and deletes
  the branch.
- Every assembled manual opens with chapter 1 *General*: 1.1 General Info (document statement + manufacturer
  address), 1.2 revision record, 1.3 table of contents, 1.4 List of Effective Pages. Module chapters number
  from 2. *Open / print* and *Export HTML* produce a self-paginating A4 document (paged.js inlined, works
  offline) with the header box and proprietary text on every page, page / pages, and the List of Effective
  Pages filled per printed page (issue.rev = doc version `A<issue>.<rev>`, effective date = release date).
- Only Released doc versions are compiled into simulator manuals. An assembled manual has a manual type:
  an *IOS technician manual* takes the technician manual of every chapter module. When a chapter module
  also has a released software manual of the same audience (customer → software-customer, technician →
  software-technician), it compiles as an extra chapter right after the module's own, titled after the
  linked software — picking the module brings both sections into the manual.
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
