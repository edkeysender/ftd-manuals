# FTD Documentation Console

One place to write, review, release and export the manuals of FTD.aero flight simulators.

A simulator is built from **modules** (a cockpit panel, an IOS station, a camera kit…) and runs
**software** (the IOS, gateways, tools). The console documents each of them as small, versioned
manuals — for the **customer** (the operator) and for the **technician** (installation, wiring,
configuration, servicing) — and assembles them into the simulator manual that ships with a device:
cover, revision record, table of contents, List of Effective Pages, one chapter per module, printed
to A4 PDF with the company header on every page.

Everything is stored in a git repository the server manages itself: every save is a commit, a draft is
a branch, a release is a merge to `main`. Nobody edits files by hand.

## What it does

**Schematics and installations.** A module also carries its wiring as data: devices from a shared device
library with typed ports, cables between them, and the connectors that leave the module. An **installation**
is one simulator delivery (racks, instructor station, cockpit) that places released modules and free devices
such as switches or power strips and cables them together. Both are built by telling the chat what is
connected to what, or over MCP, validated as they change (one cable per port, compatible connectors) and
released with their own revision record. A released module schematic prints in its technician manual as
a *Connections* block with a port list and cable schedule; a released installation prints as an
*Installation wiring* chapter of the assembled manual, whose cover takes the device, serial number and
operator from it. The interactive drag-and-connect canvas is the next phase; today the web shows the
server-rendered drawing.


- **Modules, software and hardware** — a module list with the hardware catalog it is built from and the
  software it runs; a Software page with release feeds and which manuals cover which release.
- **Manuals per audience** — up to four doc streams per module (`customer`, `technician`,
  `software-customer`, `software-technician`), each with its own versions (`A1.0`, `A1.1`…), revisions,
  draft branch and section template. Sections 1–3 (revision record, introduction, general information)
  are generated from the module data; authors write the rest.
- **Editor** — three panes: document outline · the page (rich text or HTML source) · an AI assistant and
  review comments. Both side panes fold away. Autosave, figures, tables, cross-references to other
  modules, attachments (configs, firmware), FAT checklists.
- **AI assistant (optional, OpenAI)** — first drafts, edits proposed as tracked changes you accept or
  discard, Polish translation, picture description, photos redrawn as technical line-art in the house style.
- **Review** — a read-only review link; reviewers select text and comment; the author answers, resolves or
  asks the AI to propose the change.
- **Release** — *Submit for review* → *Approve & release*; hotfixes correct a released version in place.
  Assembled manuals are released on their own (Issue / Revision).
- **Export** — a self-paginating standalone HTML document and a PDF printed by the browser on the server
  (bookmarks for every heading), for a whole simulator manual, for a single doc (drafts included) and for
  the FAT protocol. English is the source language; Polish translations export with `?lang=pl`.
- **Agents over MCP** — Claude, ChatGPT or any MCP client can read and edit documentation through the
  `/mcp` endpoint (OAuth sign-in), import pictures from Word / PowerPoint / PDF files without the bytes
  passing through the model, and handle review comments.
- **Accounts** — sign-in with roles: **admin** (everything, including deleting), **moderator** (writes,
  may connect MCP agents), **viewer** (reads and comments in reviews).
- **UI in English and Polish** (EN | PL switch, top right).

## Requirements

| | |
| --- | --- |
| **Node.js 22.9 or newer** | the server starts with `--env-file-if-exists` (production runs Node 24) |
| **git** on the `PATH` | the document store is a git repository driven through the `git` binary |
| **A 64-bit OS** | `sharp` (image resizing) ships 64-bit builds only — on a Raspberry Pi use 64-bit Raspberry Pi OS |
| **Chromium, Chrome or Edge** *(for PDF)* | PDF export prints with the browser already on the machine; without one, PDF is refused and the HTML export still prints from any browser. Override the path with `FTD_CHROME` |
| **OpenAI API key** *(optional)* | enables the AI assistant, translation, image description and illustration |
| **cloudflared** *(optional)* | to publish the console on a public URL (needed for claude.ai / ChatGPT connectors) |

Runs on Windows, Linux and macOS. Production today: a Raspberry Pi 5 (64-bit Raspberry Pi OS, Node 24,
`/usr/bin/chromium`), about 250 MB of documents.

## Install

```bash
git clone https://github.com/edkeysender/ftd-manuals.git
cd ftd-manuals
npm install
npm run build          # builds the web app into web/dist
```

Create `.env` in the project folder (never commit it):

