/**
 * Documents as a source of pictures. Source material arrives as Word / PowerPoint /
 * PDF (or a zip of pictures): every drop point (inbox, Assets tab, chat attachment,
 * import_local_files) runs `expandDocuments()` so the figures inside a document
 * become ordinary image files — and a Word file also yields "<doc>.html": its
 * content as semantic HTML (headings, inline formatting, lists, tables with
 * col/rowspans, "[figure: name]" markers naming the extracted pictures), so an
 * agent can recreate the document faithfully from it.
 *
 * No dependencies beyond node:zlib and sharp: OOXML is a zip (media under
 * word/media, ppt/media, xl/media); PDF image XObjects are found by scanning the
 * file for stream objects (DCTDecode = a JPEG as-is, FlateDecode = raw pixels
 * with an optional PNG predictor, Indexed palettes expanded). Other encodings
 * (JPX, CCITT, JBIG2, 1-bit masks) are skipped and reported.
 */
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { sniff } from './images.js';

export const DOCUMENT_EXT = /\.(docx|pptx|xlsx|zip|pdf)$/i;
export const isDocumentName = (name) => DOCUMENT_EXT.test(String(name));
const IMAGE_MEDIA = /\.(png|jpe?g|gif|webp|svg|emf|wmf|bmp|tiff?)$/i;
const MIN_PX = 48; // icons, bullets, rules

const stemOf = (name) => String(name).split(/[\\/]/).pop().replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'document';

/* ---------- zip ---------- */

/** Minimal zip reader (stored + deflate, no zip64): [{name, data}] */
export function readZip(buf) {
  const EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocd = buf.lastIndexOf(EOCD);
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    let data;
    try {
      data = method === 8 ? zlib.inflateRawSync(raw) : method === 0 ? raw : null;
    } catch {
      data = null;
    }
    if (data) entries.push({ name, data });
  }
  return entries;
}

const decodeXml = (s) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));

/* ---------- Word document → semantic HTML ---------- */

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** rId → target from a rels part (attribute order varies by producer). */
function relTargets(entries, part) {
  const xml = entries.find((e) => e.name === part)?.data.toString('utf8') || '';
  const map = {};
  for (const m of xml.matchAll(/<Relationship\b(?=[^>]*\bId="([^"]+)")(?=[^>]*\bTarget="([^"]+)")[^>]*>/g)) map[m[1]] = m[2];
  return map;
}

/** styleId → heading level (1-based) from word/styles.xml: an explicit outlineLvl or a
 *  "heading N" name, resolved through basedOn chains (custom heading styles). */
function headingLevels(entries) {
  const xml = entries.find((e) => e.name === 'word/styles.xml')?.data.toString('utf8') || '';
  const styles = {};
  for (const m of xml.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const name = (/<w:name\b[^>]*w:val="([^"]+)"/.exec(m[2]) || [])[1] || '';
    const outline = (/<w:outlineLvl\b[^>]*w:val="(\d+)"/.exec(m[2]) || [])[1];
    const named = /^(?:heading|nag[łl][óo]wek)\s*(\d)$/i.exec(name);
    styles[m[1]] = {
      basedOn: (/<w:basedOn\b[^>]*w:val="([^"]+)"/.exec(m[2]) || [])[1],
      lvl: outline !== undefined ? +outline + 1 : named ? +named[1] : null,
    };
  }
  const levels = {};
  for (const id of Object.keys(styles)) {
    let s = styles[id];
    for (let hop = 0; s && s.lvl === null && s.basedOn && hop < 6; hop++) s = styles[s.basedOn];
    if (s && s.lvl) levels[id] = s.lvl;
  }
  return levels;
}

