/**
 * HTTP surface of the schematics. Thin: every handler calls schematics-store.js and returns what it
 * gets. The owner is read from the route: /api/modules/:slug/… is a module, /api/installations/:slug/…
 * an installation (`inst:<slug>` to the store).
 */
import * as sch from './schematics-store.js';
import { renderSvg, schematicCsv } from './schematic-render.js';
import { schematicChat, attachmentsToText } from './schematic-ai.js';
import { expandDocuments } from './extract.js';
import { SchematicError } from './schematic.js';
import * as store from './store.js';
import * as ai from './ai.js';
import { DEFAULT_LANG, langOf } from './docgen.js';

/** Routes are registered with a path array, so `req.route.path` is that array — the URL says which owner it is. */
/** The readable text of a Word / PDF / PowerPoint file, through the inbox extractor (its <doc>.html), tags stripped. */
async function documentText({ name, buffer }) {
  const files = await expandDocuments([{ name, buffer }], { keepDocuments: false });
  const html = files.find((f) => /\.html$/i.test(f.name));
  return html ? html.buffer.toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

export const schematicRef = (req) => (String(req.originalUrl || req.url || '').startsWith('/api/installations/') ? sch.instRef(req.params.slug) : req.params.slug);
const paths = (suffix = '') => [`/api/modules/:slug/schematic${suffix}`, `/api/installations/:slug/schematic${suffix}`];

export function registerSchematicRoutes(app, { wrap, auth }) {
  // a refused op list is a 400 with the op index, so the UI can point at it
  const wrapOps = (fn) => wrap((req, res) =>
    Promise.resolve(fn(req, res)).catch((e) => {
      if (e instanceof SchematicError) throw Object.assign(e, { code: e.code || 'invalid-op' });
      throw e;
    })
  );

  /* ---- library ---- */
  app.get('/api/library', wrap(async (req, res) => res.json(await sch.getLibrary())));
  app.put('/api/library/connectors', wrap(async (req, res) => res.json(await sch.saveConnectors(req.body || {}))));
  app.post('/api/library/devices', wrap(async (req, res) => res.json(await sch.createDeviceTemplate(req.body || {}))));
  app.put('/api/library/devices/:id', wrap(async (req, res) => res.json(await sch.updateDeviceTemplate(req.params.id, req.body || {}))));
  app.delete('/api/library/devices/:id', wrap(async (req, res) => res.json(await sch.deleteDeviceTemplate(req.params.id))));
  app.post('/api/library/devices/:id/promote', wrap(async (req, res) => res.json(await sch.promoteDeviceToModule(req.params.id, req.body || {}))));

  /* ---- installations ---- */
  app.get('/api/installations', wrap(async (req, res) => res.json(await sch.listInstallations())));
  app.post('/api/installations', wrap(async (req, res) => res.json(await sch.createInstallation(req.body || {}))));
  app.get('/api/installations/:slug', wrap(async (req, res) => {
    const installation = await sch.getInstallation(req.params.slug);
    if (!installation) return res.status(404).json({ error: 'Installation not found' });
    const manuals = (await store.listManuals()).filter((m) => m.installation === req.params.slug).map((m) => ({ slug: m.slug, name: m.name }));
    res.json({ installation, schematic: await sch.getSchematic(sch.instRef(req.params.slug)), manuals });
  }));
  app.put('/api/installations/:slug', wrap(async (req, res) => res.json(await sch.updateInstallation(req.params.slug, req.body || {}))));
  app.delete('/api/installations/:slug', wrap(async (req, res) => res.json(await sch.deleteInstallation(req.params.slug))));

  /* ---- schematic of an owner ---- */
  app.post(paths('/discard'), auth.requireAdmin);
  app.get(paths(), wrap(async (req, res) => {
    const s = await sch.getSchematic(schematicRef(req));
    if (!s) return res.status(404).json({ error: 'No schematic', code: 'no-schematic' });
    res.json(s);
  }));
  app.post(paths(), wrap(async (req, res) => res.json(await sch.createSchematic(schematicRef(req), { bump: req.body?.bump || 'minor' }))));
  app.post(paths('/ops'), wrapOps(async (req, res) => {
    const { ops, summary, dryRun } = req.body || {};
    res.json(await sch.applySchematicOps(schematicRef(req), ops, { summary, dryRun: !!dryRun }));
  }));
  app.post(paths('/submit-review'), wrap(async (req, res) => res.json(await sch.setSchematicStatus(schematicRef(req), 'in-review'))));
  app.post(paths('/back-to-draft'), wrap(async (req, res) => res.json(await sch.setSchematicStatus(schematicRef(req), 'draft'))));
  app.post(paths('/release'), wrap(async (req, res) => res.json(await sch.releaseSchematic(schematicRef(req), { note: req.body?.note }))));
  app.put(paths('/release-note'), wrap(async (req, res) => res.json(await sch.setSchematicReleaseNote(schematicRef(req), req.body?.note))));
  app.post(paths('/hotfix'), wrap(async (req, res) => res.json(await sch.startSchematicHotfix(schematicRef(req)))));
  app.post(paths('/discard'), wrap(async (req, res) => res.json(await sch.discardSchematic(schematicRef(req)))));

  app.post(paths('/chat'), wrap(async (req, res) => {
    if (!ai.aiAvailable()) throw new Error('OPENAI_API_KEY is not set — the schematic chat is unavailable');
    const s = await sch.getSchematic(schematicRef(req));
    if (!s) throw new Error('No schematic — create one first');
    if (!s.editable) throw new Error(`Schematic ${s.state.version} is ${s.state.status} — start the next version or a hotfix to change it`);
    const ctx = await sch.schematicContext();
    // files dropped into the chat: text as it is, pictures through the vision model, Word/PDF through the extractor
    const { texts, notes } = await attachmentsToText(req.body?.attachments || [], { expand: documentText });
    const out = await schematicChat({ state: s.state, ctx, messages: req.body?.messages || [], guidelines: await store.getAiGuidelines(), lang: langOf(req.body?.lang || DEFAULT_LANG), attachments: texts });
    if (notes.length) out.note = [out.note, ...notes].filter(Boolean).join(' ');
    res.json(out);
  }));

  const pick = async (req) => {
    const s = await sch.getSchematic(schematicRef(req));
    if (!s) return null;
    return req.query.released ? s.released : s.state;
  };
  app.get(paths('/render.svg'), wrap(async (req, res) => {
    const state = await pick(req);
    if (!state) return res.status(404).json({ error: 'No schematic' });
    const ctx = await sch.schematicContext();
    res.set('Content-Type', 'image/svg+xml; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(await renderSvg(state, ctx, { lang: langOf(req.query.lang || DEFAULT_LANG), title: `${state.owner} ${state.version}` }));
  }));
  app.get(paths('/cables.csv'), wrap(async (req, res) => {
    const s = await sch.getSchematic(schematicRef(req));
    if (!s) return res.status(404).json({ error: 'No schematic' });
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${s.owner.slug}-cables.csv"`);
    res.send(schematicCsv(s.schedule));
  }));
}
