/**
 * MCP server for the Documentation Console — lets an external agent (Claude
 * Code, Claude.ai, any MCP client) search modules, read and edit drafts,
 * upload photos, generate illustrations and create new modules, using the
 * same store as the UI. Stateless Streamable HTTP endpoint at POST /mcp.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as store from './store.js';
import * as ai from './ai.js';
import * as illustrate from './illustrate.js';
import * as images from './images.js';
import * as sources from './sources.js';
import { blankContent, MANUAL_TYPES, MANUAL_ORDER, DEFAULT_MANUAL, manualTypeOf, parseDocKey, docKey, LANGUAGES, DEFAULT_LANG, langOf } from './docgen.js';
import { templateChecklist } from './checklist.js';
import * as inbox from './inbox.js';

const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const MANUAL_HELP = MANUAL_ORDER.map((id) => `"${id}" = ${MANUAL_TYPES[id].label} (${MANUAL_TYPES[id].sections.join(', ')})`).join('; ');

const MANUAL_PROP = {
  type: 'string',
  enum: MANUAL_ORDER,
  description: `Manual type — a module is documented per audience: ${MANUAL_HELP}. Software manuals need the module linked to a software.`,
};
/** Body language of a doc: English is the source; other languages are translations stored next to it. */
const LANG_PROP = {
  type: 'string',
  enum: Object.keys(LANGUAGES),
  description: `Language of the body to read/edit (default en). ${Object.values(LANGUAGES).map((l) => `${l.code} = ${l.label}${l.source ? ' (source)' : ''}`).join(', ')}. A translation exists only after translate_doc (or a save with lang); get_doc.languages tells which exist and whether they are stale (English edited since).`,
};

