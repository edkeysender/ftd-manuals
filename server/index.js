import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import * as store from './store.js';
import * as ai from './ai.js';
import { blankContent } from './docgen.js';

const PORT = process.env.PORT || 5179;
const app = express();
app.use(express.json({ limit: '10mb' }));

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
      content = await ai.generateFirstDraft(input);
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

/* ---------- AI assistant (same actions available over the API) ---------- */
app.post('/api/ai/chat', wrap(async (req, res) => {
  const { slug, version, messages } = req.body;
  const d = await store.getDoc(slug, version);
  if (!d) throw new Error('Doc not found');
  const result = await ai.chatEdit({
    module: d.module,
    doc: d.doc,
    content: req.body.html ?? d.content,
    messages: messages || [],
  });
  res.json(result);
}));

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
