#!/usr/bin/env node
/**
 * resolve.js — builds the generated docs/ tree for every simulator.
 *
 *   node tools/resolve.js sims/b73m-f2m-04-2026.json
 *   node tools/resolve.js --all
 *   node tools/resolve.js --all --strict     # exit 1 if any gap or broken link
 *
 * Steps:
 *   1. validate the sim config against sims/schema.json
 *   2. load the manual template and every component chunk
 *   3. for each installed component pick the chunk whose applies_to range matches
 *      the installed version; if none does, record a gap and emit a placeholder page
 *   4. resolve [[component-id]] links; unresolvable ones are recorded and rendered
 *      as plain text so the site still builds
 *   5. write docs/<slug>/…, docs/sidebars-<slug>.json, a manifest per manual,
 *      docs/manuals.json and docs/admin.json (coverage matrix, link graph, gaps)
 *
 * Malformed input (bad YAML, unknown template, invalid config) always fails the build.
 * A gap is different: the manual is structurally sound but a section is missing, which
 * must stay visible and reviewable. Without --strict the build therefore completes;
 * --strict is what CI and tools/bump.js use to refuse a release.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const semver = require("semver");
const yaml = require("js-yaml");
const Ajv = require("ajv/dist/2020");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_BRANCH = "main";
const FALLBACK_REPO = "ftd-aero/ftd-docs";

const argv = process.argv.slice(2);
const flags = argv.filter(a => a.startsWith("--"));
const positional = argv.filter(a => !a.startsWith("--"));
const STRICT = flags.includes("--strict");

for (const f of flags) {
  if (!["--all", "--strict"].includes(f)) fail(`unknown flag "${f}" (expected --all or --strict)`);
}
if (!flags.includes("--all") && positional.length === 0) {
  console.error("usage: node tools/resolve.js <sims/x.json> | --all  [--strict]");
  process.exit(2);
}

const simFiles = flags.includes("--all")
  ? fs.readdirSync(path.join(ROOT, "sims")).filter(f => f.endsWith(".json") && f !== "schema.json").sort().map(f => path.join(ROOT, "sims", f))
  : positional.map(a => path.resolve(a));

function fail(msg) { console.error("✖ " + msg); process.exit(1); }

/** Findings that do not stop the build but block a release. */
const gaps = [];
const brokenLinks = [];
function brokenLink(kind, o) { brokenLinks.push({ kind, ...o }); }

// ---------- repository identity (used by the admin panel to build edit URLs) ----------
function repoSlug() {
  try {
    const url = execSync("git remote get-url origin", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const m = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (m) return m[1];
  } catch { /* no remote configured yet */ }
  return FALLBACK_REPO;
}

// ---------- load registry of components ----------
function splitFrontMatter(src, where) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) fail(`${where}: missing YAML front matter`);
  let front;
  try {
    front = yaml.load(m[1]) || {};
  } catch (e) {
    // Most often an unquoted value containing ":" — e.g. summary: TODO(x): text
    fail(`${where}: front matter is not valid YAML — ${e.reason || e.message}\n`
       + `  line ${(e.mark && e.mark.line + 1) || "?"}. A value containing ":" must be quoted.`);
  }
  if (typeof front !== "object" || Array.isArray(front)) fail(`${where}: front matter must be a mapping`);
  return { front, body: m[2] };
}

