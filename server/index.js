import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import * as store from './store.js';
import * as ai from './ai.js';
import { blankContent } from './docgen.js';
import { handleMcpRequest, TOOLS as MCP_TOOLS } from './mcp.js';

const PORT = process.env.PORT || 5179;
const app = express();
app.use(express.json({ limit: '40mb' }));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e);
    res.status(400).json({ error: e.message || String(e) });
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

app.get('/api/modules/:slug/assets/:file', wrap(async (req, res) => {
  const buf = await store.getAsset(req.params.slug, req.params.file);
  if (!buf) return res.status(404).json({ error: 'Asset not found' });
  const ext = path.extname(req.params.file).toLowerCase();
  res.set('Content-Type', MIME[ext] || 'application/octet-stream');
  res.set('Cache-Control', 'no-cache');
  res.send(buf);
}));

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
  if (notes.length) result.reply = `${result.reply}\n\n${notes.join('\n')}`;
  res.json(result);
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
