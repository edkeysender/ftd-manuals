import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import * as store from './store.js';
import * as ai from './ai.js';
import * as illustrate from './illustrate.js';
import {
  blankContent,
  manualBodyHtml,
  manualExportHtml,
  MANUAL_CSS,
  MANUAL_TYPES,
  MANUAL_ORDER,
  DEFAULT_MANUAL,
  manualTypeOf,
  MODULE_TYPES,
  moduleTypeOf,
  parseParts,
  LANGUAGES,
  DEFAULT_LANG,
  langOf,
} from './docgen.js';
import { handleMcpRequest, TOOLS as MCP_TOOLS } from './mcp.js';
import { GitTransientError } from './git.js';
import * as inbox from './inbox.js';
import * as images from './images.js';
import * as sources from './sources.js';
import { templateChecklist, checklistBodyHtml, fatProtocolBodyHtml, checklistExportHtml, CHECKLIST_CSS } from './checklist.js';
import * as auth from './auth.js';
import * as oauth from './oauth.js';

const PORT = process.env.PORT || 5179;
const app = express();
app.use(express.json({ limit: '40mb' }));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e);
    if (e instanceof GitTransientError) res.set('Retry-After', '1');
    res.status(e instanceof GitTransientError ? 503 : 400).json({ error: e.message || String(e) });
  });

/* ---------- login ----------
 * Every /api route needs a signed-in user (session cookie); DELETE requests and draft
 * discards additionally need the admin role. /mcp is separate (MCP_TOKEN, see below). */
app.use('/api', auth.attachUser);

app.post('/api/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const user = auth.authenticate(email, password);
  if (!user) return res.status(401).json({ error: 'Wrong e-mail or password', code: 'bad-credentials' });
  res.cookie(auth.COOKIE, auth.createSession(user), auth.cookieOptions());
  res.json({ user: auth.publicUser(user) });
}));

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(auth.COOKIE, { path: '/' });
  res.json({ ok: true });
});

/** Who am I — 401 when not signed in (the UI shows the login page on that). */
app.get('/api/auth/me', auth.requireAuth, (req, res) => res.json({ user: auth.publicUser(req.user) }));

app.use('/api', auth.requireAuth);
app.use('/api', auth.viewerGuard); // viewers read and comment in reviews, nothing else
app.delete('/api/*', auth.requireAdmin);
app.post('/api/modules/:slug/docs/:version/discard', auth.requireAdmin);

app.post('/api/auth/password', wrap(async (req, res) => {
  const { current, next } = req.body || {};
  res.json(await auth.changePassword(req.user, current, next));
}));

/* ---------- users (admin) ---------- */
app.get('/api/users', auth.requireAdmin, (req, res) => res.json(auth.listUsers()));
app.post('/api/users', auth.requireAdmin, wrap(async (req, res) => res.json(await auth.createUser(req.body || {}))));
app.put('/api/users/:id', auth.requireAdmin, wrap(async (req, res) => res.json(await auth.updateUser(req.params.id, req.body || {}))));
app.delete('/api/users/:id', wrap(async (req, res) => {
  const r = await auth.deleteUser(req.params.id, req.user);
  await oauth.dropUser(req.params.id); // their agents lose access within the hour
  res.json(r);
}));

/* ---------- status ---------- */
app.get('/api/status', wrap(async (req, res) => {
  res.json({ ...(await store.getStatus()), ai: ai.aiAvailable() });
}));

/* ---------- modules ---------- */
app.get('/api/modules', wrap(async (req, res) => {
  res.json(await store.listModules());
}));

/** The manual types a module can have (customer / technician, hardware / software) — for pickers. */
app.get('/api/manual-types', (req, res) => {
  res.json(MANUAL_ORDER.map((id) => MANUAL_TYPES[id]));
});

/** The FAT checklist belongs to one manual of the module: the technician manual when there is one
 *  (acceptance is done against installation + configuration), else the customer manual, else the
 *  software manuals in the same order. */
const FAT_ORDER = ['technician', 'customer', 'software-technician', 'software-customer'];
const fatManualOf = (manualIds) => FAT_ORDER.find((t) => manualIds.includes(t)) || manualIds[0];

