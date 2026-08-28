import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import * as store from './store.js';
import * as ai from './ai.js';
import { blankContent, manualBodyHtml, manualExportHtml, MANUAL_CSS } from './docgen.js';
import { handleMcpRequest, TOOLS as MCP_TOOLS } from './mcp.js';
import { GitTransientError } from './git.js';

const PORT = process.env.PORT || 5179;
const app = express();
app.use(express.json({ limit: '40mb' }));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e);
    if (e instanceof GitTransientError) res.set('Retry-After', '1');
    res.status(e instanceof GitTransientError ? 503 : 400).json({ error: e.message || String(e) });
  });

/* ---------- status ---------- */
app.get('/api/status', wrap(async (req, res) => {
  res.json({ ...(await store.getStatus()), ai: ai.aiAvailable() });
}));

/* ---------- modules ---------- */
app.get('/api/modules', wrap(async (req, res) => {
  res.json(await store.listModules());
}));

app.post('/api/modules', wrap(async (req, res) => {
  const input = req.body;
  if (!input.name) throw new Error('Module name is required');
  if (!['SIM', 'IOS', 'RACK'].includes(input.group)) throw new Error('Manual group must be SIM, IOS or RACK');

  let content;
  let seed = [];
  let aiNote = null;
  const start = input.start || { mode: 'blank' };

  if (start.mode === 'copy') {
    const src = await store.getDoc(start.sourceSlug, start.sourceVersion);
    if (!src || src.doc.status !== 'released') throw new Error('Source doc must be a Released doc version');
    content = src.content;
    seed = (src.doc.revisionRecord || []).map((r) => ({ ...r, inherited: true }));
    input.copiedFrom = { slug: start.sourceSlug, version: start.sourceVersion };
    input.startSummary = `Draft copied from ${start.sourceSlug} ${start.sourceVersion}`;
  } else if (start.mode === 'ai') {
    try {
      content = await ai.generateFirstDraft(input, await store.getAiGuidelines());
      input.startSummary = 'AI first draft';
    } catch (e) {
      content = blankContent(input.name);
      aiNote = `AI draft failed (${e.message}) — created blank template instead.`;
    }
  } else {
    content = blankContent(input.name);
  }

  const created = await store.createModuleDoc(input, content, seed);
  res.json({ ...created, aiNote });
}));

app.get('/api/modules/:slug', wrap(async (req, res) => {
  const m = await store.getModule(req.params.slug);
  if (!m) return res.status(404).json({ error: 'Module not found' });
  res.json(m);
}));

app.post('/api/modules/:slug/docs', wrap(async (req, res) => {
  res.json(await store.createNextDocVersion(req.params.slug, req.body.bump || 'minor'));
}));

/* ---------- docs ---------- */
app.get('/api/modules/:slug/docs/:version', wrap(async (req, res) => {
  const d = await store.getDoc(req.params.slug, req.params.version);
  if (!d) return res.status(404).json({ error: 'Doc not found' });
  res.json(d);
}));

app.put('/api/modules/:slug/docs/:version/content', wrap(async (req, res) => {
  const { html, bump, summary } = req.body;
  if (typeof html !== 'string') throw new Error('html is required');
  res.json(await store.saveDraftContent(req.params.slug, req.params.version, html, { bump, summary }));
}));

app.post('/api/modules/:slug/docs/:version/submit-review', wrap(async (req, res) => {
  res.json(await store.setDocStatus(req.params.slug, req.params.version, 'in-review'));
}));

app.post('/api/modules/:slug/docs/:version/back-to-draft', wrap(async (req, res) => {
  res.json(await store.setDocStatus(req.params.slug, req.params.version, 'draft'));
}));

app.post('/api/modules/:slug/docs/:version/release', wrap(async (req, res) => {
  res.json(await store.releaseDoc(req.params.slug, req.params.version));
}));

app.post('/api/modules/:slug/docs/:version/discard', wrap(async (req, res) => {
  await store.discardDraft(req.params.slug, req.params.version);
  res.json({ ok: true });
}));

/* ---------- software release feed ---------- */
app.get('/api/softwares', wrap(async (req, res) => {
  res.json(await store.getSoftwareFeed());
}));