function gitInfo(relPath) {
  try {
    const out = execSync(`git log -1 --format=%h%x09%as%x09%s -- "${relPath}"`, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (!out) return { hash: "uncommitted", date: "—", subject: "not yet committed" };
    const [hash, date, subject] = out.split("\t");
    return { hash, date, subject };
  } catch { return { hash: "n/a", date: "—", subject: "" }; }
}

function loadComponents() {
  const dir = path.join(ROOT, "components");
  const registry = {};
  for (const id of fs.readdirSync(dir).sort()) {
    const cdir = path.join(dir, id);
    if (!fs.statSync(cdir).isDirectory()) continue;
    const metaFile = path.join(cdir, "component.yaml");
    if (!fs.existsSync(metaFile)) continue;
    const meta = yaml.load(fs.readFileSync(metaFile, "utf8"));
    if (meta.id !== id) fail(`components/${id}/component.yaml declares id "${meta.id}" — folder name and id must match`);
    const chunks = fs.readdirSync(cdir).filter(f => /^v\d+\.mdx?$/.test(f)).sort().map(f => {
      const rel = `components/${id}/${f}`;
      const src = fs.readFileSync(path.join(cdir, f), "utf8");
      const { front, body } = splitFrontMatter(src, rel);
      if (!front.applies_to || !semver.validRange(front.applies_to)) fail(`${rel}: missing or invalid applies_to range`);
      return {
        file: f,
        major: parseInt(f.match(/^v(\d+)/)[1], 10),
        front, body,
        range: front.applies_to,
        source: rel,
        links: [...new Set([...body.matchAll(/\[\[([a-z0-9-]+)\]\]/g)].map(m => m[1]))],
        ...gitInfo(rel),
      };
    });
    if (chunks.length === 0) fail(`components/${id}: no vN.md chunk found`);
    registry[id] = { meta, chunks, dir: cdir };
  }
  return registry;
}

// ---------- main ----------
const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "sims", "schema.json"), "utf8"));
const validate = ajv.compile(schema);
const registry = loadComponents();
const REPO = repoSlug();
const summary = [];
const adminManuals = [];
const coverageCells = {};
const simMeta = [];

