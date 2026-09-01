/**
 * Protected sources the console fetches on the agent's behalf — bytes never
 * pass through the model. Credentials live in .env:
 *
 *   ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN   Confluence Cloud (pages + attachments)
 *   FTD_URL_CREDENTIALS                     other hosts: "host=basic:user:pass;host2=bearer:TOKEN"
 *
 * `authHeadersFor(url)` is consulted by every server-side download, so a share
 * link on a configured host just works for upload_photo_from_url and the chat.
 */

const ATLASSIAN_HOST = /\.atlassian\.net$/i;

export function authHeadersFor(url) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return {};
  }
  for (const entry of (process.env.FTD_URL_CREDENTIALS || '').split(';')) {
    const eq = entry.indexOf('=');
    if (eq < 0) continue;
    const h = entry.slice(0, eq).trim().toLowerCase();
    const spec = entry.slice(eq + 1).trim();
    if (!h || !spec || !(host === h || host.endsWith(`.${h}`))) continue;
    const colon = spec.indexOf(':');
    const kind = spec.slice(0, colon).toLowerCase();
    const value = spec.slice(colon + 1);
    if (kind === 'basic') return { Authorization: `Basic ${Buffer.from(value).toString('base64')}` };
    if (kind === 'bearer') return { Authorization: `Bearer ${value}` };
  }
  if (ATLASSIAN_HOST.test(host) && confluenceConfigured()) {
    return { Authorization: `Basic ${Buffer.from(`${process.env.ATLASSIAN_EMAIL}:${process.env.ATLASSIAN_API_TOKEN}`).toString('base64')}` };
  }
  return {};
}

export const confluenceConfigured = () => !!(process.env.ATLASSIAN_EMAIL && process.env.ATLASSIAN_API_TOKEN);
export const isConfluenceUrl = (url) => {
  try {
    const u = new URL(url);
    return ATLASSIAN_HOST.test(u.hostname) && /^\/wiki\//.test(u.pathname);
  } catch {
    return false;
  }
};

/** { origin, pageId | tiny } from the page URL forms Confluence Cloud produces. */
export function parseConfluenceUrl(url) {
  const u = new URL(url);
  const origin = u.origin;
  let m = /\/wiki\/spaces\/[^/]+\/pages\/(\d+)/.exec(u.pathname);
  if (m) return { origin, pageId: m[1] };
  m = /\/wiki\/pages\/viewpage\.action/.exec(u.pathname);
  if (m && u.searchParams.get('pageId')) return { origin, pageId: u.searchParams.get('pageId') };
  m = /\/wiki\/x\/([A-Za-z0-9_-]+)/.exec(u.pathname);
  if (m) return { origin, tiny: m[1] };
  throw new Error(`Not a Confluence page URL: ${url}`);
}