/** numId → (ilvl → 'ul' | 'ol') from word/numbering.xml. */
function numberingKinds(entries) {
  const xml = entries.find((e) => e.name === 'word/numbering.xml')?.data.toString('utf8') || '';
  const abstract = {};
  for (const m of xml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[\s\S]*?<\/w:abstractNum>/g)) {
    const lvls = {};
    for (const l of m[0].matchAll(/<w:lvl\b[^>]*w:ilvl="(\d+)"[^>]*>[\s\S]*?<w:numFmt\b[^>]*w:val="([^"]+)"/g)) {
      lvls[l[1]] = l[2] === 'bullet' ? 'ul' : 'ol';
    }
    abstract[m[1]] = lvls;
  }
  const map = {};
  for (const m of xml.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>[\s\S]*?<w:abstractNumId\b[^>]*w:val="(\d+)"/g)) map[m[1]] = abstract[m[2]] || {};
  return map;
}

/** Top-level <w:tag>…</w:tag> inner ranges of xml, skipping the same tag nested deeper
 *  (nesting always passes through the tag itself: tbl→tc→tbl, tr→tc→tbl→tr). */
function topRanges(xml, tag) {
  const out = [];
  const re = new RegExp(`<w:${tag}[\\s>]|</w:${tag}>`, 'g');
  let depth = 0;
  let start = 0;
  for (let m; (m = re.exec(xml)); ) {
    if (m[0][1] === '/') {
      depth--;
      if (depth === 0) out.push(xml.slice(start, m.index));
    } else {
      depth++;
      if (depth === 1) start = m.index + m[0].length;
    }
  }
  return out;
}

/** Bold / italic / underline / vertical-align flags of one <w:rPr>…</w:rPr>. */
function runFmt(rpr) {
  const on = (tag) => {
    const m = new RegExp(`<w:${tag}\\b([^>]*?)/?>`).exec(rpr);
    if (!m) return false;
    const v = /w:val="([^"]+)"/.exec(m[1]);
    return !v || !/^(0|false|none)$/i.test(v[1]);
  };
  const va = (/<w:vertAlign\b[^>]*w:val="([^"]+)"/.exec(rpr) || [])[1];
  return { b: on('b'), i: on('i'), u: on('u'), sup: va === 'superscript', sub: va === 'subscript' };
}

const NO_FMT = { b: false, i: false, u: false, sup: false, sub: false };

/** Inline HTML of one paragraph: runs with strong/em/u/sup/sub, <br>, hyperlinks,
 *  and "[figure: file]" markers naming the extracted pictures. */
function inlineHtml(xml, ctx) {
  const segs = [];
  let fmt = NO_FMT;
  let href = null;
  const re = /<w:hyperlink\b[^>]*>|<\/w:hyperlink>|<w:rPr>[\s\S]*?<\/w:rPr>|<w:r\b[^>]*>|<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(?:br|cr)(?:\s[^>]*)?\/>|<w:tab(?:\s[^>]*)?\/>|(?:r:embed|r:link)="([^"]+)"/g;
  for (let m; (m = re.exec(xml)); ) {
    const tok = m[0];
    if (tok.startsWith('<w:hyperlink')) {
      const t = ctx.rels[(/r:id="([^"]+)"/.exec(tok) || [])[1]];
      href = t && /^https?:/i.test(t) ? t : null;
    } else if (tok === '</w:hyperlink>') href = null;
    else if (tok.startsWith('<w:rPr')) fmt = runFmt(tok);
    else if (tok.startsWith('<w:r')) fmt = NO_FMT;
    else if (m[1] !== undefined) segs.push({ fmt, href, text: esc(decodeXml(m[1])) });
    else if (tok.startsWith('<w:tab')) segs.push({ fmt: NO_FMT, href, text: ' ' });
    else if (m[2]) segs.push({ fmt: NO_FMT, href: null, text: `[figure: ${ctx.figName(m[2])}]` });
    else segs.push({ fmt, href, text: '<br>' });
  }
  // merge runs of identical formatting so <strong>a</strong><strong>b</strong> becomes <strong>ab</strong>
  const wrap = (s) => {
    if (!s) return '';
    let r = s.text;
    if (!r) return '';
    if (s.fmt.sup) r = `<sup>${r}</sup>`;
    if (s.fmt.sub) r = `<sub>${r}</sub>`;
    if (s.fmt.u) r = `<u>${r}</u>`;
    if (s.fmt.i) r = `<em>${r}</em>`;
    if (s.fmt.b) r = `<strong>${r}</strong>`;
    if (s.href) r = `<a href="${esc(s.href)}">${r}</a>`;
    return r;
  };
  let html = '';
  let cur = null;
  for (const s of segs) {
    if (cur && cur.href === s.href && ['b', 'i', 'u', 'sup', 'sub'].every((k) => cur.fmt[k] === s.fmt[k])) cur.text += s.text;
    else {
      html += wrap(cur);
      cur = { ...s };
    }
  }
  return (html + wrap(cur)).replace(/(?:<br>|\s)+$/, '');
}