for (const simFile of simFiles) {
  const configPath = path.relative(ROOT, simFile).replace(/\\/g, "/");
  const sim = JSON.parse(fs.readFileSync(simFile, "utf8"));
  if (!validate(sim)) fail(`${configPath} invalid:\n` + ajv.errorsText(validate.errors, { separator: "\n" }));
  sim.slug = sim.slug || sim.serial.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  const tplFile = path.join(ROOT, "templates", `${sim.manual.template}.yaml`);
  if (!fs.existsSync(tplFile)) fail(`${sim.serial}: template "${sim.manual.template}" not found`);
  const tpl = yaml.load(fs.readFileSync(tplFile, "utf8"));

  const installed = Object.entries(sim.components).filter(([, c]) => c.installed !== false).map(([id]) => id);
  const outDir = path.join(ROOT, "docs", sim.slug);
  fs.mkdirSync(outDir, { recursive: true });

  /**
   * Pages are written in place and stale ones pruned at the end, rather than wiping the
   * directory first. Wiping it opens a window in which docs/sidebars-<slug>.json still
   * names pages whose files are momentarily gone; the dev server watches this tree, and
   * a reload landing inside that window fails with "Invalid sidebar file" and kills the
   * server. Since the admin panel re-runs this resolver on every save, that window was
   * hit constantly. Writing in place keeps every referenced page on disk throughout.
   */
  const produced = new Set();
  const record = f => produced.add(path.relative(outDir, f).replace(/\\/g, "/"));
  const writePage = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    record(file);
  };

  /**
   * Wraps a page in the running header and footer every controlled page carries: which
   * device, which issue and revision, which section. Emitted as .mdx so the components
   * can be imported; nothing here is authored by hand.
   */
  const emitPage = (front, body, page) => {
    const attrs = o => Object.entries(o)
      .map(([k, v]) => `${k}={${JSON.stringify(v ?? "")}}`).join(" ");
    const head = {
      manual: tpl.short || tpl.title,
      serial: sim.serial,
      issue: sim.manual.issue,
      revision: sim.manual.revision,
      chapter: page.chapterTitle || "",
      section: front.title || "",
      effective: sim.manual.effective_date || "",
    };
    const foot = {
      serial: sim.serial,
      issue: sim.manual.issue,
      revision: sim.manual.revision,
      sectionId: page.id || "",
      client: sim.client,
    };
    return `---\n${yaml.dump(front)}---\n\n`
      + `import { ManualHeader, ManualFooter } from "@site/src/components/ManualPage";\n\n`
      + `<ManualHeader ${attrs(head)} />\n\n`
      + body
      + `\n\n<ManualFooter ${attrs(foot)} />\n`;
  };

  const sections = [];      // feeds the LOES / revision register
  const sidebar = [];
  const warnings = [];
  const simGaps = [];
  const issueRev = `${sim.manual.issue}.${sim.manual.revision}`;

  function gapEntry(kind, component, detail, fix, version) {
    const e = { kind, sim: sim.slug, serial: sim.serial, component, detail, fix, configPath };
    if (version) e.version = version;
    gaps.push(e);
    simGaps.push(e);
  }
  function nextMajor(id) {
    return registry[id] ? Math.max(...registry[id].chunks.map(c => c.major)) + 1 : 1;
  }

  // ----- pass 1: decide which pages exist, so [[links]] can resolve to them -----
  const linkTargets = {};
  const pages = [];

  function walk(node, chapterPath, chapterTitle) {
    const items = [];
    for (const p of node.pages || []) {
      if (p.component) {
        const id = p.component;
        if (!installed.includes(id)) { warnings.push(`skipped ${id} (not installed)`); continue; }
        const docId = `${chapterPath}/${id}`;
        linkTargets[id] = `/manuals/${sim.slug}/${docId}`;

        if (!registry[id]) {
          gapEntry("missing-component", id, `installed on ${sim.serial} but there is no components/${id}/ folder`,
            `create components/${id}/component.yaml and a first chunk`);
          pages.push({ kind: "gap", id, docId, reason: "no-component-folder", chapterTitle });
          items.push(`${sim.slug}/${docId}`);
          continue;
        }
        const version = sim.components[id].version;
        if (!version) {
          gapEntry("missing-version", id, `installed on ${sim.serial} with no version in the config`,
            `add a version to "${id}" in ${configPath}`);
          pages.push({ kind: "gap", id, docId, reason: "no-version", chapterTitle });
          items.push(`${sim.slug}/${docId}`);
          continue;
        }
        const chunk = registry[id].chunks.find(c => semver.satisfies(version, c.range));
        if (!chunk) {
          const have = registry[id].chunks.map(c => c.range).join(", ");
          gapEntry("missing-chunk", id, `no chunk of "${id}" covers installed version ${version} (have: ${have})`,
            `write components/${id}/v${nextMajor(id)}.md with applies_to covering ${version}`, version);
          pages.push({ kind: "gap", id, docId, reason: "no-chunk", version, have, chapterTitle });
          items.push(`${sim.slug}/${docId}`);
          continue;
        }
        pages.push({ kind: "component", id, docId, chunk, version, chapterTitle });
        items.push(`${sim.slug}/${docId}`);
      } else if (p.shared) {
        const file = path.join(ROOT, "shared", `${p.shared}.md`);
        if (!fs.existsSync(file)) fail(`shared page "${p.shared}" not found`);
        const docId = `${chapterPath}/${p.shared}`;
        pages.push({ kind: "shared", id: p.shared, docId, file, chapterTitle });
        items.push(`${sim.slug}/${docId}`);
      } else if (p.generated) {
        const docId = `${chapterPath}/${p.generated}`;
        pages.push({ kind: "generated", id: p.generated, docId, chapterTitle });
        items.push(`${sim.slug}/${docId}`);
      }
    }
    for (const s of node.sections || []) {
      const sub = walk(s, `${chapterPath}/${s.id}`, chapterTitle);
      if (sub.length) items.push({ type: "category", label: s.title, items: sub });
      else warnings.push(`section "${s.title}" empty for this device`);
    }
    return items;
  }

  for (const ch of tpl.chapters) {
    const items = walk(ch, ch.id, ch.title);
    if (items.length) sidebar.push({ type: "category", label: ch.title, collapsed: false, items });
  }

  // Links are resolved against the pages this manual actually contains. A link to a
  // component that is not installed here is not an authoring error — it is rendered as
  // plain text — but a link to an unknown id always is.
  const resolveLinks = (body, where) => body.replace(/\[\[([a-z0-9-]+)\]\]/g, (_, id) => {
    const name = registry[id] ? registry[id].meta.name : id;
    let reason = null;
    if (!registry[id]) reason = "unknown-component";
    else if (!installed.includes(id)) reason = "not-installed";
    else if (!linkTargets[id]) reason = "not-in-template";
    if (reason) {
      brokenLink(reason, {
        sim: sim.slug, serial: sim.serial, from: where, target: id,
        detail: {
          "unknown-component": `[[${id}]] has no components/${id}/ folder`,
          "not-installed": `[[${id}]] is not installed on ${sim.serial}`,
          "not-in-template": `[[${id}]] is installed but not placed in template "${tpl.id}"`,
        }[reason],
        fix: {
          "unknown-component": `create components/${id}/ or correct the link in ${where}`,
          "not-installed": `remove the link from ${where}, or install ${id} in ${configPath}`,
          "not-in-template": `add "- component: ${id}" to templates/${tpl.id}.yaml`,
        }[reason],
      });
      return `**${name}**`;
    }
    return `[${name}](${linkTargets[id]})`;
  });

  /**
   * Chunks reference their own figures relatively, as `assets/<name>`. Those files live
   * beside the chunk in components/<id>/assets/ and have to be copied next to the
   * generated page for the bundler to pick them up. They are namespaced per component
   * because several components share one chapter directory.
   *
   * A referenced figure that does not exist is a gap, not a build failure — the same
   * treatment a missing section gets. The reference is replaced with a visible marker so
   * the page still builds and the omission is obvious in review.
   */
  function resolveAssets(body, id, pageFile, where) {
    const srcDir = path.join(registry[id].dir, "assets");
    const destRel = `${id}-assets`;
    const destDir = path.join(path.dirname(pageFile), destRel);
    let copied = false;

    return body.replace(/(!?\[[^\]]*\])\(\s*(?:\.\/)?assets\/([^)\s]+)\s*\)/g, (_, label, name) => {
      const srcFile = path.join(srcDir, name);
      if (!fs.existsSync(srcFile)) {
        gapEntry("missing-asset", id, `${where} references assets/${name}, which does not exist`,
          `add components/${id}/assets/${name}`);
        // Plain text, not a link or an image — either would leave a broken reference on
        // the page and trip Docusaurus's broken-link check.
        const alt = label.replace(/^!?\[|\]$/g, "").trim();
        return `**[figure not available: \`assets/${name}\`${alt ? ` — ${alt}` : ""}]**`;
      }
      if (!copied) { fs.mkdirSync(destDir, { recursive: true }); copied = true; }
      const destFile = path.join(destDir, name);
      fs.copyFileSync(srcFile, destFile);
      record(destFile);
      return `${label}(./${destRel}/${name})`;
    });
  }

  // ----- pass 2: write the pages -----
  const hashInput = [];
  let pos = 0;
  for (const p of pages) {
    pos += 1;
    p.pos = pos;
    if (p.kind === "generated") continue;   // written once `sections` is complete
    const file = path.join(outDir, p.docId + ".mdx");
    fs.mkdirSync(path.dirname(file), { recursive: true });

    if (p.kind === "component") {
      const rel = p.chunk.source;
      const withAssets = b => resolveAssets(b, p.id, file, rel);
      const front = {
        id: path.basename(p.docId),
        title: p.chunk.front.title || registry[p.id].meta.name,
        description: p.chunk.front.summary || "",
        sidebar_position: pos,
        custom_edit_url: null,
      };
      const body = `:::info[Effectivity]\nComponent **\`${p.id}\`** · installed software **${p.version}** · documented range \`${p.chunk.range}\` · chunk revision \`${p.chunk.hash}\` (${p.chunk.date})\n:::\n\n` + withAssets(resolveLinks(p.chunk.body, rel));
      writePage(file, emitPage(front, body, p));
      hashInput.push(p.docId + " " + p.chunk.body);
      sections.push({ id: p.id, title: front.title, docId: p.docId, version: p.version, range: p.chunk.range,
        hash: p.chunk.hash, date: p.chunk.date, subject: p.chunk.subject, source: rel, status: "ok" });

    } else if (p.kind === "shared") {
      const rel = path.relative(ROOT, p.file).replace(/\\/g, "/");
      const { front: f, body: b } = splitFrontMatter(fs.readFileSync(p.file, "utf8"), rel);
      const git = gitInfo(rel);
      const front = { id: path.basename(p.docId), title: f.title, sidebar_position: pos, custom_edit_url: null };
      writePage(file, emitPage(front, resolveLinks(b, rel), p));
      hashInput.push(p.docId + " " + b);
      sections.push({ id: p.id, title: f.title, docId: p.docId, version: "—", range: "all", ...git, source: rel, status: "ok" });

    } else if (p.kind === "gap") {
      const name = registry[p.id] ? registry[p.id].meta.name : p.id;
      const front = { id: path.basename(p.docId), title: name, sidebar_position: pos, custom_edit_url: null };
      // Semver ranges contain "<", which MDX would read as the start of a JSX tag, so
      // every range is emitted as inline code.
      const haveCode = p.have ? p.have.split(", ").map(r => `\`${r}\``).join(", ") : "";
      const why = p.reason === "no-chunk"
        ? `Software version **${p.version}** is installed on this device, but no chunk of \`${p.id}\` documents that version (documented ranges: ${haveCode}).`
        : p.reason === "no-version"
          ? `Component \`${p.id}\` is listed as installed on this device but its configuration entry has no software version.`
          : `Component \`${p.id}\` is listed as installed on this device but has no source folder \`components/${p.id}/\`.`;
      const body = `:::danger[Section not available]\n${why}\n\nThis manual must not be issued while this section is missing. Raise a DOK ticket for component \`${p.id}\`.\n:::\n\nTODO(łukasz): supply the description of **${name}** for this software version.\n`;
      writePage(file, emitPage(front, body, p));
      hashInput.push(p.docId + " GAP:" + p.reason);
      sections.push({ id: p.id, title: name, docId: p.docId, version: p.version || "—", range: "—",
        hash: "—", date: "—", subject: "section missing", source: `components/${p.id}/`, status: "gap" });
    }
  }

  // Page titles, for the table of contents. Known only now that pass 2 has read every
  // chunk's front matter.
  const titleById = {};
  for (const s of sections) titleById[s.docId] = s.title;

  const GENERATED = {
    "revision-register": { title: "Revision register", render: () => renderRevisionRegister(sim, sections) },
    "list-of-effective-sections": { title: "List of effective sections", render: () => renderLOES(sim, sections) },
    "table-of-contents": { title: "Table of contents", render: () => renderTOC(sim, sidebar, titleById, tpl, sections) },
  };

  // Generated pages are not in `sections`, so name them for the contents list too.
  for (const p of pages.filter(x => x.kind === "generated")) {
    titleById[p.docId] = (GENERATED[p.id] || {}).title || p.id;
  }

  for (const p of pages.filter(x => x.kind === "generated")) {
    const spec = GENERATED[p.id];
    if (!spec) fail(`templates/${tpl.id}.yaml: unknown generated page "${p.id}" (expected ${Object.keys(GENERATED).join(", ")})`);
    const file = path.join(outDir, p.docId + ".mdx");
    const front = {
      id: path.basename(p.docId),
      title: spec.title,
      sidebar_position: p.pos,
      custom_edit_url: null,
    };
    writePage(file, emitPage(front, spec.render(), p));
  }

  // cover / index page
  writePage(path.join(outDir, "index.md"), `---\nid: index\ntitle: ${tpl.title}\nsidebar_position: 0\ncustom_edit_url: null\n---\n\n# ${tpl.title}\n\n| | |\n|---|---|\n| Airplane type | ${sim.device_type} |\n| Qualification level | ${sim.qualification} |\n| Serial number | ${sim.serial} |\n| Document version | Issue ${sim.manual.issue} Rev ${sim.manual.revision} |\n| Effective date | ${sim.manual.effective_date || "—"} |\n| Operator / Client | ${sim.client} |\n\nThis manual was generated from configuration file \`${configPath}\` and describes only the components installed on this device.\n`);
  sidebar.unshift(`${sim.slug}/index`);

  // Content hash covers what an operator reads: authored bodies plus the installed
  // configuration. It deliberately excludes issue/revision/effective_date and the
  // generated pages, which are derived from the hash and would otherwise be circular.
  const contentHash = crypto.createHash("sha256")
    .update(JSON.stringify({ template: tpl.id, components: sim.components, pages: hashInput.sort() }))
    .digest("hex").slice(0, 16);
  const storedHash = sim.manual.content_hash || null;

  const simBroken = brokenLinks.filter(b => b.sim === sim.slug);

  writePage(path.join(outDir, "manifest.json"), JSON.stringify(
    { sim, issueRev, sections, warnings, gaps: simGaps, brokenLinks: simBroken, contentHash }, null, 2));

  // Drop pages this run did not produce — a component uninstalled, renamed or moved to
  // another chapter. Runs after every write, so nothing current is deleted and recreated,
  // and before the sidebar is rewritten, so the sidebar on disk never names a file that
  // is about to disappear.
  pruneStale(outDir, produced);

  fs.writeFileSync(path.join(ROOT, "docs", `sidebars-${sim.slug}.json`), JSON.stringify(sidebar, null, 2));

  summary.push({ serial: sim.serial, slug: sim.slug, issueRev, pages: pages.length, warnings, gaps: simGaps.length });
  adminManuals.push({
    serial: sim.serial, slug: sim.slug, client: sim.client, device_type: sim.device_type,
    qualification: sim.qualification, template: tpl.id, issue: sim.manual.issue, revision: sim.manual.revision,
    issueRev, effective_date: sim.manual.effective_date || null, configPath,
    pages: pages.length, sections: sections.length, warnings,
    gaps: simGaps, brokenLinks: simBroken,
    contentHash, storedHash,
    unreleased: storedHash !== contentHash,
    releasable: simGaps.length === 0 && simBroken.length === 0,
  });
  simMeta.push({ slug: sim.slug, serial: sim.serial });

  // coverage matrix cells
  for (const id of new Set([...Object.keys(registry), ...Object.keys(sim.components)])) {
    const entry = sim.components[id];
    const page = pages.find(p => p.id === id && (p.kind === "component" || p.kind === "gap"));
    coverageCells[`${id}|${sim.slug}`] = !entry ? { status: "absent" }
      : entry.installed === false ? { status: "not-installed", note: entry.note || null }
      // docId lets the admin panel link straight to the rendered page.
      : page && page.kind === "component" ? { status: "ok", version: entry.version, chunk: page.chunk.file, range: page.chunk.range, docId: page.docId }
      : page ? { status: "gap", version: entry.version || null, reason: page.reason, docId: page.docId }
      : { status: "not-in-template", version: entry.version || null };
  }

  console.log(`✔ ${sim.serial} → docs/${sim.slug}  (Issue ${issueRev}, ${pages.length} pages`
    + `${simGaps.length ? `, ${simGaps.length} GAP` : ""}${simBroken.length ? `, ${simBroken.length} broken link` : ""}`
    + `${warnings.length ? ", " + warnings.join("; ") : ""})`);
}

