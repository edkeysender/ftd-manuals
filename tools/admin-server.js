#!/usr/bin/env node
/**
 * admin-server.js — local editing backend for the /admin panel.
 *
 *   node tools/admin-server.js [--port 3001]
 *
 * The admin panel is a static page: in a published site its buttons are deep links into
 * GitHub's web editor. That needs a remote. While the repository is local only, this
 * server gives the same panel a real backend — it reads and writes the authored files,
 * re-runs the resolver after every change, and drives git for the draft/release flow.
 *
 * It is a development tool: it binds to 127.0.0.1 only, has no authentication, and will
 * happily rewrite your working tree. Do not expose it. Writes are confined to the four
 * authored directories below; docs/ and build/ are generated and are never writable.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const yaml = require("js-yaml");
const semver = require("semver");

const ROOT = path.resolve(__dirname, "..");
const argv = process.argv.slice(2);
const PORT = Number(argv[argv.indexOf("--port") + 1]) || 3001;

/** Only these prefixes may be read or written. Everything else is generated or tooling. */
const WRITABLE = ["modules/", "shared/", "sims/", "templates/"];

function git(...args) {
  return gitRaw(...args).trim();
}

/**
 * Untrimmed, for `status --porcelain`: its first two columns are the status code and a
 * line may legitimately start with a space (" M path"). Trimming would shift that line's
 * path by one character.
 */
function gitRaw(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function resolveAll() {
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, "resolve.js"), "--all"],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, output: out };
  } catch (e) {
    // A gap is reported on stderr with exit 0; a real failure exits non-zero.
    return { ok: false, output: (e.stdout || "") + (e.stderr || "") };
  }
}

/**
 * Validate a file before it reaches disk, so a draft can never be committed in a state
 * that crashes the resolver. JSON must parse; a chunk must have front matter that parses
 * as a YAML mapping and declares a valid semver range.
 */
function validate(rel, content) {
  if (rel.endsWith(".json")) {
    try { JSON.parse(content); }
    catch (e) { throw new Error(`not valid JSON: ${e.message}`); }
    return;
  }
  if (!/\.mdx?$/.test(rel)) return;

  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error("missing YAML front matter (the --- block at the top)");
  let front;
  try { front = yaml.load(m[1]); }
  catch (e) {
    throw new Error(`front matter is not valid YAML — ${e.reason || e.message}. `
      + `A value containing ":" must be quoted, e.g. summary: "TODO(x): text".`);
  }
  if (typeof front !== "object" || front === null || Array.isArray(front)) {
    throw new Error("front matter must be a mapping of key: value");
  }
  // Module chunks are version-ranged; shared pages are not.
  if (rel.startsWith("modules/")) {
    if (!front.applies_to) throw new Error("front matter is missing applies_to");
    if (!semver.validRange(String(front.applies_to))) {
      throw new Error(`applies_to "${front.applies_to}" is not a valid semver range`);
    }
  }
  if (!front.title) throw new Error("front matter is missing title");
}

/** Reject anything that escapes ROOT or lands outside the authored directories. */
function safePath(rel) {
  if (typeof rel !== "string" || rel.length === 0) throw new Error("path is required");
  const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  if (norm.includes("..")) throw new Error("path may not contain ..");
  if (!WRITABLE.some(p => norm.startsWith(p))) {
    throw new Error(`path must be inside one of: ${WRITABLE.join(", ")}`);
  }
  const abs = path.resolve(ROOT, norm);
  if (!abs.startsWith(ROOT + path.sep)) throw new Error("path escapes the repository");
  return { rel: norm, abs };
}

/**
 * Files that must exist on a branch for the panel to survive checking it out. Switching to
 * a branch that predates the panel deletes the panel and this server from the working tree:
 * the page stays open, the dev server keeps serving a stale bundle and the next save fails
 * in a way that looks like a bug in the panel. Checking out such a branch is refused.
 */
const PANEL_FILES = ["src/pages/admin.js", "tools/admin-server.js"];

function panelFilesMissingOn(branch) {
  return PANEL_FILES.filter(p => {
    try { gitRaw("cat-file", "-e", `${branch}:${p}`); return false; }
    catch { return true; }
  });
}

function assertPanelSurvives(branch) {
  const missing = panelFilesMissingOn(branch);
  if (missing.length) {
    throw new Error(`branch "${branch}" does not contain ${missing.join(" or ")}. `
      + "Checking it out would delete the admin panel from the working tree and break the running dev server. "
      + `Merge the panel into "${branch}" first, or switch with git if that is really what you want.`);
  }
}