app.post('/api/softwares', wrap(async (req, res) => {
  res.json(await store.registerSoftwareRelease(req.body));
}));

app.post('/api/modules/:slug/docs/:version/cover', wrap(async (req, res) => {
  const { name, version: swVersion } = req.body;
  res.json(await store.linkReleaseToDoc(req.params.slug, req.params.version, name, swVersion));
}));

/* ---------- assets ---------- */
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
};

app.get('/api/modules/:slug/assets/:file', async (req, res) => {
  let buf;
  try {
    buf = await store.getAsset(req.params.slug, req.params.file);
  } catch (e) {
    // A failed read must never look like the image: explicit 503 + JSON.
    console.error('asset read failed:', e.message);
    res.set('Retry-After', '1');
    return res.status(503).json({ error: 'Asset temporarily unavailable: ' + e.message });
  }
  if (!buf) return res.status(404).json({ error: 'Asset not found' });
  const ext = path.extname(req.params.file).toLowerCase();
  res.set('Content-Type', MIME[ext] || 'application/octet-stream');
  res.set('Cache-Control', 'no-cache');
  res.send(buf);
});

app.get('/api/modules/:slug/assets', wrap(async (req, res) => {
  res.json(await store.listAssets(req.params.slug));
}));

app.post('/api/modules/:slug/docs/:version/assets', wrap(async (req, res) => {
  const files = (req.body.files || [])
    .map((f) => ({ name: f.name, buffer: Buffer.from(f.dataBase64 || '', 'base64') }))
    .filter((f) => f.buffer.length > 0);
  if (!files.length) throw new Error('No files provided');
  res.json(await store.saveAssets(req.params.slug, req.params.version, files));
}));

/* ---------- AI assistant (same actions available over the API and MCP) ---------- */
app.post('/api/ai/chat', wrap(async (req, res) => {
  const { slug, version, messages, attachments } = req.body;
  const d = await store.getDoc(slug, version);
  if (!d) throw new Error('Doc not found');
  const editable = d.doc.status === 'draft' || d.doc.status === 'in-review';

  const notes = [];
  const ctx = { pages: [], assets: [], attachmentsText: [] };
  const uploads = [];

  // 1. Chat attachments: images go to the asset store, text files become context.
  for (const a of attachments || []) {
    const buffer = Buffer.from(a.dataBase64 || '', 'base64');
    if (!buffer.length) continue;
    if ((a.type || '').startsWith('image/') || /\.(png|jpe?g|gif|svg|webp)$/i.test(a.name || '')) {
      uploads.push({ name: a.name || 'image', buffer, from: 'chat attachment' });
    } else if (buffer.length <= 300 * 1024) {
      ctx.attachmentsText.push({ name: a.name || 'file', text: buffer.toString('utf8').slice(0, 15000) });
    } else {
      notes.push(`Attachment "${a.name}" skipped — only images and small text files are supported.`);
    }
  }

  // 2. URLs in the latest user message: fetch page text and download its images.
  const lastUser = [...(messages || [])].reverse().find((m) => m.role === 'user');
  for (const url of ai.extractUrls(lastUser?.content || '')) {
    try {
      const page = await ai.fetchPage(url);
      ctx.pages.push(page);
      const downloads = await Promise.allSettled(page.images.slice(0, 8).map((img) => ai.downloadImage(img.url)));
      downloads.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value) {
          uploads.push({ ...r.value, alt: page.images[i].alt, from: url });
        }
      });
    } catch (e) {
      notes.push(`Could not fetch ${url}: ${e.message}`);
    }
  }

  // 3. Commit new files to the draft branch, then list everything available.
  if (uploads.length && editable) {
    const saved = await store.saveAssets(slug, version, uploads);
    saved.forEach((s, i) => ctx.assets.push({ url: s.url, alt: uploads[i].alt || '', from: uploads[i].from || '' }));
  }
  for (const a of await store.listAssets(slug)) {
    if (!ctx.assets.some((x) => x.url === a.url)) ctx.assets.push({ url: a.url, alt: '', from: 'asset store' });
  }

  const result = await ai.chatEdit({
    module: d.module,
    doc: d.doc,
    content: req.body.html ?? d.content,
    messages: messages || [],
    context: ctx,
    guidelines: await store.getAiGuidelines(),
  });

  // 4. Generate any illustrations the model requested, before returning the
  //    edit — the html already references them by name.
  for (const gi of result.generateImages || []) {
    if (!editable) break;
    try {
      let reference = null;
      if (gi.reference_asset) {
        const buf = await store.getAsset(slug, gi.reference_asset);
        if (buf) reference = { name: gi.reference_asset, buffer: buf };
      }
      const buffer = await ai.generateImage({ prompt: gi.prompt, reference });
      const [saved] = await store.saveAssets(slug, version, [{ name: gi.name, buffer }]);
      // Keep the html consistent if sanitization changed the file name.
      if (result.html && saved.name !== gi.name) {
        result.html = result.html.split(`assets/${gi.name}`).join(`assets/${saved.name}`);
      }
      notes.push(`Generated ${saved.name}${gi.reference_asset ? ` from ${gi.reference_asset}` : ''}.`);
    } catch (e) {
      notes.push(`Image generation failed for ${gi.name}: ${e.message}`);
    }
  }
  delete result.generateImages;

  if (notes.length) result.reply = `${result.reply}\n\n${notes.join('\n')}`;
  res.json(result);
}));