/**
 * Build the starting content of one manual type for a module.
 * start: { mode: 'blank' | 'copy' | 'ai', sourceSlug?, sourceVersion? } — copy takes the source
 * module's latest Released doc of the same manual type (or the given version) and falls back to blank.
 * fat: { mode: 'template' | 'copy' | 'none' } | checklist object | null.
 * Returns { spec, aiNote } where spec feeds store.createModuleDoc / store.addManual.
 */
async function manualSpec(moduleInput, manualId, start, fat) {
  const type = manualTypeOf(manualId);
  const blank = () => blankContent(moduleInput.name, moduleInput.hardwareItems, type.id, moduleInput.softwares);
  const spec = { manual: type.id, content: null, checklist: null, revisionSeed: [], startSummary: null, copiedFrom: null };
  let aiNote = null;
  let src = null;

  if (start.mode === 'copy') {
    if (!start.sourceSlug) throw new Error('Copy: sourceSlug is required');
    let key = start.sourceVersion ? `${type.id}:${start.sourceVersion}` : null;
    if (!key) {
      const m = await store.getModule(start.sourceSlug);
      const rel = (m?.docs || []).find((d) => d.manual === type.id && d.status === 'released');
      key = rel ? rel.key : null;
    }
    src = key ? await store.getDoc(start.sourceSlug, key) : null;
    if (src && src.doc.status !== 'released') throw new Error('Source doc must be a Released doc version');
    if (src) {
      spec.content = src.content;
      spec.revisionSeed = (src.doc.revisionRecord || []).map((r) => ({ ...r, inherited: true }));
      spec.copiedFrom = { slug: start.sourceSlug, manual: src.doc.manual, version: src.doc.version };
      spec.startSummary = `Draft copied from ${start.sourceSlug} ${type.label.toLowerCase()} ${src.doc.version}`;
    } else {
      spec.content = blank();
      aiNote = `${start.sourceSlug} has no released ${type.label.toLowerCase()} to copy — created the blank template instead.`;
    }
  } else if (start.mode === 'ai') {
    try {
      spec.content = await ai.generateFirstDraft(moduleInput, await store.getAiGuidelines(), type.id);
      spec.startSummary = 'AI first draft';
    } catch (e) {
      spec.content = blank();
      aiNote = `AI draft of the ${type.label.toLowerCase()} failed (${e.message}) — created blank template instead.`;
    }
  } else {
    spec.content = blank();
  }

  if (fat && typeof fat === 'object' && Array.isArray(fat.phases)) spec.checklist = fat;
  else if (!fat || fat.mode === 'none') spec.checklist = null;
  else if (fat.mode === 'template') spec.checklist = templateChecklist(moduleInput);
  else if (fat.mode === 'copy') spec.checklist = src?.checklist || templateChecklist(moduleInput);
  return { spec, aiNote };
}

app.post('/api/modules', wrap(async (req, res) => {
  const input = req.body;
  if (!input.name) throw new Error('Module name is required');
  if (!['SIM', 'IOS', 'RACK'].includes(input.group)) throw new Error('Manual group must be SIM or IOS');

  // The module type decides which manuals are drafted: own-module / third-party-kit
  // (customer + technician), own-software (the software pair), module-software (all four).
  const mtype = input.type ? moduleTypeOf(input.type) : null;

  // Parts: "Płyta czołowa v1" (made, versioned) or "Encoder" (bought) — one per line.
  if (input.parts !== undefined) {
    input.hardware = [...(Array.isArray(input.hardware) ? input.hardware : []), ...parseParts(input.parts)];
  }

  // A 3rd-party module without parts IS its own bought part (a smoke detector, an
  // intercom set) — give it a catalog row so section 3 and the FAT header list it.
  if (mtype?.id === 'third-party-kit' && !(input.hardware || []).length) {
    input.hardware = [{ name: input.name.trim(), type: 'cots', model: input.code || '' }];
  }

  // Software relation: a single name from the modal ("— none —" omitted); a software
  // type without one gets a software named after the module.
  if (typeof input.software === 'string' && input.software.trim()) {
    input.softwares = [{ name: input.software.trim(), fromVersion: input.softwareFrom || '' }];
  }
  if (mtype?.needsSoftware && !(input.softwares || []).length) {
    await store.ensureSoftware(input.name.trim()); // created on the Software page like any software
    input.softwares = [{ name: input.name.trim(), fromVersion: '' }];
  }

  const manualIds = [
    ...new Set(
      (Array.isArray(input.manuals) && input.manuals.length ? input.manuals : mtype ? mtype.manuals : [DEFAULT_MANUAL]).map(
        (m) => manualTypeOf(m).id
      )
    ),
  ];

  const start = input.start || { mode: 'blank' };
  // Hardware: catalog ids and/or new items — resolved (not yet written) so the
  // template, the AI draft and the FAT checklist see the same units.
  input.hardwareItems = await store.previewHardware(input, input.name);

  // FAT checklist: { mode: 'template' | 'copy' | 'none' } or a full checklist object — on one manual only.
  const fatManual = fatManualOf(manualIds);
  const notes = [];
  const specs = [];
  for (const id of manualIds) {
    const { spec, aiNote } = await manualSpec(input, id, start, id === fatManual ? input.checklist : null);
    specs.push(spec);
    if (aiNote) notes.push(aiNote);
  }

  const created = await store.createModuleDoc(input, specs);
  res.json({ ...created, aiNote: notes.length ? notes.join(' ') : null });
}));