function gitState() {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const branches = git("branch", "--format=%(refname:short)").split("\n").filter(Boolean);
  // Branches the panel refuses to check out, so the dropdown can mark them.
  const unsafeBranches = branches.filter(b => b !== branch && panelFilesMissingOn(b).length > 0);
  const entries = gitRaw("status", "--porcelain").split("\n").filter(Boolean).map(l => ({
    status: l.slice(0, 2).trim(),
    path: l.slice(3).replace(/^"|"$/g, ""),
  }));
  // docs/ is regenerated on every save; listing it would bury the authored changes.
  const dirty = entries.filter(f => !f.path.startsWith("docs/"));
  const generated = entries.length - dirty.length;
  let tags = [];
  try { tags = git("tag", "--list", "manual/*", "--sort=-creatordate").split("\n").filter(Boolean).slice(0, 20); } catch { /* none yet */ }
  return { branch, branches, unsafeBranches, dirty, generatedDirty: generated, tags, onMain: branch === "main" };
}

// ------------------------------------------------------------- new sections

/** Module ids are English kebab-case, match the software module and are never renamed. */
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function readTemplate(templateId) {
  const id = String(templateId || "").trim();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) throw new Error(`"${id}" is not a valid template id`);
  const rel = `templates/${id}.yaml`;
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) throw new Error(`template "${id}" not found (${rel})`);
  const text = fs.readFileSync(abs, "utf8");
  let doc;
  try { doc = yaml.load(text); }
  catch (e) { throw new Error(`${rel} is not valid YAML — ${e.reason || e.message}`); }
  if (!doc || !Array.isArray(doc.chapters)) throw new Error(`${rel} has no chapters: list`);
  return { id, rel, abs, text, doc };
}

/** Where a template places a module, or null. A module appears at most once. */
function findPlacement(doc, moduleId) {
  for (const ch of doc.chapters || []) {
    if ((ch.pages || []).some(p => p.module === moduleId)) return { chapter: ch.id, section: null };
    for (const s of ch.sections || []) {
      if ((s.pages || []).some(p => p.module === moduleId)) return { chapter: ch.id, section: s.id };
    }
  }
  return null;
}

const indentOf = line => line.match(/^[ \t]*/)[0].length;

/** End (exclusive) of the block owned by the list item starting at `start`, blanks trimmed. */
function itemBlockEnd(lines, start) {
  const content = lines[start].indexOf("- ") + 2;
  let end = start + 1;
  while (end < lines.length) {
    if (lines[end].trim() === "") { end++; continue; }
    if (indentOf(lines[end]) < content) break;
    end++;
  }
  while (end > start + 1 && lines[end - 1].trim() === "") end--;
  return end;
}

function findListItem(lines, from, to, id, dashIndent) {
  for (let i = from; i < to; i++) {
    const m = lines[i].match(/^([ \t]*)-\s+id:\s*["']?([^"'#]+?)["']?\s*$/);
    if (m && m[1].length === dashIndent && m[2] === id) return i;
  }
  return -1;
}

/**
 * Add `- module: <id>` to a chapter (or sub-section) of a template, textually, so the
 * file's comments and formatting survive. The caller re-parses the result and checks the
 * module really landed where it was asked for before anything is committed.
 */
function placeComponentInTemplate(text, chapterId, sectionId, moduleId) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const chaptersLine = lines.findIndex(l => /^chapters:\s*$/.test(l));
  if (chaptersLine === -1) throw new Error("template has no top-level chapters: list");
  const firstDash = lines.findIndex((l, i) => i > chaptersLine && /^[ \t]*-\s/.test(l));
  if (firstDash === -1) throw new Error("template has no chapters");

  let start = findListItem(lines, chaptersLine + 1, lines.length, chapterId, indentOf(lines[firstDash]));
  if (start === -1) throw new Error(`chapter "${chapterId}" is not in this template`);
  let end = itemBlockEnd(lines, start);

  if (sectionId) {
    const chapterIndent = lines[start].indexOf("- ") + 2;
    const secLine = lines.findIndex((l, i) => i > start && i < end && indentOf(l) === chapterIndent && /^\s*sections:\s*$/.test(l));
    if (secLine === -1) throw new Error(`chapter "${chapterId}" has no sub-sections`);
    const secDash = lines.findIndex((l, i) => i > secLine && i < end && /^[ \t]*-\s/.test(l));
    if (secDash === -1) throw new Error(`chapter "${chapterId}" has no sub-sections`);
    start = findListItem(lines, secLine + 1, end, sectionId, indentOf(lines[secDash]));
    if (start === -1) throw new Error(`sub-section "${sectionId}" is not in chapter "${chapterId}"`);
    end = itemBlockEnd(lines, start);
  }

  const contentIndent = lines[start].indexOf("- ") + 2;
  const pagesLine = lines.findIndex((l, i) => i > start && i < end && indentOf(l) === contentIndent && /^\s*pages:\s*$/.test(l));

  if (pagesLine === -1) {
    const pad = " ".repeat(contentIndent);
    lines.splice(end, 0, `${pad}pages:`, `${pad}  - module: ${moduleId}`);
    return lines.join("\n");
  }
  let last = pagesLine;
  let itemIndent = contentIndent + 2;
  for (let i = pagesLine + 1; i < end; i++) {
    if (lines[i].trim() === "") continue;
    if (indentOf(lines[i]) <= contentIndent) break;
    if (/^[ \t]*-\s/.test(lines[i])) itemIndent = indentOf(lines[i]);
    last = i;
  }
  lines.splice(last + 1, 0, `${" ".repeat(itemIndent)}- module: ${moduleId}`);
  return lines.join("\n");
}