// ---------- cross-cutting outputs ----------
const adminComponents = Object.entries(registry).map(([id, c]) => ({
  id,
  name: c.meta.name,
  category: c.meta.category || null,
  location: c.meta.location || null,
  owner: c.meta.owner || null,
  jira_component: c.meta.jira_component || null,
  software_component: c.meta.software_component || null,
  optional: c.meta.optional === true,
  configPath: `components/${id}/component.yaml`,
  nextMajor: Math.max(...c.chunks.map(x => x.major)) + 1,
  chunks: c.chunks.map(x => ({ file: x.file, major: x.major, range: x.range, title: x.front.title || c.meta.name,
    summary: x.front.summary || "", source: x.source, hash: x.hash, date: x.date, subject: x.subject, links: x.links })),
  usedBy: simMeta.filter(s => ["ok", "gap"].includes((coverageCells[`${id}|${s.slug}`] || {}).status)).map(s => s.slug),
}));

// Link graph over authored chunks, independent of any one simulator.
const edges = [];
for (const [id, c] of Object.entries(registry)) {
  for (const chunk of c.chunks) {
    for (const to of chunk.links) {
      edges.push({
        from: id, to, chunk: chunk.file, source: chunk.source,
        known: !!registry[to],
        brokenIn: brokenLinks.filter(b => b.from === chunk.source && b.target === to).map(b => ({ sim: b.sim, kind: b.kind })),
      });
    }
  }
}
const referenced = new Set(edges.map(e => e.to));
const orphans = Object.keys(registry).filter(id => !referenced.has(id));

