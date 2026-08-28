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
const nodeUrl = require("url");
const { execFileSync } = require("child_process");
const yaml = require("js-yaml");
const semver = require("semver");

const ROOT = path.resolve(__dirname, "..");
const argv = process.argv.slice(2);
const PORT = Number(argv[argv.indexOf("--port") + 1]) || 3001;

/** Only these prefixes may be read or written. Everything else is generated or tooling. */
const WRITABLE = ["modules/", "shared/", "sims/", "templates/"];

/**
 * The OpenAI chat model behind POST /api/assistant. Deliberately one constant, right here:
 * changing model is a one-line edit and nothing else in the file names a model.
 */
const ASSISTANT_MODEL = "gpt-5.5";
const ASSISTANT_REASONING_EFFORT = "medium";
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const ASSISTANT_TIMEOUT_MS = 180_000;

/**
 * Read .env at the repository root into process.env — KEY=VALUE, one per line, # comments,
 * optionally quoted values. Deliberately hand-rolled rather than a dotenv dependency: this is
 * six lines for the one secret the tool needs. Values already in the real environment win.
 *
 * The key this loads is used only here, in this process, to call OpenAI. It is never written
 * to a response, never logged, and .env itself is gitignored.
 */
function loadDotEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    const quoted = v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")));
    v = quoted ? v.slice(1, -1) : v.replace(/\s+#.*$/, "").trim();
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadDotEnv();

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

// ------------------------------------------------------------- AI assistant

/**
 * The drafting assistant behind POST /api/assistant.
 *
 * The browser never sees the API key and never talks to OpenAI: it posts the chunk it is
 * editing plus an instruction in plain language, and gets back a message and, at most, a
 * *proposal* — a complete replacement for the chunk. The proposal is not written anywhere.
 * The panel shows it as a diff; only an explicit Accept moves it into the editor, and only the
 * existing PUT /api/file save path writes it to disk, where validate() runs as always.
 *
 * Before returning, the proposal is screened by src/components/assistantProposal.mjs — the same
 * module the panel re-runs at Accept — and by this file's validate(). Anything that would stop
 * the chunk parsing comes back marked as blocking, and the panel refuses to apply it.
 */

/** The key, or a friendly explanation of how to provide one. Never returned to the browser. */
function openaiKey() {
  const key = String(process.env.OPENAI_API_KEY || "").trim();
  if (!key) {
    throw new Error(
      "The assistant needs an OpenAI API key and there is none. Put one in a file named .env at "
      + "the root of this repository:\n\n    OPENAI_API_KEY=sk-…\n\n"
      + ".env is gitignored; the key stays in this server process and is never sent to the "
      + "browser. Restart tools/admin-server.js after adding it.");
  }
  return key;
}

/** The authoring rules of CLAUDE.md, verbatim, so the model is held to the repository's own text. */
function houseRules() {
  const file = path.join(ROOT, "CLAUDE.md");
  if (!fs.existsSync(file)) return "(CLAUDE.md is missing from this repository.)";
  const text = fs.readFileSync(file, "utf8");
  const start = text.indexOf("## Authoring rules");
  if (start === -1) return text.slice(0, 4000);
  const rest = text.slice(start);
  const end = rest.indexOf("\n## ", 3);
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

/** modules/<id>/module.yaml for the chunk being edited, so the model knows what it documents. */
function moduleIdentity(rel) {
  const m = /^modules\/([^/]+)\//.exec(rel);
  if (!m) return null;
  const abs = path.join(ROOT, "modules", m[1], "module.yaml");
  if (!fs.existsSync(abs)) return { id: m[1], text: null };
  return { id: m[1], text: fs.readFileSync(abs, "utf8").trim() };
}

/** Every authored module id — the only legal targets of a [[link]]. */
function knownModuleIds() {
  const dir = path.join(ROOT, "modules");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(d => fs.existsSync(path.join(dir, d, "module.yaml")))
    .sort();
}

function assistantSystemPrompt(rel, identity, ids) {
  return [
    "You are a technical editor working inside FTD.aero's manual repository. You draft and revise",
    "single chunks of a flight simulator operating manual (FSTD/FNPT documentation). The author is",
    "Łukasz, the Support lead. He is at the controls: you never edit files, you propose a new text",
    "for the one chunk he has open and he accepts or rejects it.",
    "",
    "== RULE 1, ABOVE EVERYTHING ELSE: NEVER INVENT TECHNICAL CONTENT ==",
    "",
    "This is a controlled aviation document. A plausible-sounding invented fact is a safety defect,",
    "not a stylistic problem. You must not introduce, and must not 'complete', any of:",
    "  - behaviour of a control, indicator, panel or piece of software;",
    "  - timings, delays, hold durations, tolerances, temperatures, pressures, voltages;",
    "  - part numbers, serial numbers, model designations, supplier names;",
    "  - software version numbers or applies_to ranges;",
    "  - error codes, message text, menu labels, button labels;",
    "  - procedure steps, expected indications, limits or preconditions.",
    "",
    "If the instruction asks for something whose facts are not present in the chunk, the module.yaml",
    "or the author's own message, DO NOT GUESS. Write the structure and put a marker exactly in the",
    "form  TODO(łukasz): <precisely what is missing>  where the fact belongs. For example:",
    "  1. TODO(łukasz): state the grounding check to perform and the indication that confirms it.",
    "A chunk full of honest TODO markers is a good result. A chunk with one invented number is a",
    "failed result. Say plainly in your message which TODO markers you left and why.",
    "",
    "You may freely: restructure, renumber, reword to house style, split a paragraph into a numbered",
    "procedure, fix grammar, move content, and add markers. All of that reuses facts already present.",
    "",
    "== RULE 2: NO SILENT CHANGES ==",
    "",
    "Change only what the instruction asks for. Do not 'improve' untouched paragraphs, do not",
    "reflow or rewrap lines you are not editing, do not renumber unrelated lists, do not reorder",
    "sections. The author reads your work as a line diff; gratuitous churn hides the real edit.",
    "Never delete content unless asked to.",
    "",
    "== FRONT MATTER ==",
    "",
    "The chunk begins with a YAML front matter block between --- fences (applies_to, title,",
    "summary). Reproduce it byte for byte unless the author explicitly asks you to change a field.",
    "applies_to is a semver range that decides which simulators receive this chunk; changing it",
    "silently would reissue manuals. Front matter is flat 'key: value' lines only, and any value",
    "containing ':' must be quoted.",
    "",
    "== HOUSE STYLE (from the repository's CLAUDE.md, binding) ==",
    "",
    houseRules(),
    "",
    "== FORMAT NOTES ==",
    "",
    "  - Links to other modules are always [[module-id]] — never a URL or a file path. The only",
    "    ids that exist are: " + (ids.length ? ids.join(", ") : "(none yet)") + ". Never invent an id.",
    "  - Warnings are :::caution / :::danger[Title] blocks, notes are :::note, each closed by :::",
    "  - A .mdx chunk may contain `import` lines and JSX elements. Reproduce them exactly; never",
    "    add, rename or remove an import or a JSX component.",
    "  - Keep the existing markdown spelling: the same emphasis markers, the same table padding,",
    "    the same indentation. Do not convert - bullets to * or reformat tables you are not editing.",
    "  - Keep the file's trailing newline.",
    "",
    "== THE FILE ==",
    "",
    `You are editing ${rel}.`,
    identity && identity.text
      ? `Its module identity (modules/${identity.id}/module.yaml) is:\n\n${identity.text}`
      : "There is no module.yaml for this file.",
    "",
    "== YOUR REPLY ==",
    "",
    "Reply with a single JSON object and nothing else:",
    '  { "message": string, "content": string | null }',
    "",
    "  message — a short note to the author in plain English: what you changed and, above all,",
    "            every fact you refused to invent and the TODO marker you left instead. If you",
    "            need him to tell you something before you can draft, ask here and set content null.",
    "  content — the COMPLETE new text of the file, front matter included, ready to be written",
    "            verbatim. Never a fragment, never a diff, never fenced in ``` markers.",
    "            Use null when you are only answering a question or asking for a fact.",
  ].filter(Boolean).join("\n");
}

/** The proposal screening shared with the browser. ESM, so it is imported lazily and cached. */
let proposalModule = null;
function proposalTools() {
  if (!proposalModule) {
    const href = nodeUrl.pathToFileURL(path.join(ROOT, "src/components/assistantProposal.mjs")).href;
    proposalModule = import(href);
  }
  return proposalModule;
}

async function callOpenAI(messages) {
  const key = openaiKey();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ASSISTANT_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: ASSISTANT_MODEL,
        messages,
        response_format: { type: "json_object" },
        reasoning_effort: ASSISTANT_REASONING_EFFORT,
      }),
      signal: ac.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(`OpenAI did not answer within ${ASSISTANT_TIMEOUT_MS / 1000}s. Nothing was changed.`);
    }
    throw new Error(`could not reach the OpenAI API: ${e.message}. Nothing was changed.`);
  } finally {
    clearTimeout(timer);
  }

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    // OpenAI's own message, never the request: the key must not appear in any error text.
    const detail = (json && json.error && json.error.message) || `${res.status} ${res.statusText}`;
    if (res.status === 401) throw new Error(`OpenAI rejected the API key in .env: ${detail}`);
    if (res.status === 404) throw new Error(`OpenAI does not offer "${ASSISTANT_MODEL}" to this key: ${detail}. `
      + "Change ASSISTANT_MODEL at the top of tools/admin-server.js.");
    throw new Error(`OpenAI returned an error: ${detail}`);
  }

  const text = json && json.choices && json.choices[0] && json.choices[0].message
    && json.choices[0].message.content;
  if (!text) throw new Error("OpenAI returned an empty reply. Nothing was changed.");
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("OpenAI did not return the JSON object this endpoint asks for. Nothing was changed."); }
  return { parsed, usage: json.usage || null };
}