/** Front matter of an already-validated chunk. */
function frontMatterOf(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  return m ? yaml.load(m[1]) || {} : {};
}

/**
 * The first chunk of a new module. Every front-matter value is emitted with
 * JSON.stringify: a title or summary containing ":" is invalid YAML unquoted.
 */
function firstChunk(name, title, summary) {
  return [
    "---",
    'applies_to: ">=1.0.0 <2.0.0"',
    `title: ${JSON.stringify(title || name)}`,
    `summary: ${JSON.stringify(summary || `TODO(łukasz): one sentence describing what ${name} does.`)}`,
    "---",
    "",
    `TODO(łukasz): describe ${name} for software version 1.x — what it is, where it is`,
    "and how it is operated. One module per chunk; link to any other module as [[MODULE-ID]] (lower-case kebab id, see CLAUDE.md rule 4).",
    "",
    "## Related",
    "",
    "- TODO(łukasz): link related modules as [[MODULE-ID]].",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- routes

const routes = {
  "GET /api/health": () => ({ ok: true, root: ROOT, writable: WRITABLE, ...gitState() }),

  "GET /api/state": () => {
    const file = path.join(ROOT, "docs", "admin.json");
    if (!fs.existsSync(file)) resolveAll();
    return { admin: JSON.parse(fs.readFileSync(file, "utf8")), git: gitState() };
  },

  "GET /api/file": (_, url) => {
    const { rel, abs } = safePath(url.searchParams.get("path"));
    if (!fs.existsSync(abs)) throw new Error(`${rel} does not exist`);
    return { path: rel, content: fs.readFileSync(abs, "utf8") };
  },

  "PUT /api/file": body => {
    const { rel, abs } = safePath(body.path);
    if (typeof body.content !== "string") throw new Error("content is required");
    validate(rel, body.content);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body.content);
    return { path: rel, saved: true, resolve: resolveAll(), git: gitState() };
  },

  "POST /api/resolve": () => ({ resolve: resolveAll(), git: gitState() }),

  /** Create the draft branch, write the new chunk and commit it in one step. */
  "POST /api/draft": body => {
    const { rel, abs } = safePath(body.path);
    if (typeof body.content !== "string") throw new Error("content is required");
    const branch = String(body.branch || "").trim();
    if (!/^doc\/[a-z0-9-]+(\/[a-z0-9-]+)?$/.test(branch)) {
      throw new Error('branch must look like doc/<module-id>-<topic>');
    }
    if (fs.existsSync(abs) && !body.overwrite) throw new Error(`${rel} already exists`);
    validate(rel, body.content);

    const existing = git("branch", "--format=%(refname:short)").split("\n");
    if (existing.includes(branch)) { assertPanelSurvives(branch); git("checkout", branch); }
    else git("checkout", "-b", branch);

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body.content);
    const r = resolveAll();

    git("add", rel);
    const message = body.message || `Draft: ${rel}`;
    let committed = false;
    if (git("diff", "--cached", "--name-only")) { git("commit", "-m", message); committed = true; }
    return { branch, path: rel, committed, resolve: r, git: gitState() };
  },

  /**
   * Create a brand-new section: modules/<id>/module.yaml, modules/<id>/v1.md and
   * the module's placement in a manual template — a module that is not placed in a
   * template never renders and every [[link]] to it degrades to plain text.
   *
   * Everything is validated before anything is written, and the branch is only created
   * once the write is known to be legal. If the resolver still rejects the result, the
   * files, the template edit and the branch are all rolled back, so a rejected request
   * never leaves a half-made section behind.
   */
  "POST /api/section": body => {
    const id = String(body.id || "").trim();
    if (!ID_RE.test(id)) {
      throw new Error(`"${id}" is not a valid module id — English kebab-case, e.g. cargo-fire-panel`);
    }
    const cdir = path.join(ROOT, "modules", id);
    if (fs.existsSync(cdir)) throw new Error(`modules/${id}/ already exists — module ids are never reused or renamed`);

    const name = String(body.name || "").trim();
    if (!name) throw new Error("a module name is required");

    // ----- placement -----
    const tpl = readTemplate(body.template || "fcom-fnpt2");
    const already = findPlacement(tpl.doc, id);
    const chapterId = body.chapter ? String(body.chapter).trim() : (already ? already.chapter : "");
    const sectionId = body.section ? String(body.section).trim() : (already && !body.chapter ? already.section : null);
    if (!chapterId) {
      throw new Error(`a chapter of templates/${tpl.id}.yaml is required — a module that is not placed `
        + "in the template never renders and every [[link]] to it degrades to plain text");
    }
    const chapter = tpl.doc.chapters.find(c => c.id === chapterId);
    if (!chapter) throw new Error(`chapter "${chapterId}" is not in templates/${tpl.id}.yaml`);
    if (sectionId && !(chapter.sections || []).some(s => s.id === sectionId)) {
      throw new Error(`sub-section "${sectionId}" is not in chapter "${chapterId}" of templates/${tpl.id}.yaml`);
    }
    if (already && (already.chapter !== chapterId || already.section !== sectionId)) {
      throw new Error(`"${id}" is already placed in templates/${tpl.id}.yaml under `
        + `${already.chapter}${already.section ? "/" + already.section : ""} — a module appears once per template`);
    }

    // ----- files -----
    const metaRel = `modules/${id}/module.yaml`;
    const chunkRel = `modules/${id}/v1.md`;
    safePath(metaRel); safePath(chunkRel); safePath(tpl.rel);

    const meta = {
      id,
      name,
      category: body.category ? String(body.category).trim() : null,
      location: body.location ? String(body.location).trim() : null,
      owner: body.owner ? String(body.owner).trim() : "support",
      jira_component: body.jira_component ? String(body.jira_component).trim() : null,
      software_component: body.software_component ? String(body.software_component).trim() : null,
    };
    if (body.optional === true) meta.optional = true;
    // js-yaml quotes only what has to be quoted, which keeps the file identical in style
    // to the hand-written ones while never emitting an unquoted value containing ":".
    const metaText = yaml.dump(meta, { lineWidth: -1 });

    const chunkText = typeof body.content === "string" && body.content.trim()
      ? body.content
      : firstChunk(name, body.title, body.summary);
    validate(chunkRel, chunkText);
    const range = String(frontMatterOf(chunkText).applies_to);
    if (!semver.satisfies("1.0.0", range)) {
      throw new Error(`v1.md must document the first software version: applies_to "${range}" does not cover 1.0.0. Use ">=1.0.0 <2.0.0".`);
    }

    const newTplText = already ? tpl.text : placeComponentInTemplate(tpl.text, chapterId, sectionId, id);
    if (!already) {
      let reparsed;
      try { reparsed = yaml.load(newTplText); }
      catch (e) { throw new Error(`the edited ${tpl.rel} would not be valid YAML — ${e.reason || e.message}. Nothing was written.`); }
      const landed = reparsed && findPlacement(reparsed, id);
      if (!landed || landed.chapter !== chapterId || landed.section !== sectionId) {
        throw new Error(`the edit to ${tpl.rel} did not place "${id}" under `
          + `${chapterId}${sectionId ? "/" + sectionId : ""}. Nothing was written.`);
      }
    }

    // ----- branch -----
    const branch = String(body.branch || `doc/${id}-v1`).trim();
    if (!/^doc\/[a-z0-9-]+(\/[a-z0-9-]+)?$/.test(branch)) {
      throw new Error('branch must look like doc/<module-id>-<topic>');
    }
    const from = git("rev-parse", "--abbrev-ref", "HEAD");
    const reused = git("branch", "--format=%(refname:short)").split("\n").includes(branch);
    if (reused) { assertPanelSurvives(branch); git("checkout", branch); }
    else git("checkout", "-b", branch);

    const files = already ? [metaRel, chunkRel] : [metaRel, chunkRel, tpl.rel];
    let wrote = false;
    try {
      fs.mkdirSync(cdir, { recursive: true });
      fs.writeFileSync(path.join(ROOT, metaRel), metaText);
      fs.writeFileSync(path.join(ROOT, chunkRel), chunkText);
      if (!already) fs.writeFileSync(tpl.abs, newTplText);
      wrote = true;

      const r = resolveAll();
      if (!r.ok) throw new Error(`the resolver rejected the new section, so nothing was committed:\n${r.output.trim()}`);

      git("add", "--", ...files);
      const message = body.message || `Add section: ${name} (${id})`;
      let committed = false;
      if (git("diff", "--cached", "--name-only")) { git("commit", "-m", message); committed = true; }
      return {
        id, branch, files, committed,
        placement: { template: tpl.id, chapter: chapterId, section: sectionId, alreadyPlaced: !!already },
        resolve: r, git: gitState(),
      };
    } catch (e) {
      if (wrote) {
        try { git("reset", "--quiet", "HEAD", "--", ...files); } catch { /* nothing staged */ }
        fs.rmSync(cdir, { recursive: true, force: true });
        if (!already) fs.writeFileSync(tpl.abs, tpl.text);
        resolveAll();
      }
      if (!reused && git("rev-parse", "--abbrev-ref", "HEAD") === branch) {
        git("checkout", from);
        try { git("branch", "-D", branch); } catch { /* never got a commit */ }
      }
      throw e;
    }
  },

  "POST /api/git/branch": body => {
    const name = String(body.name || "").trim();
    if (!/^[a-z0-9][a-z0-9._\/-]*$/.test(name)) throw new Error("invalid branch name");
    const existing = git("branch", "--format=%(refname:short)").split("\n");
    if (existing.includes(name)) { assertPanelSurvives(name); git("checkout", name); }
    else git("checkout", "-b", name);
    return { git: gitState() };
  },

  "POST /api/git/checkout": body => {
    const name = String(body.name || "").trim();
    if (!name) throw new Error("a branch name is required");
    assertPanelSurvives(name);
    git("checkout", name);
    resolveAll();
    return { git: gitState() };
  },

  "POST /api/git/commit": body => {
    const message = String(body.message || "").trim();
    if (!message) throw new Error("a commit message is required");
    const paths = Array.isArray(body.paths) && body.paths.length
      ? body.paths.map(p => safePath(p).rel)
      : WRITABLE;
    git("add", "--", ...paths);
    if (!git("diff", "--cached", "--name-only")) return { committed: false, reason: "nothing staged", git: gitState() };
    git("commit", "-m", message);
    return { committed: true, git: gitState() };
  },

  /**
   * Release: stamp revisions with bump.js, commit the version fields and tag.
   * Manuals held by a gap or a broken link are skipped by bump.js itself.
   */
  "POST /api/release": () => {
    const state = gitState();
    if (!state.onMain && !state.allowAnyBranch) {
      // Releasing from a draft branch would tag content that is not on main yet.
      if (state.branch !== "main") throw new Error(`releases are cut from main; you are on "${state.branch}"`);
    }
    let output;
    try {
      output = execFileSync(process.execPath, [path.join(__dirname, "bump.js"), "--write"],
        { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) { throw new Error((e.stdout || "") + (e.stderr || "")); }

    const relFile = path.join(ROOT, "dist", "release.json");
    if (!fs.existsSync(relFile)) return { released: [], output, git: gitState() };
    const release = JSON.parse(fs.readFileSync(relFile, "utf8"));

    git("add", "sims");
    const tags = release.manuals.map(m => m.tag);
    if (git("diff", "--cached", "--name-only")) {
      git("commit", "-m", `Release: ${tags.join(" ")}\n\nRevision numbers, effective dates and content hashes written by tools/bump.js.`);
      for (const t of tags) {
        try { git("tag", "-a", t, "-m", t); } catch { /* tag already exists */ }
      }
    }
    return { released: release.manuals, output, git: gitState() };
  },
};

// ---------------------------------------------------------------- plumbing

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const key = `${req.method} ${url.pathname}`;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

  const handler = routes[key];
  if (!handler) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `no route for ${key}`, routes: Object.keys(routes) }));
    return;
  }

  let raw = "";
  req.on("data", c => { raw += c; if (raw.length > 4e6) req.destroy(); });
  req.on("end", () => {
    try {
      const body = raw ? JSON.parse(raw) : {};
      const out = handler(body, url);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
      console.log(`  ${key}${body.path ? " " + body.path : ""} → ok`);
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e.message || e) }));
      console.error(`  ${key} → ${e.message}`);
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  const s = gitState();
  console.log(`admin API on http://127.0.0.1:${PORT}  (branch: ${s.branch})`);
  console.log(`writable: ${WRITABLE.join(", ")}`);
  console.log("local development tool — do not expose this port");
});