/** Every doc-scoped tool addresses one manual of a module: `manual` + `version`, or a full key in `version`. */
const SLUG_VER = {
  slug: { type: 'string', description: 'Module slug, e.g. starting-panel' },
  manual: {
    ...MANUAL_PROP,
    description: `Which manual of the module the call targets (default customer). ${MANUAL_PROP.description}`,
  },
  version: {
    type: 'string',
    description:
      'Doc version of that manual, e.g. A1.0 — or a full key "<manual>:<version>" such as technician:A1.0 / software-customer:A1.0. Omit to target the latest doc of `manual` (its open draft when one exists). Editing tools need a Draft or In-review doc. Keys are listed by get_module.',
  },
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
    description:
      'Get one module: metadata, all doc versions of every manual type (customer / technician / software-customer / software-technician — each with its key, status and branch), a per-type summary in `manuals`, history and the software release feed.',
    inputSchema: { type: 'object', properties: { slug: SLUG_VER.slug }, required: ['slug'] },
    annotations: { title: 'Get module', ...RO },
  },
  {
    name: 'list_manual_types',
    description:
      'The manual types a module can have — customer, technician, software-customer, software-technician — with audience, section names and what belongs in each section. Use it to decide which manual a piece of source material belongs to.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'List manual types', ...RO },
  },
  {
    name: 'list_software',
    description:
      'Software-centric view: every software linked to a module, with the modules linked to it, their software manuals (software-customer / software-technician: key, version, status), and the registered releases with which docs cover each. Use it to manage software manuals across modules and to find releases nobody documents yet.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Optional software name filter' } } },
    annotations: { title: 'List software', ...RO },
  },
  {
    name: 'get_doc',
    description:
      'Get a doc version of a module: metadata (incl. `manual` type and `key`), revision record, the editable body HTML (sections 4–7) and its FAT checklist (null when none). Omit version for the latest doc of `manual` (default customer).',
    inputSchema: {
      type: 'object',
      properties: {
        ...SLUG_VER,
        lang: LANG_PROP,
        include_assets: { type: 'boolean', description: 'Also return the module assets list (saves a list_assets call)' },
      },
      required: ['slug'],
    },
    annotations: { title: 'Get doc', ...RO },
  },
  {
    name: 'translate_doc',
    description:
      'Translate the English body of a Draft/In-review doc into another language with the AI and store it next to the English source (content.<lang>.html); replaces an existing translation. Afterwards the translation can be read/edited with lang on get_doc / save_doc_content / replace_in_doc / insert_into_section / edit_doc. get_doc.languages[lang].stale tells when the English body changed since the translation. Pass html to store a translation you made yourself instead of calling the AI.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SLUG_VER,
        lang: { ...LANG_PROP, description: 'Target language (default pl)' },
        html: { type: 'string', description: 'Optional ready translation of the whole body (skips the AI)' },
        summary: { type: 'string', description: 'Revision record entry' },
      },
      required: ['slug'],
    },
    annotations: { title: 'Translate doc', ...RW, openWorldHint: true },
  },
  {
    name: 'list_assets',
    description:
      "List the files in a module's assets folder with their served URLs (use these URLs in <img src>). Each entry carries `meta` — the version stamp taken when the file was added (doc version, newest software release per linked software, hardware unit versions, appliesTo hardware ids; null for files added before stamping) — and `stale`: reasons the picture may be out of date (a newer manual-affecting software release or a changed hardware version). Do not embed stale assets for new content without telling the user; fix stamps with update_asset. With thumbnails: true the result also carries a small picture of every raster asset (in list order) so you can see what is there; get_asset gives one picture at a larger size.",
    inputSchema: { type: 'object', properties: { slug: SLUG_VER.slug, thumbnails: { type: 'boolean', description: 'Also return a ≤160 px thumbnail of each image (about 100 tokens each)' } }, required: ['slug'] },
    annotations: { title: 'List assets', ...RO },
  },
  {
    name: 'create_module',
    description:
      'Create a new module with the first draft (A1.0 r1) of each requested manual type, each on its own draft/<slug>-<manual>-a1.0 branch (same as the New module doc wizard). Returns slug and `docs` [{manual, key, version, branch}]. Edit each body afterwards with save_doc_content / replace_in_doc / insert_into_section using the doc key.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        manuals: {
          type: 'array',
          items: MANUAL_PROP,
          description: `Which manuals to create (default ["customer"]). A hardware module typically gets "customer" + "technician"; a software-related one also "software-customer" and/or "software-technician". ${MANUAL_HELP}.`,
        },
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
        content_html: { type: 'string', description: 'Optional starting body HTML (sections 4–7) for the FIRST listed manual. Other manuals start from their blank template.' },
        checklist: {
          type: 'string',
          enum: ['template', 'none'],
          description: 'FAT (factory acceptance test) checklist: "template" seeds one from the category template (default) on the technician manual (else the customer manual), "none" creates the module without one.',
        },
      },
      required: ['name', 'group'],
    },
    annotations: { title: 'Create module', ...RW },
  },
  {
    name: 'create_doc_version',
    description:
      'Start a new draft of one manual type for an existing module. If the module has no doc of that type yet, its A1.0 r1 is created from the blank template (or content_html); otherwise the next version (bump minor → A1.1, major → A2.0) is created from the latest released content — only when no draft of that type is open. Returns {key, version, branch}.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: SLUG_VER.slug,
        manual: MANUAL_PROP,
        bump: { type: 'string', enum: ['minor', 'major'], description: 'Version bump when the manual type already exists (default minor)' },
        content_html: { type: 'string', description: 'Starting body HTML for a NEW manual type (ignored for a next version)' },
        checklist: { type: 'string', enum: ['template', 'none'], description: 'FAT checklist for a NEW manual type (default: template for technician / customer, none for software manuals)' },
      },
      required: ['slug', 'manual'],
    },
    annotations: { title: 'Create doc version', ...RW },
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
      'Replace the whole body HTML (sections 4–7 — the four <h2> sections of the manual type, e.g. Installation, Configuration, Maintenance, Appendixes for a technician manual; see get_doc) of a Draft/In-review doc. Allowed HTML: h2, h3, p, ol, ul, li, strong, em, table, figure/img/figcaption, <div class="admonition warning|note"><p class="admonition-title">…</p>…</div>. Commits on the draft branch and bumps the revision (r1 → r2 …) with the summary in the revision record. Prefer replace_in_doc or insert_into_section for small changes.',
    inputSchema: {
      type: 'object',
      properties: { ...SLUG_VER, lang: LANG_PROP, html: { type: 'string' }, summary: { type: 'string', description: 'Revision record entry' } },
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
        lang: LANG_PROP,
      },
      required: ['slug', 'version', 'find', 'replace'],
    },
    annotations: { title: 'Replace in doc', ...RW },
  },
  {
    name: 'insert_into_section',
    description:
      'Append (or prepend) HTML inside one of the body <h2> sections (they depend on the manual type — e.g. Description, Operation, Maintenance, Appendixes for a customer manual; the error lists them) without touching the rest. Use it to add a paragraph, a procedure, a warning or a <figure> with an uploaded image. Bumps the revision. For several changes at once use edit_doc (one call, one revision).',
    inputSchema: {
      type: 'object',
      properties: {
        ...SLUG_VER,
        section: { type: 'string', description: 'Section title as in its <h2>, e.g. Installation' },
        html: { type: 'string' },
        position: { type: 'string', enum: ['end', 'start'], description: 'Default end' },
        summary: { type: 'string' },
        lang: LANG_PROP,
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
        lang: LANG_PROP,
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
    name: 'get_asset',
    description:
      'LOOK at a module asset: returns the picture itself as image content (a downscaled JPEG preview, ~300–600 tokens) plus its metadata (pixel size, bytes, version stamp, stale reasons). Use it to pick the right photo for a figure, to write a factual caption, to check a line-art result, or to verify a figure still matches the hardware. size: "preview" (default, ≤768 px), "thumb" (≤256 px), "full" (original bytes — large; only when detail matters).',
    inputSchema: {
      type: 'object',
      properties: {
        slug: SLUG_VER.slug,
        name: { type: 'string', description: 'Asset file name (see list_assets)' },
        size: { type: 'string', enum: ['thumb', 'preview', 'full'] },
      },
      required: ['slug', 'name'],
    },
    annotations: { title: 'Get asset (image)', ...RO },
  },
  {
    name: 'describe_asset',
    description:
      "Have the console's vision model describe an asset: kind (photo / screenshot / drawing), a manual-style caption, alt text, what is visible, readable on-screen or label text, which of the module's hardware units it shows, and a suggested file name. Cheaper than get_asset when you only need words; use the `shows` ids with update_asset applies_to.",
    inputSchema: { type: 'object', properties: { slug: SLUG_VER.slug, name: { type: 'string', description: 'Asset file name' } }, required: ['slug', 'name'] },
    annotations: { title: 'Describe asset (vision)', ...RO, openWorldHint: true },
  },
  {
    name: 'attach_figure',
    description:
      'Insert an asset as a proper <figure> into a section of the doc body — no hand-written HTML. Placement: right after the block (paragraph / list / table) that contains `after_text` inside `section`, else at the end of `section` (or its start with position "start"). Sets alt, caption and optionally the applies_to hardware stamp. Commits a revision. For translations pass lang and the section title in that language.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SLUG_VER,
        lang: LANG_PROP,
        asset: { type: 'string', description: 'Asset file name (see list_assets)' },
        section: { type: 'string', description: '<h2> title of the target section' },
        after_text: { type: 'string', description: 'A short unique phrase inside the section; the figure goes after the block containing it' },
        position: { type: 'string', enum: ['start', 'end'], description: 'Where in the section when after_text is not given (default end)' },
        caption: { type: 'string', description: 'Figure caption (operating-manual English / the doc language)' },
        alt: { type: 'string', description: 'Alt text (defaults to the caption)' },
        applies_to: { type: 'array', items: { type: 'string' }, description: 'Hardware unit ids the picture shows (stamps the asset)' },
        summary: { type: 'string', description: 'Revision record entry' },
      },
      required: ['slug', 'asset', 'section', 'caption'],
    },
    annotations: { title: 'Attach figure', ...RW },
  },
  {
    name: 'upload_photo_from_url',
    description:
      "Download an image from a URL into the module draft's assets folder (the console fetches it — no bytes through you). Public URLs work as-is; hosts configured in .env FTD_URL_CREDENTIALS (\"host=basic:user:pass;host=bearer:TOKEN\") are fetched with credentials. For pictures behind a login you cannot link to (e.g. wiki attachments), use request_upload so the user drops them into the inbox. Returns the served URL to use in <img src=\"…\">.",
    inputSchema: {
      type: 'object',
      properties: {
        ...SLUG_VER,
        url: { type: 'string', description: 'http(s) URL of the image' },
        name: { type: 'string', description: 'Optional file name; defaults to the URL file name' },
      },
      required: ['slug', 'url'],
    },
    annotations: { title: 'Upload photo from URL', ...RW, openWorldHint: true },
  },
  {
    name: 'request_upload',
    description:
      'When a picture exists only on the user\'s computer or phone: returns the link to the module\'s Assets tab (the drop area / inbox). Tell the user to open it and drop the files, then call list_inbox and import_local_files (bare names) — the bytes go browser → console, never through the chat.',
    inputSchema: { type: 'object', properties: { slug: SLUG_VER.slug }, required: ['slug'] },
    annotations: { title: 'Request upload link', ...RO },
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
    name: 'create_software',
    description:
      'Create a NEW software: adds it to the release feed (softwares.json on main), optionally with its first version and linked to modules right away (each link uses from_version or the first version). A module\'s software-customer / software-technician manuals become available once it is linked — create them with create_doc_version. Fails if the name already exists: then use register_software_release (new version) or link_software.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Software name, e.g. "2N Access Unit"' },
        version: { type: 'string', description: 'Optional first version, e.g. v1.0.0' },
        manual_affecting: { type: 'boolean', description: 'Whether the first version needs manuals (default false)' },
        note: { type: 'string' },
        modules: {
          type: 'array',
          description: 'Modules to link now: [{slug, from_version?}]',
          items: { type: 'object', properties: { slug: { type: 'string' }, from_version: { type: 'string' } }, required: ['slug'] },
        },
      },
      required: ['name'],
    },
    annotations: { title: 'Create software', ...RW },
  },
  {
    name: 'register_software_release',
    description:
      'Register a NEW VERSION (release) of an existing software in the release feed. manual_affecting: true means every manual type of every module linked to that software needs a new doc version covering it (orange dot until each has one — create it with create_doc_version, then cover_release); false means the released docs can simply extend their covered range with cover_release.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Software name exactly as in list_software' },
        version: { type: 'string', description: 'Release version, e.g. v2.1.0' },
        manual_affecting: { type: 'boolean' },
        note: { type: 'string' },
      },
      required: ['name', 'version'],
    },
    annotations: { title: 'Register software release (new version)', ...RW },
  },
  {
    name: 'link_software',
    description:
      'Link an existing software to a module (or update the from-version of an existing link) — the "software relation" that enables the module\'s software manuals and puts the software\'s releases on its watch list. Set unlink: true to remove the link instead.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Module slug' },
        name: { type: 'string', description: 'Software name (see list_software / create_software)' },
        from_version: { type: 'string', description: 'First version this module ships with, e.g. v2.0.0' },
        unlink: { type: 'boolean', description: 'Remove the link instead of adding it' },
      },
      required: ['slug', 'name'],
    },
    annotations: { title: 'Link software to module', ...RW },
  },
  {
    name: 'cover_release',
    description:
      'Make a doc the manual for a software release: widens a Released doc\'s covered range (non-manual-affecting release) or assigns the release to an open Draft/In-review doc (a manual-affecting release that got its own doc version). Each manual type covers releases on its own — call it once per manual (customer, technician, software-customer, …) that documents the software.',
    inputSchema: {
      type: 'object',
      properties: { ...SLUG_VER, software: { type: 'string', description: 'Software name linked to the module' }, release: { type: 'string', description: 'Release version from the feed' } },
      required: ['slug', 'software', 'release'],
    },
    annotations: { title: 'Cover software release', ...RW },
  },
  {
    name: 'submit_for_review',
    description: 'Mark a Draft doc version as In review.',
    inputSchema: { type: 'object', properties: SLUG_VER, required: ['slug'] },
    annotations: { title: 'Submit for review', ...RW },
  },
  {
    name: 'list_comments',
    description:
      'Review comments on a Draft/In-review doc: threads viewers left on selected text ({id, status open|resolved, author, text, anchor:{quote, section, lang}, replies}). Open ones first. Address an open comment by editing the quoted passage (replace_in_doc / edit_doc), then resolve_comment with a note saying what changed.',
    inputSchema: { type: 'object', properties: SLUG_VER, required: ['slug'] },
    annotations: { title: 'List review comments', ...RO },
  },
  {
    name: 'reply_comment',
    description: 'Reply in a review thread (e.g. ask the reviewer a question or explain why nothing changes).',
    inputSchema: {
      type: 'object',
      properties: { ...SLUG_VER, id: { type: 'string', description: 'Thread id from list_comments' }, text: { type: 'string' }, author: { type: 'string', description: 'Default "AI agent"' } },
      required: ['slug', 'id', 'text'],
    },
    annotations: { title: 'Reply to comment', ...RW },
  },
  {
    name: 'resolve_comment',
    description: 'Resolve (or reopen with reopen: true) a review thread; `note` is posted as the closing reply — say what was changed and in which revision.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SLUG_VER,
        id: { type: 'string' },
        note: { type: 'string' },
        reopen: { type: 'boolean' },
        author: { type: 'string', description: 'Default "AI agent"' },
      },
      required: ['slug', 'id'],
    },
    annotations: { title: 'Resolve comment', ...RW },
  },
  {
    name: 'back_to_draft',
    description: 'Return an In-review doc version to Draft.',
    inputSchema: { type: 'object', properties: SLUG_VER, required: ['slug'] },
    annotations: { title: 'Back to draft', ...RW },
  },
  {
    name: 'discard_doc',
    description: 'Discard a Draft/In-review doc version: deletes its draft branch and everything committed on it (content, checklist, assets added there). A never-released module with no other draft disappears entirely. Irreversible — confirm with the user first.',
    inputSchema: { type: 'object', properties: SLUG_VER, required: ['slug', 'version'] },
    annotations: { title: 'Discard doc', ...RW, destructiveHint: true },
  },
  {
    name: 'release_doc',
    description:
      'Release an In-review doc version: merges the draft branch to main, freezes the revision counter and supersedes older released versions of the same manual type.',
    inputSchema: { type: 'object', properties: SLUG_VER, required: ['slug'] },
    annotations: { title: 'Release doc', ...RW, idempotentHint: true },
  },
];

