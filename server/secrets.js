/**
 * API keys entered in Settings. They live in <data>/secrets.json next to users.json — outside the
 * document repository, so a key is never committed — readable by the console's user only. A key in
 * the environment still works; a key saved here takes precedence, so an operator can change it from
 * the browser without touching .env.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = process.env.FTD_DATA_DIR ? path.resolve(process.env.FTD_DATA_DIR) : path.resolve('data', 'repo');
const AUTH_DIR = process.env.FTD_AUTH_DIR ? path.resolve(process.env.FTD_AUTH_DIR) : path.dirname(DATA_DIR);
const FILE = path.join(AUTH_DIR, 'secrets.json');
export const SECRET_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

let cache = null;
function read() {
  if (cache) return cache;
  try {
    cache = JSON.parse(require_fs().readFileSync(FILE, 'utf8')) || {};
  } catch {
    cache = {};
  }
  return cache;
}
import { createRequire } from 'node:module';
const require_fs = () => createRequire(import.meta.url)('node:fs');

/** The stored value of one secret, or undefined. */
export const secret = (name) => read()[name] || undefined;

/** Save (or with an empty value, remove) keys; unknown names are ignored. */
export async function setSecrets(patch) {
  const cur = { ...read() };
  for (const name of SECRET_NAMES) {
    if (!(name in patch)) continue;
    const v = String(patch[name] ?? '').trim();
    if (v) cur[name] = v;
    else delete cur[name];
  }
  await fs.mkdir(AUTH_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(cur, null, 2) + '\n', { mode: 0o600 });
  await fs.chmod(FILE, 0o600).catch(() => {});
  cache = cur;
  return maskedKeys();
}

/** What the UI may see: whether a key is set and its last four characters, never the key. */
export function maskedKeys() {
  const mask = (v) => (v ? `…${String(v).slice(-4)}` : null);
  return { anthropic: mask(secret('ANTHROPIC_API_KEY') || process.env.ANTHROPIC_API_KEY), openai: mask(secret('OPENAI_API_KEY') || process.env.OPENAI_API_KEY) };
}
