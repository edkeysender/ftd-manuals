/**
 * OAuth 2.1 authorization server for the /mcp endpoint — the redirect flow MCP
 * clients (the claude.ai connector, Claude Code) speak natively:
 *
 *   discovery   GET /.well-known/oauth-authorization-server  (+ oauth-protected-resource)
 *   register    POST /oauth/register            dynamic client registration (public clients)
 *   authorize   GET/POST /oauth/authorize       sign-in + consent page → 302 redirect_uri?code=…
 *   token       POST /oauth/token               authorization_code (PKCE S256) / refresh_token
 *
 * Access tokens are short-lived HMAC-signed blobs ({uid, exp, aud:"mcp"}) verified by
 * the /mcp middleware; refresh tokens are stored hashed in <data>/oauth.json and can be
 * revoked by deleting the user. Only administrators and moderators are authorized —
 * viewers are refused at consent and at verification.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as auth from './auth.js';

const DATA_DIR = process.env.FTD_DATA_DIR ? path.resolve(process.env.FTD_DATA_DIR) : path.resolve('data', 'repo');
const AUTH_DIR = process.env.FTD_AUTH_DIR ? path.resolve(process.env.FTD_AUTH_DIR) : path.dirname(DATA_DIR);
const OAUTH_FILE = path.join(AUTH_DIR, 'oauth.json');

const ACCESS_TTL = 3600; // seconds
const REFRESH_DAYS = 30;
const CODE_TTL = 10 * 60e3;

let db = { clients: [], refresh: [] };
const codes = new Map(); // code -> {clientId, redirectUri, challenge, userId, exp}
let writing = Promise.resolve();

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const b64url = (b) => Buffer.from(b).toString('base64url');

export async function initOAuth() {
  try {
    const parsed = JSON.parse(await fs.readFile(OAUTH_FILE, 'utf8'));
    db = { clients: parsed.clients || [], refresh: parsed.refresh || [] };
  } catch {
    db = { clients: [], refresh: [] };
  }
}

async function save() {
  writing = writing.then(async () => {
    await fs.mkdir(AUTH_DIR, { recursive: true });
    const tmp = `${OAUTH_FILE}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(db, null, 2) + '\n');
    await fs.rename(tmp, OAUTH_FILE);
  });
  return writing;
}

/** Public origin as the client sees it (tunnel-aware). */
export const baseUrl = (req) => `${req.headers['x-forwarded-proto'] || req.protocol || 'http'}://${req.headers.host}`;

/* ---------- discovery ---------- */

export function asMetadata(req) {
  const base = baseUrl(req);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
    // Shown by clients that render the server's brand on their connect / consent screen.
    logo_uri: `${base}/favicon.png`,
    service_documentation: base,
  };
}