/** Tools that address one doc of a module (slug + manual/version) — their `version` is resolved to a full key. */
const DOC_SCOPED = new Set(TOOLS.filter((t) => t.inputSchema.properties?.version && t.inputSchema.properties?.manual).map((t) => t.name));

/**
 * Resolve the doc a call addresses to a key "<manual>:<version>":
 *  - `version` may already be a key (then `manual`, if given, must agree),
 *  - a bare `version` is combined with `manual` (default customer),
 *  - no `version`: the latest doc of `manual`, preferring its open draft.
 */
async function resolveDocKey(args) {
  const version = String(args.version || '').trim();
  let manual = args.manual ? manualTypeOf(args.manual).id : null;
  if (version.includes(':')) {
    const parsed = parseDocKey(version);
    if (manual && parsed.manual !== manual) {
      throw new Error(`version "${version}" names the ${parsed.manual} manual but manual is "${manual}" — give one or the other`);
    }
    return docKey(parsed.manual, parsed.version);
  }
  manual = manual || DEFAULT_MANUAL;
  if (version) return docKey(manual, version);
  const m = await store.getModule(args.slug);
  if (!m) throw new Error(`Module "${args.slug}" not found`);
  const typed = m.docs.filter((d) => d.manual === manual);
  if (!typed.length) {
    const have = Object.keys(m.manuals || {});
    throw new Error(
      `Module "${args.slug}" has no ${MANUAL_TYPES[manual].label.toLowerCase()} — it has: ${have.join(', ') || 'none'}. Create one with create_doc_version {manual: "${manual}"}.`
    );
  }
  return (typed.find((d) => d.status === 'draft' || d.status === 'in-review') || typed[0]).key;
}