/** One <w:p>: {kind: 'p', html} for paragraphs/headings, {kind: 'li', level, type, html} for list items. */
function paraBlock(pXml, ctx) {
  const pPr = (/<w:pPr>[\s\S]*?<\/w:pPr>/.exec(pXml) || [''])[0];
  const style = (/<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(pPr) || [])[1] || '';
  const inner = inlineHtml(pXml, ctx);
  if (!inner.replace(/<br>/g, '').trim()) return null;
  const outline = (/<w:outlineLvl\b[^>]*w:val="(\d+)"/.exec(pPr) || [])[1];
  const level = outline !== undefined ? +outline + 1 : ctx.headings[style] || (/^(?:Heading|Nag[łl][óo]wek)(\d)$/i.exec(style) || [])[1];
  if (level) {
    const h = Math.min(+level + 1, 6);
    return { kind: 'p', html: `<h${h}>${inner}</h${h}>` };
  }
  if (/^Title$/i.test(style)) return { kind: 'p', html: `<h1>${inner}</h1>` };
  const numPr = /<w:numPr[\s/>]/.exec(pPr);
  if (numPr) {
    const num = (/<w:numPr>[\s\S]*?<\/w:numPr>/.exec(pPr) || [''])[0];
    const level = +((/<w:ilvl\b[^>]*w:val="(\d+)"/.exec(num) || [])[1] || 0);
    const numId = (/<w:numId\b[^>]*w:val="(\d+)"/.exec(num) || [])[1];
    const type = (ctx.nums[numId] || {})[level] || 'ul';
    return { kind: 'li', level, type, html: inner };
  }
  return { kind: 'p', html: `<p>${inner}</p>` };
}

/** Consecutive list paragraphs → nested <ul>/<ol> (deeper ilvl nests under the previous item). */
function renderList(items) {
  const base = items[0].level;
  let html = `<${items[0].type}>`;
  for (let i = 0; i < items.length; ) {
    html += `<li>${items[i].html}`;
    let j = i + 1;
    while (j < items.length && items[j].level > base) j++;
    if (j > i + 1) html += renderList(items.slice(i + 1, j));
    html += '</li>';
    i = j;
  }
  return html + `</${items[0].type}>`;
}

/** <w:tbl> → <table> with colspan (gridSpan), rowspan (vMerge) and th header rows (tblHeader). */
function tableHtml(tblXml, ctx) {
  const rows = topRanges(tblXml, 'tr').map((rowXml) => ({
    header: /<w:tblHeader\b/.test((/<w:trPr>[\s\S]*?<\/w:trPr>/.exec(rowXml) || [''])[0]),
    cells: topRanges(rowXml, 'tc').map((cellXml) => {
      const tcPr = (/<w:tcPr>[\s\S]*?<\/w:tcPr>/.exec(cellXml) || [''])[0];
      const vm = /<w:vMerge\b([^>]*?)\/?>/.exec(tcPr);
      let html = blocksHtml(cellXml.replace(/<w:tcPr>[\s\S]*?<\/w:tcPr>/, ''), ctx);
      const single = /^<p>([\s\S]*)<\/p>$/.exec(html);
      if (single) html = single[1];
      return {
        colspan: +((/<w:gridSpan\b[^>]*w:val="(\d+)"/.exec(tcPr) || [])[1] || 1),
        merge: vm ? (/w:val="restart"/.test(vm[1]) ? 'restart' : 'cont') : null,
        rowspan: 1,
        html,
      };
    }),
  }));
  // vertical merges: a "cont" cell extends the "restart" cell above it in the same grid column
  const owners = {};
  for (const row of rows) {
    let col = 0;
    for (const cell of row.cells) {
      if (cell.merge === 'cont' && owners[col]) {
        owners[col].rowspan++;
        cell.skip = true;
      } else if (cell.merge) owners[col] = cell;
      else delete owners[col];
      col += cell.colspan;
    }
  }
  let html = '<table>';
  for (const row of rows) {
    const tag = row.header ? 'th' : 'td';
    html += `<tr>${row.cells
      .filter((c) => !c.skip)
      .map((c) => `<${tag}${c.colspan > 1 ? ` colspan="${c.colspan}"` : ''}${c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : ''}>${c.html}</${tag}>`)
      .join('')}</tr>`;
  }
  return html + '</table>';
}