app.get('/api/modules/:slug', wrap(async (req, res) => {
  const m = await store.getModule(req.params.slug);
  if (!m) return res.status(404).json({ error: 'Module not found' });
  res.json(m);
}));

/** Module metadata: name, code, category, group, softwares, hardware (catalog ids and/or new items). */
app.patch('/api/modules/:slug', wrap(async (req, res) => {
  const patch = req.body || {};
  if (patch.group !== undefined && !['SIM', 'IOS', 'RACK'].includes(patch.group)) {
    throw new Error('Manual group must be SIM, IOS or RACK');
  }
  res.json(await store.updateModule(req.params.slug, patch));
}));

/* ---------- hardware catalog ---------- */
app.get('/api/hardware', wrap(async (req, res) => {
  res.json(await store.listHardware());
}));

app.post('/api/hardware', wrap(async (req, res) => {
  res.json(await store.createHardware(req.body || {}));
}));

app.put('/api/hardware/:id', wrap(async (req, res) => {
  res.json(await store.updateHardware(req.params.id, req.body || {}));
}));

app.delete('/api/hardware/:id', wrap(async (req, res) => {
  res.json(await store.deleteHardware(req.params.id));
}));

/**
 * New doc draft of one manual type. When the module has no doc of that type yet this
 * creates its A1.0 (with `start` and `checklist` like the wizard); otherwise the next
 * version (`bump`: minor | major) based on the latest released content.
 */
app.post('/api/modules/:slug/docs', wrap(async (req, res) => {
  const body = req.body || {};
  const type = manualTypeOf(body.manual || DEFAULT_MANUAL);
  const m = await store.getModule(req.params.slug);
  if (!m) throw new Error('Module not found');
  if (m.docs.some((d) => d.manual === type.id)) {
    return res.json(await store.createNextDocVersion(req.params.slug, type.id, body.bump || 'minor'));
  }
  const moduleInput = { ...m.module, hardwareItems: m.module.hardwareItems || [] };
  const { spec, aiNote } = await manualSpec(moduleInput, type.id, body.start || { mode: 'blank' }, body.checklist || null);
  const created = await store.addManual(req.params.slug, spec);
  res.json({ ...created, aiNote });
}));

/* ---------- docs ---------- */
/** ?lang=pl returns the Polish body (content '' when not translated yet) and Polish generated sections. */
app.get('/api/modules/:slug/docs/:version', wrap(async (req, res) => {
  const d = await store.getDoc(req.params.slug, req.params.version, { lang: req.query.lang || DEFAULT_LANG });
  if (!d) return res.status(404).json({ error: 'Doc not found' });
  res.json(d);
}));

/** The languages a doc can have; English is the source, the others are translations. */
app.get('/api/languages', (req, res) => res.json(Object.values(LANGUAGES)));

app.put('/api/modules/:slug/docs/:version/content', wrap(async (req, res) => {
  const { html, bump, summary, lang } = req.body;
  if (typeof html !== 'string') throw new Error('html is required');
  res.json(await store.saveDraftContent(req.params.slug, req.params.version, html, { bump, summary, lang: lang || DEFAULT_LANG }));
}));

/**
 * Translate the English body into `lang` with the AI (replaces an existing translation) and
 * return the doc as GET ?lang= would. `html` may be given instead to store a translation made
 * elsewhere (no AI call).
 */
