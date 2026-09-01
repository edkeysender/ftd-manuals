/**
 * Asset validation: never store bytes that are not the complete file they
 * claim to be. A truncated base64 paste used to be saved as a "successful"
 * upload and then served as a broken image — now it is rejected with a
 * message that says what is wrong.
 */

import sharp from 'sharp';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|pdf)$/i;

function pngInfo(b) {
  if (b.length < 33 || b.toString('latin1', 1, 4) !== 'PNG' || b[0] !== 0x89) return null;
  const complete = b.length >= 12 && b.toString('latin1', b.length - 8, b.length - 4) === 'IEND';
  return { type: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20), complete };
}

function jpegInfo(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  // EOI marker in the last 64 bytes (some writers pad after it)
  const tail = b.subarray(Math.max(0, b.length - 64));
  const complete = tail.includes(Buffer.from([0xff, 0xd9]));
  let width = 0;
  let height = 0;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      height = b.readUInt16BE(i + 5);
      width = b.readUInt16BE(i + 7);
      break;
    }
    i += 2 + len;
  }
  return { type: 'jpeg', width, height, complete };
}

function gifInfo(b) {
  if (b.length < 13 || !/^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return null;
  return { type: 'gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8), complete: b[b.length - 1] === 0x3b };
}

function webpInfo(b) {
  if (b.length < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
  const riffSize = b.readUInt32LE(4);
  const complete = b.length >= riffSize + 8;
  const chunk = b.toString('latin1', 12, 16);
  let width = 0;
  let height = 0;
  if (chunk === 'VP8X') {
    width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
  } else if (chunk === 'VP8 ') {
    width = b.readUInt16LE(26) & 0x3fff;
    height = b.readUInt16LE(28) & 0x3fff;
  } else if (chunk === 'VP8L') {
    const b0 = b[21];
    const b1 = b[22];
    const b2 = b[23];
    const b3 = b[24];
    width = 1 + (((b1 & 0x3f) << 8) | b0);
    height = 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
  }
  return { type: 'webp', width, height, complete };
}

function svgInfo(b) {
  const head = b.toString('utf8', 0, Math.min(b.length, 4096));
  if (!/<svg[\s>]/i.test(head)) return null;
  const tail = b.toString('utf8', Math.max(0, b.length - 4096));
  const complete = /<\/svg\s*>\s*$/i.test(tail) || /<svg[^>]*\/>\s*$/i.test(tail);
  const w = /\swidth="([\d.]+)/i.exec(head);
  const h = /\sheight="([\d.]+)/i.exec(head);
  return { type: 'svg', width: w ? Math.round(+w[1]) : 0, height: h ? Math.round(+h[1]) : 0, complete };
}

function pdfInfo(b) {
  if (b.length < 8 || b.toString('latin1', 0, 5) !== '%PDF-') return null;
  const complete = b.toString('latin1', Math.max(0, b.length - 2048)).includes('%%EOF');
  return { type: 'pdf', width: 0, height: 0, complete };
}

/** Identify the file from its bytes: {type, width, height, complete} or null when it is none of the known types. */
export function sniff(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return pngInfo(b) || jpegInfo(b) || gifInfo(b) || webpInfo(b) || svgInfo(b) || pdfInfo(b);
}

const EXT_TYPE = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp', svg: 'svg', pdf: 'pdf' };
const fmtKb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${n} bytes`);

/**
 * Throw when `buffer` is not a complete file of the type its name claims.
 * Files with non-image extensions are not inspected. Returns the sniffed info.
 */
export function validateAsset(name, buffer) {
  const m = IMAGE_EXT.exec(String(name));
  if (!m) return null;
  const ext = m[1].toLowerCase();
  if (!buffer || !buffer.length) throw new Error(`${name}: file is empty`);
  const info = sniff(buffer);
  if (!info) {
    throw new Error(
      `${name}: content is not a ${ext.toUpperCase()} file (${fmtKb(buffer.length)}, starts with ${buffer.subarray(0, 8).toString('hex')}) — the data is probably not the complete file`
    );
  }
  if (info.type !== EXT_TYPE[ext]) {
    throw new Error(`${name}: extension says ${ext.toUpperCase()} but the content is ${info.type.toUpperCase()} — rename the file`);
  }
  if (!info.complete) {
    throw new Error(
      `${name}: ${info.type.toUpperCase()} is truncated (${fmtKb(buffer.length)} received, end-of-file marker missing) — the complete file was not transferred; use import_local_files / the inbox instead of pasting base64`
    );
  }
  return info;
}

export const isImageName = (name) => /\.(png|jpe?g|gif|webp|svg)$/i.test(String(name));

/* ------------------------------------------------------------------ */
/* Resizing (sharp) — previews the model can look at, thumbnails for   */
/* the UI, and the ?w= variant of the asset route.                     */
/* ------------------------------------------------------------------ */

const RASTERISABLE = new Set(['png', 'jpeg', 'gif', 'webp', 'svg']);

/**
 * Downscaled JPEG of an asset for the model / thumbnails. Returns
 * {buffer, mimeType, width, height, original:{type,width,height,bytes}} or null
 * when the file cannot be rasterised (PDF, unknown bytes).
 */
export async function preview(buffer, { max = 768, quality = 78 } = {}) {
  const info = sniff(buffer);
  if (!info || !RASTERISABLE.has(info.type)) return null;
  const out = await sharp(buffer, { animated: false, density: 144 })
    .rotate()
    .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return {
    buffer: out.data,
    mimeType: 'image/jpeg',
    width: out.info.width,
    height: out.info.height,
    original: { type: info.type, width: info.width, height: info.height, bytes: buffer.length },
  };
}

/** Same-format (PNG keeps transparency) resize to `width` px for the asset route; null when not resizable. */
export async function resizeSameFormat(buffer, width) {
  const info = sniff(buffer);
  if (!info || !['png', 'jpeg', 'webp', 'gif'].includes(info.type)) return null;
  // no upscaling: a request wider than the picture gets the original bytes (re-encoding would only grow them)
  if (info.width && width >= info.width) return null;
  const fmt = info.type === 'gif' ? 'png' : info.type;
  const out = await sharp(buffer, { animated: false })
    .rotate()
    .resize({ width: Math.max(16, Math.min(2000, width)), withoutEnlargement: true })
    .toFormat(fmt, fmt === 'jpeg' ? { quality: 82, mozjpeg: true } : fmt === 'png' ? { palette: true, quality: 90, compressionLevel: 9 } : {})
    .toBuffer();
  // a resized thumbnail must never weigh more than the original
  if (out.length >= buffer.length) return null;
  return { buffer: out, mimeType: fmt === 'jpeg' ? 'image/jpeg' : `image/${fmt}` };
}