/** True when the tag opening at index i ends "/>", i.e. carries no content ("<w:p w:rsidR="…"/>"). */
const selfClosing = (xml, i) => xml[xml.indexOf('>', i) - 1] === '/';

/** Block sequence of a body / table cell: paragraphs, lists and (nested) tables in order. */
function blocksHtml(xml, ctx) {
  const out = [];
  let list = null;
  const flushList = () => {
    if (list) out.push(renderList(list));
    list = null;
  };
  const re = /<w:(tbl|p)[\s/>]/g;
  for (let m; (m = re.exec(xml)); ) {
    if (selfClosing(xml, m.index)) continue; // <w:p/>, <w:p attrs/>
    if (m[1] === 'tbl') {
      // depth-aware: consume the whole table (tables nest via tc)
      const t = /<w:tbl[\s>]|<\/w:tbl>/g;
      t.lastIndex = m.index;
      let depth = 0;
      let end = xml.length;
      for (let mm; (mm = t.exec(xml)); ) {
        if (mm[0][1] === '/') {
          if (--depth === 0) {
            end = mm.index + mm[0].length;
            break;
          }
        } else if (!selfClosing(xml, mm.index)) depth++;
      }
      flushList();
      out.push(tableHtml(xml.slice(m.index, end), ctx));
      re.lastIndex = end;
    } else {
      // depth-aware close: a text box (w:txbxContent) nests paragraphs inside a paragraph
      const t = /<w:p[\s>]|<\/w:p>/g;
      t.lastIndex = m.index;
      let depth = 0;
      let close = -1;
      for (let mm; (mm = t.exec(xml)); ) {
        if (mm[0][1] === '/') {
          if (--depth === 0) {
            close = mm.index;
            break;
          }
        } else if (!selfClosing(xml, mm.index)) depth++;
      }
      if (close < 0) break;
      re.lastIndex = close + 6;
      // text boxes render as their own blocks after the carrying paragraph
      const boxes = [];
      const pXml = xml.slice(m.index, close).replace(/<w:txbxContent>([\s\S]*?)<\/w:txbxContent>/g, (_, box) => {
        boxes.push(box);
        return '';
      });
      const p = paraBlock(pXml, ctx);
      if (p) {
        if (p.kind === 'li') (list ||= []).push(p);
        else {
          flushList();
          out.push(p.html);
        }
      }
      for (const box of boxes) {
        const boxHtml = blocksHtml(box, ctx);
        if (boxHtml) {
          flushList();
          out.push(boxHtml);
        }
      }
    }
  }
  flushList();
  return out.join('\n');
}

/**
 * Word document → semantic HTML: headings (Heading1 → h2 …), paragraphs with
 * strong/em/u/sup/sub and hyperlinks, nested ul/ol, tables with colspan/rowspan
 * and th header rows, pictures as "[figure: <extracted file name>]" markers.
 * `mediaNames` maps a media base name (image1.png) to the name the picture was
 * extracted under, so the markers match the files next to this text.
 */
