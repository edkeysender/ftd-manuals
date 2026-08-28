/**
 * ChunkRichEditor — the visual (WYSIWYG) editing surface of the admin panel's chunk editor.
 *
 * It is a *structured* editor, not a free-form HTML one. The document is held as the lossless
 * model produced by chunkMarkdown.mjs, and every keystroke is written back into that model, so
 * the markdown source is regenerated rather than converted from HTML. Two consequences matter:
 *
 *   - A block the author never touches is never re-derived from the DOM. Opening a chunk and
 *     saving it without typing therefore returns the file byte for byte (tools/chunk-editor-check.mjs
 *     proves this for every chunk in the repository).
 *   - Anything the model cannot represent — MDX imports, JSX components, fenced code, nested
 *     lists, thematic breaks — is shown as a read-only *protected* block. It can be moved or
 *     deleted, never typed into, and it is written back exactly as it was read.
 *
 * Front matter is never exposed to the visual surface: each key is edited in its own field and
 * an untouched key keeps the exact YAML spelling it had.
 *
 * Files the model refuses (unterminated admonitions, JSX with children, raw HTML, non-flat front
 * matter …) are not opened here at all; the panel keeps the author in Source mode and says why.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChunkParseError, parseChunk, serializeChunk, parseInline, inlineToMd,
  escapeInlineText, escapeLineStart, decodeYamlScalar, encodeYamlScalar, alignmentsOf,
} from "./chunkMarkdown.mjs";
import styles from "./ChunkRichEditor.module.css";

/* ------------------------------------------------------------ model → html */

const escHtml = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * A backslash escape is markup, not text: the author must see the character it produces, not
 * the backslash. escapeInlineText puts the backslash back when the block is written, so an
 * edited "\*" leaves as "\*" again rather than as "\\\*".
 */