```ini
# sign-in: the administrator created on first start, when there are no users yet
FTD_ADMIN_EMAIL=you@ftd.aero
FTD_ADMIN_PASSWORD=choose-a-strong-one

# optional
ANTHROPIC_API_KEY=sk-ant-…          # AI assistant (Claude) — or paste it in Settings → AI agent
OPENAI_API_KEY=sk-…                 # image generation + dictation (and the assistant when no Anthropic key)
PORT=5179                           # default 5179
FTD_PUBLIC_URL=https://…            # base of links handed to users (upload links, MCP)
FTD_SECURE_COOKIE=1                 # mark the session cookie Secure (when served over HTTPS)
FTD_IMPORT_ROOTS=/srv/share;/home/me/Documents   # folders agents may import files from (';'-separated)
FTD_URL_CREDENTIALS=nas.local=basic:user:pass     # credentials for protected picture hosts
FTD_CHROME=/usr/bin/chromium        # the browser that prints PDFs, if not found automatically
MCP_TOKEN=…                         # master token for MCP tooling without OAuth (OpenAI Responses API)
```

All settings:

| variable | default | |
| --- | --- | --- |
| `PORT` | `5179` | HTTP port (UI + API + `/mcp`) |
| `FTD_DATA_DIR` | `data/repo` | the document repository |
| `FTD_AUTH_DIR` | parent of `FTD_DATA_DIR` | `users.json`, `oauth.json`, `auth-secret` |
| `FTD_INBOX_DIR` | `data/inbox` | files dropped for import |
| `FTD_IMPORT_ROOTS` | — | extra folders agents may import from |
| `FTD_ADMIN_EMAIL` / `FTD_ADMIN_PASSWORD` | built-in | the administrator seeded on first start — set them, then change the password in Settings |
| `FTD_SECURE_COOKIE` | off | `1` = Secure session cookie |
| `FTD_PUBLIC_URL` | request host | public base URL |
| `FTD_URL_CREDENTIALS` | — | `host=basic:user:pass;host=bearer:TOKEN` |
| `FTD_CHROME` | auto | browser used for PDF |
| `MCP_TOKEN` | — | master bearer token for `/mcp` |
| `ANTHROPIC_API_KEY` | — | the assistant runs on Claude (text + vision); keys can also be saved in Settings → AI agent (`data/secrets.json`, admin only) |
| `AI_PROVIDER` | auto | `anthropic` / `openai` when both keys exist |
| `ANTHROPIC_MODEL` / `ANTHROPIC_EFFORT` | `claude-opus-5-5` / `medium` | |
| `OPENAI_API_KEY` | — | illustrations and dictation; the assistant too when it is the only key |
| `OPENAI_MODEL` | `gpt-5` | chat / editing model |
| `OPENAI_REASONING_EFFORT` | `low` | |
| `OPENAI_IMAGE_MODEL` / `OPENAI_IMAGE_QUALITY` | `gpt-image-2` / `medium` | illustrations |
| `OPENAI_TRANSCRIBE_MODEL` | `gpt-4o-transcribe` | speech to text in the chat box |

Start it:

```bash
npm start              # UI + API on http://localhost:5179
```

On first start the server creates `data/` (the document repository and the user store) and the
administrator from `FTD_ADMIN_*`. Sign in, change the password (Settings → *Your password*) and add the
other users (Settings → *Users*).

### Run as a service (Linux)

`/etc/systemd/system/ftd-docs.service`:

```ini
[Unit]
Description=FTD Documentation Console
After=network.target

[Service]
User=sim
Group=sim
WorkingDirectory=/home/sim/ftd-manuals
ExecStart=/usr/bin/node --env-file-if-exists=.env server/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ftd-docs
```

`User` must be an account that exists on the machine. The service does not watch files: restart it after
every update of the server code.

### Public URL (optional)

The claude.ai and ChatGPT connectors need an HTTPS address. The quickest is a Cloudflare quick tunnel:

```bash
cloudflared tunnel --url http://localhost:5179 --no-autoupdate
```

It prints a `https://<random>.trycloudflare.com` address, which changes every time the tunnel restarts
(a named Cloudflare tunnel keeps a fixed one). Set `FTD_SECURE_COOKIE=1` when users sign in over it.

### Connect an AI agent (MCP)

Endpoint: `http://localhost:5179/mcp`, or `https://<public-url>/mcp`. Sign-in is OAuth — the client opens the
console's sign-in page; approve as an admin or moderator.

- **Claude Code**: `claude mcp add --transport http ftd-docs <endpoint>`
- **claude.ai**: Settings → Connectors → *Add custom connector* → the endpoint → Authorize
- **ChatGPT**: Settings → Apps & Connectors → Advanced → **Developer mode** → *Create* a connector with the
  endpoint and **OAuth** authentication
- **OpenAI Responses API**: no interactive sign-in — set `MCP_TOKEN` and pass it as `authorization` on the
  `mcp` tool

## Update

```bash
git pull
npm install            # dependencies may have changed
npm run build
sudo systemctl restart ftd-docs      # or stop and start `npm start`
```

The web app is live as soon as it is built; server changes need the restart. Updates never rewrite your
documents: older layouts are read where they are (see *Data compatibility*).

## Where the data lives

Everything that is yours is in `data/` (gitignored), plus `.env`:

```
data/
  repo/          the document repository — a git repo the server manages (all modules, docs, assets,
                 manuals, software feed, hardware catalog, settings, logo, illustration style)
  users.json     accounts (scrypt-hashed passwords)
  auth-secret    signs the session cookies — keep it to keep users signed in
  oauth.json     MCP clients and their refresh tokens — keep it to keep agents connected
  inbox/         files dropped for import (transient)
```

