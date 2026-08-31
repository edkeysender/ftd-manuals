/**
 * MCP server for the Documentation Console — lets an external agent (Claude
 * Code, Claude.ai, any MCP client) search modules, read and edit drafts,
 * upload photos, generate illustrations and create new modules, using the
 * same store as the UI. Stateless Streamable HTTP endpoint at POST /mcp.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as store from './store.js';
import * as ai from './ai.js';
import * as illustrate from './illustrate.js';
import { blankContent } from './docgen.js';
import { templateChecklist } from './checklist.js';
import * as inbox from './inbox.js';

const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const SLUG_VER = {
  slug: { type: 'string', description: 'Module slug, e.g. starting-panel' },
  version: { type: 'string', description: 'Doc version, e.g. A1.0 (must be Draft or In review)' },
};

export const TOOLS = [
  {
    name: 'search_modules',
    description:
      'List modules, optionally filtered by a query matched against name, code, slug, category and linked software names. Returns list rows with latest doc version and status.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Optional filter text' } } },
    annotations: { title: 'Search modules', ...RO },
  },
  {
    name: 'get_module',
    description: 'Get one module: metadata, all doc versions with statuses, history and software release feed.',
    inputSchema: { type: 'object', properties: { slug: SLUG_VER.slug }, required: ['slug'] },
    annotations: { title: 'Get module', ...RO },
  },
  {
    name: 'get_doc',
    description:
      'Get a doc version of a module: metadata, revision record, the editable body HTML (sections 4–7) and its FAT checklist (null when none). Omit version for the latest one.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: SLUG_VER.slug,
        version: { type: 'string', description: 'e.g. A1.0; omit for latest' },
        include_assets: { type: 'boolean', description: 'Also return the module assets list (saves a list_assets call)' },
      },
      required: ['slug'],
    },
    annotations: { title: 'Get doc', ...RO },
  },
  {
    name: 'list_assets',
    description:
      "List the files in a module's assets folder with their served URLs (use these URLs in <img src>). Each entry carries `meta` — the version stamp taken when the file was added (doc version, newest software release per linked software, hardware unit versions, appliesTo hardware ids; null for files added before stamping) — and `stale`: reasons the picture may be out of date (a newer manual-affecting software release or a changed hardware version). Do not embed stale assets for new content without telling the user; fix stamps with update_asset.",
    inputSchema: { type: 'object', properties: { slug: SLUG_VER.slug }, required: ['slug'] },
    annotations: { title: 'List assets', ...RO },
  },
  {
    name: 'create_module',
    description:
      'Create a new module with its first doc draft A1.0 r1 on a draft/<slug>-a1.0 branch (same as the New module doc wizard). Returns slug, version and branch. Edit the body afterwards with save_doc_content / replace_in_doc / insert_into_section.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        code: { type: 'string', description: 'Module code like SW-STP' },
        category: { type: 'string', enum: ['software', 'cockpit-hardware', 'structure', 'peripherals', 'rack'] },
        group: { type: 'string', enum: ['SIM', 'IOS', 'RACK'], description: 'Which simulator manual it compiles into' },
        hardware: {
          type: 'array',
          description:
            'Hardware units this module describes, from the shared catalog (list_hardware). Each entry is either {id} of an existing catalog item or a new item {name, type:"ftd"|"cots", version (ftd) | manufacturer, model (cots), notes} which is added to the catalog. Several entries when one manual covers several unit types (e.g. three camera models). Omit for no hardware.',
          items: { type: 'object' },
        },
        softwares: {
          type: 'array',
          items: { type: 'object', properties: { name: { type: 'string' }, fromVersion: { type: 'string' } }, required: ['name'] },
        },
        content_html: { type: 'string', description: 'Optional starting body HTML (sections 4–7). Defaults to the blank FTD template.' },
        checklist: {
          type: 'string',
          enum: ['template', 'none'],
          description: 'FAT (factory acceptance test) checklist: "template" seeds one from the category template (default), "none" creates the module without one.',
        },
      },
      required: ['name', 'group'],
    },
    annotations: { title: 'Create module', ...RW },
  },
  {
    name: 'update_module',
    description:
      'Edit module metadata: name, code, category, group, hardware units, linked softwares. Only the fields given are changed. "hardware" replaces the whole assignment: an array of {id} (catalog item) or new items {name, type, version | manufacturer, model, notes}; [] unassigns all.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: SLUG_VER.slug,
        name: { type: 'string' },
        code: { type: 'string' },
        category: { type: 'string', enum: ['software', 'cockpit-hardware', 'structure', 'peripherals', 'rack'] },
        group: { type: 'string', enum: ['SIM', 'IOS', 'RACK'] },
        hardware: { type: 'array', items: { type: 'object' } },
        softwares: { type: 'array', items: { type: 'object' } },
      },
      required: ['slug'],
    },
    annotations: { title: 'Update module', ...RW },
  },
  {
    name: 'list_hardware',
    description:
      'The shared hardware catalog: every unit type a module manual can describe ({id, name, type ftd|cots, version | manufacturer, model, notes}) with the modules using it. Assign with create_module / update_module "hardware": [{id}].',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'List hardware', ...RO },
  },
  {
    name: 'create_hardware',
    description:
      'Add a unit type to the hardware catalog without assigning it. type "ftd" = FTD.aero build (give version), "cots" = bought (give manufacturer, model).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unit name as it appears in manuals, e.g. "Cockpit camera — PTZ"' },
        type: { type: 'string', enum: ['ftd', 'cots'] },
        version: { type: 'string' },
        manufacturer: { type: 'string' },
        model: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['name', 'type'],
    },
    annotations: { title: 'Create hardware', ...RW },
  },
  {
    name: 'update_hardware',
    description: 'Edit a hardware catalog item (name, type, version, manufacturer, model, notes). Only the fields given change; every module using it sees the change.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        type: { type: 'string', enum: ['ftd', 'cots'] },
        version: { type: 'string' },
        manufacturer: { type: 'string' },
        model: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['id'],
    },
    annotations: { title: 'Update hardware', ...RW },
  },
  {
    name: 'save_doc_content',
    description:
      'Replace the whole body HTML (sections 4–7: <h2>Installation</h2>, Operation, Maintenance, Appendixes) of a Draft/In-review doc. Allowed HTML: h2, h3, p, ol, ul, li, strong, em, table, figure/img/figcaption, <div class="admonition warning|note"><p class="admonition-title">…</p>…</div>. Commits on the draft branch and bumps the revision (r1 → r2 …) with the summary in the revision record. Prefer replace_in_doc or insert_into_section for small changes.',
    inputSchema: {
      type: 'object',
      properties: { ...SLUG_VER, html: { type: 'string' }, summary: { type: 'string', description: 'Revision record entry' } },
      required: ['slug', 'version', 'html'],
    },
    annotations: { title: 'Save doc content', ...RW },
  },
  {
    name: 'replace_in_doc',
    description:
      'Edit part of the body HTML: replace an exact substring of the current body (get it with get_doc) with new HTML. Fails if the substring is not found or is ambiguous. Bumps the revision. For several changes at once use edit_doc (one call, one revision).',
    inputSchema: {
      type: 'object',
      properties: {
        ...SLUG_VER,
        find: { type: 'string', description: 'Exact substring of the current body HTML' },
        replace: { type: 'string', description: 'Replacement HTML (empty string deletes)' },
        summary: { type: 'string' },
      },
      required: ['slug', 'version', 'find', 'replace'],
    },
    annotations: { title: 'Replace in doc', ...RW },
  },
  {
    name: 'insert_into_section',
    description:
      'Append (or prepend) HTML inside one of the body sections — Installation, Operation, Maintenance or Appendixes — without touching the rest. Use it to add a paragraph, a procedure, a warning or a <figure> with an uploaded image. Bumps the revision. For several changes at once use edit_doc (one call, one revision).',
    inputSchema: {
      type: 'object',
      properties: {
        ...SLUG_VER,
        section: { type: 'string', description: 'Section title as in its <h2>, e.g. Installation' },
        html: { type: 'string' },
        position: { type: 'string', enum: ['end', 'start'], description: 'Default end' },
        summary: { type: 'string' },
      },
      required: ['slug', 'version', 'section', 'html'],
    },
    annotations: { title: 'Insert into section', ...RW },
  },
  {
    name: 'edit_doc',
    description:
      'Apply MANY edits to a Draft/In-review doc body in ONE call: a list of replace ({find, replace}) and insert ({section, html, position}) operations, applied in order to the current body, committed once with a single revision bump. Prefer this over repeated replace_in_doc / insert_into_section calls — it keeps the number of tool calls per task low. Atomic: if any edit fails (text not found / ambiguous, unknown section) nothing is saved and the error names the failing edit index.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SLUG_VER,
        edits: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              find: { type: 'string', description: 'replace op: exact substring of the current body HTML' },
              replace: { type: 'string', description: 'replace op: replacement HTML (empty string deletes)' },
              section: { type: 'string', description: 'insert op: section <h2> title, e.g. Operation' },
              html: { type: 'string', description: 'insert op: HTML to insert' },
              position: { type: 'string', enum: ['end', 'start'], description: 'insert op: default end' },
            },
          },
        },
        summary: { type: 'string', description: 'Revision record entry for the whole batch' },
      },
      required: ['slug', 'version', 'edits'],
    },
    annotations: { title: 'Edit doc (batch)', ...RW },
  },
  {
    name: 'import_local_files',
    description:
      "Import files into the module draft's assets folder WITHOUT any bytes passing through the model — the way to add real photos and artwork. Give bare file names to take them from the console INBOX (the drop folder users fill from the Assets tab; see list_inbox), or absolute paths / a folder inside one of the allowed import roots. Imported inbox files are removed from the inbox unless keep_in_inbox is true. Every file is validated (complete PNG/JPEG/…); returns the served URLs to use in <img src>.",
    inputSchema: {
      type: 'object',
      properties: {
        ...SLUG_VER,
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Inbox file names (e.g. ["cbw-operation.png"]) or absolute paths / a folder inside an allowed import root',
        },
        keep_in_inbox: { type: 'boolean', description: 'Leave imported files in the inbox (default: remove them)' },
      },
      required: ['slug', 'version', 'paths'],
    },
    annotations: { title: 'Import local files', ...RW },
  },
  {
    name: 'list_inbox',
    description:
      'List the console inbox: files the user dropped on the console machine, waiting to be attached to a module (name, size, type, pixel size, complete). Import them with import_local_files by bare name. Ask the user to drop files into the inbox (Module → Assets tab) when artwork is needed.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'List inbox', ...RO },
  },
  {
    name: 'delete_asset',
    description: "Remove a file from a Draft/In-review doc's assets (git rm + commit on the draft branch). Use it to clean up a broken or superseded upload; make sure no <img> in the body still references it.",
    inputSchema: { type: 'object', properties: { ...SLUG_VER, name: { type: 'string', description: 'Asset file name as in list_assets' } }, required: ['slug', 'version', 'name'] },
    annotations: { title: 'Delete asset', ...RW, destructiveHint: true },
  },
  {
    name: 'update_asset',
    description:
      "Edit an asset's version stamp on the draft branch. `applies_to`: which of the module's hardware units (catalog ids, see get_module) the picture shows — [] means every unit; give it when a manual covers several unit types. `verify: true` re-stamps the asset with today's newest software releases and hardware versions, i.e. the author confirmed the picture is still correct (or replaced it) after a manual-affecting change — use it to clear `stale`.",
    inputSchema: {
      type: 'object',
      properties: {
        ...SLUG_VER,
        name: { type: 'string', description: 'Asset file name as in list_assets' },
        applies_to: { type: 'array', items: { type: 'string' }, description: 'Hardware ids this picture shows; [] = all' },
        verify: { type: 'boolean', description: 'Re-stamp as current (clears stale)' },
      },
      required: ['slug', 'version', 'name'],
    },
    annotations: { title: 'Update asset stamp', ...RW },
  },
  {
    name: 'upload_photo',
    description:
      "Upload a SMALL image (a few KB) from base64 data into the module draft's assets folder. Do not use it for real photos — tens of thousands of base64 characters cannot be emitted reliably in one call, and the server now REJECTS truncated or mislabelled files. Use the inbox + import_local_files (no bytes through the model), upload_photo_from_url (public URL) or generate_illustration instead. Returns the served URL.",
    inputSchema: {
      type: 'object',
      properties: {
        ...SLUG_VER,
        name: { type: 'string', description: 'File name including extension' },
        data_base64: { type: 'string', description: 'File content, base64-encoded' },
      },
      required: ['slug', 'version', 'name', 'data_base64'],
    },
    annotations: { title: 'Upload photo (base64)', ...RW },
  },
  {
    name: 'upload_photo_from_url',
    description:
      "Download an image from a public URL into the module draft's assets folder (the console fetches it — no need to pass bytes). Returns the served URL to use in <img src=\"…\">.",
    inputSchema: {
      type: 'object',
      properties: {
        ...SLUG_VER,
        url: { type: 'string', description: 'Public http(s) URL of the image' },
        name: { type: 'string', description: 'Optional file name; defaults to the URL file name' },
      },
      required: ['slug', 'version', 'url'],
    },
    annotations: { title: 'Upload photo from URL', ...RW, openWorldHint: true },
  },
  {
    name: 'generate_illustration',
    description:
      'Generate an illustration with the image model and store it as a module asset. With style "line-art" the console prepends the FTD.aero house style ("Technical Aviation Manual Line-Art", editable in Settings) so the prompt only needs to describe the subject and callouts; otherwise give the full style in the prompt. Optionally name an existing asset (e.g. a photo) as visual reference so the drawing is based on it. Returns the served URL.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SLUG_VER,
        name: { type: 'string', description: 'Output file name, e.g. st-622-mounting-lineart.png' },
        prompt: { type: 'string' },
        style: { type: 'string', enum: ['line-art'], description: 'Apply the house style definition automatically' },
        reference_asset: { type: 'string', description: 'Optional existing asset file name to base the image on' },
      },
      required: ['slug', 'version', 'name', 'prompt'],
    },
    annotations: { title: 'Generate illustration', ...RW, openWorldHint: true },
  },
  {
    name: 'convert_to_line_art',
    description:
      'Redraw an existing asset photo as an FTD.aero house-style illustration ("Technical Aviation Manual Line-Art") and store it as <photo-stem>-lineart.png in the draft — the same conversion the editor drop target performs. Optional instructions add emphasis (e.g. "number the three latches, arrow showing the pull direction"). Returns the source and illustration URLs; embed the illustration as <figure><img src=URL></figure>.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SLUG_VER,
        reference_asset: { type: 'string', description: 'Photo asset file name (see list_assets); optional when edit_of is given' },
        edit_of: { type: 'string', description: 'Existing illustration asset to modify in place (iterate on a drawing instead of redrawing the photo)' },
        instructions: { type: 'string', description: 'Optional extra instructions / requested changes' },
        name: { type: 'string', description: 'Optional output file name (default <stem>-lineart.png, or the edited file name)' },
      },
      required: ['slug', 'version'],
    },
    annotations: { title: 'Convert photo to line-art', ...RW, openWorldHint: true },
  },
  {
    name: 'save_checklist',
    description:
      'Replace the FAT (factory acceptance test) checklist of a Draft/In-review doc version in one call, or remove it with checklist: null. Shape: {enabled, phases:[{title, items:[{id?, check, expected, type:"check"|"measure"|"record", unit?, ref?, mandatory?}]}]} — ids are assigned automatically when omitted; ref should name the manual section the check comes from (e.g. "Operation"). Bumps the revision. Read the current one with get_doc; use get_checklist_template for the category starting point.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SLUG_VER,
        checklist: { type: ['object', 'null'] },
        summary: { type: 'string', description: 'Revision record entry' },
      },
      required: ['slug', 'version', 'checklist'],
    },
    annotations: { title: 'Save FAT checklist', ...RW },
  },
  {
    name: 'get_checklist_template',
    description: 'The FAT checklist template the console would generate for a module (from its category, hardware relation and linked softwares) — a starting point to refine with save_checklist.',
    inputSchema: { type: 'object', properties: { slug: SLUG_VER.slug }, required: ['slug'] },
    annotations: { title: 'FAT checklist template', ...RO },
  },
  {
    name: 'submit_for_review',
    description: 'Mark a Draft doc version as In review.',
    inputSchema: { type: 'object', properties: SLUG_VER, required: ['slug', 'version'] },
    annotations: { title: 'Submit for review', ...RW },
  },
  {
    name: 'release_doc',
    description:
      'Release an In-review doc version: merges the draft branch to main, freezes the revision counter and supersedes older released versions.',
    inputSchema: { type: 'object', properties: SLUG_VER, required: ['slug', 'version'] },
    annotations: { title: 'Release doc', ...RW, idempotentHint: true },
  },
];

async function latestVersion(slug) {
  const m = await store.getModule(slug);
  if (!m || !m.docs.length) throw new Error(`Module "${slug}" not found or has no docs`);
  return m.docs[0].version;
}

async function currentBody(slug, version) {
  const d = await store.getDoc(slug, version);
  if (!d) throw new Error(`Doc ${slug} ${version} not found`);
  return d.content;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function replaceOnce(body, find, replace) {
  if (!find) throw new Error('find must be a non-empty string');
  const count = body.split(find).length - 1;
  if (count === 0) throw new Error('find text not found in the current body — call get_doc and copy the exact HTML');
  if (count > 1) throw new Error(`find text occurs ${count} times — include more context to make it unique`);
  return body.replace(find, () => replace);
}

function insertIntoSection(content, section, html, position = 'end') {
  const re = new RegExp(`<h2[^>]*>\\s*${escapeRe(section.trim())}\\s*</h2>`, 'i');
  const m = re.exec(content);
  if (!m) {
    const titles = [...content.matchAll(/<h2[^>]*>(.*?)<\/h2>/gi)].map((x) => x[1]).join(', ');
    throw new Error(`Section "${section}" not found — body <h2> titles are: ${titles}`);
  }
  const start = m.index + m[0].length;
  const rest = content.slice(start);
  const next = rest.search(/<h2[\s>]/i);
  const end = next === -1 ? content.length : start + next;
  if (position === 'start') return `${content.slice(0, start)}\n${html}\n${content.slice(start)}`;
  return `${content.slice(0, end).replace(/\s*$/, '')}\n${html}\n${content.slice(end)}`;
}

async function callTool(name, args) {
  switch (name) {
    case 'search_modules': {
      const rows = await store.listModules();
      const q = (args.query || '').toLowerCase().trim();
      if (!q) return rows;
      return rows.filter((r) =>
        [r.name, r.code, r.slug, r.category, r.softwareLabel, r.hardwareLabel].filter(Boolean).some((s) => s.toLowerCase().includes(q))
      );
    }
    case 'get_module': {
      const m = await store.getModule(args.slug);
      if (!m) throw new Error(`Module "${args.slug}" not found`);
      return m;
    }
    case 'get_doc': {
      const version = args.version || (await latestVersion(args.slug));
      const d = await store.getDoc(args.slug, version);
      if (!d) throw new Error(`Doc ${args.slug} ${version} not found`);
      const out = { module: d.module, doc: d.doc, content: d.content, checklist: d.checklist || null };
      if (args.include_assets) out.assets = await store.listAssets(args.slug);
      return out;
    }
    case 'list_assets':
      return await store.listAssets(args.slug);
    case 'update_asset':
      return await store.setAssetMeta(args.slug, args.version, args.name, { appliesTo: args.applies_to, verify: !!args.verify });
    case 'list_hardware':
      return await store.listHardware();
    case 'create_hardware':
      return await store.createHardware(args);
    case 'update_hardware': {
      const { id, ...patch } = args;
      return await store.updateHardware(id, patch);
    }
    case 'create_module': {
      const input = {
        name: args.name,
        code: args.code || null,
        category: args.category || 'software',
        group: args.group,
        hardware: args.hardware || [],
        softwares: args.softwares || [],
        startSummary: 'Created via MCP',
      };
      input.hardwareItems = await store.previewHardware(input, input.name);
      const content = args.content_html || blankContent(args.name, input.hardwareItems);
      input.checklist = args.checklist === 'none' ? null : templateChecklist(input);
      return await store.createModuleDoc(
        input,
        content,
        []
      );
    }
    case 'update_module': {
      const { slug, ...patch } = args;
      return await store.updateModule(slug, patch);
    }
    case 'save_doc_content':
      return await store.saveDraftContent(args.slug, args.version, args.html, {
        bump: true,
        summary: args.summary || 'Edit via MCP',
      });
    case 'replace_in_doc': {
      const body = await currentBody(args.slug, args.version);
      const html = replaceOnce(body, args.find, args.replace);
      return await store.saveDraftContent(args.slug, args.version, html, {
        bump: true,
        summary: args.summary || 'Edit via MCP (replace)',
      });
    }
    case 'insert_into_section': {
      const body = await currentBody(args.slug, args.version);
      const html = insertIntoSection(body, args.section, args.html, args.position || 'end');
      return await store.saveDraftContent(args.slug, args.version, html, {
        bump: true,
        summary: args.summary || `Add content to ${args.section} via MCP`,
      });
    }
    case 'edit_doc': {
      if (!Array.isArray(args.edits) || !args.edits.length) throw new Error('edits must be a non-empty array');
      let html = await currentBody(args.slug, args.version);
      args.edits.forEach((e, i) => {
        try {
          if (typeof e.find === 'string') html = replaceOnce(html, e.find, e.replace ?? '');
          else if (e.section) html = insertIntoSection(html, e.section, e.html || '', e.position || 'end');
          else throw new Error('each edit needs either {find, replace} or {section, html}');
        } catch (err) {
          throw new Error(`edit[${i}]: ${err.message}`);
        }
      });
      return await store.saveDraftContent(args.slug, args.version, html, {
        bump: true,
        summary: args.summary || `${args.edits.length} edits via MCP`,
      });
    }
    case 'upload_photo': {
      const buffer = Buffer.from(args.data_base64, 'base64');
      if (!buffer.length) throw new Error('data_base64 is empty or invalid');
      return await store.saveAssets(args.slug, args.version, [{ name: args.name, buffer }]);
    }
    case 'import_local_files': {
      const files = [];
      const fromInbox = [];
      for (const p of args.paths || []) {
        const str = String(p);
        if (!path.isAbsolute(str) && !/[\\/]/.test(str)) {
          // bare name → inbox
          const f = await inbox.readInbox(str);
          if (!f) throw new Error(`"${str}" is not in the inbox — call list_inbox, or ask the user to drop the file into the inbox (Assets tab)`);
          files.push(f);
          fromInbox.push(f.name);
          continue;
        }
        const abs = path.resolve(str);
        if (!inbox.isAllowedPath(abs)) {
          throw new Error(`${abs} is outside the allowed import roots (${inbox.IMPORT_ROOTS.join('; ')}) — ask the user to drop the file into the inbox (Module → Assets tab) or to add the folder to FTD_IMPORT_ROOTS`);
        }
        let st;
        try {
          st = await fs.stat(abs);
        } catch {
          throw new Error(`Path not found: ${abs}`);
        }
        if (st.isDirectory()) {
          for (const name of await fs.readdir(abs)) {
            if (/\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(name)) {
              files.push({ name, buffer: await fs.readFile(path.join(abs, name)) });
            }
          }
        } else {
          if (st.size > 20 * 1024 * 1024) throw new Error(`${abs} is larger than 20 MB`);
          files.push({ name: path.basename(abs), buffer: await fs.readFile(abs) });
        }
      }
      if (!files.length) throw new Error('No files found at the given paths');
      const saved = await store.saveAssets(args.slug, args.version, files);
      if (!args.keep_in_inbox) for (const n of fromInbox) await inbox.deleteInbox(n);
      return saved;
    }
    case 'list_inbox':
      return { dir: inbox.INBOX_DIR, files: await inbox.listInbox() };
    case 'delete_asset':
      return await store.deleteAsset(args.slug, args.version, args.name);
    case 'upload_photo_from_url': {
      const dl = await ai.downloadImage(args.url, { minBytes: 1 });
      if (!dl) throw new Error('URL did not return an image (or it is larger than 6 MB)');
      return await store.saveAssets(args.slug, args.version, [{ name: args.name || dl.name, buffer: dl.buffer }]);
    }
    case 'generate_illustration': {
      let reference = null;
      if (args.reference_asset) {
        const buf = await store.getAsset(args.slug, args.reference_asset);
        if (!buf) throw new Error(`Reference asset "${args.reference_asset}" not found — see list_assets`);
        reference = { name: args.reference_asset, buffer: buf };
      }
      const prompt =
        args.style === 'line-art'
          ? illustrate.lineArtPrompt(await illustrate.getStyle(), args.prompt, { hasReference: !!reference })
          : args.prompt;
      const buffer = await ai.generateImage({ prompt, reference });
      return await store.saveAssets(args.slug, args.version, [{ name: args.name, buffer }]);
    }
    case 'convert_to_line_art':
      return await illustrate.convertToLineArt({
        slug: args.slug,
        version: args.version,
        reference: args.reference_asset ? { assetName: args.reference_asset } : null,
        editOf: args.edit_of || null,
        instructions: args.instructions || '',
        name: args.name || null,
      });
    case 'save_checklist':
      return await store.saveChecklist(args.slug, args.version, args.checklist, { summary: args.summary || 'FAT checklist via MCP' });
    case 'get_checklist_template': {
      const m = await store.getModule(args.slug);
      if (!m) throw new Error(`Module "${args.slug}" not found`);
      return templateChecklist(m.module);
    }
    case 'submit_for_review':
      return await store.setDocStatus(args.slug, args.version, 'in-review');
    case 'release_doc':
      return await store.releaseDoc(args.slug, args.version);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function buildServer() {
  const server = new Server({ name: 'ftd-docs-console', version: '0.2.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = await callTool(req.params.name, req.params.arguments || {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  });
  return server;
}

/** Stateless Streamable HTTP handler for POST /mcp. */
export async function handleMcpRequest(req, res) {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