// Component ids mentioned by a template but never authored, and the chapter/sub-section
// skeleton of every template — the admin panel needs it to place a brand-new section.
const templateIds = new Set();
const adminTemplates = [];
for (const f of fs.readdirSync(path.join(ROOT, "templates")).filter(f => f.endsWith(".yaml")).sort()) {
  const t = yaml.load(fs.readFileSync(path.join(ROOT, "templates", f), "utf8"));
  const collect = n => { for (const p of n.pages || []) if (p.component) templateIds.add(p.component); for (const s of n.sections || []) collect(s); };
  for (const ch of t.chapters || []) collect(ch);
  const componentsOf = n => (n.pages || []).filter(p => p.component).map(p => p.component);
  adminTemplates.push({
    id: t.id || f.replace(/\.yaml$/, ""),
    title: t.title || t.id || f,
    file: `templates/${f}`,
    chapters: (t.chapters || []).map(ch => ({
      id: ch.id,
      title: ch.title,
      components: componentsOf(ch),
      sections: (ch.sections || []).map(s => ({ id: s.id, title: s.title, components: componentsOf(s) })),
    })),
  });
}
const undocumented = [...templateIds].filter(id => !registry[id]).sort();

const admin = {
  generatedAt: new Date().toISOString(),
  repo: REPO,
  defaultBranch: DEFAULT_BRANCH,
  totals: {
    manuals: adminManuals.length,
    components: adminComponents.length,
    chunks: adminComponents.reduce((n, c) => n + c.chunks.length, 0),
    gaps: gaps.length,
    brokenLinks: brokenLinks.length,
    unreleased: adminManuals.filter(m => m.unreleased).length,
  },
  manuals: adminManuals,
  components: adminComponents,
  templates: adminTemplates,
  coverage: {
    componentIds: [...new Set([...Object.keys(registry), ...templateIds])].sort(),
    sims: simMeta,
    cells: coverageCells,
  },
  links: { edges, orphans, undocumented },
  gaps,
  brokenLinks,
};

