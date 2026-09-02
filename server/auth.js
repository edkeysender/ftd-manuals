/**
 * Console login: users with scrypt-hashed passwords in <data>/users.json, an HMAC-signed
 * session cookie, and two roles — `admin` (everything, including deleting) and `editor`
 * (everything except deleting). The first start seeds the default administrator.
 *
 * The /mcp endpoint requires a per-user bearer token (mcp-tokens.json, hashes only):
 * each user creates and revokes their own in Settings → MCP connector; MCP_TOKEN in
 * .env stays honoured as a master token for local tooling.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.FTD_DATA_DIR ? path.resolve(process.env.FTD_DATA_DIR) : path.resolve('data', 'repo');
/** users.json and the cookie secret sit next to the document repo (data/), never inside it. */
const AUTH_DIR = process.env.FTD_AUTH_DIR ? path.resolve(process.env.FTD_AUTH_DIR) : path.dirname(DATA_DIR);
const USERS_FILE = path.join(AUTH_DIR, 'users.json');
const SECRET_FILE = path.join(AUTH_DIR, 'auth-secret');

export const ROLES = ['admin', 'editor'];
export const COOKIE = 'ftd_session';
const SESSION_DAYS = 30;
const MIN_PASSWORD = 8;

/** Seeded on first start when users.json does not exist yet. */
const DEFAULT_ADMIN = {
  email: process.env.FTD_ADMIN_EMAIL || 'l.wicenciak@ftd.aero',
  password: process.env.FTD_ADMIN_PASSWORD || 'Simulation01',
  name: 'Łukasz Wicenciak',
};

let secret = null;
let users = [];
let writing = Promise.resolve();

/* ---------- passwords ---------- */
const hashPassword = (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
};

const verifyPassword = (password, stored) => {
  const [algo, salt, hash] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};

const normEmail = (email) => String(email || '').trim().toLowerCase();
const validEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

/** What the API returns for a user — never the hash. */
export const publicUser = (u) => (u ? { id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.createdAt } : null);

/* ---------- persistence ---------- */
async function saveUsers() {
  writing = writing.then(async () => {
    await fs.mkdir(AUTH_DIR, { recursive: true });
    const tmp = `${USERS_FILE}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ users }, null, 2) + '\n');
    await fs.rename(tmp, USERS_FILE);
  });
  return writing;
}

export async function initAuth() {
  await fs.mkdir(AUTH_DIR, { recursive: true });
  try {
    secret = await fs.readFile(SECRET_FILE);
    if (secret.length < 32) throw new Error('short secret');
  } catch {
    secret = crypto.randomBytes(32);
    await fs.writeFile(SECRET_FILE, secret, { mode: 0o600 });
  }
  try {
    const parsed = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
    users = Array.isArray(parsed.users) ? parsed.users : [];
  } catch {
    users = [];
  }
  try {
    const parsed = JSON.parse(await fs.readFile(TOKENS_FILE, 'utf8'));
    tokens = Array.isArray(parsed.tokens) ? parsed.tokens : [];
  } catch {
    tokens = [];
  }
  if (!users.length) {
    users.push({
      id: crypto.randomUUID(),
      email: normEmail(DEFAULT_ADMIN.email),
      name: DEFAULT_ADMIN.name,
      role: 'admin',
      passwordHash: hashPassword(DEFAULT_ADMIN.password),
      createdAt: new Date().toISOString(),
    });
    await saveUsers();
    console.log(`Auth: created default administrator ${DEFAULT_ADMIN.email} (${USERS_FILE})`);
  }
}

/* ---------- sessions: base64url(payload).hmac ---------- */
const sign = (data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

export function createSession(user) {
  const payload = Buffer.from(JSON.stringify({ uid: user.id, exp: Date.now() + SESSION_DAYS * 86400e3 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readSession(token) {
  if (!token) return null;
  const [payload, sig] = String(token).split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!uid || !exp || exp < Date.now()) return null;
    return users.find((u) => u.id === uid) || null;
  } catch {
    return null;
  }
}

const parseCookies = (header) =>
  Object.fromEntries(
    String(header || '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
  );

export const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  maxAge: SESSION_DAYS * 86400e3,
  secure: process.env.FTD_SECURE_COOKIE === '1',
});

/** Express middleware: sets req.user from the session cookie (or null). */
export function attachUser(req, res, next) {
  req.user = readSession(parseCookies(req.headers.cookie)[COOKIE]);
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required', code: 'unauthenticated' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required', code: 'unauthenticated' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator privileges required — deleting is reserved for administrators', code: 'forbidden' });
  next();
}

/* ---------- user operations ---------- */
export function authenticate(email, password) {
  const u = users.find((x) => x.email === normEmail(email));
  if (!u || !verifyPassword(password, u.passwordHash)) return null;
  return u;
}

export const listUsers = () => users.map(publicUser);

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
}

export async function createUser({ email, name, password, role = 'editor' }) {
  email = normEmail(email);
  if (!validEmail(email)) throw new Error('A valid e-mail address is required');
  if (users.some((u) => u.email === email)) throw new Error(`${email} already has an account`);
  if (!ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}`);
  checkPassword(password);
  const u = {
    id: crypto.randomUUID(),
    email,
    name: String(name || '').trim() || email,
    role,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  users.push(u);
  await saveUsers();
  return publicUser(u);
}

/** Admin edit: name, role and/or a new password. The last administrator cannot be demoted. */
export async function updateUser(id, { name, role, password } = {}) {
  const u = users.find((x) => x.id === id);
  if (!u) throw new Error('User not found');
  if (name !== undefined) u.name = String(name).trim() || u.email;
  if (role !== undefined) {
    if (!ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}`);
    if (u.role === 'admin' && role !== 'admin' && users.filter((x) => x.role === 'admin').length === 1) throw new Error('Cannot demote the last administrator');
    u.role = role;
  }
  if (password !== undefined) {
    checkPassword(password);
    u.passwordHash = hashPassword(password);
  }
  await saveUsers();
  return publicUser(u);
}

export async function deleteUser(id, actor) {
  const i = users.findIndex((x) => x.id === id);
  if (i < 0) throw new Error('User not found');
  if (actor && actor.id === id) throw new Error('You cannot delete your own account');
  if (users[i].role === 'admin' && users.filter((x) => x.role === 'admin').length === 1) throw new Error('Cannot delete the last administrator');
  users.splice(i, 1);
  if (tokens.some((t) => t.userId === id)) {
    tokens = tokens.filter((t) => t.userId !== id); // a deleted user's MCP tokens die with the account
    await saveTokens();
  }
  await saveUsers();
  return { ok: true };
}

/* ---------- MCP tokens: per-user bearer tokens for the /mcp endpoint ---------- */

const TOKENS_FILE = path.join(AUTH_DIR, 'mcp-tokens.json');
let tokens = [];

async function saveTokens() {
  writing = writing.then(async () => {
    await fs.mkdir(AUTH_DIR, { recursive: true });
    const tmp = `${TOKENS_FILE}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ tokens }, null, 2) + '\n');
    await fs.rename(tmp, TOKENS_FILE);
  });
  return writing;
}

const hashMcpToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

const publicToken = (tk) => ({
  id: tk.id,
  label: tk.label,
  owner: users.find((u) => u.id === tk.userId)?.email || '(deleted)',
  createdAt: tk.createdAt,
  lastUsedAt: tk.lastUsedAt || null,
});

/** Create a bearer token for the /mcp endpoint. The plaintext is returned ONCE; only its hash is stored. */
export async function createMcpToken(user, label) {
  const plain = `ftd_${crypto.randomBytes(24).toString('hex')}`;
  const tk = {
    id: crypto.randomUUID(),
    userId: user.id,
    label: String(label || '').trim().slice(0, 60) || 'MCP client',
    tokenHash: hashMcpToken(plain),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  tokens.push(tk);
  await saveTokens();
  return { ...publicToken(tk), token: plain };
}

/** A user sees their own tokens; administrators see everyone's. */
export const listMcpTokens = (user) => tokens.filter((tk) => user.role === 'admin' || tk.userId === user.id).map(publicToken);

export async function revokeMcpToken(id, actor) {
  const i = tokens.findIndex((tk) => tk.id === id);
  if (i < 0) throw new Error('Token not found');
  if (actor.role !== 'admin' && tokens[i].userId !== actor.id) throw new Error('You can only revoke your own tokens');
  tokens.splice(i, 1);
  await saveTokens();
  return { ok: true };
}

/** The user behind an Authorization header, or null. Updates lastUsedAt (throttled to once a minute). */
export function verifyMcpToken(header) {
  const m = /^Bearer\s+(.+)$/i.exec(String(header || ''));
  if (!m) return null;
  const hash = hashMcpToken(m[1].trim());
  const tk = tokens.find((x) => x.tokenHash.length === hash.length && crypto.timingSafeEqual(Buffer.from(x.tokenHash), Buffer.from(hash)));
  if (!tk) return null;
  const user = users.find((u) => u.id === tk.userId);
  if (!user) return null;
  if (!tk.lastUsedAt || Date.now() - Date.parse(tk.lastUsedAt) > 60e3) {
    tk.lastUsedAt = new Date().toISOString();
    saveTokens().catch(() => {});
  }
  return user;
}

/** Self-service password change — requires the current password. */
export async function changePassword(user, current, next) {
  if (!verifyPassword(current, user.passwordHash)) throw new Error('Current password is incorrect');
  checkPassword(next);
  user.passwordHash = hashPassword(next);
  await saveUsers();
  return { ok: true };
}
