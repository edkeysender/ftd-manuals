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
const WRITABLE = ["components/", "shared/", "sims/", "templates/"];

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
  // Component chunks are version-ranged; shared pages are not.
  if (rel.startsWith("components/")) {
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

function gitState() {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const branches = git("branch", "--format=%(refname:short)").split("\n").filter(Boolean);
  const entries = gitRaw("status", "--porcelain").split("\n").filter(Boolean).map(l => ({
    status: l.slice(0, 2).trim(),
    path: l.slice(3).replace(/^"|"$/g, ""),
  }));
  // docs/ is regenerated on every save; listing it would bury the authored changes.
  const dirty = entries.filter(f => !f.path.startsWith("docs/"));
  const generated = entries.length - dirty.length;
  let tags = [];
  try { tags = git("tag", "--list", "manual/*", "--sort=-creatordate").split("\n").filter(Boolean).slice(0, 20); } catch { /* none yet */ }
  return { branch, branches, dirty, generatedDirty: generated, tags, onMain: branch === "main" };
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
      throw new Error('branch must look like doc/<component-id>-<topic>');
    }
    if (fs.existsSync(abs) && !body.overwrite) throw new Error(`${rel} already exists`);
    validate(rel, body.content);

    const existing = git("branch", "--format=%(refname:short)").split("\n");
    if (existing.includes(branch)) git("checkout", branch);
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

  "POST /api/git/branch": body => {
    const name = String(body.name || "").trim();
    if (!/^[a-z0-9][a-z0-9._\/-]*$/.test(name)) throw new Error("invalid branch name");
    const existing = git("branch", "--format=%(refname:short)").split("\n");
    if (existing.includes(name)) git("checkout", name);
    else git("checkout", "-b", name);
    return { git: gitState() };
  },

  "POST /api/git/checkout": body => {
    git("checkout", String(body.name));
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