async function atlassianJson(url) {
  const res = await fetch(url, { headers: { ...authHeadersFor(url), Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (res.status === 401 || res.status === 403) throw new Error(`Confluence refused the request (${res.status}) — check ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN and that the account can see the page`);
  if (!res.ok) throw new Error(`Confluence ${res.status} for ${url}`);
  return res.json();
}

const decodeEntities = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));

/**
 * Confluence storage format → readable text with structure markers the model can
 * work from: "## Heading", "- item", "1. step", table rows as "cell | cell", and
 * "[figure: file.png — alt]" where a picture sits. Returns { text, images }.
 */
export function storageToText(storage) {
  const images = [];
  let s = String(storage || '');
  // pictures: ac:image wrapping ri:attachment (or ri:url)
  s = s.replace(/<ac:image([^>]*)>([\s\S]*?)<\/ac:image>/gi, (_, attrs, inner) => {
    const file = (/ri:filename="([^"]+)"/i.exec(inner) || [])[1];
    const ext = (/ri:value="([^"]+)"/i.exec(inner) || [])[1];
    const alt = decodeEntities((/ac:alt="([^"]*)"/i.exec(attrs) || [])[1] || '');
    const name = file || ext || '';
    images.push({ filename: file || null, url: file ? null : ext || null, alt, index: images.length });
    return `\n[figure ${images.length}: ${name}${alt ? ` — ${alt}` : ''}]\n`;
  });
  // macros: keep the body (code, panels, expand, note) — drop parameters
  s = s.replace(/<ac:parameter[^>]*>[\s\S]*?<\/ac:parameter>/gi, '');
  s = s.replace(/<ac:structured-macro[^>]*ac:name="(code|noformat)"[^>]*>[\s\S]*?<ac:plain-text-body><!\[CDATA\[([\s\S]*?)\]\]><\/ac:plain-text-body>[\s\S]*?<\/ac:structured-macro>/gi, '\n```\n$2\n```\n');
  s = s.replace(/<ac:structured-macro[^>]*ac:name="toc"[^>]*>[\s\S]*?<\/ac:structured-macro>/gi, '');
  s = s.replace(/<\/?ac:(structured-macro|rich-text-body|plain-text-body|layout[^>]*|link|link-body|inline-comment-marker|placeholder|task[^>]*|emoticon)[^>]*>/gi, '');
  s = s.replace(/<ri:[^>]*>/gi, '');
  // block structure
  s = s.replace(/<h([1-6])[^>]*>/gi, (_, n) => `\n${'#'.repeat(+n + 1)} `).replace(/<\/h[1-6]>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '\n- ').replace(/<\/li>/gi, '');
  s = s.replace(/<\/(p|div|ul|ol|table|thead|tbody|blockquote)>/gi, '\n').replace(/<(p|div|ul|ol|table|blockquote)[^>]*>/gi, '\n');
  s = s.replace(/<\/tr>/gi, '\n').replace(/<\/t[dh]>/gi, ' | ').replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: s, images };
}

/**
 * Fetch a Confluence Cloud page: title, readable text, the figures in reading
 * order and the page's attachments (with authenticated download URLs).
 */
export async function fetchConfluencePage(url) {
  if (!confluenceConfigured()) {
    throw new Error('Confluence is not configured — set ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN in .env (create a token at https://id.atlassian.com/manage-profile/security/api-tokens)');
  }
  let { origin, pageId, tiny } = parseConfluenceUrl(url);
  if (!pageId) {
    const res = await fetch(`${origin}/wiki/x/${tiny}`, { headers: authHeadersFor(url), redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const loc = res.headers.get('location') || '';
    pageId = (/\/pages\/(\d+)/.exec(loc) || [])[1];
    if (!pageId) throw new Error(`Could not resolve the short link ${url}`);
  }
  const page = await atlassianJson(`${origin}/wiki/api/v2/pages/${pageId}?body-format=storage`);
  const att = await atlassianJson(`${origin}/wiki/api/v2/pages/${pageId}/attachments?limit=250`);
  const attachments = (att.results || []).map((a) => ({
    name: a.title,
    mediaType: a.mediaType || '',
    size: a.fileSize || 0,
    url: a.downloadLink ? `${origin}/wiki${a.downloadLink}` : null,
  }));
  const { text, images } = storageToText(page.body?.storage?.value || '');
  const byName = new Map(attachments.map((a) => [a.name, a]));
  const figures = images.map((im) => {
    const a = im.filename ? byName.get(im.filename) : null;
    return { index: im.index + 1, filename: im.filename, alt: im.alt, url: a?.url || im.url || null, mediaType: a?.mediaType || '', size: a?.size || 0 };
  });
  return {
    url: page._links?.webui ? `${origin}/wiki${page._links.webui}` : url,
    pageId,
    title: page.title || '',
    text,
    figures,
    attachments,
  };
}

/** Download a protected file; returns {name, buffer, mimeType} or null. */
export async function downloadWithAuth(url, name = null) {
  const res = await fetch(url, { headers: authHeadersFor(url), redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!res.ok) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length || buffer.length > 20 * 1024 * 1024) return null;
  const mimeType = (res.headers.get('content-type') || '').split(';')[0].trim();
  let fileName = name;
  if (!fileName) {
    try {
      fileName = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'file');
    } catch {
      fileName = 'file';
    }
  }
  return { name: fileName, buffer, mimeType };
}
