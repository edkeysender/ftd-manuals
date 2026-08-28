/**
 * chunkMarkdown — a deliberately small, lossless model of the markdown dialect used by the
 * chunks in modules/ and shared/.
 *
 * It exists for one reason: the admin panel offers a rich-text (WYSIWYG) editing mode, and a
 * controlled aviation document must never be silently rewritten by opening it in that mode.
 * A general markdown AST (mdast/remark) cannot give that guarantee — it normalises emphasis
 * markers, table padding, line wrapping and escapes, and it has no idea what `[[link]]`,
 * `:::caution` or a bare JSX tag are.
 *
 * The design is therefore:
 *
 *   1. Every node stores the *exact source spelling* it was parsed from (the emphasis marker
 *      actually used, the number of backticks, the padding inside a table cell, the YAML
 *      value as written). Serialising an untouched node reproduces its source byte for byte.
 *   2. Every block verifies itself at parse time: if `blockToLines(block)` does not equal the
 *      lines it came from, the block is demoted to a *protected* block that holds the raw
 *      lines and is read-only in the editor. Nothing is ever guessed at.
 *   3. The whole document is verified once more at the end. If it does not reproduce the
 *      input byte for byte, parseChunk throws and the rich-text mode refuses to open the
 *      file, leaving the author in Source mode.
 *
 * Anything the model cannot delimit safely (unterminated admonition or code fence, JSX with
 * children, raw HTML, front matter that is not a flat key: value mapping) is refused rather
 * than protected, because protecting it would require guessing where the construct ends.
 *
 * The module is plain ESM with no dependencies so it can be used both by the browser bundle
 * (src/components/ChunkRichEditor.jsx) and by node (tools/chunk-editor-check.mjs).
 */

/** Thrown when a file cannot be represented safely. The rich-text mode must then refuse. */
export class ChunkParseError extends Error {
  constructor(message, line) {
    super(message);
    this.name = "ChunkParseError";
    this.line = line || null;
  }
}

/* ------------------------------------------------------------------ line ends */

function detectEol(src) {
  const crlf = (src.match(/\r\n/g) || []).length;
  const lf = (src.match(/\n/g) || []).length;
  const cr = (src.match(/\r/g) || []).length;
  if (crlf === 0) {
    if (cr > 0) throw new ChunkParseError("the file uses bare CR line endings");
    return "\n";
  }
  if (crlf !== lf || crlf !== cr) throw new ChunkParseError("the file mixes CRLF and LF line endings");
  return "\r\n";
}

/* ---------------------------------------------------------------- inline model */

/*
 * Inline nodes:
 *   { type: "text",   raw }                        literal source, never reinterpreted
 *   { type: "strong", marker, children }
 *   { type: "em",     marker, children }
 *   { type: "code",   ticks, raw }
 *   { type: "link",   label: [...], destRaw }
 *   { type: "image",  alt, destRaw }               atomic in the editor
 *   { type: "wiki",   id }                         [[module-id]] — atomic in the editor
 */

const ESCAPABLE = "\\`*_{}[]()#+-.!<>|~:\"'";

export function inlineToMd(nodes) {
  let out = "";
  for (const n of nodes) {
    switch (n.type) {
      case "text": out += n.raw; break;
      case "strong":
      case "em": out += n.marker + inlineToMd(n.children) + n.marker; break;
      case "code": out += n.ticks + n.raw + n.ticks; break;
      case "link": out += "[" + inlineToMd(n.label) + "](" + n.destRaw + ")"; break;
      case "image": out += "![" + n.alt + "](" + n.destRaw + ")"; break;
      case "wiki": out += "[[" + n.id + "]]"; break;
      default: throw new ChunkParseError(`unknown inline node "${n.type}"`);
    }
  }
  return out;
}

