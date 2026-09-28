/**
 * PDF export: the HTML export printed by the browser that is already on the machine.
 *
 * The export paginates itself with paged.js, so the pages in the PDF are the ones the console
 * lays out — the browser only prints what paged.js produced, adding no header, footer or margin
 * of its own. No new dependency: the Pi has /usr/bin/chromium, a workstation has Chrome or Edge.
 *
 * The browser is driven over its DevTools protocol rather than with --print-to-pdf, because that
 * switch prints on a timer: on a long manual it can fire while paged.js is still laying pages out
 * and produce a PDF that is short of pages without saying so. Here the page itself says when it
 * is done — the export script writes data-pages on <html> — and only then is the PDF taken.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Where a browser usually sits, per platform; FTD_CHROME overrides all of it. */
const CANDIDATES = {
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/snap/bin/chromium'],
};

let cached;
/** The browser this machine can print with, or null. Looked up once. */
export function findBrowser() {
  if (cached !== undefined) return cached;
  const wanted = process.env.FTD_CHROME;
  if (wanted) return (cached = existsSync(wanted) ? wanted : null);
  cached = (CANDIDATES[process.platform] || CANDIDATES.linux).find((p) => existsSync(p)) || null;
  return cached;
}

export const pdfAvailable = () => !!findBrowser();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastLines = (s) => s.trim().split('\n').slice(-2).join(' ');

/** Poll until the value is truthy, or the deadline passes. */
async function until(read, deadline) {
  while (Date.now() < deadline) {
    const v = await read();
    if (v) return v;
    await sleep(200);
  }
  return null;
}

/**
 * Render a self-contained HTML document (every picture already a data URI) to a PDF buffer.
 * Waits for the document to report the page count it settled on before printing.
 */
export async function htmlToPdf(html, { timeoutMs = 240000 } = {}) {
  const browser = findBrowser();
  if (!browser)
    throw Object.assign(
      new Error(
        'No browser to print with on this machine. Install Chromium or Chrome, or point FTD_CHROME at one; the HTML export prints to PDF from any browser meanwhile.'
      ),
      { code: 'no-browser' }
    );
  const dir = await mkdtemp(path.join(tmpdir(), 'ftd-pdf-'));
  const profile = path.join(dir, 'profile');
  const src = path.join(dir, 'export.html');
  const deadline = Date.now() + timeoutMs;
  let child = null;
  let cdp = null;
  try {
    await writeFile(src, html, 'utf8');
    child = spawn(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--mute-audio',
        `--user-data-dir=${profile}`,
        '--remote-debugging-port=0',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let stderr = '';
    let exited = null;
    child.stderr.on('data', (b) => {
      stderr += b.toString();
    });
    child.on('close', (code) => {
      exited = code;
    });
    child.on('error', (e) => {
      exited = -1;
      stderr += e.message;
    });

    // the port the browser picked is written into its profile once it is listening
    let port = null;
    while (!port && Date.now() < deadline) {
      if (exited !== null)
        throw new Error(`${path.basename(browser)} stopped before it was ready${stderr ? `: ${lastLines(stderr)}` : ''}`);
      port = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')
        .then((t) => Number(t.split('\n')[0]) || null)
        .catch(() => null);
      if (!port) await sleep(100);
    }
    if (!port) throw new Error('The browser did not start in time');

    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    cdp = new Cdp(version.webSocketDebuggerUrl);
    await cdp.ready;
    const { targetId } = await cdp.send('Target.createTarget', { url: pathToFileURL(src).href });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    // The export says it has finished by writing the page count it settled on. A document that
    // could not paginate (paged.js fell back to the flowing body) never will, so after the grace
    // period it is printed as it stands rather than failing.
    const settled = await until(
      () =>
        cdp
          .send('Runtime.evaluate', { expression: "document.documentElement.getAttribute('data-pages')", returnByValue: true }, sessionId)
          .then((r) => r.result.value),
      deadline
    );
    if (!settled) await sleep(2000);
    const { data } = await cdp.send(
      'Page.printToPDF',
      { printBackground: true, preferCSSPageSize: true, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0, transferMode: 'ReturnAsBase64' },
      sessionId
    );
    const pdf = Buffer.from(data, 'base64');
    if (pdf.length < 1000 || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('The browser produced no usable PDF');
    return pdf;
  } finally {
    cdp?.close();
    child?.kill();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The little bit of the DevTools protocol this needs: send a command, await its reply. */
class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.id = 0;
    this.waiting = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve());
      this.socket.addEventListener('error', () => reject(new Error('Lost the connection to the browser')));
    });
    this.socket.addEventListener('message', (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(`${msg.error.message} (${w.method})`));
      else w.resolve(msg.result);
    });
    this.socket.addEventListener('close', () => {
      for (const w of this.waiting.values()) w.reject(new Error('The browser closed while printing'));
      this.waiting.clear();
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() {
    try {
      this.socket.close();
    } catch {}
  }
}