export function docxHtml(entries, stem = 'document', mediaNames = {}) {
  const doc = entries.find((e) => e.name === 'word/document.xml');
  if (!doc) return '';
  const rels = relTargets(entries, 'word/_rels/document.xml.rels');
  const ctx = {
    rels,
    nums: numberingKinds(entries),
    headings: headingLevels(entries),
    figName: (id) => {
      const base = (rels[id] || id).split('/').pop();
      return mediaNames[base] || `${stem}-${base}`;
    },
  };
  const xml = doc.data.toString('utf8');
  let body = (/<w:body[\s>]([\s\S]*)<\/w:body>/.exec(xml) || [null, xml])[1];
  // mc:AlternateContent carries the same content twice (Choice + Fallback) — keep one
  body = body.replace(/<mc:Fallback(?:\s[^>]*)?>[\s\S]*?<\/mc:Fallback>/g, '');
  return blocksHtml(body, ctx).trim();
}

/* ---------- PDF images ---------- */

function pdfValue(dict, key) {
  const m = new RegExp(`/${key}\\s*(\\[[^\\]]*\\]|<<[\\s\\S]*?>>|/[A-Za-z0-9.+-]+|\\d+\\s+\\d+\\s+R|-?\\d+(?:\\.\\d+)?|\\([^)]*\\)|<[0-9A-Fa-f\\s]*>|true|false)`).exec(dict);
  return m ? m[1].trim() : null;
}

function resolveObj(str, ref) {
  const m = /^(\d+)\s+(\d+)\s+R$/.exec(ref || '');
  if (!m) return ref;
  const re = new RegExp(`(?:^|[^0-9])${m[1]}\\s+${m[2]}\\s+obj\\s*([\\s\\S]*?)\\s*endobj`);
  const hit = re.exec(str);
  return hit ? hit[1].trim() : null;
}