app.post('/api/modules/:slug/docs/:version/translate', wrap(async (req, res) => {
  const lang = langOf(req.body?.lang || 'pl');
  const d = await store.getDoc(req.params.slug, req.params.version);
  if (!d) throw new Error('Doc not found');
  if (!(d.doc.status === 'draft' || d.doc.status === 'in-review')) throw new Error('Translations are added to a Draft or In-review doc version');
  let html = req.body?.html;
  let source = 'manual';
  if (typeof html !== 'string' || !html.trim()) {
    if (!d.content.trim()) throw new Error('The English body is empty — nothing to translate');
    html = await ai.translateHtml({ html: d.content, lang, module: d.module, doc: d.doc, guidelines: await store.getAiGuidelines() });
    source = 'ai';
  }
  await store.saveTranslation(req.params.slug, req.params.version, lang, html, { source, summary: req.body?.summary });
  res.json(await store.getDoc(req.params.slug, req.params.version, { lang }));
}));

/* ---------- FAT checklist (per doc version) ---------- */
async function fatRenderOpts() {
  const logo = await store.getBrandLogo();
  return { logoUrl: logo ? `/api/settings/logo?v=${encodeURIComponent(logo.name)}` : null };
}

/** Replace the console-served logo URL with a data URI so the export is self-contained. */
async function inlineLogo(html) {
  const logo = await store.getBrandLogo();
  if (!logo) return html;
  const mime = MIME[path.extname(logo.name).toLowerCase()] || 'application/octet-stream';
  return html.replace(/\/api\/settings\/logo(\?[^"' >)]*)?/g, `data:${mime};base64,${logo.buffer.toString('base64')}`);
}

/* ---------- review comments (per doc version, on the draft branch) ---------- */
app.get('/api/modules/:slug/docs/:version/comments', wrap(async (req, res) => {
  const r = await store.listComments(req.params.slug, req.params.version);
  if (!r) return res.status(404).json({ error: 'Doc not found' });
  res.json(r.threads);
}));

app.post('/api/modules/:slug/docs/:version/comments', wrap(async (req, res) => {
  res.json(await store.addComment(req.params.slug, req.params.version, req.body || {}));
}));

app.post('/api/modules/:slug/docs/:version/comments/:id/replies', wrap(async (req, res) => {
  res.json(await store.replyComment(req.params.slug, req.params.version, req.params.id, req.body || {}));
}));

/** body: {status: 'resolved'|'open', author?, note?, revision?} */
app.put('/api/modules/:slug/docs/:version/comments/:id', wrap(async (req, res) => {
  const { status, author, note, revision } = req.body || {};
  res.json(await store.setCommentStatus(req.params.slug, req.params.version, req.params.id, status, { author, note, revision }));
}));

app.delete('/api/modules/:slug/docs/:version/comments/:id', wrap(async (req, res) => {
  res.json(await store.deleteComment(req.params.slug, req.params.version, req.params.id));
}));

app.get('/api/modules/:slug/docs/:version/checklist', wrap(async (req, res) => {
  const r = await store.getChecklist(req.params.slug, req.params.version);
  if (!r) return res.status(404).json({ error: 'Doc not found' });
  const opts = await fatRenderOpts();
  res.json({
    checklist: r.checklist,
    template: templateChecklist(r.module),
    css: CHECKLIST_CSS,
    html: r.checklist ? checklistBodyHtml(r.module, r.doc, r.checklist, opts) : null,
  });
}));

app.put('/api/modules/:slug/docs/:version/checklist', wrap(async (req, res) => {
  const { checklist, summary } = req.body;
  if (checklist !== null && typeof checklist !== 'object') throw new Error('checklist must be an object or null');
  res.json(await store.saveChecklist(req.params.slug, req.params.version, checklist, { summary }));
}));

app.get('/api/modules/:slug/docs/:version/checklist.html', wrap(async (req, res) => {
  const r = await store.getChecklist(req.params.slug, req.params.version);
  if (!r) return res.status(404).json({ error: 'Doc not found' });
  if (!r.checklist) return res.status(404).json({ error: 'This doc version has no FAT checklist' });
  const html = await inlineLogo(
    checklistExportHtml(`FAT ${r.module.code || r.module.slug} ${r.doc.version}`, checklistBodyHtml(r.module, r.doc, r.checklist, await fatRenderOpts()))
  );
  res.set('Content-Type', 'text/html; charset=utf-8');
  if (req.query.download !== undefined) {
    res.set('Content-Disposition', `attachment; filename="${r.module.slug}-${r.doc.version}-fat.html"`);
  }
  res.send(html);
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

/** Software page: every software with its linked modules, their software manuals and release coverage. */
app.get('/api/software', wrap(async (req, res) => {
  res.json(await store.listSoftware());
}));

/** Create a software: {name, version?, manualAffecting?, note?, modules?: [{slug, fromVersion?}], ownManual?: {group?}}
 *  ownManual → the software also gets its own manual (an own-software module named after it; result.ownModule). */
app.post('/api/software', wrap(async (req, res) => {
  res.json(await store.createSoftware(req.body || {}));
}));

/** The own manual of an existing software: an own-software module named after it, linked to it,
 *  with blank software customer + technician drafts. {group?: SIM|IOS, fromVersion?} */
app.post('/api/software/:name/own-manual', wrap(async (req, res) => {
  const { group, fromVersion } = req.body || {};
  res.json(await store.createOwnSoftwareModule(req.params.name, { group: group || 'SIM', fromVersion: fromVersion || '' }));
}));

/** Delete a module: its draft branches, its folder on main and its chapter in every manual. */
app.delete('/api/modules/:slug', wrap(async (req, res) => {
  res.json(await store.deleteModule(req.params.slug));
}));

/** Repair a software known from module links only: merge it into a registered one — {into}. */
app.post('/api/software/:name/merge', wrap(async (req, res) => {
  res.json(await store.mergeSoftware(req.params.name, (req.body || {}).into));
}));

/** Delete a software: unlinked from every module, dropped from the feed with its releases. */
app.delete('/api/software/:name', wrap(async (req, res) => {
  res.json(await store.deleteSoftware(req.params.name));
}));

/** Link / unlink a software on a module: {name, fromVersion?} | {name, unlink: true} */
app.post('/api/modules/:slug/software', wrap(async (req, res) => {
  const { name, fromVersion, unlink } = req.body || {};
  res.json(unlink ? await store.unlinkSoftware(req.params.slug, name) : await store.linkSoftware(req.params.slug, name, fromVersion));
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
  // attachments — files the reader downloads from the manual
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.cfg': 'text/plain; charset=utf-8',
  '.conf': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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
  // ?w=320 → resized variant (same format); falls back to the original for SVG/PDF
  const w = parseInt(req.query.w, 10);
  if (w > 0) {
    try {
      const r = await images.resizeSameFormat(buf, w);
      if (r) {
        res.set('Content-Type', r.mimeType);
        res.set('Cache-Control', 'private, max-age=300');
        return res.send(r.buffer);
      }
    } catch (e) {
      console.error('asset resize failed:', e.message);
    }
  }
  res.set('Content-Type', MIME[ext] || 'application/octet-stream');
  res.set('Cache-Control', 'no-cache');
  if (store.assetKind(req.params.file) === 'attachment') {
    // A download, never a page: the reader gets the file, the browser does not render it.
    res.set('Content-Disposition', `attachment; filename="${req.params.file.replace(/["\r\n]/g, '')}"`);
    res.set('X-Content-Type-Options', 'nosniff');
  }
  res.send(buf);
});

app.get('/api/modules/:slug/assets', wrap(async (req, res) => {
  res.json(await store.listAssets(req.params.slug));
}));

app.delete('/api/modules/:slug/docs/:version/assets/:file', wrap(async (req, res) => {
  res.json(await store.deleteAsset(req.params.slug, req.params.version, req.params.file));
}));

/** Version stamp of one asset: {appliesTo: [hardware ids]} and/or {verify: true} (re-stamp as current). */
app.put('/api/modules/:slug/docs/:version/assets/:file/meta', wrap(async (req, res) => {
  const { appliesTo, verify } = req.body || {};
  res.json(await store.setAssetMeta(req.params.slug, req.params.version, req.params.file, { appliesTo, verify: !!verify }));
}));

/* ---------- inbox: drop folder on the console machine, imported into drafts by name ---------- */
app.get('/api/inbox', wrap(async (req, res) => {
  res.json({ dir: inbox.INBOX_DIR, roots: inbox.IMPORT_ROOTS, files: await inbox.listInbox() });
}));

app.post('/api/inbox', wrap(async (req, res) => {
  const files = (req.body.files || [])
    .map((f) => ({ name: f.name, buffer: Buffer.from(f.dataBase64 || '', 'base64') }))
    .filter((f) => f.buffer.length > 0);
  if (!files.length) throw new Error('No files provided');
  res.json(await inbox.saveToInbox(files));
}));

app.get('/api/inbox/:file', wrap(async (req, res) => {
  const f = await inbox.readInbox(req.params.file);
  if (!f) return res.status(404).json({ error: 'Not in inbox' });
  res.set('Content-Type', MIME[path.extname(f.name).toLowerCase()] || 'application/octet-stream');
  res.set('Cache-Control', 'no-cache');
  res.send(f.buffer);
}));

app.delete('/api/inbox/:file', wrap(async (req, res) => {
  await inbox.deleteInbox(req.params.file);
  res.json({ ok: true });
}));

app.post('/api/modules/:slug/docs/:version/assets/import', wrap(async (req, res) => {
  const names = req.body.names || [];
  if (!names.length) throw new Error('names is required');
  res.json(await store.importFromInbox(req.params.slug, req.params.version, names, { keep: !!req.body.keep }));
}));

app.post('/api/modules/:slug/docs/:version/assets', wrap(async (req, res) => {
  const files = (req.body.files || [])
    .map((f) => ({ name: f.name, buffer: Buffer.from(f.dataBase64 || '', 'base64') }))
    .filter((f) => f.buffer.length > 0);
  if (!files.length) throw new Error('No files provided');
  // attachments: true — keep every file as it is (the editor's paste / drop of non-image files)
  res.json(await store.saveAssets(req.params.slug, req.params.version, files, { attachments: !!req.body.attachments }));
}));

/* ---------- photo → house-style line-art (same engine as the AI chat and MCP) ---------- */
app.post('/api/modules/:slug/docs/:version/illustrate', wrap(async (req, res) => {
  const { name, dataBase64, assetName, instructions, outputName, keepSource, editOf } = req.body || {};
  const d = await store.getDoc(req.params.slug, req.params.version);
  if (!d) throw new Error('Doc not found');
  if (!(d.doc.status === 'draft' || d.doc.status === 'in-review')) throw new Error('Illustrations are added to a Draft or In-review doc version');
  const reference = assetName
    ? { assetName }
    : dataBase64
      ? { name: name || 'photo.png', buffer: Buffer.from(dataBase64 || '', 'base64') }
      : null;
  if (!reference && !editOf) throw new Error('No image data');
  if (reference?.buffer && !reference.buffer.length) throw new Error('No image data');
  if (reference?.buffer && reference.buffer.length > 20 * 1024 * 1024) throw new Error('Image is larger than 20 MB');
  res.json(
    await illustrate.convertToLineArt({
      slug: req.params.slug,
      version: req.params.version,
      reference,
      instructions: instructions || '',
      name: outputName || null,
      keepSource: keepSource !== false,
      editOf: editOf || null,
    })
  );
}));

/* ---------- AI assistant (same actions available over the API and MCP) ---------- */
app.post('/api/ai/chat', wrap(async (req, res) => {
  const { slug, version, messages, attachments } = req.body;
  const lang = langOf(req.body.lang || DEFAULT_LANG);
  const d = await store.getDoc(slug, version, { lang });
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
      const downloads = await Promise.allSettled(page.images.slice(0, 8).map((img) => ai.downloadImage(img.url, { headers: sources.authHeadersFor(img.url) })));
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
    if (!ctx.assets.some((x) => x.url === a.url)) ctx.assets.push({ url: a.url, name: a.name, kind: a.kind, alt: '', from: 'asset store', version: store.describeAssetVersion(a) });
  }

  const result = await ai.chatEdit({
    module: d.module,
    doc: d.doc,
    content: req.body.html ?? d.content,
    messages: messages || [],
    context: ctx,
    guidelines: await store.getAiGuidelines(),
    illustrationStyle: await illustrate.getStyle(),
    lang,
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
      const prompt =
        gi.style === 'line-art' || !gi.prompt
          ? illustrate.lineArtPrompt(await illustrate.getStyle(), gi.prompt || '', { hasReference: !!reference })
          : gi.prompt;
      const buffer = await ai.generateImage({ prompt, reference });
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

  // 5. Module-data changes the model asked for (the generated section 3.2 "Software relation"):
  //    software links go to the module, covered releases to this doc; then sections 1–3 are
  //    re-rendered so the editor can swap them in.
  let dataChanged = false;
  const mu = result.moduleUpdate;
  if (editable && mu && Array.isArray(mu.softwares)) {
    const softwares = mu.softwares
      .filter((s) => s && typeof s.name === 'string' && s.name.trim())
      .map((s) => ({ name: s.name.trim(), fromVersion: String(s.from_version ?? s.fromVersion ?? '').trim() }));
    try {
      await store.updateModule(slug, { softwares });
      dataChanged = true;
      notes.push(`Software relation updated: ${softwares.map((s) => `${s.name}${s.fromVersion ? ` from ${s.fromVersion}` : ''}`).join(', ') || 'no software linked'}.`);
    } catch (e) {
      notes.push(`Software relation not updated: ${e.message}`);
    }
  }
  for (const c of editable ? result.coverReleases || [] : []) {
    try {
      await store.linkReleaseToDoc(slug, version, String(c.name), String(c.version));
      dataChanged = true;
      notes.push(`This doc now covers ${c.name} ${c.version}.`);
    } catch (e) {
      notes.push(`Could not cover ${c.name} ${c.version}: ${e.message}`);
    }
  }
  delete result.moduleUpdate;
  delete result.coverReleases;
  if (dataChanged) {
    const fresh = await store.getDoc(slug, version, { lang });
    if (fresh) Object.assign(result, { generated: fresh.generated, module: fresh.module, doc: fresh.doc });
  }

  if (notes.length) result.reply = `${result.reply}\n\n${notes.join('\n')}`;
  res.json(result);
}));

/* ---------- manuals ---------- */
app.get('/api/manuals', wrap(async (req, res) => {
  const manuals = await store.listManuals();
  const modules = await store.listModules();
  res.json(
    manuals.map((m) => {
      const type = manualTypeOf(m.manual).id;
      return {
        ...m,
        manual: type,
        moduleNames: m.modules.map((s) => modules.find((x) => x.slug === s)?.name || s),
        // chapters whose doc of this manual type is not released (or does not exist)
        unreleased: m.modules.filter((s) => {
          const mod = modules.find((x) => x.slug === s);
          return !mod || !mod.manuals[type] || !mod.manuals[type].released;
        }).length,
      };
    })
  );
}));

app.post('/api/manuals', wrap(async (req, res) => {
  res.json(await store.createManual(req.body));
}));

// Import a simulator configuration file: one manual per "simulator" / "ios" section.
app.post('/api/manuals/import', wrap(async (req, res) => {
  const { replace, config, ...rest } = req.body || {};
  res.json(await store.importManuals(config || rest, { replace: !!replace }));
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
  const compiled = await store.compileManual(req.params.slug, { lang: req.query.lang || DEFAULT_LANG });
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

// Speech to text for the editor chat box (a short clip recorded in the browser).
app.post('/api/transcribe', wrap(async (req, res) => {
  const buffer = Buffer.from(req.body.dataBase64 || '', 'base64');
  if (!buffer.length) throw new Error('No audio data');
  res.json({ text: await ai.transcribe(buffer, req.body.name || 'speech.webm', req.body.lang || '') });
}));

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
  const compiled = await store.compileManual(req.params.slug, { lang: req.query.lang || DEFAULT_LANG });
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
    res.set('Content-Disposition', `attachment; filename="${compiled.manual.slug}${compiled.lang && compiled.lang !== DEFAULT_LANG ? `-${compiled.lang}` : ''}.html"`);
  }
  res.send(html);
}));

// FAT protocol: the checklists of every module in the manual as one standalone document.
app.get('/api/manuals/:slug/fat.html', wrap(async (req, res) => {
  const compiled = await store.compileManual(req.params.slug);
  if (!compiled) return res.status(404).json({ error: 'Manual not found' });
  const html = await inlineLogo(
    checklistExportHtml(`FAT protocol — ${compiled.manual.name}`, fatProtocolBodyHtml(compiled, await fatRenderOpts()))
  );
  res.set('Content-Type', 'text/html; charset=utf-8');
  if (req.query.download !== undefined) {
    res.set('Content-Disposition', `attachment; filename="${compiled.manual.slug}-fat.html"`);
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

app.get('/api/settings/illustration-style', wrap(async (req, res) => {
  const saved = await store.getIllustrationStyle();
  res.json({
    name: illustrate.STYLE_NAME,
    style: saved || illustrate.DEFAULT_STYLE,
    isDefault: !saved,
    defaultStyle: illustrate.DEFAULT_STYLE,
    exemplars: await store.listStyleExemplars(),
    imageModel: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2',
  });
}));

// Style exemplars: finished house-style illustrations the image model is shown with every photo.
app.get('/api/settings/illustration-style/exemplars/:name', wrap(async (req, res) => sendImage(res, await store.getStyleExemplar(req.params.name))));

app.post('/api/settings/illustration-style/exemplars', wrap(async (req, res) => {
  const files = (req.body.files || [])
    .map((f) => ({ name: f.name || 'exemplar.png', buffer: Buffer.from(f.dataBase64 || '', 'base64') }))
    .filter((f) => f.buffer.length > 0);
  if (!files.length) throw new Error('No files provided');
  if ((await store.listStyleExemplars()).length + files.length > 6) throw new Error('At most 6 exemplars — the image model takes a limited number of input images');
  res.json(await store.saveStyleExemplars(files));
}));

app.delete('/api/settings/illustration-style/exemplars/:name', wrap(async (req, res) => {
  await store.deleteStyleExemplar(req.params.name);
  res.json({ ok: true });
}));

app.put('/api/settings/illustration-style', wrap(async (req, res) => {
  await store.saveIllustrationStyle(req.body.style || '');
  res.json({ ok: true });
}));

app.put('/api/settings/ai', wrap(async (req, res) => {
  await store.saveAiGuidelines(req.body.guidelines || '');
  res.json({ ok: true });
}));

/* ---------- MCP (Model Context Protocol) endpoint ---------- */
// Optional protection for public tunnels: set MCP_TOKEN in .env and clients
// must send  Authorization: Bearer <token>.
/* ---------- OAuth for MCP: discovery, registration, consent, tokens ---------- */
app.get('/.well-known/oauth-authorization-server', (req, res) => res.json(oauth.asMetadata(req)));
app.get('/.well-known/oauth-authorization-server/mcp', (req, res) => res.json(oauth.asMetadata(req)));
app.get('/.well-known/oauth-protected-resource', (req, res) => res.json(oauth.resourceMetadata(req)));
app.get('/.well-known/oauth-protected-resource/mcp', (req, res) => res.json(oauth.resourceMetadata(req)));
app.use('/oauth', express.urlencoded({ extended: false }), auth.attachUser);
app.post('/oauth/register', wrap(async (req, res) => res.status(201).json(await oauth.register(req.body))));
app.get('/oauth/authorize', wrap(oauth.authorize));
app.post('/oauth/authorize', wrap(oauth.authorize));
app.post('/oauth/token', wrap(oauth.token));

/* The MCP endpoint accepts OAuth access tokens (admin + moderator only); MCP_TOKEN in .env
 * stays as a master token for local tooling. 401s point clients at the discovery documents. */
app.use('/mcp', (req, res, next) => {
  const master = process.env.MCP_TOKEN;
  if (master && req.headers.authorization === `Bearer ${master}`) return next();
  const user = auth.verifyMcpAccessToken(req.headers.authorization);
  if (!user) {
    res.set('WWW-Authenticate', oauth.wwwAuthenticate(req));
    return res.status(401).json({
      error: 'Unauthorized — connect through the OAuth flow (sign in as an administrator or moderator when your MCP client opens the authorization page).',
    });
  }
  req.user = user;
  next();
});

const runMcp = (req, res) => {
  handleMcpRequest(req, res).catch((e) => {
    console.error('MCP error:', e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });
};

app.post('/mcp', runMcp);
app.get('/mcp', (req, res) => res.status(405).json({ error: 'Stateless MCP endpoint — use POST' }));
app.delete('/mcp', (req, res) => res.status(405).json({ error: 'Stateless MCP endpoint — use POST' }));


app.get('/api/mcp-info', (req, res) => {
  res.json({
    endpoint: `http://localhost:${PORT}/mcp`,
    transport: 'streamable-http (stateless)',
    authRequired: true,
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
await oauth.initOAuth();
await inbox.ensureInbox();
await auth.initAuth();
app.listen(PORT, () => {
  console.log(`FTD Documentation Console API on http://localhost:${PORT}`);
  if (!ai.aiAvailable()) console.log('Note: OPENAI_API_KEY not set — AI assistant disabled.');
});
