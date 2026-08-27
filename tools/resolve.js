#!/usr/bin/env node
/**
 * resolve.js — builds the generated docs/ tree for one simulator.
 *
 *   node tools/resolve.js sims/b73m-f2m-04-2026.json
 *   node tools/resolve.js --all
 *
 * Steps:
 *   1. validate the sim config against sims/schema.json
 *   2. load the manual template and every component chunk
 *   3. for each installed component pick the chunk whose applies_to range
 *      matches the installed version (build fails if none does)
 *   4. resolve [[component-id]] links; fail on unknown or not-installed targets
 *   5. write docs/<slug>/... plus sidebars-<slug>.js and a manifest for the
 *      Revision Register / List of Effective Sections
 */
const fs = require("fs");
const path = require("path");
const semver = require("semver");
const yaml = require("js-yaml");
const Ajv = require("ajv/dist/2020");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: node tools/resolve.js <sims/x.json> | --all");
  process.exit(2);
}

const simFiles = args[0] === "--all"
  ? fs.readdirSync(path.join(ROOT, "sims")).filter(f => f.endsWith(".json") && f !== "schema.json").map(f => path.join(ROOT, "sims", f))
  : args.map(a => path.resolve(a));

// ---------- load registry of components ----------
function loadComponents() {
  const dir = path.join(ROOT, "components");
  const registry = {};
  for (const id of fs.readdirSync(dir)) {
    const cdir = path.join(dir, id);
    const metaFile = path.join(cdir, "component.yaml");
    if (!fs.existsSync(metaFile)) continue;
    const meta = yaml.load(fs.readFileSync(metaFile, "utf8"));
    if (meta.id !== id) fail(`components/${id}/component.yaml declares id "${meta.id}" — folder name and id must match`);
    const chunks = fs.readdirSync(cdir).filter(f => /^v\d+\.mdx?$/.test(f)).map(f => {
      const src = fs.readFileSync(path.join(cdir, f), "utf8");
      const { front, body } = splitFrontMatter(src, `components/${id}/${f}`);
      if (!front.applies_to || !semver.validRange(front.applies_to)) fail(`components/${id}/${f}: missing or invalid applies_to range`);
      return { file: f, front, body, range: front.applies_to };
    });
    if (chunks.length === 0) fail(`components/${id}: no vN.md chunk found`);
    registry[id] = { meta, chunks, dir: cdir };
  }
  return registry;
}

function splitFrontMatter(src, where) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) fail(`${where}: missing YAML front matter`);
  return { front: yaml.load(m[1]) || {}, body: m[2] };
}

function fail(msg) { console.error("✖ " + msg); process.exit(1); }

function gitInfo(relPath) {
  try {
    const out = execSync(`git log -1 --format=%h%x09%as%x09%s -- "${relPath}"`, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (!out) return { hash: "uncommitted", date: "—", subject: "not yet committed" };
    const [hash, date, subject] = out.split("\t");
    return { hash, date, subject };
  } catch { return { hash: "n/a", date: "—", subject: "" }; }
}

// ---------- main ----------
const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "sims", "schema.json"), "utf8"));
const validate = ajv.compile(schema);
const registry = loadComponents();
const summary = [];