fs.writeFileSync(path.join(ROOT, "docs", "manuals.json"), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(ROOT, "docs", "admin.json"), JSON.stringify(admin, null, 2));

// ---------- report ----------
for (const g of gaps) console.error(`⚠ GAP  ${g.serial} · ${g.component}: ${g.detail}\n       fix: ${g.fix}`);
for (const b of brokenLinks) console.error(`⚠ LINK ${b.serial} · ${b.from}: ${b.detail}\n       fix: ${b.fix}`);
if (undocumented.length) console.error(`⚠ template references components with no folder: ${undocumented.join(", ")}`);

if (STRICT && (gaps.length || brokenLinks.length)) {
  console.error(`\n✖ --strict: ${gaps.length} gap(s), ${brokenLinks.length} broken link(s) — not releasable`);
  process.exit(1);
}

/**
 * Remove files under root that the current run did not write, then any directory left
 * empty. `produced` holds paths relative to root, so the walk carries root through the
 * recursion rather than comparing against the directory it is currently in.
 */
function pruneStale(root, produced, dir = root) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      pruneStale(root, produced, abs);
      if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
    } else if (!produced.has(path.relative(root, abs).replace(/\\/g, "/"))) {
      fs.unlinkSync(abs);
    }
  }
}

/**
 * Contents list for one manual, rendered from the sidebar tree so it always matches the
 * order a reader actually sees. Chapters and sections become headings; pages become
 * links. Sections missing their content are marked, the same as in the LOES.
 */