async function currentBody(slug, version, lang = DEFAULT_LANG) {
  const d = await store.getDoc(slug, version, { lang });
  if (!d) throw new Error(`Doc ${slug} ${version} not found`);
  if (lang !== DEFAULT_LANG && !d.languages[lang]?.exists) {
    throw new Error(`Doc ${version} has no ${LANGUAGES[lang].label} translation yet — create it with translate_doc`);
  }
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

const escapeHtml = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const escapeAttr = (s) => escapeHtml(s).replace(/"/g, '&quot;');

/**
 * Put `figure` into `section`: after the block containing `afterText` when given
 * (paragraph, list, table, heading or admonition), else at the start/end of the section.
 */
function insertFigure(content, section, figure, { afterText = '', position = 'end' } = {}) {
  const re = new RegExp(`<h2[^>]*>\\s*${escapeRe(String(section).trim())}\\s*</h2>`, 'i');
  const m = re.exec(content);
  if (!m) throw new Error(`Section "${section}" not found — the body has: ${[...content.matchAll(/<h2[^>]*>(.*?)<\/h2>/gi)].map((x) => x[1]).join(', ')}`);
  const start = m.index + m[0].length;
  const nextH2 = content.slice(start).search(/<h2[\s>]/i);
  const end = nextH2 < 0 ? content.length : start + nextH2;
  const needle = String(afterText || '').trim();
  if (needle) {
    const slice = content.slice(start, end);
    const plainIdx = slice.indexOf(needle);
    if (plainIdx < 0) throw new Error(`"${needle}" not found in section "${section}" — pick a phrase that appears verbatim in that section`);
    const closer = /<\/(p|ol|ul|table|figure|h3|div)>/gi;
    closer.lastIndex = plainIdx;
    let close = closer.exec(slice);
    // an inner </p> inside a list item or admonition: keep looking for the enclosing block when nested
    while (close && close[1] === 'p') {
      const open = slice.lastIndexOf('<', plainIdx);
      const inList = /<li[\s>]/i.test(slice.slice(Math.max(0, open - 200), open)) && !/<\/li>/i.test(slice.slice(open, plainIdx));
      if (!inList) break;
      close = closer.exec(slice);
    }
    const at = close ? start + close.index + close[0].length : end;
    return `${content.slice(0, at)}\n${figure}${content.slice(at)}`;
  }
  return position === 'start' ? `${content.slice(0, start)}\n${figure}${content.slice(start)}` : `${content.slice(0, end).replace(/\s+$/, '')}\n${figure}\n${content.slice(end)}`;
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
  if (name === 'discard_doc' && !String(args.version || '').trim()) {
    throw new Error('discard_doc needs an explicit version (e.g. "A1.0" with manual, or "technician:A1.0") — it is irreversible');
  }
  if (DOC_SCOPED.has(name)) args = { ...args, version: await resolveDocKey(args) };
  switch (name) {
    case 'list_manual_types':
      return MANUAL_ORDER.map((id) => MANUAL_TYPES[id]);
    case 'list_software': {
      const rows = await store.listSoftware();
      const q = (args.name || '').toLowerCase().trim();
      return q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows;
    }
    case 'create_software':
      return await store.createSoftware({
        name: args.name,
        version: args.version,
        manualAffecting: !!args.manual_affecting,
        note: args.note,
        modules: (args.modules || []).map((m) => ({ slug: m.slug, fromVersion: m.from_version })),
      });
    case 'link_software':
      return args.unlink ? await store.unlinkSoftware(args.slug, args.name) : await store.linkSoftware(args.slug, args.name, args.from_version);
    case 'register_software_release':
      return await store.registerSoftwareRelease({ name: args.name, version: args.version, manualAffecting: !!args.manual_affecting, note: args.note });
    case 'cover_release':
      return await store.linkReleaseToDoc(args.slug, args.version, args.software, args.release);
    case 'list_comments': {
      const r = await store.listComments(args.slug, args.version);
      if (!r) throw new Error(`Doc ${args.slug} ${args.version} not found`);
      return r.threads;
    }
    case 'reply_comment':
      return await store.replyComment(args.slug, args.version, args.id, { author: args.author || 'AI agent', text: args.text });
    case 'resolve_comment':
      return await store.setCommentStatus(args.slug, args.version, args.id, args.reopen ? 'open' : 'resolved', { author: args.author || 'AI agent', note: args.note });
    case 'back_to_draft':
      return await store.setDocStatus(args.slug, args.version, 'draft');
    case 'discard_doc':
      await store.discardDraft(args.slug, args.version);
      return { ok: true, discarded: args.version };
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
    case 'translate_doc': {
      const lang = langOf(args.lang || 'pl');
      const d = await store.getDoc(args.slug, args.version);
      if (!d) throw new Error(`Doc ${args.slug} ${args.version} not found`);
      let html = args.html;
      let source = 'manual';
      if (typeof html !== 'string' || !html.trim()) {
        html = await ai.translateHtml({ html: d.content, lang, module: d.module, doc: d.doc, guidelines: await store.getAiGuidelines() });
        source = 'ai';
      }
      const meta = await store.saveTranslation(args.slug, args.version, lang, html, { source, summary: args.summary });
      return { doc: meta, lang, languages: (await store.getDoc(args.slug, args.version, { lang })).languages };
    }
    case 'get_doc': {
      const version = args.version; // resolved above
      const lang = langOf(args.lang || DEFAULT_LANG);
      const d = await store.getDoc(args.slug, version, { lang });
      if (!d) throw new Error(`Doc ${args.slug} ${version} not found`);
      const out = { module: d.module, doc: d.doc, lang, languages: d.languages, content: d.content, checklist: d.checklist || null };
      if (args.include_assets) out.assets = await store.listAssets(args.slug);
      return out;
    }
    case 'list_assets': {
      const list = await store.listAssets(args.slug);
      if (!args.thumbnails) return list;
      const blocks = [{ type: 'text', text: JSON.stringify(list, null, 2) }];
      for (const a of list) {
        const buf = await store.getAsset(args.slug, a.name);
        const p = buf ? await images.preview(buf, { max: 160, quality: 60 }).catch(() => null) : null;
        if (!p) continue;
        blocks.push({ type: 'text', text: `↓ ${a.name}` }, { type: 'image', data: p.buffer.toString('base64'), mimeType: p.mimeType });
      }
      return richContent(blocks);
    }
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
      const manuals = [...new Set((Array.isArray(args.manuals) && args.manuals.length ? args.manuals : [DEFAULT_MANUAL]).map((m) => manualTypeOf(m).id))];
      const fatManual = ['technician', 'customer', 'software-technician', 'software-customer'].find((t) => manuals.includes(t)) || manuals[0];
      const specs = manuals.map((manual, i) => ({
        manual,
        content: (i === 0 && args.content_html) || blankContent(args.name, input.hardwareItems, manual, input.softwares),
        checklist: manual === fatManual && args.checklist !== 'none' ? templateChecklist(input) : null,
        startSummary: 'Created via MCP',
      }));
      return await store.createModuleDoc(input, specs);
    }
    case 'create_doc_version': {
      const m = await store.getModule(args.slug);
      if (!m) throw new Error(`Module "${args.slug}" not found`);
      const type = manualTypeOf(args.manual);
      if (m.docs.some((d) => d.manual === type.id)) return await store.createNextDocVersion(args.slug, type.id, args.bump || 'minor');
      const wantFat = args.checklist ? args.checklist === 'template' : type.kind !== 'software';
      return await store.addManual(args.slug, {
        manual: type.id,
        content: args.content_html || blankContent(m.module.name, m.module.hardwareItems, type.id, m.module.softwares),
        checklist: wantFat ? templateChecklist(m.module) : null,
        startSummary: 'Created via MCP',
      });
    }
    case 'update_module': {
      const { slug, ...patch } = args;
      return await store.updateModule(slug, patch);
    }
    case 'save_doc_content':
      return await store.saveDraftContent(args.slug, args.version, args.html, {
        bump: true,
        summary: args.summary || 'Edit via MCP',
        lang: langOf(args.lang || DEFAULT_LANG),
      });
    case 'replace_in_doc': {
      const lang = langOf(args.lang || DEFAULT_LANG);
      const body = await currentBody(args.slug, args.version, lang);
      const html = replaceOnce(body, args.find, args.replace);
      return await store.saveDraftContent(args.slug, args.version, html, {
        bump: true,
        summary: args.summary || 'Edit via MCP (replace)',
        lang,
      });
    }
    case 'insert_into_section': {
      const lang = langOf(args.lang || DEFAULT_LANG);
      const body = await currentBody(args.slug, args.version, lang);
      const html = insertIntoSection(body, args.section, args.html, args.position || 'end');
      return await store.saveDraftContent(args.slug, args.version, html, {
        bump: true,
        summary: args.summary || `Add content to ${args.section} via MCP`,
        lang,
      });
    }
    case 'edit_doc': {
      if (!Array.isArray(args.edits) || !args.edits.length) throw new Error('edits must be a non-empty array');
      const lang = langOf(args.lang || DEFAULT_LANG);
      let html = await currentBody(args.slug, args.version, lang);
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
        lang,
      });
    }
    case 'get_asset': {
      const buf = await store.getAsset(args.slug, args.name);
      if (!buf) throw new Error(`Asset "${args.name}" not found — see list_assets`);
      const meta = (await store.listAssets(args.slug)).find((a) => a.name === args.name) || { name: args.name };
      const size = args.size || 'preview';
      const info = images.sniff(buf);
      if (size === 'full') {
        const mime = info ? `image/${info.type === 'svg' ? 'svg+xml' : info.type}` : 'application/octet-stream';
        return richContent([{ type: 'image', data: buf.toString('base64'), mimeType: mime }, { type: 'text', text: JSON.stringify({ ...meta, bytes: buf.length, width: info?.width, height: info?.height }, null, 2) }]);
      }
      const p = await images.preview(buf, { max: size === 'thumb' ? 256 : 768 });
      if (!p) return richContent([{ type: 'text', text: JSON.stringify({ ...meta, bytes: buf.length, note: 'not a raster image — no preview (PDF?)' }, null, 2) }]);
      return richContent([
        { type: 'image', data: p.buffer.toString('base64'), mimeType: p.mimeType },
        { type: 'text', text: JSON.stringify({ ...meta, preview: { width: p.width, height: p.height }, original: p.original }, null, 2) },
      ]);
    }
    case 'describe_asset': {
      const buf = await store.getAsset(args.slug, args.name);
      if (!buf) throw new Error(`Asset "${args.name}" not found — see list_assets`);
      const m = await store.getModule(args.slug);
      const p = await images.preview(buf, { max: 1024, quality: 85 });
      if (!p) throw new Error(`"${args.name}" is not a raster image — nothing to describe`);
      return await ai.describeImage({ buffer: p.buffer, mimeType: p.mimeType, module: m?.module, name: args.name });
    }
    case 'attach_figure': {
      const lang = langOf(args.lang || DEFAULT_LANG);
      const assets = await store.listAssets(args.slug);
      const asset = assets.find((a) => a.name === args.asset);
      if (!asset) throw new Error(`Asset "${args.asset}" not found — see list_assets or import it first`);
      const body = await currentBody(args.slug, args.version, lang);
      const caption = String(args.caption || '').trim();
      const figure = `<figure><img src="${asset.url}" alt="${escapeAttr(args.alt || caption)}"><figcaption>${escapeHtml(caption)}</figcaption></figure>`;
      const html = insertFigure(body, args.section, figure, { afterText: args.after_text, position: args.position || 'end' });
      const meta = await store.saveDraftContent(args.slug, args.version, html, {
        bump: true,
        summary: args.summary || `Figure ${args.asset} in ${args.section}`,
        lang,
      });
      if (Array.isArray(args.applies_to)) await store.setAssetMeta(args.slug, args.version, args.asset, { appliesTo: args.applies_to, verify: false });
      return { doc: meta, figure, section: args.section };
    }
    case 'request_upload': {
      const base = currentBaseUrl || `http://localhost:${process.env.PORT || 5179}`;
      return {
        url: `${base}/#/modules/${args.slug}?tab=assets`,
        instructions: 'Ask the user to open this link and drop the pictures on the "Drop files for the inbox" area (or drag them onto the Assets tab to attach them directly). Then call list_inbox and import_local_files with the bare file names.',
      };
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
      const dl = await ai.downloadImage(args.url, { minBytes: 1, headers: sources.authHeadersFor(args.url) });
      if (!dl) throw new Error('URL did not return an image (or it is larger than 6 MB) — for a protected host configure credentials in .env, or use request_upload');
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

/** Tool results that carry images: callTool returns richContent([...blocks]) instead of JSON. */
const RICH = Symbol('rich-content');
const richContent = (blocks) => ({ [RICH]: blocks });

/** Base URL of the console as the current MCP client reached it (for links handed to users). */
let currentBaseUrl = '';

const ASSET_URI = /^ftd:\/\/modules\/([^/]+)\/assets\/(.+)$/;
const mimeOf = (name) => {
  const ext = path.extname(name).toLowerCase();
  return { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' }[ext] || 'application/octet-stream';
};

function buildServer() {
  const server = new Server({ name: 'ftd-docs-console', version: '0.3.0' }, { capabilities: { tools: {}, resources: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = await callTool(req.params.name, req.params.arguments || {});
      if (result && result[RICH]) return { content: result[RICH] };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  });
  // Assets as MCP resources: ftd://modules/<slug>/assets/<file> — clients can show them inline.
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = [];
    for (const m of await store.listModules()) {
      for (const a of await store.listAssets(m.slug)) {
        resources.push({ uri: `ftd://modules/${m.slug}/assets/${a.name}`, name: `${m.name} — ${a.name}`, mimeType: mimeOf(a.name), description: store.describeAssetVersion(a) });
      }
    }
    return { resources };
  });
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const m = ASSET_URI.exec(req.params.uri || '');
    if (!m) throw new Error(`Unknown resource ${req.params.uri}`);
    const buf = await store.getAsset(m[1], decodeURIComponent(m[2]));
    if (!buf) throw new Error(`Asset not found: ${req.params.uri}`);
    return { contents: [{ uri: req.params.uri, mimeType: mimeOf(m[2]), blob: buf.toString('base64') }] };
  });
  return server;
}

/** Stateless Streamable HTTP handler for POST /mcp. */
export async function handleMcpRequest(req, res) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  currentBaseUrl = process.env.FTD_PUBLIC_URL || `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
