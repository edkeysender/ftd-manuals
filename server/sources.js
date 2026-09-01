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
