/**
 * MCP server for the Documentation Console — lets an external agent (Claude
 * Code, Claude.ai, any MCP client) search modules, read and edit drafts,
 * upload photos, generate illustrations and create new modules, using the
 * same store as the UI. Stateless Streamable HTTP endpoint at POST /mcp.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as store from './store.js';
import * as ai from './ai.js';
import { blankContent } from './docgen.js';

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
      'Get a doc version of a module: metadata, revision record and the editable body HTML (sections 4–7). Omit version for the latest one.',
    inputSchema: {
      type: 'object',
      properties: { slug: SLUG_VER.slug, version: { type: 'string', description: 'e.g. A1.0; omit for latest' } },
      required: ['slug'],
    },
    annotations: { title: 'Get doc', ...RO },
  },
  {
    name: 'list_assets',
    description: "List the files in a module's assets folder with their served URLs (use these URLs in <img src>).",
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
        hardware: { type: 'object', description: '{type:"ftd",version} or {type:"cots",manufacturer,model} or {type:"none"}' },
        softwares: {
          type: 'array',
          items: { type: 'object', properties: { name: { type: 'string' }, fromVersion: { type: 'string' } }, required: ['name'] },
        },
        content_html: { type: 'string', description: 'Optional starting body HTML (sections 4–7). Defaults to the blank FTD template.' },
      },
      required: ['name', 'group'],
    },
    annotations: { title: 'Create module', ...RW },
  },
  {
    name: 'update_module',
    description:
      'Edit module metadata: name, code, category, group, hardware relation, linked softwares. Only the fields given are changed.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: SLUG_VER.slug,
        name: { type: 'string' },
        code: { type: 'string' },
        category: { type: 'string', enum: ['software', 'cockpit-hardware', 'structure', 'peripherals', 'rack'] },
        group: { type: 'string', enum: ['SIM', 'IOS', 'RACK'] },
        hardware: { type: 'object' },
        softwares: { type: 'array', items: { type: 'object' } },
      },
      required: ['slug'],
    },
    annotations: { title: 'Update module', ...RW },
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
      'Edit part of the body HTML: replace an exact substring of the current body (get it with get_doc) with new HTML. Fails if the substring is not found or is ambiguous. Bumps the revision.',
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
      'Append (or prepend) HTML inside one of the body sections — Installation, Operation, Maintenance or Appendixes — without touching the rest. Use it to add a paragraph, a procedure, a warning or a <figure> with an uploaded image. Bumps the revision.',
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
    name: 'upload_photo',
    description:
      "Upload an image (or other file) from base64 data into the module draft's assets folder. Returns the served URL to use in <img src=\"…\">.",
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
      'Generate an illustration with the image model and store it as a module asset. Give a detailed prompt (include the style, e.g. the Technical Aviation Manual Line-Art style from Settings); optionally name an existing asset (e.g. a photo) as visual reference so the drawing is based on it. Returns the served URL.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SLUG_VER,
        name: { type: 'string', description: 'Output file name, e.g. st-622-mounting-lineart.png' },
        prompt: { type: 'string' },
        reference_asset: { type: 'string', description: 'Optional existing asset file name to base the image on' },
      },
      required: ['slug', 'version', 'name', 'prompt'],
    },
    annotations: { title: 'Generate illustration', ...RW, openWorldHint: true },
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
        [r.name, r.code, r.slug, r.category, r.softwareLabel].filter(Boolean).some((s) => s.toLowerCase().includes(q))
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
      return { module: d.module, doc: d.doc, content: d.content };
    }
    case 'list_assets':
      return await store.listAssets(args.slug);
    case 'create_module': {
      const content = args.content_html || blankContent(args.name);
      return await store.createModuleDoc(
        {
          name: args.name,
          code: args.code || null,
          category: args.category || 'software',
          group: args.group,
          hardware: args.hardware || { type: 'none' },
          softwares: args.softwares || [],
          startSummary: 'Created via MCP',
        },
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
      const count = body.split(args.find).length - 1;
      if (count === 0) throw new Error('find text not found in the current body — call get_doc and copy the exact HTML');
      if (count > 1) throw new Error(`find text occurs ${count} times — include more context to make it unique`);
      const html = body.replace(args.find, () => args.replace);
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
    case 'upload_photo': {
      const buffer = Buffer.from(args.data_base64, 'base64');
      if (!buffer.length) throw new Error('data_base64 is empty or invalid');
      return await store.saveAssets(args.slug, args.version, [{ name: args.name, buffer }]);
    }
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
      const buffer = await ai.generateImage({ prompt: args.prompt, reference });
      return await store.saveAssets(args.slug, args.version, [{ name: args.name, buffer }]);
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
