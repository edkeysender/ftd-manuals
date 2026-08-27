# ftd-docs — instructions for AI authoring sessions

This repository generates FTD.aero simulator manuals from small component chunks.
Read this file before writing or changing anything. The architecture plan lives in the
"Dokumentacja FTD" Claude project (claude/modular-manuals-plan.md).

## How the repo works

- `components/<id>/component.yaml` — identity of one component (id, name, category, location, owner).
- `components/<id>/vN.md` — one chunk per software version range; front matter `applies_to` is a semver range.
- `shared/*.md` — pages included in every manual (legal, safety intro).
- `sims/<slug>.json` — what is installed on one simulator, validated by `sims/schema.json`.
- `templates/<id>.yaml` — chapter order of a manual type.
- `tools/resolve.js` — builds `docs/` for every sim. `docs/` and `build/` are generated; never edit them.
- `inbox/` — raw material from Łukasz (notes, photos, screenshots, voice transcripts). Empty it as you process it.

Build check: `node tools/resolve.js --all && npm run build`. Both must pass before a PR.

## Authoring rules

1. **IDs** are English kebab-case, match the software component name, and are never renamed.
   A new ID needs a `component.yaml`; only the Support lead approves new IDs.
2. **One chunk = one component.** Never describe a second component inside a chunk; link to it with `[[other-id]]`.
3. **Version ranges, not exact versions.** New chunk only when user-visible behaviour changes.
   Keep old chunks — older simulators still run the old software.
4. **Links** between components are always `[[component-id]]`. Never write a URL or a file path to another chunk.
5. **Tone**: operating-manual English, present tense, second person avoided ("The knob is turned…" or imperative in
   numbered procedures). No marketing words. Match the existing FCOM vocabulary (FNPT, IOS, FSTD, LE devices).
6. **Procedures** are numbered lists, one action per step, expected indication after the action.
   Warnings use `:::caution`, notes use `:::note`.
7. **Images**: put files in `components/<id>/assets/`, reference relatively; prefer SVG for panel diagrams.
   Interactive or animated parts are React components in `src/components/`, used from a `.mdx` chunk.
8. **Never edit generated pages** (revision register, list of effective sections, index) — they come from Git history
   and the sim config.
9. **Sim configs**: Production creates the initial file at delivery; Support updates it on every upgrade.
   Changing a version in a sim config is what triggers a new manual revision — bump `manual.revision` in the same PR.

## Turning inbox material into chunks

When Łukasz drops material in `inbox/` (or pastes it in chat):

1. Identify which component(s) it describes. Check `components/` for an existing ID first.
2. Decide if it is a new version range (behaviour changed) or a correction to an existing chunk.
3. Write or update the chunk following the rules above. Keep everything he stated; do not invent behaviour,
   ranges, timings or part numbers — leave `TODO(łukasz): …` markers for anything missing.
4. Run the build check. Fix broken `[[links]]`.
5. Commit on a branch named `doc/<component-id>-<short-topic>` and open a PR; do not push to `main`.
6. Move the processed inbox files to `inbox/done/` in the same commit.