function matchWiki(s, i) {
  const m = /^\[\[([A-Za-z0-9][A-Za-z0-9._/-]*)\]\]/.exec(s.slice(i));
  return m ? { node: { type: "wiki", id: m[1] }, end: i + m[0].length } : null;
}

function matchImage(s, i) {
  const m = /^!\[([^\]]*)\]\(([^()\s]*(?:\s+"[^"]*")?)\)/.exec(s.slice(i));
  return m ? { node: { type: "image", alt: m[1], destRaw: m[2] }, end: i + m[0].length } : null;
}

function matchLink(s, i) {
  const m = /^\[([^\]\[]+)\]\(([^()\s]*(?:\s+"[^"]*")?)\)/.exec(s.slice(i));
  if (!m) return null;
  return { node: { type: "link", label: parseInline(m[1]), destRaw: m[2] }, end: i + m[0].length };
}

function matchCode(s, i) {
  let n = 0;
  while (s[i + n] === "`") n++;
  const fence = "`".repeat(n);
  // The closing run must be exactly n backticks long.
  let j = i + n;
  while (j < s.length) {
    if (s[j] === "`") {
      let k = 0;
      while (s[j + k] === "`") k++;
      if (k === n) {
        const raw = s.slice(i + n, j);
        if (raw.length === 0) return null;
        return { node: { type: "code", ticks: fence, raw }, end: j + n };
      }
      j += k;
    } else j++;
  }
  return null;
}

function emphasisInner(s, open, close) {
  if (s.length === 0) return false;
  if (/^\s|\s$/.test(s)) return false;
  if (s.includes(open) || s.includes(close)) return false;
  return true;
}

function matchStar(s, i) {
  if (s.startsWith("**", i)) {
    const j = s.indexOf("**", i + 2);
    if (j > i + 2) {
      const inner = s.slice(i + 2, j);
      if (emphasisInner(inner, "**", "**") && !inner.includes("*")) {
        return { node: { type: "strong", marker: "**", children: parseInline(inner) }, end: j + 2 };
      }
    }
    return null;
  }
  const j = s.indexOf("*", i + 1);
  if (j > i + 1) {
    const inner = s.slice(i + 1, j);
    if (emphasisInner(inner, "*", "*")) {
      return { node: { type: "em", marker: "*", children: parseInline(inner) }, end: j + 1 };
    }
  }
  return null;
}

const WORDY = /[A-Za-z0-9]/;

function matchUnderscore(s, i) {
  // Underscore emphasis only when it clearly stands outside a word, so identifiers such as
  // applies_to or jira_component are never mistaken for emphasis. Ambiguous cases stay text.
  if (i > 0 && WORDY.test(s[i - 1])) return null;
  const double = s.startsWith("__", i);
  const marker = double ? "__" : "_";
  const j = s.indexOf(marker, i + marker.length);
  if (j <= i + marker.length) return null;
  const after = s[j + marker.length];
  if (after !== undefined && WORDY.test(after)) return null;
  const inner = s.slice(i + marker.length, j);
  if (!emphasisInner(inner, "_", "_")) return null;
  return {
    node: { type: double ? "strong" : "em", marker, children: parseInline(inner) },
    end: j + marker.length,
  };
}

/**
 * Scan one line of inline content. Everything the scanner does not positively recognise is
 * kept as literal text, so `inlineToMd(parseInline(s)) === s` holds by construction.
 */
export function parseInline(s) {
  const out = [];
  let text = "";
  let i = 0;
  const flush = () => { if (text) { out.push({ type: "text", raw: text }); text = ""; } };

  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length && ESCAPABLE.includes(s[i + 1])) {
      text += s[i] + s[i + 1];
      i += 2;
      continue;
    }
    let m = null;
    if (c === "[" && s[i + 1] === "[") m = matchWiki(s, i);
    if (!m && c === "!" && s[i + 1] === "[") m = matchImage(s, i);
    if (!m && c === "[") m = matchLink(s, i);
    if (!m && c === "`") m = matchCode(s, i);
    if (!m && c === "*") m = matchStar(s, i);
    if (!m && c === "_") m = matchUnderscore(s, i);
    if (m) { flush(); out.push(m.node); i = m.end; }
    else { text += c; i++; }
  }
  flush();
  return out;
}

/** Escape text typed by an author so it cannot turn into markup when serialised. */
export function escapeInlineText(s, { pipes = false } = {}) {
  let out = s.replace(/\u00a0/g, " ").replace(/[\\`*_[\]<>]/g, m => "\\" + m);
  if (pipes) out = out.replace(/\|/g, "\\|");
  return out;
}

/** Escape the start of an authored line so it cannot become a heading, list item or fence. */
export function escapeLineStart(s) {
  return s
    .replace(/^(\s*)(#{1,6}\s)/, "$1\\$2")
    .replace(/^(\s*)([-+]\s)/, "$1\\$2")
    .replace(/^(\s*)(\d{1,9})([.)]\s)/, "$1$2\\$3")
    .replace(/^(\s*)(>)/, "$1\\$2")
    .replace(/^(\s*)(:::)/, "$1\\:::")
    .replace(/^(\s*)(\|)/, "$1\\|");
}

/* ----------------------------------------------------------------- block model */

const RE_HEADING = /^(#{1,6})([ \t]+)(.*)$/;
const RE_LIST = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/;
const RE_ADMON_OPEN = /^:::([A-Za-z][A-Za-z0-9-]*)(\[[^\]]*\])?[ \t]*$/;
const RE_ADMON_CLOSE = /^:::[ \t]*$/;
const RE_FENCE = /^[ \t]*(```+|~~~+)/;
const RE_ESM = /^(import|export)[\s{]/;
const RE_JSX_SELF = /^<([A-Za-z][A-Za-z0-9._]*)((?:\s[^<>]*)?)\/>[ \t]*$/;
const RE_HR = /^[ \t]*((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/;

const isBlank = l => /^[ \t]*$/.test(l);

/** Split a table row on unescaped pipes; returns null when the line is not a row. */
function splitRow(line) {
  const bars = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") { i++; continue; }
    if (line[i] === "|") bars.push(i);
  }
  if (bars.length < 2) return null;
  const parts = [];
  for (let k = 0; k < bars.length - 1; k++) parts.push(line.slice(bars[k] + 1, bars[k + 1]));
  return { pre: line.slice(0, bars[0]), parts, post: line.slice(bars[bars.length - 1] + 1) };
}

const RE_DELIM_CELL = /^[ \t]*:?-+:?[ \t]*$/;

function isDelimiterRow(line) {
  const r = splitRow(line);
  return !!r && r.parts.length > 0 && r.parts.every(p => RE_DELIM_CELL.test(p));
}

function cellOf(part) {
  const m = /^([ \t]*)([\s\S]*?)([ \t]*)$/.exec(part);
  return { lead: m[1], inline: parseInline(m[2]), trail: m[3] };
}

export function cellText(cell) {
  return inlineToMd(cell.inline);
}

function rowOf(line, delimiter) {
  const r = splitRow(line);
  return { pre: r.pre, post: r.post, delimiter, cells: r.parts.map(cellOf) };
}

function rowToLine(row) {
  return row.pre + "|" + row.cells.map(c => c.lead + inlineToMd(c.inline) + c.trail).join("|") + "|" + row.post;
}

export function alignmentsOf(table) {
  const d = table.rows.find(r => r.delimiter);
  if (!d) return [];
  return d.cells.map(c => {
    const t = inlineToMd(c.inline).trim();
    if (t.startsWith(":") && t.endsWith(":")) return "center";
    if (t.endsWith(":")) return "right";
    if (t.startsWith(":")) return "left";
    return null;
  });
}

/** Render one block back to its source lines. */
export function blockToLines(b) {
  switch (b.type) {
    case "blank":
    case "protected":
      return b.lines.slice();
    case "heading":
      return [b.hashes + b.gap + inlineToMd(b.inline)];
    case "paragraph":
      return b.lines.map(inlineToMd);
    case "list": {
      const out = [];
      for (const it of b.items) {
        it.lines.forEach((ln, k) => {
          out.push(k === 0
            ? it.indent + it.marker + it.gap + inlineToMd(ln.inline)
            : ln.indent + inlineToMd(ln.inline));
        });
      }
      return out;
    }
    case "table":
      return b.rows.map(rowToLine);
    case "admonition":
      return [b.openRaw, ...blocksToLines(b.blocks), b.closeRaw];
    default:
      throw new ChunkParseError(`unknown block type "${b.type}"`);
  }
}

export function blocksToLines(blocks) {
  const out = [];
  for (const b of blocks) out.push(...blockToLines(b));
  return out;
}

/** True when the line would start a new block, so a paragraph must stop before it. */
function breaksParagraph(line) {
  return isBlank(line)
    || RE_HEADING.test(line)
    || RE_LIST.test(line)
    || RE_ADMON_OPEN.test(line)
    || RE_ADMON_CLOSE.test(line)
    || RE_FENCE.test(line)
    || RE_HR.test(line);
}

function protectedBlock(lines, reason) {
  return { type: "protected", lines: lines.slice(), reason };
}

/**
 * Parse a run of body lines into blocks. `base` is the 1-based line number of lines[0] in the
 * whole file, used for the messages shown when the editor refuses a file.
 */
function parseBlocks(lines, base, depth) {
  const blocks = [];
  const at = i => base + i;
  let i = 0;

  const push = (block, from, to, reason) => {
    const src = lines.slice(from, to);
    let ok = false;
    try {
      const out = blockToLines(block);
      ok = out.length === src.length && out.every((l, k) => l === src[k]);
    } catch { ok = false; }
    blocks.push(ok ? block : protectedBlock(src, reason || "this block is kept verbatim because it cannot be modelled exactly"));
  };

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      const start = i;
      while (i < lines.length && isBlank(lines[i])) i++;
      blocks.push({ type: "blank", lines: lines.slice(start, i) });
      continue;
    }

    // ---- admonition -------------------------------------------------------
    const admon = RE_ADMON_OPEN.exec(line);
    if (admon && !RE_ADMON_CLOSE.test(line)) {
      if (depth > 0) {
        throw new ChunkParseError(`line ${at(i)}: nested ":::" admonitions are not supported`, at(i));
      }
      let j = i + 1;
      let close = -1;
      while (j < lines.length) {
        if (RE_ADMON_CLOSE.test(lines[j])) { close = j; break; }
        if (RE_ADMON_OPEN.test(lines[j])) {
          throw new ChunkParseError(`line ${at(j)}: a second ":::" block opens before "${admon[1]}" is closed`, at(j));
        }
        j++;
      }
      if (close === -1) {
        throw new ChunkParseError(`line ${at(i)}: ":::${admon[1]}" is never closed by a ":::" line`, at(i));
      }
      const children = parseBlocks(lines.slice(i + 1, close), at(i + 1), depth + 1);
      push({
        type: "admonition",
        kind: admon[1],
        titleRaw: admon[2] || "",
        openRaw: line,
        closeRaw: lines[close],
        blocks: children,
      }, i, close + 1);
      i = close + 1;
      continue;
    }
    if (RE_ADMON_CLOSE.test(line)) {
      throw new ChunkParseError(`line ${at(i)}: ":::" closes an admonition that was never opened`, at(i));
    }

    // ---- fenced code ------------------------------------------------------
    const fence = RE_FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      let j = i + 1;
      while (j < lines.length && !new RegExp("^[ \\t]*" + marker[0] + "{" + marker.length + ",}[ \\t]*$").test(lines[j])) j++;
      if (j >= lines.length) {
        throw new ChunkParseError(`line ${at(i)}: the code fence "${marker}" is never closed`, at(i));
      }
      blocks.push(protectedBlock(lines.slice(i, j + 1), "fenced code — kept verbatim"));
      i = j + 1;
      continue;
    }

    // ---- MDX import / export ---------------------------------------------
    if (RE_ESM.test(line)) {
      let j = i;
      while (j < lines.length && !isBlank(lines[j]) && !/;[ \t]*$/.test(lines[j])) j++;
      if (j >= lines.length || isBlank(lines[j])) j = i;   // single-line statement without ";"
      blocks.push(protectedBlock(lines.slice(i, j + 1), "MDX import — kept verbatim"));
      i = j + 1;
      continue;
    }

    // ---- JSX / HTML -------------------------------------------------------
    if (line.trimStart().startsWith("<")) {
      const self = RE_JSX_SELF.exec(line.trim());
      if (!self) {
        throw new ChunkParseError(
          `line ${at(i)}: only a single self-closing JSX tag on its own line (e.g. "<StartingPanelDemo />") `
          + "can be handled; a tag with children, a multi-line tag or raw HTML is not supported",
          at(i));
      }
      if (!/^[A-Z]/.test(self[1])) {
        throw new ChunkParseError(`line ${at(i)}: raw HTML ("<${self[1]}>") is not supported`, at(i));
      }
      blocks.push(protectedBlock([line], `JSX module <${self[1]} /> — kept verbatim`));
      i += 1;
      continue;
    }

    // ---- thematic break ---------------------------------------------------
    if (RE_HR.test(line)) {
      blocks.push(protectedBlock([line], "thematic break — kept verbatim"));
      i += 1;
      continue;
    }

    // ---- heading ----------------------------------------------------------
    const h = RE_HEADING.exec(line);
    if (h) {
      push({ type: "heading", hashes: h[1], gap: h[2], inline: parseInline(h[3]) }, i, i + 1);
      i += 1;
      continue;
    }

    // ---- table ------------------------------------------------------------
    if (splitRow(line) && i + 1 < lines.length && isDelimiterRow(lines[i + 1]) && !isDelimiterRow(line)) {
      let j = i + 2;
      while (j < lines.length && splitRow(lines[j]) && !isBlank(lines[j])) j++;
      const rows = [];
      for (let k = i; k < j; k++) rows.push(rowOf(lines[k], k === i + 1));
      push({ type: "table", rows }, i, j);
      i = j;
      continue;
    }

    // ---- list -------------------------------------------------------------
    const li = RE_LIST.exec(line);
    if (li) {
      const items = [];
      let nested = false;
      let j = i;
      while (j < lines.length) {
        const m = RE_LIST.exec(lines[j]);
        if (m) {
          if (items.length && m[1].length > 0) { nested = true; break; }
          items.push({ indent: m[1], marker: m[2], gap: m[3], lines: [{ indent: null, inline: parseInline(m[4]) }] });
          j++;
          continue;
        }
        if (!items.length) break;
        // continuation: an indented, non-blank line that does not start another block
        if (!isBlank(lines[j]) && /^[ \t]+\S/.test(lines[j]) && !breaksParagraph(lines[j])) {
          const ind = /^([ \t]+)/.exec(lines[j])[1];
          items[items.length - 1].lines.push({ indent: ind, inline: parseInline(lines[j].slice(ind.length)) });
          j++;
          continue;
        }
        break;
      }
      const ordered = /\d/.test(items[0].marker);
      if (nested) {
        // A nested list is kept verbatim rather than flattened into something else.
        let end = j;
        while (end < lines.length && !isBlank(lines[end])) end++;
        blocks.push(protectedBlock(lines.slice(i, end), "nested list — kept verbatim"));
        i = end;
        continue;
      }
      push({ type: "list", ordered, items }, i, j, "list — kept verbatim");
      i = j;
      continue;
    }

    // ---- paragraph --------------------------------------------------------
    let j = i;
    while (j < lines.length && !breaksParagraph(lines[j])) j++;
    push({ type: "paragraph", lines: lines.slice(i, j).map(parseInline) }, i, j);
    i = j;
  }

  return blocks;
}

/* ---------------------------------------------------------------- front matter */

const RE_FM_FENCE = /^---[ \t]*$/;
const RE_FM_FIELD = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t](.*)$/;

/** Decode a YAML scalar as written, for display in a form field. */
export function decodeYamlScalar(raw) {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2)) {
    try { return JSON.parse(s); } catch { /* fall through */ }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

/** Encode a value the way the panel already does elsewhere: quote anything YAML would misread. */
export function encodeYamlScalar(value) {
  const s = String(value).trim();
  if (s === "") return '""';
  return /^[A-Za-z0-9][A-Za-z0-9 _.,'()/-]*$/.test(s) ? s : JSON.stringify(s);
}

/* ------------------------------------------------------------------- document */

export function serializeChunk(doc) {
  const out = [
    doc.frontMatter.openRaw,
    ...doc.frontMatter.fields.map(f => `${f.key}: ${f.raw}`),
    doc.frontMatter.closeRaw,
    ...blocksToLines(doc.blocks),
  ];
  return out.join("\n").split("\n").join(doc.eol);
}

/**
 * Parse a chunk. Throws ChunkParseError when the file cannot be represented losslessly —
 * the caller must then refuse to open rich-text mode and leave the author in Source mode.
 */
export function parseChunk(src) {
  if (typeof src !== "string") throw new ChunkParseError("nothing to parse");
  const eol = detectEol(src);
  const text = eol === "\n" ? src : src.split("\r\n").join("\n");
  const lines = text.split("\n");

  if (!lines.length || !RE_FM_FENCE.test(lines[0])) {
    throw new ChunkParseError("the file does not start with a YAML front matter fence (---)", 1);
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (RE_FM_FENCE.test(lines[i])) { close = i; break; }
  }
  if (close === -1) throw new ChunkParseError("the YAML front matter is never closed by a --- line", 1);

  const fields = [];
  const seen = new Set();
  for (let i = 1; i < close; i++) {
    const m = RE_FM_FIELD.exec(lines[i]);
    if (!m) {
      throw new ChunkParseError(
        `line ${i + 1}: front matter is only supported as flat "key: value" lines, so that every `
        + "value can be edited in its own field and nothing else is touched", i + 1);
    }
    if (seen.has(m[1])) throw new ChunkParseError(`line ${i + 1}: duplicate front matter key "${m[1]}"`, i + 1);
    seen.add(m[1]);
    fields.push({ key: m[1], raw: m[2] });
  }

  const doc = {
    eol,
    frontMatter: { openRaw: lines[0], closeRaw: lines[close], fields },
    blocks: parseBlocks(lines.slice(close + 1), close + 2, 0),
  };

  const back = serializeChunk(doc);
  if (back !== src) {
    throw new ChunkParseError("the file did not survive the internal round-trip check, so it is not opened in rich text");
  }
  return doc;
}

/** Convenience for the checker: parse and serialise, reporting whether the bytes match. */
export function roundTrip(src) {
  try {
    const doc = parseChunk(src);
    const out = serializeChunk(doc);
    return { ok: out === src, doc, output: out };
  } catch (e) {
    if (e instanceof ChunkParseError) return { ok: false, refused: true, reason: e.message };
    throw e;
  }
}

/** Count blocks by type, recursing into admonitions — used by the checker's report. */
export function census(blocks, into = {}) {
  for (const b of blocks) {
    into[b.type] = (into[b.type] || 0) + 1;
    if (b.type === "admonition") census(b.blocks, into);
  }
  return into;
}
