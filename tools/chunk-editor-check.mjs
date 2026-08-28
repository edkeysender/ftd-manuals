#!/usr/bin/env node
/**
 * chunk-editor-check — the safety net for the rich-text (WYSIWYG) mode of the admin panel.
 *
 *   node tools/chunk-editor-check.mjs
 *
 * It does three things:
 *
 *   1. Round-trip: every chunk in modules/ and shared/ is parsed into the editor model
 *      (src/components/chunkMarkdown.mjs) and serialised straight back. The result must be
 *      byte-identical to the file on disk. This is exactly what happens when an author opens
 *      a chunk in rich-text mode and saves it without typing anything.
 *   2. Refusal: a set of constructs the model deliberately cannot represent must be *refused*
 *      (rich-text mode stays closed) rather than silently mangled.
 *   3. SSR: the editor module is rendered with react-dom/server in both modes, to prove it
 *      does not touch window/document at render time and that the protected blocks and the
 *      mode toggle appear.
 *
 * Exit code 0 only when all three pass. No new dependency: the JSX is compiled for step 3 with
 * @swc/core, which is already installed as part of @docusaurus/faster.
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const mdPath = path.join(ROOT, "src/components/chunkMarkdown.mjs");
const { parseChunk, serializeChunk, parseInline, inlineToMd, escapeInlineText, census, ChunkParseError } =
  await import(url.pathToFileURL(mdPath).href);

let failures = 0;
const ok = s => `  ✓ ${s}`;
const bad = s => `  ✗ ${s}`;

/* ------------------------------------------------------------- 1. round trip */

function chunkFiles() {
  const out = [];
  const comp = path.join(ROOT, "modules");
  for (const id of fs.readdirSync(comp)) {
    const dir = path.join(comp, id);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (/^v\d+\.mdx?$/.test(f)) out.push(path.join(dir, f));
    }
  }
  const shared = path.join(ROOT, "shared");
  if (fs.existsSync(shared)) {
    for (const f of fs.readdirSync(shared)) if (/\.mdx?$/.test(f)) out.push(path.join(shared, f));
  }
  return out.sort();
}

console.log("Round-trip: parse each chunk into the editor model and serialise it back\n");

const totals = {};
for (const file of chunkFiles()) {
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  const src = fs.readFileSync(file, "utf8");
  let doc;
  try {
    doc = parseChunk(src);
  } catch (e) {
    failures++;
    console.log(bad(`${rel} — REFUSED: ${e.message}`));
    continue;
  }
  const out = serializeChunk(doc);
  const c = census(doc.blocks);
  for (const k of Object.keys(c)) totals[k] = (totals[k] || 0) + c[k];
  if (out === src) {
    const shape = Object.entries(c).filter(([k]) => k !== "blank")
      .map(([k, v]) => `${v} ${k}`).join(", ");
    console.log(ok(`${rel} — byte-identical (${src.length} bytes; ${shape})`));
  } else {
    failures++;
    const at = [...src].findIndex((ch, i) => out[i] !== ch);
    console.log(bad(`${rel} — DIFFERS at byte ${at}`));
    console.log(`      was: ${JSON.stringify(src.slice(Math.max(0, at - 40), at + 40))}`);
    console.log(`      got: ${JSON.stringify(out.slice(Math.max(0, at - 40), at + 40))}`);
  }
}
console.log(`\n  block census: ${Object.entries(totals).map(([k, v]) => `${k}=${v}`).join(" ")}`);

/* ---------------------------------------------------------------- 2. refusal */

const FM = '---\napplies_to: ">=1.0.0 <2.0.0"\ntitle: Fixture\n---\n\n';
const REFUSALS = [
  ["JSX element with children", FM + "<Panel>\n  text inside a module\n</Panel>\n"],
  ["multi-line JSX tag", FM + '<StartingPanelDemo\n  variant="wide"\n/>\n'],
  ["raw HTML block", FM + '<div class="note">raw html</div>\n'],
  ["unterminated admonition", FM + ":::caution\nThe bolt is fully down.\n"],
  ["nested admonition", FM + ":::note\n:::caution\ninner\n:::\n:::\n"],
  ["stray admonition close", FM + "A paragraph.\n\n:::\n"],
  ["unterminated code fence", FM + "```json\n{ }\n"],
  ["no front matter", "Just a body with no front matter.\n"],
  ["unclosed front matter", "---\ntitle: Fixture\n\nbody\n"],
  ["nested front-matter mapping", "---\ntitle: Fixture\nmeta:\n  owner: support\n---\n\nbody\n"],
  ["mixed line endings", FM.replace("---\n\n", "---\r\n\r\n") + "body\n"],
];

