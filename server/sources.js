/**
 * Credentials for server-side downloads from protected hosts — so a share link
 * on the company NAS or an internal web server can be fetched by the console
 * without the bytes passing through the model. Optional; in .env:
 *
 *   FTD_URL_CREDENTIALS="host=basic:user:pass;other.host=bearer:TOKEN"
 *
 * Hosts match exactly or by suffix (sub.domain matches "domain"). Every
 * server-side download (upload_photo_from_url, URLs pasted into the AI chat)
 * consults authHeadersFor(url).
 */
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
  return {};
}

const FILE_HEADERS = { 'User-Agent': 'FTD-Docs-Console/1.0 (+server-side fetch)', Accept: '*/*' };
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Download any file (picture, Word / PowerPoint / PDF / zip …) from a URL, with the per-host
 * credentials above. Returns {name, buffer, type}; the name comes from Content-Disposition, else
 * the URL path. Throws on HTTP errors and on files over 64 MB.
 */
export async function fetchFile(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Not a valid URL');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http(s) URLs can be fetched');
  const res = await fetch(url, { headers: { ...FILE_HEADERS, ...authHeadersFor(url) }, redirect: 'follow', signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${parsed.hostname} answered ${res.status} ${res.statusText}${res.status === 401 || res.status === 403 ? ' — configure credentials for this host in .env FTD_URL_CREDENTIALS' : ''}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_FILE_BYTES) throw new Error(`File is ${Math.round(len / 1048576)} MB — the limit is 64 MB`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('The URL returned an empty body');
  if (buffer.length > MAX_FILE_BYTES) throw new Error('File is larger than 64 MB');
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  let name = '';
  const cd = res.headers.get('content-disposition') || '';
  const star = cd.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  const plain = cd.match(/filename="?([^";]+)"?/i);
  if (star) name = decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
  else if (plain) name = plain[1].trim();
  if (!name) {
    try {
      name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
    } catch {
      name = '';
    }
  }
  if (!name || !/\.[a-z0-9]{2,5}$/i.test(name)) {
    const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'application/pdf': '.pdf', 'application/zip': '.zip',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx' }[type] || '';
    name = (name || 'download') + ext;
  }
  return { name, buffer, type };
}