/* ---------- manuals ---------- */
app.get('/api/manuals', wrap(async (req, res) => {
  const manuals = await store.listManuals();
  const modules = await store.listModules();
  res.json(
    manuals.map((m) => ({
      ...m,
      moduleNames: m.modules.map((s) => modules.find((x) => x.slug === s)?.name || s),
      unreleased: m.modules.filter((s) => {
        const mod = modules.find((x) => x.slug === s);
        return !mod || mod.status !== 'released';
      }).length,
    }))
  );
}));

app.post('/api/manuals', wrap(async (req, res) => {
  res.json(await store.createManual(req.body));
}));

async function manualRenderOpts(slug, manual) {
  const logo = await store.getBrandLogo();
  const cover = await store.getManualCover(slug);
  return {
    logoUrl: logo ? `/api/settings/logo?v=${encodeURIComponent(logo.name)}` : null,
    coverUrl: cover ? `/api/manuals/${slug}/cover?v=${encodeURIComponent(manual.updatedAt || '')}` : null,
  };
}

app.get('/api/manuals/:slug', wrap(async (req, res) => {
  const compiled = await store.compileManual(req.params.slug);
  if (!compiled) return res.status(404).json({ error: 'Manual not found' });
  const opts = await manualRenderOpts(req.params.slug, compiled.manual);
  res.json({ ...compiled, hasCover: !!opts.coverUrl, hasLogo: !!opts.logoUrl, css: MANUAL_CSS, html: manualBodyHtml(compiled, opts) });
}));

function sendImage(res, file) {
  if (!file) return res.status(404).json({ error: 'Not found' });
  res.set('Content-Type', MIME[path.extname(file.name).toLowerCase()] || 'application/octet-stream');
  res.set('Cache-Control', 'no-cache');
  res.send(file.buffer);
}

app.get('/api/manuals/:slug/cover', wrap(async (req, res) => sendImage(res, await store.getManualCover(req.params.slug))));

app.post('/api/manuals/:slug/cover', wrap(async (req, res) => {
  const buffer = Buffer.from(req.body.dataBase64 || '', 'base64');
  if (!buffer.length) throw new Error('No image data');
  if (!(await store.getManual(req.params.slug))) throw new Error('Manual not found');
  res.json(await store.saveManualCover(req.params.slug, req.body.name || 'cover.png', buffer));
}));

app.get('/api/settings/logo', wrap(async (req, res) => sendImage(res, await store.getBrandLogo())));

app.post('/api/settings/logo', wrap(async (req, res) => {
  const buffer = Buffer.from(req.body.dataBase64 || '', 'base64');
  if (!buffer.length) throw new Error('No image data');
  res.json(await store.saveBrandLogo(req.body.name || 'logo.png', buffer));
}));