export function resourceMetadata(req) {
  const base = baseUrl(req);
  return { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'] };
}

export const wwwAuthenticate = (req) =>
  `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource", error="invalid_token"`;

/* ---------- dynamic client registration ---------- */

export async function register(body) {
  const uris = (Array.isArray(body?.redirect_uris) ? body.redirect_uris : []).filter((u) => /^https?:\/\//.test(u));
  if (!uris.length) throw new Error('redirect_uris (http/https) are required');
  const client = {
    id: `mcp-${crypto.randomBytes(12).toString('hex')}`,
    name: String(body.client_name || 'MCP client').slice(0, 100),
    redirectUris: uris.slice(0, 10),
    createdAt: new Date().toISOString(),
  };
  db.clients.push(client);
  if (db.clients.length > 200) db.clients.splice(0, db.clients.length - 200);
  await save();
  return {
    client_id: client.id,
    client_name: client.name,
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  };
}

/* ---------- authorize: sign-in + consent page ---------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:'Segoe UI',system-ui,sans-serif;background:#f4f6f8;color:#1c2733;display:flex;justify-content:center;padding-top:8vh;margin:0}
.card{background:#fff;border:1px solid #dde3ea;border-radius:12px;padding:28px 30px;width:360px;box-shadow:0 8px 30px rgba(16,24,35,.08)}
h1{font-size:18px;margin:0 0 4px}p{color:#64748b;font-size:13.5px;margin:8px 0 16px}
input{width:100%;box-sizing:border-box;border:1px solid #dde3ea;border-radius:8px;padding:9px 11px;margin-bottom:10px;font:inherit}
button{width:100%;border:none;border-radius:8px;padding:10px;font:inherit;font-weight:600;cursor:pointer}
.primary{background:#0b5fff;color:#fff}.ghost{background:none;color:#64748b;margin-top:6px}
.err{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:8px;padding:8px 11px;font-size:13px;margin-bottom:12px}
.who{background:#f6f8fb;border:1px solid #dde3ea;border-radius:8px;padding:8px 11px;font-size:13px;margin-bottom:14px}</style>
</head><body><div class="card"><div style="font-weight:700;letter-spacing:.06em;margin-bottom:14px">FTD <span style="color:#64748b;font-weight:500">Documentation Console</span></div>${body}</div></body></html>`;
}

const hidden = (params) =>
  ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'response_type']
    .map((k) => `<input type="hidden" name="${k}" value="${esc(params[k] || '')}">`)
    .join('');

/** GET and POST /oauth/authorize. GET renders sign-in/consent; POST (from the page) issues the code. */
export async function authorize(req, res) {
  const params = { ...req.query, ...(req.body || {}) };
  const client = db.clients.find((c) => c.id === params.client_id);
  if (!client) return res.status(400).send(page('Error', `<h1>Unknown client</h1><p>client_id is not registered. Re-add the MCP connector so it registers itself.</p>`));
  if (!client.redirectUris.includes(params.redirect_uri)) return res.status(400).send(page('Error', `<h1>Bad redirect URI</h1><p>The redirect_uri does not match the client registration.</p>`));
  const deny = () => res.redirect(`${params.redirect_uri}${params.redirect_uri.includes('?') ? '&' : '?'}error=access_denied${params.state ? `&state=${encodeURIComponent(params.state)}` : ''}`);
  if (params.response_type !== 'code' || !params.code_challenge || params.code_challenge_method !== 'S256') {
    return res.status(400).send(page('Error', `<h1>Unsupported request</h1><p>response_type=code with PKCE (S256) is required.</p>`));
  }

  // who is asking — session cookie, or credentials posted from the sign-in form
  let user = req.user || null;
  let loginError = '';
  if (!user && req.method === 'POST' && params.email) {
    user = auth.authenticate(params.email, params.password);
    if (!user) loginError = 'Wrong e-mail or password.';
    else res.cookie(auth.COOKIE, auth.createSession(user), auth.cookieOptions());
  }

  if (req.method === 'POST' && params.action === 'deny') return deny();

  if (!user) {
    return res.status(loginError ? 401 : 200).send(
      page('Sign in', `<h1>Sign in to continue</h1><p><strong>${esc(client.name)}</strong> asks for access to the documentation MCP.</p>
${loginError ? `<div class="err">${esc(loginError)}</div>` : ''}
<form method="POST" action="/oauth/authorize">${hidden(params)}
<input name="email" type="email" placeholder="E-mail" required autofocus>
<input name="password" type="password" placeholder="Password" required>
<button class="primary">Sign in &amp; continue</button>
<button class="ghost" name="action" value="deny">Cancel</button></form>`)
    );
  }

  if (!auth.MCP_ROLES.includes(user.role)) {
    return res.status(403).send(
      page('Not allowed', `<h1>MCP access is not allowed for your role</h1>
<p>${esc(user.email)} is a <strong>${esc(user.role)}</strong>. Only administrators and moderators can connect agents. Ask an administrator to change your role.</p>
<form method="POST" action="/oauth/authorize">${hidden(params)}<button class="ghost" name="action" value="deny">Back to the app</button></form>`)
    );
  }

  if (req.method === 'POST' && params.action === 'approve') {
    const code = crypto.randomBytes(24).toString('base64url');
    codes.set(code, { clientId: client.id, redirectUri: params.redirect_uri, challenge: params.code_challenge, userId: user.id, exp: Date.now() + CODE_TTL });
    for (const [c, v] of codes) if (v.exp < Date.now()) codes.delete(c);
    const sep = params.redirect_uri.includes('?') ? '&' : '?';
    return res.redirect(`${params.redirect_uri}${sep}code=${code}${params.state ? `&state=${encodeURIComponent(params.state)}` : ''}`);
  }

  return res.send(
    page('Authorize', `<h1>Authorize ${esc(client.name)}</h1>
<p>The agent gets the same access you have in the console: reading and editing manuals over MCP.</p>
<div class="who">Signed in as <strong>${esc(user.email)}</strong> (${esc(user.role)})</div>
<form method="POST" action="/oauth/authorize">${hidden(params)}
<button class="primary" name="action" value="approve">Authorize</button>
<button class="ghost" name="action" value="deny">Deny</button></form>`)
  );
}

/* ---------- token endpoint ---------- */

const hashRefresh = (t) => crypto.createHash('sha256').update(t).digest('hex');

async function issueTokens(user, clientId) {
  const refresh = `ftr_${crypto.randomBytes(32).toString('hex')}`;
  db.refresh.push({ hash: hashRefresh(refresh), userId: user.id, clientId, exp: Date.now() + REFRESH_DAYS * 86400e3, createdAt: new Date().toISOString() });
  db.refresh = db.refresh.filter((r) => r.exp > Date.now()).slice(-500);
  await save();
  return {
    access_token: auth.createMcpAccessToken(user, ACCESS_TTL),
    token_type: 'Bearer',
    expires_in: ACCESS_TTL,
    refresh_token: refresh,
    scope: 'mcp',
  };
}

export async function token(req, res) {
  const p = req.body || {};
  const fail = (code, description, status = 400) => res.status(status).json({ error: code, error_description: description });
  if (p.grant_type === 'authorization_code') {
    const c = codes.get(p.code);
    codes.delete(p.code); // single use
    if (!c || c.exp < Date.now()) return fail('invalid_grant', 'Unknown or expired authorization code');
    if (c.clientId !== p.client_id || (p.redirect_uri && p.redirect_uri !== c.redirectUri)) return fail('invalid_grant', 'client_id / redirect_uri mismatch');
    if (!p.code_verifier || b64url(sha256(p.code_verifier)) !== c.challenge) return fail('invalid_grant', 'PKCE verification failed');
    const user = auth.userById(c.userId);
    if (!user || !auth.MCP_ROLES.includes(user.role)) return fail('invalid_grant', 'User no longer allowed');
    return res.json(await issueTokens(user, c.clientId));
  }
  if (p.grant_type === 'refresh_token') {
    const hash = hashRefresh(String(p.refresh_token || ''));
    const i = db.refresh.findIndex((r) => r.hash === hash);
    if (i < 0 || db.refresh[i].exp < Date.now()) return fail('invalid_grant', 'Unknown or expired refresh token');
    const rec = db.refresh.splice(i, 1)[0]; // rotate
    const user = auth.userById(rec.userId);
    if (!user || !auth.MCP_ROLES.includes(user.role)) {
      await save();
      return fail('invalid_grant', 'User no longer allowed');
    }
    return res.json(await issueTokens(user, rec.clientId));
  }
  return fail('unsupported_grant_type', 'Use authorization_code or refresh_token');
}

/** Drop a deleted user's refresh tokens (access tokens die by expiry within the hour). */
export async function dropUser(userId) {
  const before = db.refresh.length;
  db.refresh = db.refresh.filter((r) => r.userId !== userId);
  if (db.refresh.length !== before) await save();
}
