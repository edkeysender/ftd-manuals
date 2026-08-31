/**
 * Inbox — a drop folder on the console machine for files waiting to be
 * attached to a module. Users drop files into it from the browser (no need
 * to know paths); the assistant sees it through list_inbox and imports by
 * bare file name, so no image bytes ever travel through the model.
 *
 *   FTD_INBOX_DIR     folder (default data/inbox)
 *   FTD_IMPORT_ROOTS  extra folders import_local_files may read, ';'-separated
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { sniff, validateAsset } from './images.js';

export const INBOX_DIR = path.resolve(process.env.FTD_INBOX_DIR || path.join('data', 'inbox'));
export const IMPORT_ROOTS = [
  INBOX_DIR,
  ...String(process.env.FTD_IMPORT_ROOTS || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(s)),
];

const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

/** True when `abs` is one of the import roots or inside one. */
export function isAllowedPath(abs) {
  const a = norm(path.resolve(abs));
  return IMPORT_ROOTS.some((r) => {
    const root = norm(r);
    return a === root || a.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  });
}

export async function ensureInbox() {
  await fs.mkdir(INBOX_DIR, { recursive: true });
}

/** Sanitise a name for the inbox: basename only, safe characters, keeps case. */
export function inboxName(name) {
  const base = String(name).split(/[\\/]/).pop() || 'file';
  const cleaned = base.replace(/[^\w.\- ()]+/g, '-').replace(/^[.\-]+/, '');
  return cleaned || 'file';
}

export function inboxPath(name) {
  const p = path.join(INBOX_DIR, inboxName(name));
  if (!isAllowedPath(p)) throw new Error('Invalid inbox file name');
  return p;
}

export async function listInbox() {
  await ensureInbox();
  const out = [];
  for (const name of await fs.readdir(INBOX_DIR)) {
    const p = path.join(INBOX_DIR, name);
    const st = await fs.stat(p).catch(() => null);
    if (!st || !st.isFile()) continue;
    const entry = { name, size: st.size, modified: st.mtime.toISOString() };
    if (/\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(name) && st.size <= 32 * 1024 * 1024) {
      const info = sniff(await fs.readFile(p));
      if (info) Object.assign(entry, { type: info.type, width: info.width, height: info.height, complete: info.complete });
      else entry.complete = false;
    }
    out.push(entry);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Write files into the inbox after validation; a name that exists gets a numeric suffix. files: [{name, buffer}] */
export async function saveToInbox(files) {
  await ensureInbox();
  const saved = [];
  for (const f of files) {
    validateAsset(f.name, f.buffer);
    let name = inboxName(f.name);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 2; await exists(path.join(INBOX_DIR, name)); i++) name = `${stem}-${i}${ext}`;
    await fs.writeFile(path.join(INBOX_DIR, name), f.buffer);
    saved.push({ name, size: f.buffer.length });
  }
  return saved;
}

export async function readInbox(name) {
  const p = inboxPath(name);
  try {
    return { name: path.basename(p), buffer: await fs.readFile(p) };
  } catch {
    return null;
  }
}

export async function deleteInbox(name) {
  const p = inboxPath(name);
  await fs.rm(p, { force: true });
}

/* ---------- chunked uploads: base64 in parts, assembled into the inbox ---------- */
const PARTS_DIR = path.join(INBOX_DIR, '.parts');
const partDir = (id) => path.join(PARTS_DIR, inboxName(id).replace(/\s+/g, '_'));
export const PART_MAX_CHARS = 12000;

/**
 * Store one base64 part of a file (MCP upload_photo_part). Parts may arrive in
 * any order; when every part is present the string is decoded, validated like
 * any other asset and dropped into the inbox under `name` — from there the
 * normal import_local_files path takes over. A failed validation discards the
 * parts so a corrupt file never lingers.
 */
export async function putPart({ id, name, part, parts, data, abort }) {
  if (!id) throw new Error('upload_id is required');
  const dir = partDir(id);
  if (abort) {
    await fs.rm(dir, { recursive: true, force: true });
    return { upload_id: id, aborted: true };
  }
  if (!name) throw new Error('name (file name with extension) is required');
  part = Number(part);
  parts = Number(parts);
  if (!Number.isInteger(parts) || parts < 1 || parts > 500) throw new Error('parts must be an integer between 1 and 500');
  if (!Number.isInteger(part) || part < 1 || part > parts) throw new Error(`part must be between 1 and ${parts}`);
  const chunk = String(data || '').replace(/\s+/g, '');
  if (!chunk) throw new Error(`part ${part} is empty`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(chunk)) throw new Error(`part ${part} is not valid base64 (only A–Z a–z 0–9 + / and trailing =)`);
  if (chunk.length > PART_MAX_CHARS) {
    throw new Error(`part ${part} is ${chunk.length} characters — keep parts to about 6000 characters so each one arrives intact`);
  }
  if (part < parts && chunk.includes('=')) {
    throw new Error(
      `part ${part} carries '=' padding but is not the last part — encode the WHOLE file once and split that one base64 string; do not encode each part separately`
    );
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${part}.b64`), chunk);
  const have = (await fs.readdir(dir))
    .map((f) => /^(\d+)\.b64$/.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  const missing = [];
  for (let i = 1; i <= parts; i++) if (!have.includes(i)) missing.push(i);
  if (missing.length) return { upload_id: id, complete: false, received: have, missing };
  let b64 = '';
  for (let i = 1; i <= parts; i++) b64 += await fs.readFile(path.join(dir, `${i}.b64`), 'utf8');
  const buffer = Buffer.from(b64, 'base64');
  try {
    const [saved] = await saveToInbox([{ name, buffer }]);
    await fs.rm(dir, { recursive: true, force: true });
    const info = sniff(buffer);
    return {
      upload_id: id,
      complete: true,
      inbox: saved.name,
      size: buffer.length,
      ...(info ? { type: info.type, width: info.width, height: info.height } : {}),
      next: `import_local_files with paths: ["${saved.name}"]`,
    };
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true });
    throw new Error(`${e.message} — all ${parts} parts (${b64.length} base64 characters) were discarded; check every part is complete and resend them`);
  }
}

async function exists(p) {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}
