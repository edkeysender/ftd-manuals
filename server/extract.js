/**
 * Documents as a source of pictures. Source material arrives as Word / PowerPoint /
 * PDF (or a zip of pictures): every drop point (inbox, Assets tab, chat attachment,
 * import_local_files) runs `expandDocuments()` so the figures inside a document
 * become ordinary image files — and a Word file also yields its text with
 * "[figure: name]" markers, so an agent can write the sections from it.
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

/** Word document text: headings as "## …", list items as "- …", table rows as "a | b", figures as "[figure: file]". */
export function docxText(entries) {
  const doc = entries.find((e) => e.name === 'word/document.xml');
  if (!doc) return '';
  const relsXml = entries.find((e) => e.name === 'word/_rels/document.xml.rels')?.data.toString('utf8') || '';
  const rels = {};
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)) rels[m[1]] = m[2].split('/').pop();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*\bTarget="([^"]+)"[^>]*\bId="([^"]+)"/g)) rels[m[2]] = m[1].split('/').pop();
  let xml = doc.data.toString('utf8');
  const encodeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // tables: every row becomes one paragraph "cell | cell"
  xml = xml.replace(/<w:tr[\s>][\s\S]*?<\/w:tr>/g, (row) => {
    const cells = [...row.matchAll(/<w:tc[\s>][\s\S]*?<\/w:tc>/g)].map((c) =>
      [...c[0].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => decodeXml(m[1])).join('').trim()
    );
    return `<w:p><w:r><w:t>${encodeXml(cells.join(' | '))}</w:t></w:r></w:p>`;
  });
  const out = [];
  const paras = xml.split(/<w:p[\s>]/).slice(1);
  for (const p of paras) {
    const style = (/<w:pStyle w:val="([^"]+)"/.exec(p) || [])[1] || '';
    const heading = /^Heading(\d)/i.exec(style) || /^Nag[łl][óo]wek(\d)/i.exec(style);
    const list = /<w:numPr[\s/>]/.test(p);
    let text = '';
    for (const m of p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>|r:embed="([^"]+)"/g)) {
      if (m[1] !== undefined) text += decodeXml(m[1]);
      else if (m[0] === '<w:tab/>') text += '\t';
      else if (m[0] === '<w:br/>') text += '\n';
      else if (m[2]) text += `[figure: ${rels[m[2]] || m[2]}]`;
    }
    text = text.replace(/[ \t]+$/g, '');
    if (!text.trim()) continue;
    out.push(heading ? `${'#'.repeat(+heading[1] + 1)} ${text}` : list ? `- ${text}` : text);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
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
  let m = /^\[\s*\/ICCBased\s+(\d+\s+\d+\s+R)/.exec(cs);
  if (m) {
    const obj = resolveObj(str, m[1]) || '';
    const n = +(/\/N\s+(\d)/.exec(obj) || [])[1] || 3;
    return { n };
  }
  m = /^\[\s*\/Indexed\s+(\/[A-Za-z]+|\[[^\]]*\]|\d+\s+\d+\s+R)\s+(\d+)\s+(<[0-9A-Fa-f\s]*>|\([^)]*\)|\d+\s+\d+\s+R)/.exec(cs);
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
        extracted.push({ name, buffer, from: f.name });
      }
      if (ext === 'docx') {
        const text = docxText(entries);
        if (text) extracted.push({ name: `${stem}.txt`, buffer: Buffer.from(text, 'utf8'), from: f.name, text: true });
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
