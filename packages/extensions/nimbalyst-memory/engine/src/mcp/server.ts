/**
 * MCP server adapter over MemoryEngine. Thin: it maps tool calls to engine
 * methods and serializes results as JSON text content. Any MCP client (the
 * Nimbalyst coding agent today, the voice bridge later, or a third-party agent)
 * gets the same surface.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { MemoryEngine } from '../engine.js';
import { buildProjectSearchResponse, buildPublicEngineStatus } from '../searchResponse.js';

const TOOLS = [
  {
    name: 'search_project_knowledge',
    description:
      'Search the indexed project markdown with local keyword retrieval and ' +
      'semantic matching when available ' +
      '(design docs, plans, CLAUDE.md, trackers, voice-memory). Returns the top ' +
      'matching chunks with source + heading citations. Use this to ground ' +
      'answers in how the project actually works.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language or keyword query.' },
        k: { type: 'number', description: 'Max results (default 5).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'expand',
    description:
      'Expand a search hit to its full heading section. Pass the sourcePath and ' +
      'headingPath from a search_project_knowledge result.',
    inputSchema: {
      type: 'object',
      properties: {
        sourcePath: { type: 'string' },
        headingPath: { type: 'array', items: { type: 'string' } },
      },
      required: ['sourcePath'],
    },
  },
  {
    name: 'read_doc',
    description: 'Read a managed document by its relative path (e.g. a plan file).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'remember',
    description:
      'Append a durable fact to memory (ADD-only; never overwrites). Use for ' +
      'preferences, decisions, and project truths worth recalling later.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        category: { type: 'string' },
        scope: { type: 'string' },
        priority: { type: 'number', description: 'Higher = injected sooner at start.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'recall',
    description:
      'Recall stored facts, optionally filtered by category/scope and ranked by a ' +
      'query. Newest wins when facts conflict.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        category: { type: 'string' },
        scope: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'index',
    description:
      'Run an incremental index pass over the configured sources. Returns the ' +
      'number of (re)embedded chunks and files scanned.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'status',
    description: 'Report index size, the active embedder, and whether a re-index is needed.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const;

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function createMcpServer(engine: MemoryEngine): Server {
  const server = new Server(
    { name: 'nimbalyst-memory-engine', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as unknown as object[] }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name } = req.params;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case 'search_project_knowledge': {
          const query = String(args.query ?? '');
          if (!query) throw new McpError(ErrorCode.InvalidParams, 'query is required');
          const k = typeof args.k === 'number' ? args.k : 5;
          const chunks = await engine.search(query, k);
          return jsonResult(buildProjectSearchResponse(chunks, engine.status().retrieval));
        }
        case 'expand': {
          const sourcePath = String(args.sourcePath ?? '');
          if (!sourcePath) throw new McpError(ErrorCode.InvalidParams, 'sourcePath is required');
          const headingPath = Array.isArray(args.headingPath)
            ? (args.headingPath as unknown[]).map(String)
            : [];
          return jsonResult(engine.expand(sourcePath, headingPath));
        }
        case 'read_doc': {
          const p = String(args.path ?? '');
          if (!p) throw new McpError(ErrorCode.InvalidParams, 'path is required');
          return jsonResult(await engine.readDoc(p));
        }
        case 'remember': {
          const text = String(args.text ?? '');
          if (!text) throw new McpError(ErrorCode.InvalidParams, 'text is required');
          const written = await engine.remember({
            text,
            category: args.category != null ? String(args.category) : null,
            scope: args.scope != null ? String(args.scope) : null,
            priority: typeof args.priority === 'number' ? args.priority : 0,
          });
          return jsonResult({ ok: true, path: written });
        }
        case 'recall': {
          return jsonResult({
            facts: await engine.recall({
              query: args.query != null ? String(args.query) : undefined,
              category: args.category != null ? String(args.category) : undefined,
              scope: args.scope != null ? String(args.scope) : undefined,
              limit: typeof args.limit === 'number' ? args.limit : undefined,
            }),
          });
        }
        case 'index': {
          return jsonResult(await engine.indexAll());
        }
        case 'status': {
          return jsonResult(buildPublicEngineStatus(engine.status()));
        }
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (err) {
      if (err instanceof McpError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
    }
  });

  return server;
}