/** Number of colour components of a colour space value, and an Indexed palette when present. */
function colorInfo(str, cs) {
  cs = resolveObj(str, cs);
  if (!cs) return null;
  if (/^\/DeviceRGB$|^\/CalRGB$/.test(cs)) return { n: 3 };
  if (/^\/DeviceGray$|^\/CalGray$/.test(cs)) return { n: 1 };
  if (/^\/DeviceCMYK$/.test(cs)) return { n: 4 };
  let m = /^\[\s*\/ICCBased\s*(\d+\s+\d+\s+R)/.exec(cs);
  if (m) {
    const obj = resolveObj(str, m[1]) || '';
    const n = +(/\/N\s*(\d)/.exec(obj) || [])[1] || 3;
    return { n };
  }
  // names may follow each other without whitespace: [/Indexed/DeviceRGB 234 38 0 R]
  m = /^\[\s*\/Indexed\s*(\/[A-Za-z]+|\[[^\]]*\]|\d+\s+\d+\s+R)\s*(\d+)\s*(<[0-9A-Fa-f\s]*>|\([^)]*\)|\d+\s+\d+\s+R)/.exec(cs);
  if (m) {
    const base = colorInfo(str, m[1]);
    if (!base) return null;
    let lookup = m[3];
    let pal;
    if (lookup.startsWith('<')) pal = Buffer.from(lookup.replace(/[<>\s]/g, ''), 'hex');
    else if (lookup.startsWith('(')) pal = Buffer.from(lookup.slice(1, -1), 'latin1');
    else {
      const obj = resolveObj(str, lookup) || '';
      const sm = /stream\r?\n/.exec(obj);
      if (sm) {
        let raw = Buffer.from(obj.slice(sm.index + sm[0].length, obj.lastIndexOf('endstream')), 'latin1');
        if (/\/FlateDecode/.test(obj)) {
          try {
            raw = zlib.inflateSync(raw);
          } catch {
            return null;
          }
        }
        pal = raw;
      }
    }
    if (!pal) return null;
    return { n: 1, palette: { base: base.n, data: pal } };
  }
  if (/^\[\s*\/(CalRGB|Lab)/.test(cs)) return { n: 3 };
  if (/^\[\s*\/CalGray/.test(cs)) return { n: 1 };
  return null;
}

/** Undo PNG row predictors (Predictor >= 10) in place. */
function unpredictPng(data, colors, bpc, columns) {
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = Buffer.alloc(rows * rowLen);
  let prev = Buffer.alloc(rowLen);
  for (let r = 0; r < rows; r++) {
    const ft = data[r * (rowLen + 1)];
    const src = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
    const cur = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let x = src[i];
      if (ft === 1) x += a;
      else if (ft === 2) x += b;
      else if (ft === 3) x += (a + b) >> 1;
      else if (ft === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        x += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = x & 0xff;
    }
    prev = cur;
  }
  return out;
}

/** Extract the raster images embedded in a PDF: [{name, buffer, width, height, skipped?}] */
export async function extractPdfImages(buf, stem = 'document') {
  const str = buf.toString('latin1');
  const out = [];
  const seen = new Set();
  const skipped = [];
  const re = /(\d+)\s+(\d+)\s+obj\s*<<([\s\S]*?)>>\s*stream\r?\n/g;
  let m;
  let n = 0;
  while ((m = re.exec(str))) {
    const dict = m[3];
    if (!/\/Subtype\s*\/Image\b/.test(dict)) continue;
    const width = +resolveObj(str, pdfValue(dict, 'Width')) || 0;
    const height = +resolveObj(str, pdfValue(dict, 'Height')) || 0;
    if (width < MIN_PX || height < MIN_PX) continue;
    if (/\/ImageMask\s+true/.test(dict)) continue;
    const bpc = +resolveObj(str, pdfValue(dict, 'BitsPerComponent')) || 8;
    let length = resolveObj(str, pdfValue(dict, 'Length'));
    length = length ? +length : NaN;
    const start = m.index + m[0].length;
    let end = Number.isFinite(length) && length > 0 ? start + length : -1;
    if (end < 0 || end > str.length) end = str.indexOf('endstream', start);
    if (end < 0) continue;
    const data = buf.subarray(start, end);
    const filters = (pdfValue(dict, 'Filter') || '').match(/\/[A-Za-z0-9]+/g) || [];
    const filter = filters[filters.length - 1] || '';
    n++;
    try {
      let file = null;
      if (filter === '/DCTDecode' && filters.length === 1) {
        // JPEG as-is (CMYK JPEGs are converted so browsers can show them)
        let jpg = data;
        if ((/\/DeviceCMYK/.test(dict) || /\/Decode\s*\[\s*1/.test(dict)) && sniff(jpg)?.type === 'jpeg') jpg = await sharp(jpg).toColourspace('srgb').jpeg({ quality: 88 }).toBuffer();
        file = { name: `${stem}-${n}.jpg`, buffer: jpg };
      } else if (filter === '/JPXDecode' && filters.length === 1) {
        file = { name: `${stem}-${n}.png`, buffer: await sharp(data).png().toBuffer() }; // works only when libvips has OpenJPEG
      } else if (filter === '/FlateDecode' && filters.length === 1 && bpc === 8) {
        const ci = colorInfo(str, pdfValue(dict, 'ColorSpace'));
        if (!ci) throw new Error('unsupported colour space');
        let raw = zlib.inflateSync(data);
        const parms = pdfValue(dict, 'DecodeParms') || '';
        const predictor = +(/\/Predictor\s+(\d+)/.exec(parms) || [])[1] || 1;
        if (predictor >= 10) {
          const colors = +(/\/Colors\s+(\d+)/.exec(parms) || [])[1] || ci.n;
          const columns = +(/\/Columns\s+(\d+)/.exec(parms) || [])[1] || width;
          raw = unpredictPng(raw, colors, bpc, columns);
        } else if (predictor === 2) throw new Error('TIFF predictor');
        let channels = ci.n;
        if (ci.palette) {
          const { base, data: pal } = ci.palette;
          const px = Buffer.alloc(width * height * base);
          for (let i = 0; i < width * height; i++) {
            const idx = raw[i] * base;
            for (let c = 0; c < base; c++) px[i * base + c] = pal[idx + c] ?? 0;
          }
          raw = px;
          channels = base;
        }
        if (channels === 4) {
          // CMYK → RGB (simple inversion)
          const rgb = Buffer.alloc(width * height * 3);
          for (let i = 0, j = 0; i < width * height * 4; i += 4, j += 3) {
            const k = raw[i + 3];
            rgb[j] = 255 - Math.min(255, raw[i] + k);
            rgb[j + 1] = 255 - Math.min(255, raw[i + 1] + k);
            rgb[j + 2] = 255 - Math.min(255, raw[i + 2] + k);
          }
          raw = rgb;
          channels = 3;
        }
        if (raw.length < width * height * channels) throw new Error('pixel data shorter than width × height');
        file = { name: `${stem}-${n}.png`, buffer: await sharp(raw.subarray(0, width * height * channels), { raw: { width, height, channels } }).png({ palette: true }).toBuffer() };
      } else {
        throw new Error(`filter ${filters.join(' ') || 'none'} not supported`);
      }
      const hash = createHash('sha1').update(file.buffer).digest('hex');
      if (seen.has(hash)) continue;
      seen.add(hash);
      out.push({ ...file, width, height });
    } catch (e) {
      skipped.push(`image ${n} (${width}×${height}): ${e.message}`);
    }
  }
  if (skipped.length) out.skipped = skipped;
  return out;
}

/* ---------- entry point ---------- */

/**
 * Replace document files in `files` ([{name, buffer}]) by the pictures they contain
 * (and, for Word, a <stem>.txt with the text). Images and other files pass through.
 * PDFs are kept as well (a PDF is a legitimate appendix asset) unless keepDocuments is false.
 * Returns the expanded list; each extracted entry carries `from` (the document).
 */
export async function expandDocuments(files, { keepDocuments = true, minPx = MIN_PX } = {}) {
  const out = [];
  for (const f of files) {
    if (!isDocumentName(f.name) || !f.buffer?.length) {
      out.push(f);
      continue;
    }
    const stem = stemOf(f.name);
    const ext = (f.name.match(/\.([a-z0-9]+)$/i) || [])[1].toLowerCase();
    const extracted = [];
    const notes = [];
    if (ext === 'pdf') {
      if (keepDocuments) out.push(f);
      const imgs = await extractPdfImages(f.buffer, stem);
      for (const im of imgs) extracted.push({ name: im.name, buffer: im.buffer, from: f.name });
      if (imgs.skipped) notes.push(...imgs.skipped);
    } else {
      let entries;
      try {
        entries = readZip(f.buffer);
      } catch (e) {
        throw new Error(`${f.name}: ${e.message}`);
      }
      const media = entries.filter((e) => /^(word|ppt|xl)\/media\//.test(e.name) || (ext === 'zip' && IMAGE_MEDIA.test(e.name)));
      const mediaNames = {};
      let k = 0;
      for (const e of media) {
        const base = e.name.split('/').pop();
        if (!IMAGE_MEDIA.test(base)) continue;
        let buffer = e.data;
        let name = `${stem}-${base}`;
        const info = sniff(buffer);
        if (!info) {
          // EMF/WMF/BMP/TIFF: rasterise when sharp can, else skip
          try {
            buffer = await sharp(buffer).png().toBuffer();
            name = name.replace(/\.[^.]+$/, '.png');
          } catch {
            notes.push(`${base}: format not supported`);
            continue;
          }
        } else if (info.type !== 'svg' && (info.width < minPx || info.height < minPx)) continue;
        k++;
        mediaNames[base] = name;
        extracted.push({ name, buffer, from: f.name });
      }
      if (ext === 'docx') {
        const html = docxHtml(entries, stem, mediaNames);
        if (html) extracted.push({ name: `${stem}.html`, buffer: Buffer.from(html, 'utf8'), from: f.name, text: true });
      }
    }
    if (!extracted.length && !(ext === 'pdf' && keepDocuments)) {
      throw new Error(`${f.name}: no pictures found inside${notes.length ? ` (${notes.join('; ')})` : ''}`);
    }
    for (const e of extracted) out.push(e);
    if (notes.length) out.notes = [...(out.notes || []), ...notes.map((s) => `${f.name}: ${s}`)];
  }
  return out;
}