const unescapeMd = s => s.replace(/\\([\\`*_{}[\]()#+\-.!<>|~:"'])/g, "$1");

function inlineToHtml(nodes) {
  return nodes.map(n => {
    switch (n.type) {
      case "text": return escHtml(unescapeMd(n.raw));
      case "strong": return `<strong>${inlineToHtml(n.children)}</strong>`;
      case "em": return `<em>${inlineToHtml(n.children)}</em>`;
      case "code": return `<code>${escHtml(n.raw)}</code>`;
      case "link": return `<a href="${escHtml(n.destRaw)}" data-md-link="1">${inlineToHtml(n.label)}</a>`;
      case "image":
        return `<span class="${styles.chip} ${styles.chipImage}" contenteditable="false" `
          + `data-img-alt="${escHtml(n.alt)}" data-img-dest="${escHtml(n.destRaw)}" `
          + `title="image ${escHtml(n.destRaw)}">${escHtml(n.alt || n.destRaw)}</span>`;
      case "wiki":
        return `<span class="${styles.chip} ${styles.chipWiki}" contenteditable="false" `
          + `data-wiki="${escHtml(n.id)}" title="link to component ${escHtml(n.id)}">[[${escHtml(n.id)}]]</span>`;
      default: return "";
    }
  }).join("");
}

const linesToHtml = lines => lines.map(inlineToHtml).join("<br>");

/* ------------------------------------------------------------ html → model */

const BREAK = { type: "__break" };

function domToNodes(el, out, opts, inside) {
  for (const child of el.childNodes) {
    if (child.nodeType === 3) {
      const raw = escapeInlineText(child.data, opts);
      if (raw) out.push({ type: "text", raw });
      continue;
    }
    if (child.nodeType !== 1) continue;
    const tag = child.tagName.toLowerCase();
    const ds = child.dataset || {};

    if (tag === "br") { out.push(BREAK); continue; }
    if (ds.wiki) { out.push({ type: "wiki", id: ds.wiki }); continue; }
    if (ds.imgDest !== undefined) {
      out.push({ type: "image", alt: ds.imgAlt || "", destRaw: ds.imgDest });
      continue;
    }
    if (tag === "code") {
      const raw = child.textContent.replace(/ /g, " ");
      if (raw) out.push({ type: "code", ticks: raw.includes("`") ? "``" : "`", raw });
      continue;
    }
    if ((tag === "strong" || tag === "b") && !inside.strong) {
      const kids = collect(child, opts, { ...inside, strong: true });
      if (kids.length) out.push({ type: "strong", marker: "**", children: kids });
      continue;
    }
    if ((tag === "em" || tag === "i") && !inside.em) {
      const kids = collect(child, opts, { ...inside, em: true });
      if (kids.length) out.push({ type: "em", marker: "*", children: kids });
      continue;
    }
    if (tag === "a" && !inside.link) {
      const kids = collect(child, opts, { ...inside, link: true });
      const dest = child.getAttribute("href") || "";
      if (kids.length && dest && !/\s/.test(dest)) out.push({ type: "link", label: kids, destRaw: dest });
      else out.push(...kids);
      continue;
    }
    if (tag === "div" || tag === "p" || tag === "li") { out.push(BREAK); domToNodes(child, out, opts, inside); continue; }
    // Anything else (a pasted table, a span with styles, an unknown element) contributes only
    // its text. Nothing unrecognised is ever written into the document.
    domToNodes(child, out, opts, inside);
  }
  return out;
}

/** Inline children of a wrapper: breaks become spaces, since markers cannot span lines. */
function collect(el, opts, inside) {
  const raw = domToNodes(el, [], opts, inside);
  const out = [];
  for (const n of raw) {
    if (n === BREAK) { out.push({ type: "text", raw: " " }); continue; }
    out.push(n);
  }
  // A marker may not sit against a space; trim the edges into plain text instead.
  while (out.length && out[0].type === "text" && !out[0].raw.trim()) out.shift();
  while (out.length && out[out.length - 1].type === "text" && !out[out.length - 1].raw.trim()) out.pop();
  return out;
}

/** Exported for tools/chunk-editor-check.mjs, which drives it with a synthetic DOM. */
export function domToLines(el, opts) {
  const flat = domToNodes(el, [], opts, {});
  const lines = [[]];
  for (const n of flat) {
    if (n === BREAK) lines.push([]);
    else lines[lines.length - 1].push(n);
  }
  while (lines.length > 1 && lines[0].length === 0) lines.shift();
  if (opts.single) {
    const merged = [];
    for (const l of lines) { if (merged.length && l.length) merged.push({ type: "text", raw: " " }); merged.push(...l); }
    return [merged];
  }
  return lines;
}

/** Protect the start of an authored line so it cannot silently become a heading or a list. */
function guardLineStarts(lines) {
  return lines.map(nodes => {
    const md = inlineToMd(nodes);
    const safe = escapeLineStart(md);
    return safe === md ? nodes : parseInline(safe);
  });
}

/* --------------------------------------------------------------- block tree */

const isBlank = b => b.type === "blank";
const BLANK = () => ({ type: "blank", lines: [""] });

/** Apply fn to the block list addressed by parentPath ([] = top level, [i] = inside block i). */
function mapList(blocks, parentPath, fn) {
  if (parentPath.length === 0) return fn(blocks);
  const [i, ...rest] = parentPath;
  const copy = blocks.slice();
  copy[i] = { ...copy[i], blocks: mapList(copy[i].blocks, rest, fn) };
  return copy;
}

function insertAfter(list, index, block) {
  const out = list.slice();
  out.splice(index + 1, 0, BLANK(), block);
  return out;
}

function appendBlock(list, block) {
  let last = list.length - 1;
  while (last >= 0 && isBlank(list[last])) last--;
  if (last < 0) return [...list, BLANK(), block, BLANK()];
  return insertAfter(list, last, block);
}

function removeAt(list, index) {
  const out = list.slice();
  out.splice(index, 1);
  if (out[index] && isBlank(out[index]) && out[index - 1] && isBlank(out[index - 1])) out.splice(index, 1);
  return out;
}

function moveAt(list, index, dir) {
  const out = list.slice();
  let j = index + dir;
  while (j >= 0 && j < out.length && isBlank(out[j])) j += dir;
  if (j < 0 || j >= out.length) return list;
  const tmp = out[index];
  out[index] = out[j];
  out[j] = tmp;
  return out;
}

/* ------------------------------------------------------------- new blocks */

const NEW = {
  paragraph: () => ({ type: "paragraph", lines: [parseInline("New paragraph.")] }),
  heading: () => ({ type: "heading", hashes: "##", gap: " ", inline: parseInline("New section") }),
  bullets: () => ({ type: "list", ordered: false, items: [item("-", "New item.")] }),
  numbers: () => ({ type: "list", ordered: true, items: [item("1.", "First action.")] }),
  table: () => ({
    type: "table",
    rows: [
      row([" Column ", " Column "]),
      row([" --- ", " --- "], true),
      row(["  ", "  "]),
    ],
  }),
  note: () => admon("note"),
  caution: () => admon("caution"),
  danger: () => admon("danger"),
};

const item = (marker, text) => ({ indent: "", marker, gap: " ", lines: [{ indent: null, inline: parseInline(text) }] });
const row = (parts, delimiter = false) => ({
  pre: "", post: "", delimiter,
  cells: parts.map(p => {
    const m = /^([ \t]*)([\s\S]*?)([ \t]*)$/.exec(p);
    return { lead: m[1], inline: parseInline(m[2]), trail: m[3] };
  }),
});
const admon = kind => ({
  type: "admonition", kind, titleRaw: "", openRaw: `:::${kind}`, closeRaw: ":::",
  blocks: [{ type: "paragraph", lines: [parseInline("New text.")] }],
});

/* ----------------------------------------------------------- inline editing */

function InlineEditable({ lines, onCommit, single, pipes, className, register }) {
  const ref = useRef(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const [frozen, setFrozen] = useState(false);
  const frozenHtml = useRef("");

  const live = linesToHtml(lines);
  if (!frozen) frozenHtml.current = live;
  const html = frozen ? frozenHtml.current : live;

  const commit = useCallback(() => {
    if (!ref.current) return;
    commitRef.current(domToLines(ref.current, { pipes, single }));
  }, [pipes, single]);

  return (
    <div
      ref={ref}
      className={[styles.editable, className].filter(Boolean).join(" ")}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onFocus={() => { setFrozen(true); if (register) register(commit); }}
      onInput={commit}
      onBlur={() => { commit(); setFrozen(false); }}
      onKeyDown={e => { if (single && e.key === "Enter") e.preventDefault(); }}
      onPaste={e => {
        // Never let foreign HTML into the document: paste is always plain text.
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData("text/plain");
        document.execCommand("insertText", false, single ? text.replace(/\s*\n\s*/g, " ") : text);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/* -------------------------------------------------------------- block views */

function Shell({ label, tone, path, api, children, controls }) {
  return (
    <div className={[styles.block, tone && styles[tone]].filter(Boolean).join(" ")}>
      <div className={styles.gutter}>
        <span className={styles.kind}>{label}</span>
        <span className={styles.gutterSpacer} />
        {controls}
        <button type="button" className={styles.iconBtn} title="Move up" onClick={() => api.move(path, -1)}>↑</button>
        <button type="button" className={styles.iconBtn} title="Move down" onClick={() => api.move(path, 1)}>↓</button>
        <button type="button" className={styles.iconBtn} title="Insert a paragraph below" onClick={() => api.insertAfter(path, NEW.paragraph())}>+</button>
        <button type="button" className={`${styles.iconBtn} ${styles.iconDanger}`} title="Delete this block" onClick={() => api.remove(path)}>✕</button>
      </div>
      <div className={styles.body}>{children}</div>
    </div>
  );
}

function HeadingBlock({ block, path, api }) {
  const level = block.hashes.length;
  return (
    <Shell
      label={`heading ${level}`}
      path={path}
      api={api}
      controls={
        <select
          className={styles.mini}
          value={level}
          title="Heading level"
          onChange={e => api.set(path, { ...block, hashes: "#".repeat(Number(e.target.value)) })}
        >
          {[1, 2, 3, 4, 5, 6].map(n => <option key={n} value={n}>H{n}</option>)}
        </select>
      }
    >
      <InlineEditable
        single
        register={api.register}
        className={styles[`h${Math.min(level, 4)}`]}
        lines={[block.inline]}
        onCommit={ls => api.set(path, { ...block, inline: ls[0] })}
      />
    </Shell>
  );
}

const TODO_RE = /TODO\(/;

function ParagraphBlock({ block, path, api }) {
  const todo = block.lines.some(l => TODO_RE.test(inlineToMd(l)));
  return (
    <Shell label={todo ? "todo" : "text"} tone={todo ? "todoTone" : null} path={path} api={api}>
      <InlineEditable
        register={api.register}
        lines={block.lines}
        onCommit={ls => api.set(path, { ...block, lines: guardLineStarts(ls) })}
      />
    </Shell>
  );
}

function ListBlock({ block, path, api }) {
  const Tag = block.ordered ? "ol" : "ul";
  const setItems = items => api.set(path, { ...block, items: renumber({ ...block, items }) });
  return (
    <Shell
      label={block.ordered ? "numbered list" : "bullet list"}
      path={path}
      api={api}
      controls={
        <>
          <button
            type="button"
            className={styles.iconBtn}
            title={block.ordered ? "Change to a bullet list" : "Change to a numbered list"}
            onClick={() => api.set(path, retype(block, !block.ordered))}
          >{block.ordered ? "1." : "•"}</button>
          <button
            type="button"
            className={styles.iconBtn}
            title="Add an item"
            onClick={() => setItems([...block.items, item(block.ordered ? "1." : "-", "New item.")])}
          >+row</button>
        </>
      }
    >
      <Tag className={styles.list}>
        {block.items.map((it, k) => (
          <li key={k}>
            <InlineEditable
              register={api.register}
              lines={it.lines.map(l => l.inline)}
              onCommit={ls => {
                const indent = (it.lines[1] && it.lines[1].indent) || " ".repeat(it.marker.length + it.gap.length);
                const next = block.items.slice();
                next[k] = { ...it, lines: guardLineStarts(ls).map((inline, n) => ({ indent: n === 0 ? null : indent, inline })) };
                setItems(next);
              }}
            />
            <button
              type="button"
              className={`${styles.iconBtn} ${styles.iconDanger} ${styles.itemBtn}`}
              title="Delete this item"
              onClick={() => setItems(block.items.filter((_, n) => n !== k))}
            >✕</button>
          </li>
        ))}
      </Tag>
    </Shell>
  );
}

function renumber(block) {
  if (!block.ordered) return block.items;
  return block.items.map((it, k) => {
    const suffix = /[.)]$/.test(it.marker) ? it.marker.slice(-1) : ".";
    return { ...it, marker: `${k + 1}${suffix}` };
  });
}

function retype(block, ordered) {
  const items = block.items.map((it, k) => ({ ...it, marker: ordered ? `${k + 1}.` : "-" }));
  return { ...block, ordered, items };
}

function TableBlock({ block, path, api }) {
  const aligns = alignmentsOf(block);
  const bodyRows = block.rows.filter(r => !r.delimiter);
  const delimIndex = block.rows.findIndex(r => r.delimiter);
  const width = Math.max(...block.rows.map(r => r.cells.length));

  const setCell = (rowIndex, cellIndex, inline) => {
    const rows = block.rows.slice();
    const cells = rows[rowIndex].cells.slice();
    cells[cellIndex] = { ...cells[cellIndex], inline };
    rows[rowIndex] = { ...rows[rowIndex], cells };
    api.set(path, { ...block, rows });
  };

  const addRow = () => {
    const rows = block.rows.slice();
    rows.push(row(new Array(width).fill("  ")));
    api.set(path, { ...block, rows });
  };
  const addColumn = () => {
    const rows = block.rows.map(r => ({
      ...r,
      cells: [...r.cells, r.delimiter ? row([" --- "], true).cells[0] : row(["  "]).cells[0]],
    }));
    api.set(path, { ...block, rows });
  };
  const dropRow = index => api.set(path, { ...block, rows: block.rows.filter((_, k) => k !== index) });
  const dropColumn = index => api.set(path, {
    ...block,
    rows: block.rows.map(r => ({ ...r, cells: r.cells.filter((_, k) => k !== index) })),
  });

  return (
    <Shell
      label="table"
      path={path}
      api={api}
      controls={
        <>
          <button type="button" className={styles.iconBtn} title="Add a row" onClick={addRow}>+row</button>
          <button type="button" className={styles.iconBtn} title="Add a column" onClick={addColumn}>+col</button>
        </>
      }
    >
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              {block.rows[0].cells.map((cell, c) => (
                <th key={c} style={{ textAlign: aligns[c] || "left" }}>
                  <InlineEditable
                    single pipes
                    register={api.register}
                    lines={[cell.inline]}
                    onCommit={ls => setCell(0, c, ls[0])}
                  />
                  <button type="button" className={`${styles.iconBtn} ${styles.iconDanger} ${styles.colBtn}`}
                    title="Delete this column" onClick={() => dropColumn(c)}>✕</button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bodyRows.slice(1).map((r, k) => {
              const rowIndex = block.rows.indexOf(r);
              return (
                <tr key={rowIndex}>
                  {r.cells.map((cell, c) => (
                    <td key={c} style={{ textAlign: aligns[c] || "left" }}>
                      <InlineEditable
                        single pipes
                        register={api.register}
                        lines={[cell.inline]}
                        onCommit={ls => setCell(rowIndex, c, ls[0])}
                      />
                    </td>
                  ))}
                  <td className={styles.rowTool}>
                    <button type="button" className={`${styles.iconBtn} ${styles.iconDanger}`}
                      title="Delete this row" onClick={() => dropRow(rowIndex)}>✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {delimIndex !== 1 && <p className={styles.warn}>Unusual table layout — the alignment row is not the second line.</p>}
    </Shell>
  );
}

const ADMON_KINDS = ["note", "tip", "info", "caution", "danger"];

function AdmonitionBlock({ block, path, api }) {
  const title = block.titleRaw.replace(/^\[|\]$/g, "");
  const rebuild = (kind, titleText) => {
    const titleRaw = titleText ? `[${titleText}]` : "";
    return { ...block, kind, titleRaw, openRaw: `:::${kind}${titleRaw}` };
  };
  return (
    <Shell
      label="admonition"
      tone={block.kind === "danger" || block.kind === "caution" ? "dangerTone" : "noteTone"}
      path={path}
      api={api}
      controls={
        <>
          <select className={styles.mini} value={block.kind} title="Admonition type"
            onChange={e => api.set(path, rebuild(e.target.value, title))}>
            {ADMON_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
            {!ADMON_KINDS.includes(block.kind) && <option value={block.kind}>{block.kind}</option>}
          </select>
          <input className={styles.mini} value={title} placeholder="title (optional)" title="Admonition title"
            onChange={e => api.set(path, rebuild(block.kind, e.target.value))} />
        </>
      }
    >
      <div className={styles.admonBody}>
        <BlockList blocks={block.blocks} path={path} api={api} />
        <div className={styles.insertRow}>
          <button type="button" className={styles.addBtn}
            onClick={() => api.appendInside(path, NEW.paragraph())}>+ paragraph</button>
          <button type="button" className={styles.addBtn}
            onClick={() => api.appendInside(path, NEW.numbers())}>+ numbered list</button>
        </div>
      </div>
    </Shell>
  );
}

function ProtectedBlock({ block, path, api }) {
  return (
    <Shell label="protected" tone="protectedTone" path={path} api={api}>
      <div className={styles.protectedNote}>
        {block.reason} — read only, written back exactly as it was read.
      </div>
      <pre className={styles.protectedPre}>{block.lines.join("\n")}</pre>
    </Shell>
  );
}

function BlockList({ blocks, path, api }) {
  return blocks.map((b, i) => {
    const p = [...path, i];
    if (b.type === "blank") return null;
    if (b.type === "heading") return <HeadingBlock key={i} block={b} path={p} api={api} />;
    if (b.type === "paragraph") return <ParagraphBlock key={i} block={b} path={p} api={api} />;
    if (b.type === "list") return <ListBlock key={i} block={b} path={p} api={api} />;
    if (b.type === "table") return <TableBlock key={i} block={b} path={p} api={api} />;
    if (b.type === "admonition") return <AdmonitionBlock key={i} block={b} path={p} api={api} />;
    return <ProtectedBlock key={i} block={b} path={p} api={api} />;
  });
}

/* ------------------------------------------------------------------ toolbar */

function Toolbar({ activeCommit }) {
  const exec = (cmd, arg) => {
    if (typeof document === "undefined") return;
    try { document.execCommand("styleWithCSS", false, false); } catch { /* not supported everywhere */ }
    document.execCommand(cmd, false, arg);
    if (activeCommit.current) activeCommit.current();
  };
  const insertHtml = html => exec("insertHTML", html);
  const hold = e => e.preventDefault();   // keep the selection in the editable

  const wrapCode = () => {
    const sel = typeof window !== "undefined" && window.getSelection ? String(window.getSelection()) : "";
    if (!sel) return;
    insertHtml(`<code>${escHtml(sel)}</code>`);
  };
  const addLink = () => {
    const url = window.prompt("Link address (a URL, or assets/… for a file beside the chunk)", "https://");
    if (url) exec("createLink", url);
  };
  const addWiki = () => {
    const id = window.prompt("Component id to link to (lower-case kebab-case, e.g. starting-panel)", "");
    if (!id) return;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id.trim())) {
      window.alert("Component ids are English kebab-case, e.g. starting-panel.");
      return;
    }
    insertHtml(`<span class="${styles.chip} ${styles.chipWiki}" contenteditable="false" data-wiki="${escHtml(id.trim())}">[[${escHtml(id.trim())}]]</span>&nbsp;`);
  };

  return (
    <div className={styles.toolbar} onMouseDown={hold}>
      <button type="button" className={styles.toolBtn} title="Bold" onClick={() => exec("bold")}><b>B</b></button>
      <button type="button" className={styles.toolBtn} title="Italic" onClick={() => exec("italic")}><i>I</i></button>
      <button type="button" className={styles.toolBtn} title="Code" onClick={wrapCode}><code>{"</>"}</code></button>
      <button type="button" className={styles.toolBtn} title="Link" onClick={addLink}>Link</button>
      <button type="button" className={styles.toolBtn} title="Link to another component" onClick={addWiki}>[[ ]]</button>
      <button type="button" className={styles.toolBtn} title="Remove formatting" onClick={() => exec("removeFormat")}>Clear</button>
      <span className={styles.toolHint}>
        Select text, then apply. Use <code>[[ ]]</code> for a component link — typed brackets stay
        literal text. Paste is always plain text.
      </span>
    </div>
  );
}

/* -------------------------------------------------------------- front matter */

const FIELD_HINT = {
  applies_to: "Semver range of the software versions this chunk describes, e.g. \">=2.0.0 <3.0.0\".",
  title: "Heading of the section in the manual.",
  summary: "One sentence describing what the component does.",
};

function FrontMatter({ fields, onField }) {
  return (
    <div className={styles.front}>
      <div className={styles.frontHead}>
        Front matter — edited only through these fields. A field left alone keeps its exact YAML spelling.
      </div>
      <div className={styles.frontGrid}>
        {fields.map((f, i) => (
          <label key={f.key} className={styles.frontField}>
            <span>{f.key}</span>
            <input
              className={styles.input}
              value={decodeYamlScalar(f.raw)}
              title={FIELD_HINT[f.key] || ""}
              onChange={e => onField(i, e.target.value)}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- editor */

/** Can this source be opened visually? Used by the panel before it offers the mode. */
export function inspectChunk(src) {
  try {
    parseChunk(src);
    return { ok: true };
  } catch (e) {
    if (e instanceof ChunkParseError) return { ok: false, reason: e.message };
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

export default function ChunkRichEditor({ value, onChange, path }) {
  const initial = useMemo(() => inspect(value), []);       // eslint-disable-line react-hooks/exhaustive-deps
  const [state, setState] = useState(initial);
  const emitted = useRef(value);
  const docRef = useRef(state.doc);
  docRef.current = state.doc;
  const activeCommit = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (value === emitted.current) return;              // our own edit coming back down
    emitted.current = value;
    setState(inspect(value));
  }, [value]);

  const apply = useCallback(next => {
    const text = serializeChunk(next);
    emitted.current = text;
    docRef.current = next;
    setState({ doc: next, error: null });
    onChangeRef.current(text);
  }, []);

  const api = useMemo(() => {
    const edit = (parentPath, fn) => apply({ ...docRef.current, blocks: mapList(docRef.current.blocks, parentPath, fn) });
    return {
      register: commit => { activeCommit.current = commit; },
      set: (p, block) => edit(p.slice(0, -1), list => { const o = list.slice(); o[p[p.length - 1]] = block; return o; }),
      remove: p => edit(p.slice(0, -1), list => removeAt(list, p[p.length - 1])),
      move: (p, dir) => edit(p.slice(0, -1), list => moveAt(list, p[p.length - 1], dir)),
      insertAfter: (p, block) => edit(p.slice(0, -1), list => insertAfter(list, p[p.length - 1], block)),
      appendInside: (p, block) => edit(p, list => appendBlock(list, block)),
      append: block => edit([], list => appendBlock(list, block)),
    };
  }, [apply]);

  const setField = (i, text) => {
    const fields = state.doc.frontMatter.fields.slice();
    fields[i] = { ...fields[i], raw: encodeYamlScalar(text) };
    apply({ ...state.doc, frontMatter: { ...state.doc.frontMatter, fields } });
  };

  if (state.error) {
    return (
      <div className={styles.refusal}>
        <strong>This file cannot be opened in rich text.</strong>
        <div>{state.error}</div>
        <div className={styles.refusalHint}>
          Nothing has been changed. Edit it in Source mode, where the file is handled as plain text.
        </div>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <Toolbar activeCommit={activeCommit} />
      <div className={styles.scroll}>
        <FrontMatter fields={state.doc.frontMatter.fields} onField={setField} />
        <BlockList blocks={state.doc.blocks} path={[]} api={api} />
        <div className={styles.insertRow}>
          <span className={styles.dim}>Add:</span>
          <button type="button" className={styles.addBtn} onClick={() => api.append(NEW.paragraph())}>paragraph</button>
          <button type="button" className={styles.addBtn} onClick={() => api.append(NEW.heading())}>heading</button>
          <button type="button" className={styles.addBtn} onClick={() => api.append(NEW.numbers())}>numbered list</button>
          <button type="button" className={styles.addBtn} onClick={() => api.append(NEW.bullets())}>bullet list</button>
          <button type="button" className={styles.addBtn} onClick={() => api.append(NEW.table())}>table</button>
          <button type="button" className={styles.addBtn} onClick={() => api.append(NEW.note())}>note</button>
          <button type="button" className={styles.addBtn} onClick={() => api.append(NEW.caution())}>caution</button>
          <button type="button" className={styles.addBtn} onClick={() => api.append(NEW.danger())}>danger</button>
        </div>
        <p className={styles.footNote}>
          {path && /\.mdx$/.test(path)
            ? "MDX chunk: imports and JSX components are protected blocks and are written back unchanged."
            : "Markdown chunk."}
        </p>
      </div>
    </div>
  );
}

function inspect(src) {
  try {
    return { doc: parseChunk(src), error: null };
  } catch (e) {
    return { doc: null, error: (e && e.message) || String(e) };
  }
}
