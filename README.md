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
inbox/                           raw material to be turned into chunks
```

## Releasing a manual revision

1. Bump `manual.revision` (or `issue`) and `effective_date` in `sims/<slug>.json`, merge to `main`.
2. Tag: `git tag manual/<slug>/<issue>.<revision>` and push the tag.
3. CI builds the site; the revision register and list of effective sections are generated from Git history.

See `CLAUDE.md` for authoring rules.