console.log("\nRefusal: constructs the model cannot represent must not open in rich text\n");
for (const [name, src] of REFUSALS) {
  try {
    parseChunk(src);
    failures++;
    console.log(bad(`${name} — was accepted, but must be refused`));
  } catch (e) {
    if (e instanceof ChunkParseError) console.log(ok(`${name} — refused: ${e.message}`));
    else { failures++; console.log(bad(`${name} — threw ${e.name}: ${e.message}`)); }
  }
}

/* ------------------------------------------------------- 3. edit stability */

/*
 * Round-tripping an untouched file is necessary but not sufficient: what the editor writes
 * after an edit must itself be valid, stable markdown. Each chunk is mutated the way the
 * editor mutates it — heading text replaced, a line appended to a paragraph, a table row
 * added, an admonition retyped — and the result must re-parse and re-serialise unchanged.
 */
console.log("\nEdit stability: mutate every chunk through the model and re-parse the result\n");

const TYPED = "Typed by an author: 5 * 3, snake_case, [brackets], `ticks`, <angle> and a | pipe.";

function firstOf(blocks, type) {
  for (const b of blocks) {
    if (b.type === type) return b;
    if (b.type === "admonition") { const hit = firstOf(b.blocks, type); if (hit) return hit; }
  }
  return null;
}

for (const file of chunkFiles()) {
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  const doc = parseChunk(fs.readFileSync(file, "utf8"));
  const typed = parseInline(escapeInlineText(TYPED));

  const heading = firstOf(doc.blocks, "heading");
  if (heading) heading.inline = parseInline(escapeInlineText("Edited heading * with _marks_"));
  const para = firstOf(doc.blocks, "paragraph");
  if (para) para.lines = [...para.lines, typed];
  const table = firstOf(doc.blocks, "table");
  if (table) {
    table.rows.push({
      pre: "", post: "", delimiter: false,
      cells: table.rows[0].cells.map(() => ({ lead: " ", inline: typed, trail: " " })),
    });
  }
  const admon = firstOf(doc.blocks, "admonition");
  if (admon) { admon.kind = "danger"; admon.titleRaw = "[Warning]"; admon.openRaw = ":::danger[Warning]"; }
  doc.blocks.push({ type: "blank", lines: [""] }, { type: "paragraph", lines: [typed] }, { type: "blank", lines: [""] });

  const text = serializeChunk(doc);
  const problems = [];
  // 1. everything the editor writes must parse again …
  let again;
  try { again = parseChunk(text); }
  catch (e) { problems.push(`the edited file no longer parses: ${e.message}`); }
  // 2. … and be stable, so a second open/save cycle changes nothing …
  if (again && serializeChunk(again) !== text) problems.push("the edited file is not stable on a second pass");
  // 3. … and text typed by the author must stay text, never turn into markup.
  const typedLine = inlineToMd(typed);
  if (!text.includes(typedLine)) problems.push("the typed line was altered on the way out");
  if (parseInline(typedLine).some(n => n.type !== "text")) problems.push("typed punctuation was reinterpreted as markup");

  if (problems.length) { failures += problems.length; console.log(bad(`${rel} — ${problems.join("; ")}`)); }
  else console.log(ok(`${rel} — edits re-parse, stay stable and keep typed punctuation literal`));
}

/* -------------------------------------------------------------- 4. SSR smoke */