Inside `data/repo`, one module is one folder:

```
modules/<slug>/module.json                          identity, hardware and software links
modules/<slug>/docs/<manual>/A1.0/doc.json          one doc: version, revisions, status
modules/<slug>/docs/<manual>/A1.0/content.html      the body (semantic HTML); content.pl.html = Polish
modules/<slug>/docs/<manual>/A1.0/main-page.html    the doc's own title page, when edited
modules/<slug>/docs/<manual>/A1.0/checklist.json    FAT checklist (optional)
modules/<slug>/assets/                              pictures and attachments of the module
software/<slug>/…                                   a software that owns its manuals — same layout
manuals/<slug>/manual.json                          an assembled simulator manual + its releases
hardware.json                                       shared hardware catalog
softwares.json                                      software release feed
settings/                                           AI guidelines, illustration style, logo
```

`main` holds what is released; open drafts live on `draft/<slug>-<manual>-a<maj>.<min>` branches. The
history of every document is the git history of this repository. **Never edit it by hand** — go through
the UI, the API or MCP so every change is a commit and the server's view stays consistent.

## Back up

The repository is plain git, so a backup is one file:

```bash
cd data/repo
git bundle create ../../ftd-docs-$(date +%F).bundle --all     # every branch: released + drafts
```

Also keep `data/users.json`, `data/auth-secret`, `data/oauth.json` and `.env`. A simple full backup with
the service stopped:

```bash
sudo systemctl stop ftd-docs
tar czf ftd-docs-data-$(date +%F).tgz data .env
sudo systemctl start ftd-docs
```

## Migrate to another machine

1. **On the new machine:** install the requirements and the app (*Install* above), but do not start it.
2. **On the old machine:** stop the console (`sudo systemctl stop ftd-docs`, or stop `npm start`) so nothing
   writes mid-copy, then archive the data:
   ```bash
   tar czf ftd-docs-data.tgz data .env
   ```
3. Copy `ftd-docs-data.tgz` across and unpack it in the project folder of the new machine:
   ```bash
   tar xzf ftd-docs-data.tgz
   ```
   Check the paths in `.env` (`FTD_IMPORT_ROOTS`, `FTD_CHROME`, `FTD_DATA_DIR`…) — Windows paths do not
   work on Linux and the other way round.
4. Start the console and sign in with the existing accounts. Open a module, a doc and a manual, and export
   one PDF to confirm pictures and printing work.
5. If the public URL changed, re-point the MCP connectors (claude.ai / ChatGPT) to the new `…/mcp` address.
   Keeping `oauth.json` and `auth-secret` keeps users and agents signed in; without them everyone simply
   signs in again.

Moving only the documents (no accounts) — from a bundle:

```bash
git clone --mirror ftd-docs-2026-10-10.bundle data/repo/.git
cd data/repo && git config --bool core.bare false && git checkout main
```

then start the console: the administrator from `FTD_ADMIN_*` is created as on a fresh install.

## Data compatibility

The console reads older layouts in place and never migrates them:

- docs created before the customer / technician split (`modules/<slug>/docs/A1.0/`) are read as customer manuals;
- modules with an inline `hardware` object still resolve; older category values keep their labels;
- softwares documented as *own-software modules* keep working, and writing their manual again adopts them;
- a version released before release notes existed prints one "Released." line until a note is set.

So an update or a move never needs a conversion step — copy `data/` and start.

## Bringing in existing documentation

- **Word / PowerPoint / PDF / zip** — drop them on a module's Assets tab (or into the inbox): the pictures
  inside become assets and a Word file also yields its content as HTML, which an AI agent can rebuild as
  doc sections over MCP (`read_inbox_text`, `import_local_files`, `attach_figure`).
- **Simulator configuration** — `POST /api/manuals/import` with a configuration file creates one assembled
  manual per `simulator` / `ios` section, listing its modules.

## Develop

```bash
npm run dev            # API on :5179 (restarts on change) + Vite dev server on :5173
npm run build && npm run smoke     # the check before every merge: build, then an end-to-end API run
```

`npm run smoke` starts its own server on a temporary data folder (port 5197, `SMOKE_PORT` to change it)
and exercises the API, MCP, exports and PDF. Work on `console/<topic>` branches and merge to `main` by pull request.
[`CLAUDE.md`](CLAUDE.md) holds the detailed domain rules (versions, releases, manual assembly, print rules).

```
server/   Express API · store.js + git.js (document store) · docgen.js (templates, generated sections,
          manual frame, export) · pdf.js (PDF via the browser) · mcp.js · auth.js + oauth.js · ai.js ·
          illustrate.js · extract.js (pictures from Word/PDF) · images.js
web/      React + Vite single-page app (modules, software, manuals, editor, settings)
tools/    smoke.mjs — end-to-end test
data/     runtime data (gitignored)
```
