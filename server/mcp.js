/**
 * MCP server for the Documentation Console — lets an external agent (Claude
 * Code, Claude.ai, any MCP client) search modules, read and edit drafts,
 * upload photos and create new modules, using the same store as the UI.
 * Stateless Streamable HTTP endpoint mounted at POST /mcp.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as store from './store.js';
import { blankContent } from './docgen.js';

export const TOOLS = [
  {
    name: 'search_modules',
    description:
      'List modules, optionally filtered by a query matched against name, code, slug, category and linked software names. Returns list rows with latest doc version and status.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Optional filter text' } },
    },
  },
  {
    name: 'get_module',
    description: 'Get one module: metadata, all doc versions with statuses, history and software release feed.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug'],
    },
  },
  {
    name: 'get_doc',
    description:
      'Get a doc version of a module: metadata, revision record and the editable body HTML (sections 4–7). Omit version for the latest one.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' }, version: { type: 'string', description: 'e.g. A1.0; omit for latest' } },
      required: ['slug'],
    },
  },
  {
    name: 'create_module',
    description:
      'Create a new module with its first doc draft A1.0 r1 on a draft/<slug>-a1.0 branch (same as the New module doc wizard). Returns slug, version and branch.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        code: { type: 'string', description: 'Module code like SW-STP' },
        category: { type: 'string', enum: ['software', 'cockpit-hardware', 'structure', 'peripherals', 'rack'] },
        group: { type: 'string', enum: ['SIM', 'IOS', 'RACK'], description: 'Which simulator manual it compiles into' },
        hardware: {
          type: 'object',
          description: '{type:"ftd",version} or {type:"cots",manufacturer,model} or {type:"none"}',
        },
        softwares: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, fromVersion: { type: 'string' } },
            required: ['name'],
          },
        },
        content_html: {
          type: 'string',
          description: 'Optional starting body HTML (sections 4–7). Defaults to the blank FTD template.',
        },
      },
      required: ['name', 'group'],
    },
  },
  {
    name: 'save_doc_content',
    description:
      'Save the body HTML (sections 4–7) of a Draft/In-review doc. Commits on the draft branch and bumps the revision (r1 → r2 …) with the given summary in the revision record.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        version: { type: 'string' },
        html: { type: 'string' },
        summary: { type: 'string', description: 'Revision record entry, e.g. "Add grounding check"' },
      },
      required: ['slug', 'version', 'html'],
    },
  },
  {
    name: 'upload_photo',
    description:
      'Upload an image (or other file) into the module draft\'s assets folder. Returns the served URL to use in <img src="…">.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        version: { type: 'string' },
        name: { type: 'string', description: 'File name including extension' },
        data_base64: { type: 'string', description: 'File content, base64-encoded' },
      },
      required: ['slug', 'version', 'name', 'data_base64'],
    },
  },
  {
    name: 'list_assets',
    description: 'List the files in a module\'s assets folder with their served URLs.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
  },
  {
    name: 'submit_for_review',
    description: 'Mark a Draft doc version as In review.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' }, version: { type: 'string' } },
      required: ['slug', 'version'],
    },
  },
  {
    name: 'release_doc',
    description:
      'Release an In-review doc version: merges the draft branch to main, freezes the revision counter and supersedes older released versions.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' }, version: { type: 'string' } },
      required: ['slug', 'version'],
    },
  },
];

async function latestVersion(slug) {
  const m = await store.getModule(slug);
  if (!m || !m.docs.length) throw new Error(`Module "${slug}" not found or has no docs`);
  return m.docs[0].version;
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
    case 'save_doc_content':
      return await store.saveDraftContent(args.slug, args.version, args.html, {
        bump: true,
        summary: args.summary || 'Edit via MCP',
      });
    case 'upload_photo': {
      const buffer = Buffer.from(args.data_base64, 'base64');
      if (!buffer.length) throw new Error('data_base64 is empty or invalid');
      return await store.saveAssets(args.slug, args.version, [{ name: args.name, buffer }]);
    }
    case 'list_assets':
      return await store.listAssets(args.slug);
    case 'submit_for_review':
      return await store.setDocStatus(args.slug, args.version, 'in-review');
    case 'release_doc':
      return await store.releaseDoc(args.slug, args.version);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function buildServer() {
  const server = new Server(
    { name: 'ftd-docs-console', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );
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
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
