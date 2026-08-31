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
modules/<slug>/module.json               # identity + hardware/software relations
modules/<slug>/docs/A1.0/doc.json        # doc version metadata, revision record, covered sw releases
modules/<slug>/docs/A1.0/content.html    # sections 4–7 (semantic HTML)
softwares.json                           # software release feed (manual-affecting flags)
```

- Drafts live on `draft/<slug>-a1.0` branches; every save is a commit; accepted changes bump `r1 → r2 …`.
- **Submit for review** flags the doc In review; **Approve & release** merges the branch into `main`,
  freezes the revision counter, supersedes older released versions and deletes the branch.
- Only Released doc versions are compiled into simulator manuals (compilation/export comes later).
- Sections 1–3 (revision record, introduction, general information) are generated from module data —
  never hand-edited.

## Layout

```
server/   Express API: store (git), docgen (templates + auto sections), ai (OpenAI)
web/      React + Vite frontend (modules list, wizard, 3-pane editor)
data/     runtime document store (gitignored)
tools/    smoke.mjs — end-to-end API exercise
```
