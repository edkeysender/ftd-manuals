# ftd-docs

Generated simulator manuals for FTD.aero devices. One manual per serial number, built from
versioned component chunks and the device's configuration file.

## Quick start (Windows)

1. Install [Node.js 22 LTS](https://nodejs.org) and [GitHub Desktop](https://desktop.github.com).
2. Clone this repository with GitHub Desktop.
3. In a terminal inside the repo folder:

   ```
   npm install
   node tools/resolve.js --all
   npm start
   ```

   `npm start` opens http://localhost:3000 with live reload. Re-run `node tools/resolve.js --all`
   after changing chunks, configs or templates (the dev server does not run the resolver).

4. `npm run build` produces the static site in `build/` and fails on any broken link.

## Layout

```
components/<id>/component.yaml   identity of a component
components/<id>/vN.md            chunk per software version range (applies_to)
shared/                          pages in every manual
sims/<slug>.json                 installed components + versions for one device
templates/<id>.yaml              chapter structure per manual type
tools/resolve.js                 config x template x chunks -> docs/ (generated)
tools/bump.js                    decides and stamps manual revisions
inbox/                           raw material to be turned into chunks
```

## Admin panel

`/admin` is an editorial dashboard built from `docs/admin.json`, which the resolver writes on
every build. It shows the manuals with their release state, every component and its chunks, a
coverage matrix (which chunk covers which device) and the `[[link]]` graph.

It runs in one of two modes, chosen automatically when the page loads.

### Local mode (no GitHub needed)

Run the editing backend next to the site:

```
npm run admin        # http://127.0.0.1:3001
npm start            # http://localhost:3000/ftd-docs/admin
```

The panel then shows a **local mode** badge and a git bar, and every button edits the working
tree directly:

- **Edit config / Edit identity / chunk name** — opens the file in an editor; saving writes it
  and re-runs the resolver, so the coverage matrix and gap list update immediately.
- **New draft v*N*** (also **Write v*N*** on a gap) — opens a pre-filled chunk with a branch
  name; saving creates the branch `doc/<component-id>-v<N>`, writes the file and commits it.
- **New branch / Commit / Release** — plain git. Release runs `tools/bump.js --write`, commits
  the version fields and tags; it is refused off `main` so a draft branch cannot be tagged.

Nothing invalid reaches disk: front matter must parse as a YAML mapping with a `title`,
`applies_to` must be a valid semver range, and JSON configs must parse. Writes are confined to
`components/`, `shared/`, `sims/` and `templates/`.

The backend binds to `127.0.0.1`, has no authentication and rewrites your working tree. It is a
development tool — do not expose the port. If you run it elsewhere, append
`?api=http://127.0.0.1:PORT` to the admin URL.

### Read-only mode

With the backend not running, the panel is read only and every button becomes a deep link into
GitHub's web editor — the mode the published site uses. An author commits from there to a new
branch named `doc/<component-id>-<topic>` and opens a pull request. This needs a remote.

## Gaps

A **gap** is a manual that is structurally sound but missing a section — usually a device running
a software version no chunk covers. The build deliberately does not fail on one: the manual is
still generated, with a placeholder page and a warning in its List of Effective Sections, so the
gap is visible and reviewable. Two things do act on it:

- `node tools/resolve.js --all --strict` exits non-zero — use it wherever a gap must block.
- `tools/bump.js` refuses to release a manual with a gap or a broken link.

## Releasing a manual revision

Revisions are not chosen by hand. The resolver computes a content hash per manual from the chunk
bodies and the device configuration; `manual.content_hash` in the sim config records the hash of
the last release. When the two differ, the manual has unreleased changes.

1. Merge the content change to `main`.
2. `.github/workflows/release.yml` runs `tools/bump.js --write`: for each manual whose content
   changed it bumps `manual.revision` (the first release keeps the declared revision), stamps
   `effective_date`, stores the new `content_hash`, commits, and pushes a tag
   `manual/<slug>/<issue>.<revision>`.
3. Manuals held by a gap or a broken link are skipped and listed in the job summary.

Locally, `node tools/bump.js` reports what would change without touching anything; `--check`
exits non-zero if content changed without a release. Never edit `manual.revision`,
`effective_date` or `content_hash` by hand — `bump.js` owns them.

## Publishing

The site is served from GitHub Pages at `https://ftd-aero.github.io/ftd-docs/`. First-time setup:

1. Repository settings → Pages → Source = **GitHub Actions**.
2. Branch protection on `main`: require the *Build manuals* check and one approving review.
   If reviews are required, either let the `github-actions[bot]` bypass protection or add a PAT
   as `secrets.RELEASE_TOKEN`, otherwise the release workflow cannot push its version commit.
3. Fill in the real GitHub handles in `.github/CODEOWNERS`.

If a custom domain (`docs.ftd.aero`) is used instead, set `url` to it and `baseUrl` back to `"/"`
in `docusaurus.config.js`, and add a `static/CNAME` file.

See `CLAUDE.md` for authoring rules.