for (const simFile of simFiles) {
  const sim = JSON.parse(fs.readFileSync(simFile, "utf8"));
  if (!validate(sim)) fail(`${path.relative(ROOT, simFile)} invalid:\n` + ajv.errorsText(validate.errors, { separator: "\n" }));
  sim.slug = sim.slug || sim.serial.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  const tplFile = path.join(ROOT, "templates", `${sim.manual.template}.yaml`);
  if (!fs.existsSync(tplFile)) fail(`${sim.serial}: template "${sim.manual.template}" not found`);
  const tpl = yaml.load(fs.readFileSync(tplFile, "utf8"));

  const installed = Object.entries(sim.components).filter(([, c]) => c.installed !== false).map(([id]) => id);
  const outDir = path.join(ROOT, "docs", sim.slug);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const sections = []; // for LOES / revision register
  const sidebar = [];
  const warnings = [];
  const issueRev = `${sim.manual.issue}.${sim.manual.revision}`;

  // resolve [[id]] links → relative doc links
  const linkTargets = {};
  const resolveLinks = (body, where) => body.replace(/\[\[([a-z0-9-]+)\]\]/g, (_, id) => {
    if (!registry[id]) fail(`${where}: link to unknown component [[${id}]]`);
    if (!installed.includes(id)) fail(`${where}: links to [[${id}]] which is not installed on ${sim.serial}`);
    if (!linkTargets[id]) fail(`${where}: [[${id}]] is installed but not placed in template "${tpl.id}"`);
    return `[${registry[id].meta.name}](${linkTargets[id]})`;
  });

  // first pass: decide which pages exist so links can resolve
  const pages = [];
  function walk(node, chapterPath, depth) {
    const items = [];
    for (const p of node.pages || []) {
      if (p.component) {
        const id = p.component;
        if (!installed.includes(id)) { warnings.push(`skipped ${id} (not installed)`); continue; }
        if (!registry[id]) fail(`${sim.serial}: installed component "${id}" has no components/${id}/ folder`);
        const version = sim.components[id].version;
        if (!version) fail(`${sim.serial}: component ${id} is installed but has no version`);
        const chunk = registry[id].chunks.find(c => semver.satisfies(version, c.range));
        if (!chunk) fail(`${sim.serial}: no chunk of "${id}" covers installed version ${version} (have: ${registry[id].chunks.map(c => c.range).join(", ")}) — write a new components/${id}/vN.md or open a DOK ticket`);
        const docId = `${chapterPath}/${id}`;
        linkTargets[id] = `/manuals/${sim.slug}/${docId}`;
        pages.push({ kind: "component", id, docId, chunk, version });
        items.push(`${sim.slug}/${docId}`);
      } else if (p.shared) {
        const file = path.join(ROOT, "shared", `${p.shared}.md`);
        if (!fs.existsSync(file)) fail(`shared page "${p.shared}" not found`);
        const docId = `${chapterPath}/${p.shared}`;
        pages.push({ kind: "shared", id: p.shared, docId, file });
        items.push(`${sim.slug}/${docId}`);
      } else if (p.generated) {
        const docId = `${chapterPath}/${p.generated}`;
        pages.push({ kind: "generated", id: p.generated, docId });
        items.push(`${sim.slug}/${docId}`);
      }
    }
    for (const s of node.sections || []) {
      const sub = walk(s, `${chapterPath}/${s.id}`, depth + 1);
      if (sub.length) items.push({ type: "category", label: s.title, items: sub });
      else warnings.push(`section "${s.title}" empty for this device`);
    }
    return items;
  }
  for (const ch of tpl.chapters) {
    const items = walk(ch, ch.id, 1);
    if (items.length) sidebar.push({ type: "category", label: ch.title, collapsed: false, items });
  }

  // second pass: write pages
  let pos = 0;
  for (const p of pages) {
    pos += 1;
    const file = path.join(outDir, p.docId + ".md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let front, body;
    if (p.kind === "component") {
      const rel = path.relative(ROOT, path.join(registry[p.id].dir, p.chunk.file));
      const git = gitInfo(rel);
      front = {
        id: path.basename(p.docId),
        title: p.chunk.front.title || registry[p.id].meta.name,
        description: p.chunk.front.summary || "",
        sidebar_position: pos,
        custom_edit_url: null,
      };
      body = `:::info[Effectivity]\nComponent **\`${p.id}\`** · installed software **${p.version}** · documented range \`${p.chunk.range}\` · chunk revision \`${git.hash}\` (${git.date})\n:::\n\n` + resolveLinks(p.chunk.body, rel);
      sections.push({ id: p.id, title: front.title, docId: p.docId, version: p.version, range: p.chunk.range, ...git, source: rel });
    } else if (p.kind === "shared") {
      const rel = path.relative(ROOT, p.file);
      const { front: f, body: b } = splitFrontMatter(fs.readFileSync(p.file, "utf8"), rel);
      const git = gitInfo(rel);
      front = { id: path.basename(p.docId), title: f.title, sidebar_position: pos, custom_edit_url: null };
      body = resolveLinks(b, rel);
      sections.push({ id: p.id, title: f.title, docId: p.docId, version: "—", range: "all", ...git, source: rel });
    } else {
      front = { id: path.basename(p.docId), title: p.id === "revision-register" ? "Revision register" : "List of effective sections", sidebar_position: pos, custom_edit_url: null };
      body = p.id === "revision-register" ? renderRevisionRegister(sim, sections) : renderLOES(sim, sections);
      if (p.id === "list-of-effective-sections" || p.id === "revision-register") {
        // generated pages depend on all other pages: defer
        p.file = file; p.front = front; p.deferred = true; continue;
      }
    }
    fs.writeFileSync(file, `---\n${yaml.dump(front)}---\n\n${body}`);
  }
  for (const p of pages.filter(x => x.deferred)) {
    const body = p.id === "revision-register" ? renderRevisionRegister(sim, sections) : renderLOES(sim, sections);
    fs.writeFileSync(p.file, `---\n${yaml.dump(p.front)}---\n\n${body}`);
  }

  // cover / index page
  fs.writeFileSync(path.join(outDir, "index.md"), `---\nid: index\ntitle: ${tpl.title}\nsidebar_position: 0\ncustom_edit_url: null\n---\n\n# ${tpl.title}\n\n| | |\n|---|---|\n| Airplane type | ${sim.device_type} |\n| Qualification level | ${sim.qualification} |\n| Serial number | ${sim.serial} |\n| Document version | Issue ${sim.manual.issue} Rev ${sim.manual.revision} |\n| Effective date | ${sim.manual.effective_date || "—"} |\n| Operator / Client | ${sim.client} |\n\nThis manual was generated from configuration file \`sims/${path.basename(simFile)}\` and describes only the components installed on this device.\n`);
  sidebar.unshift(`${sim.slug}/index`);

  fs.writeFileSync(path.join(ROOT, "docs", `sidebars-${sim.slug}.json`), JSON.stringify(sidebar, null, 2));
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ sim, issueRev, sections, warnings }, null, 2));
  summary.push({ serial: sim.serial, slug: sim.slug, issueRev, pages: pages.length, warnings });
  console.log(`✔ ${sim.serial} → docs/${sim.slug}  (Issue ${issueRev}, ${pages.length} pages${warnings.length ? ", " + warnings.join("; ") : ""})`);
}

fs.writeFileSync(path.join(ROOT, "docs", "manuals.json"), JSON.stringify(summary, null, 2));

function renderRevisionRegister(sim, sections) {
  const rows = sections.map(s => `| ${s.title} | ${s.date} | ${sim.manual.issue} | ${sim.manual.revision} | ${s.subject.replace(/\|/g, "\\|")} (${s.hash}) |`).join("\n");
  return `Revision history is derived from the Git history of every section included in this manual. The current document is **Issue ${sim.manual.issue} Revision ${sim.manual.revision}**, effective ${sim.manual.effective_date || "—"}.\n\n| Section affected | Revision date | Issue | Rev. | Change description |\n|---|---|---|---|---|\n${rows}\n`;
}
function renderLOES(sim, sections) {
  const rows = sections.map(s => `| ${s.title} | \`${s.id}\` | ${s.version} | \`${s.range}\` | ${sim.manual.issue} | ${sim.manual.revision} | ${s.date} |`).join("\n");
  return `This manual is controlled at section level. Each section below is effective for the serial number on the cover page at the stated issue and revision.\n\n| Section | Component id | Installed version | Documented range | Issue | Rev. | Effective date |\n|---|---|---|---|---|---|---|\n${rows}\n`;
}