/**
 * The model writes LF and may drop the final newline; neither is an editorial change, and both
 * would otherwise show up as noise in the diff or be refused outright (chunkMarkdown does not
 * accept mixed line endings). Nothing else about the text is touched.
 */
function matchLineEndings(original, proposal) {
  let out = proposal;
  const crlf = /\r\n/.test(original);
  out = out.replace(/\r\n/g, "\n");
  if (crlf) out = out.replace(/\n/g, "\r\n");
  const eol = crlf ? "\r\n" : "\n";
  if (original.endsWith(eol) && !out.endsWith(eol)) out += eol;
  return out;
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

  /**
   * Ask the assistant for a change to one chunk. Reads nothing but the file being edited and
   * its module identity, writes nothing at all. See the AI assistant section above.
   *
   * body: { path, content?, instruction, history?: [{ role: "user" | "assistant", text }] }
   * →     { reply, proposal: string | null, screening, model, usage }
   */
  "POST /api/assistant": async body => {
    const { rel, abs } = safePath(body.path);
    if (!/\.mdx?$/.test(rel)) {
      throw new Error("the assistant only edits markdown chunks (.md / .mdx). "
        + "Sim configs, module.yaml and templates are edited by hand.");
    }
    const instruction = String(body.instruction || "").trim();
    if (!instruction) throw new Error("an instruction is required");

    // The draft in the editor is the truth, not the file on disk: the author may have typed
    // into it, and a "draft" chunk does not exist on disk at all.
    const content = typeof body.content === "string"
      ? body.content
      : (fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "");

    const identity = moduleIdentity(rel);
    const messages = [
      { role: "system", content: assistantSystemPrompt(rel, identity, knownModuleIds()) },
      ...(Array.isArray(body.history) ? body.history : [])
        .filter(h => h && (h.role === "user" || h.role === "assistant") && typeof h.text === "string")
        .slice(-8)
        .map(h => ({ role: h.role, content: h.text })),
      {
        role: "user",
        content: `Current contents of ${rel}:\n\n<file>\n${content}\n</file>\n\n`
          + `Instruction: ${instruction}`,
      },
    ];

    const { parsed, usage } = await callOpenAI(messages);
    const reply = typeof parsed.message === "string" && parsed.message.trim()
      ? parsed.message.trim()
      : "(the model returned no message)";

    let proposal = typeof parsed.content === "string" && parsed.content.trim() !== ""
      ? matchLineEndings(content, parsed.content)
      : null;

    let screening = null;
    if (proposal !== null) {
      const { screenProposal } = await proposalTools();
      screening = screenProposal(content, proposal, rel);
      if (screening.unchanged) {
        proposal = null;
        screening = null;
      } else {
        // The same gate the file itself passes on every save. A proposal that would be
        // rejected on save is marked here so the panel never offers to apply it.
        try { validate(rel, proposal); }
        catch (e) {
          screening = {
            ...screening,
            ok: false,
            blocking: [...screening.blocking, `saving this would be refused: ${e.message}`],
          };
        }
      }
    }

    return { reply, proposal, screening, model: ASSISTANT_MODEL, usage };
  },

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
  // Handlers may be async — the assistant route waits on OpenAI — so every result is awaited.
  req.on("end", async () => {
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
      const out = await handler(body, url);
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
