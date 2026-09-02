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
import { expandDocuments } from './extract.js';

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

/** Write files into the inbox after validation; a name that exists gets a numeric suffix. files: [{name, buffer}].
 *  Word / PowerPoint / PDF / zip files are replaced by the pictures inside them (and a .html with the Word content). */
export async function saveToInbox(files) {
  await ensureInbox();
  const saved = [];
  const expanded = await expandDocuments(files);
  for (const f of expanded) {
    if (!f.text) validateAsset(f.name, f.buffer);
    let name = inboxName(f.name);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 2; await exists(path.join(INBOX_DIR, name)); i++) name = `${stem}-${i}${ext}`;
    await fs.writeFile(path.join(INBOX_DIR, name), f.buffer);
    saved.push({ name, size: f.buffer.length, ...(f.from ? { from: f.from } : {}), ...(f.text ? { text: true } : {}) });
  }
  if (expanded.notes) saved.notes = expanded.notes;
  return saved;
}

/** Text of a .html/.txt/.md inbox entry (e.g. the HTML extracted from a Word file). */
export async function readInboxText(name) {
  if (!/\.(txt|md|html)$/i.test(name)) throw new Error('Only .html / .txt / .md inbox entries can be read as text');
  const f = await readInbox(name);
  if (!f) return null;
  return f.buffer.toString('utf8').slice(0, 200000);
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

async function exists(p) {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}