console.log("\nSSR and DOM conversion: render with react-dom/server, then drive the DOM reader\n");
try {
  const { transformSync } = await import("@swc/core");
  const React = (await import("react")).default;
  const { renderToString } = await import("react-dom/server");

  /*
   * Compile the JSX beside its source under a temporary name, so that "react" and the
   * relative import of chunkMarkdown.mjs resolve exactly as they do in the real bundle.
   * The CSS module import is the only thing stubbed out.
   */
  const temps = [];
  const stamp = Date.now();
  const CSS_STUB = "const styles = new Proxy({}, { get: (_, k) => String(k) });";

  async function compile(rel, tmpRel, patch) {
    const abs = path.join(ROOT, rel);
    const tmp = path.join(ROOT, tmpRel);
    let code = transformSync(fs.readFileSync(abs, "utf8"), {
      filename: abs,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, target: "es2020" },
      module: { type: "es6" },
    }).code.replace(/import\s+\w+\s+from\s+"[^"]*\.module\.css";?/g, CSS_STUB);
    if (patch) code = patch(code);
    fs.writeFileSync(tmp, code);
    temps.push(tmp);
    return import(url.pathToFileURL(tmp).href + `?t=${stamp}`);
  }

  let editorModule, adminModule;
  try {
    editorModule = await compile("src/components/ChunkRichEditor.jsx", "src/components/.ChunkRichEditor.ssrcheck.mjs");
    const richUrl = url.pathToFileURL(path.join(ROOT, "src/components/.ChunkRichEditor.ssrcheck.mjs")).href;
    const baked = fs.readFileSync(path.join(ROOT, "docs/admin.json"), "utf8");
    // The admin page is server-rendered by Docusaurus, so the drawer must render without a
    // browser too. Stub only what Docusaurus itself provides, and expose the drawer so it can
    // be rendered on its own.
    // Compiled into src/components/, not src/pages/, so it can never be mistaken for a route.
    adminModule = await compile("src/pages/admin.js", "src/components/.admin.ssrcheck.mjs", code => code
      .replace(/import\s+Layout\s+from\s+"@theme\/Layout";?/, 'const Layout = p => React.createElement("div", null, p.children);')
      .replace(/import\s+Link\s+from\s+"@docusaurus\/Link";?/, 'const Link = p => React.createElement("a", { href: p.to }, p.children);')
      .replace(/import\s+useBaseUrl\s+from\s+"@docusaurus\/useBaseUrl";?/, "const useBaseUrl = s => s;")
      .replace(/import\s+baked\s+from\s+"@site\/docs\/admin\.json";?/, `const baked = ${baked};`)
      .replace(/import\s+ChunkRichEditor\s*,\s*\{([^}]*)\}\s*from\s+"[^"]*";?/,
        (_, named) => `import ChunkRichEditor, {${named}} from ${JSON.stringify(richUrl)};`)
      + "\nexport { Editor as __Editor, Ctx as __Ctx };\n");
  } finally {
    // Removed after the modules are loaded; node has already read them.
    for (const t of temps) if (fs.existsSync(t)) fs.unlinkSync(t);
  }
  const ChunkRichEditor = editorModule.default;

  const sample = fs.readFileSync(path.join(ROOT, "modules/starting-panel/v2.mdx"), "utf8");

  const html = renderToString(React.createElement(ChunkRichEditor, {
    value: sample, onChange: () => {}, path: "modules/starting-panel/v2.mdx",
  }));
  const editables = (html.match(/contenteditable="true"/gi) || []).length;
  const checks = [
    ["front matter fields", /applies_to/.test(html)],
    ["protected JSX block", /StartingPanelDemo/.test(html) && /protected|Protected/.test(html)],
    ["wiki-link chip", /\[\[starting-panel-error-codes\]\]/.test(html)],
    ["table rendered", /<table/.test(html)],
    ["admonition rendered", /danger/.test(html)],
    [`${editables} contenteditable surfaces`, editables > 20],
  ];
  for (const [name, pass] of checks) {
    if (pass) console.log(ok(`rich mode SSR — ${name}`));
    else { failures++; console.log(bad(`rich mode SSR — ${name} missing`)); }
  }

  // A file the model refuses must render the refusal notice instead of any editing surface.
  const refusedHtml = renderToString(React.createElement(ChunkRichEditor, {
    value: FM + "<Panel>\n  hello\n</Panel>\n", onChange: () => {}, path: "modules/x/v1.mdx",
  }));
  if (/cannot be opened|not supported/i.test(refusedHtml) && !/contenteditable/i.test(refusedHtml)) {
    console.log(ok("rich mode SSR — refused file shows the reason and no editing surface"));
  } else {
    failures++;
    console.log(bad("rich mode SSR — refused file did not render a refusal notice"));
  }
  /* ---- the real drawer from src/pages/admin.js, server-rendered ---- */
  const { __Editor: Drawer, __Ctx: Ctx } = adminModule;
  const drawer = (specPath, content) => renderToString(React.createElement(
    Ctx.Provider,
    { value: { refresh: async () => {}, setFlash: () => {}, local: true, data: {}, gh: {} } },
    React.createElement(Drawer, {
      spec: { path: specPath, title: "Harness", mode: "draft", content },
      close: () => {},
    })));

  const chunkDrawer = drawer("modules/starting-panel/v2.mdx", sample);
  const jsonDrawer = drawer("sims/b73m-f2m-04-2026.json", "{}");
  const drawerChecks = [
    ["mode toggle offered for a chunk", /Rich text/.test(chunkDrawer) && /Source/.test(chunkDrawer)],
    ["Source is the default", /<textarea/.test(chunkDrawer) && !/contenteditable/i.test(chunkDrawer)],
    ["no mode toggle for a sim config", !/Rich text/.test(jsonDrawer) && /<textarea/.test(jsonDrawer)],
  ];
  for (const [name, pass] of drawerChecks) {
    if (pass) console.log(ok(`editor drawer SSR — ${name}`));
    else { failures++; console.log(bad(`editor drawer SSR — ${name} failed`)); }
  }

  /*
   * What the browser hands back after an edit. A synthetic DOM stands in for contenteditable,
   * so the reader that turns the edited HTML into model nodes can be checked without a browser.
   */
  const { domToLines } = editorModule;
  const text = data => ({ nodeType: 3, data });
  const el = (tag, children = [], attrs = {}) => ({
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: children,
    dataset: attrs.dataset || {},
    getAttribute: k => (k in attrs ? attrs[k] : null),
    get textContent() { return textOf(children); },
  });
  const textOf = nodes => nodes.map(n => (n.nodeType === 3 ? n.data : textOf(n.childNodes || []))).join("");
  const wiki = id => el("span", [text(`[[${id}]]`)], { dataset: { wiki: id } });
  const md = (children, opts = {}) => domToLines(el("div", children), opts).map(inlineToMd);

  const domCases = [
    ["bold, code and a wiki chip",
      md([text("The bolt is "), el("strong", [text("fully down")]), text(" at "),
        el("code", [text("6/18")]), text(". See "), wiki("emergency-stop"), text(".")]),
      ["The bolt is **fully down** at `6/18`. See [[emergency-stop]]."]],
    ["a soft line break",
      md([text("first"), el("br"), text("second")]),
      ["first", "second"]],
    ["browsers wrapping later lines in divs",
      md([text("first"), el("div", [text("second")])]),
      ["first", "second"]],
    ["typed punctuation is escaped, never markup",
      md([text("5 * 3 and snake_case and [x] and <y>")]),
      ["5 \\* 3 and snake\\_case and \\[x\\] and \\<y\\>"]],
    ["pasted markup contributes only its text",
      md([el("span", [el("font", [text("pasted")])], { dataset: {} })]),
      ["pasted"]],
    ["nested bold is not doubled",
      md([el("strong", [text("a "), el("b", [text("b")])])]),
      ["**a b**"]],
    ["an empty emphasis is dropped",
      md([el("em", []), text("plain")]),
      ["plain"]],
    ["a link keeps its address",
      md([el("a", [text("manual")], { href: "assets/x.pdf" })]),
      ["[manual](assets/x.pdf)"]],
    ["a table cell stays on one line and escapes pipes",
      md([text("a | b"), el("br"), text("c")], { single: true, pipes: true }),
      ["a \\| b c"]],
  ];

  for (const [name, got, want] of domCases) {
    const same = got.length === want.length && got.every((l, i) => l === want[i]);
    if (same) console.log(ok(`DOM reader — ${name}`));
    else { failures++; console.log(bad(`DOM reader — ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)); }
  }
} catch (e) {
  failures++;
  console.log(bad(`SSR harness failed: ${e.stack || e.message}`));
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