app.put('/api/manuals/:slug', wrap(async (req, res) => {
  res.json(await store.updateManual(req.params.slug, req.body));
}));

app.delete('/api/manuals/:slug', wrap(async (req, res) => {
  await store.deleteManual(req.params.slug);
  res.json({ ok: true });
}));

// Standalone HTML export with images inlined as data URIs.
app.get('/api/manuals/:slug/export.html', wrap(async (req, res) => {
  const compiled = await store.compileManual(req.params.slug);
  if (!compiled) return res.status(404).json({ error: 'Manual not found' });
  const opts = await manualRenderOpts(req.params.slug, compiled.manual);
  let html = manualExportHtml(compiled, opts);
  // Inline every console-served image (module assets, logo, cover) as a data URI.
  const refs = [...new Set([...html.matchAll(/\/api\/(?:modules\/[^/"']+\/assets\/[^"' >)?]+|settings\/logo|manuals\/[^/"']+\/cover)(?:\?[^"' >)]*)?/g)].map((m) => m[0]))];
  for (const ref of refs) {
    const clean = ref.split('?')[0];
    let file = null;
    let m;
    if ((m = /^\/api\/modules\/([^/]+)\/assets\/(.+)$/.exec(clean))) {
      const name = decodeURIComponent(m[2]);
      const buf = await store.getAsset(m[1], name);
      if (buf) file = { name, buffer: buf };
    } else if (clean === '/api/settings/logo') {
      file = await store.getBrandLogo();
    } else if ((m = /^\/api\/manuals\/([^/]+)\/cover$/.exec(clean))) {
      file = await store.getManualCover(m[1]);
    }
    if (!file) continue;
    const mime = MIME[path.extname(file.name).toLowerCase()] || 'application/octet-stream';
    html = html.split(ref).join(`data:${mime};base64,${file.buffer.toString('base64')}`);
  }
  res.set('Content-Type', 'text/html; charset=utf-8');
  if (req.query.download !== undefined) {
    res.set('Content-Disposition', `attachment; filename="${compiled.manual.slug}.html"`);
  }
  res.send(html);
}));

/* ---------- settings ---------- */
app.get('/api/settings/ai', wrap(async (req, res) => {
  res.json({
    guidelines: await store.getAiGuidelines(),
    model: process.env.OPENAI_MODEL || 'gpt-5',
    reasoningEffort: process.env.OPENAI_REASONING_EFFORT || 'low',
    available: ai.aiAvailable(),
  });
}));

app.put('/api/settings/ai', wrap(async (req, res) => {
  await store.saveAiGuidelines(req.body.guidelines || '');
  res.json({ ok: true });
}));

/* ---------- MCP (Model Context Protocol) endpoint ---------- */
// Optional protection for public tunnels: set MCP_TOKEN in .env and clients
// must send  Authorization: Bearer <token>.
app.use('/mcp', (req, res, next) => {
  const token = process.env.MCP_TOKEN;
  if (token && req.headers.authorization !== `Bearer ${token}`) {
    return res.status(401).json({ error: 'Unauthorized — send Authorization: Bearer <MCP_TOKEN>' });
  }
  next();
});

app.post('/mcp', (req, res) => {
  handleMcpRequest(req, res).catch((e) => {
    console.error('MCP error:', e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });
});
app.get('/mcp', (req, res) => res.status(405).json({ error: 'Stateless MCP endpoint — use POST' }));
app.delete('/mcp', (req, res) => res.status(405).json({ error: 'Stateless MCP endpoint — use POST' }));

app.get('/api/mcp-info', (req, res) => {
  res.json({
    endpoint: `http://localhost:${PORT}/mcp`,
    transport: 'streamable-http (stateless)',
    authRequired: !!process.env.MCP_TOKEN,
    tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description })),
  });
});

/* ---------- static frontend (production build) ---------- */
const dist = path.resolve('web', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

await store.initStore();
app.listen(PORT, () => {
  console.log(`FTD Documentation Console API on http://localhost:${PORT}`);
  if (!ai.aiAvailable()) console.log('Note: OPENAI_API_KEY not set — AI assistant disabled.');
});