function renderTOC(sim, sidebar, titleById, tpl, sections) {
  const missing = new Set(sections.filter(s => s.status === "gap").map(s => s.docId));
  const lines = [];
  const walk = (node, depth) => {
    for (const item of node) {
      if (typeof item === "string") {
        const docId = item.replace(new RegExp(`^${sim.slug}/`), "");
        const title = titleById[docId] || docId.split("/").pop();
        const mark = missing.has(docId) ? " ⚠️" : "";
        lines.push(`${"  ".repeat(depth)}- [${title}](/manuals/${sim.slug}/${docId})${mark}`);
      } else if (item && item.items) {
        lines.push(`${"  ".repeat(depth)}- **${item.label}**`);
        walk(item.items, depth + 1);
      }
    }
  };
  walk(sidebar, 0);

  return `${tpl.title} — **${sim.serial}**, Issue ${sim.manual.issue} Revision ${sim.manual.revision}`
    + `${sim.manual.effective_date ? `, effective ${sim.manual.effective_date}` : ""}.\n\n`
    + `Only the sections installed on this device are listed. Page numbering applies to the printed`
    + ` and PDF editions; in this online edition each entry links to its section.\n\n`
    + lines.join("\n") + "\n";
}

function renderRevisionRegister(sim, sections) {
  const rows = sections.map(s => `| ${s.title} | ${s.date} | ${sim.manual.issue} | ${sim.manual.revision} | ${String(s.subject).replace(/\|/g, "\\|")} (${s.hash}) |`).join("\n");
  return `Revision history is derived from the Git history of every section included in this manual. The current document is **Issue ${sim.manual.issue} Revision ${sim.manual.revision}**, effective ${sim.manual.effective_date || "—"}.\n\n| Section affected | Revision date | Issue | Rev. | Change description |\n|---|---|---|---|---|\n${rows}\n`;
}
function renderLOES(sim, sections) {
  const rows = sections.map(s => `| ${s.title}${s.status === "gap" ? " ⚠️" : ""} | \`${s.id}\` | ${s.version} | \`${s.range}\` | ${sim.manual.issue} | ${sim.manual.revision} | ${s.date} |`).join("\n");
  const missing = sections.filter(s => s.status === "gap");
  const banner = missing.length
    ? `\n:::danger[Incomplete]\n${missing.length} section(s) marked ⚠️ below are not available. This manual must not be issued in this state.\n:::\n`
    : "";
  return `This manual is controlled at section level. Each section below is effective for the serial number on the cover page at the stated issue and revision.\n${banner}\n| Section | Component id | Installed version | Documented range | Issue | Rev. | Effective date |\n|---|---|---|---|---|---|---|\n${rows}\n`;
}
