// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCP_HOST, MCP_CORE } from '@nimbalyst/runtime/ai/server/services/mcpTopology';
import { selectFirstPartyToolsForEndpoint } from '../mcpEndpointRouting';

const getUsage = vi.hoisted(() => vi.fn());
vi.mock('../../services/OllamaUsageService', () => ({ ollamaUsageService: { getUsage } }));
import { dispatchUsagePollingTool, USAGE_POLLING_TOOL_SCHEMAS } from '../usagePollingServer';

beforeEach(() => {
  getUsage.mockReset().mockResolvedValue({
    source: 'ollama-dashboard', authStatus: 'connected', limitsAvailable: true,
    plan: 'pro', creditBalanceUSD: 0, lastUpdated: 123,
    weekly: { utilization: 62.5, resetsAt: null, models: [{ name: 'fixture-alpha', requestCount: 2 }], modelCountsAvailable: true },
    modelCountsPeriod: 'this-week', internalBinding: 'must-not-leave-service',
  });
});

describe('host-bound Ollama usage tools', () => {
  it.each(['scrape_ollama_usage', 'get_provider_usage'])('reads %s through the shared service with the host workspace', async name => {
    const args = name === 'get_provider_usage' ? { provider: 'ollama', forceRefresh: true } : { forceRefresh: true };
    const result = await dispatchUsagePollingTool(`mcp__nimbalyst-host__${name}`, args, '/host/workspace');
    expect(getUsage).toHaveBeenCalledWith('/host/workspace', true);
    expect(result.isError).toBe(false);
    const value = JSON.parse(result.content[0].text);
    expect(value).toMatchObject({ creditBalanceUSD: 0, weekly: { utilization: 62.5, resetsAt: null, models: [{ name: 'fixture-alpha', requestCount: 2 }] } });
    expect(value).not.toHaveProperty('internalBinding');
    expect(value).not.toHaveProperty('session');
  });

  it.each([
    ['scrape_ollama_usage', { workspacePath: '/other' }],
    ['scrape_ollama_usage', { url: 'https://other.test' }],
    ['scrape_ollama_usage', { script: 'anything' }],
    ['scrape_ollama_usage', { forceRefresh: 'true' }],
    ['get_provider_usage', { provider: 'other' }],
    ['get_provider_usage', {}],
  ] as const)('rejects undeclared input for %s before reading usage', async (name, args) => {
    expect((await dispatchUsagePollingTool(name, args, '/host')).isError).toBe(true);
    expect(getUsage).not.toHaveBeenCalled();
  });

  it('requires a host workspace and never opens account sign-in', async () => {
    expect((await dispatchUsagePollingTool('scrape_ollama_usage', {}, undefined)).isError).toBe(true);
    expect(getUsage).not.toHaveBeenCalled();
    getUsage.mockResolvedValue({ limitsAvailable: false, source: 'ollama-dashboard', authStatus: 'sign-in-required', lastUpdated: 1 });
    const result = await dispatchUsagePollingTool('scrape_ollama_usage', {}, '/host');
    expect(JSON.parse(result.content[0].text).authStatus).toBe('sign-in-required');
    expect(getUsage).toHaveBeenCalledWith('/host', false);
  });

  it('omits unverified model counts and redacts thrown browser details', async () => {
    getUsage.mockResolvedValueOnce({ weekly: { utilization: 12, resetsAt: null, modelCountsAvailable: true, models: [{ name: 'unverified', requestCount: 999 }] } });
    const data = JSON.parse((await dispatchUsagePollingTool('scrape_ollama_usage', {}, '/host')).content[0].text);
    expect(data.weekly.modelCountsAvailable).toBe(false);
    expect(data.weekly).not.toHaveProperty('models');
    getUsage.mockRejectedValueOnce(new Error('private-browser-detail'));
    const error = await dispatchUsagePollingTool('scrape_ollama_usage', {}, '/host');
    expect(error.isError).toBe(true);
    expect(JSON.stringify(error)).not.toContain('private-browser-detail');
  });

  it('rejects unknown tools and declares only read-only bounded input', async () => {
    await expect(dispatchUsagePollingTool('unknown', {}, '/host')).rejects.toThrow('Unknown tool');
    for (const tool of USAGE_POLLING_TOOL_SCHEMAS) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('serves the actual HTTP consumer registrations on deferred host and dispatches its bound workspace', async () => {
    const source = ts.createSourceFile('httpServer.ts', readFileSync(new URL('../httpServer.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    let registration: ts.ArrayLiteralExpression | undefined;
    let factory: ts.FunctionDeclaration | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'builtInTools' && node.initializer && ts.isArrayLiteralExpression(node.initializer)) registration = node.initializer;
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'createSharedMcpServer') factory = node;
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(registration).toBeDefined(); expect(factory).toBeDefined();
    const context: Record<string, unknown> = {
      USAGE_POLLING_TOOL_SCHEMAS, Server, CallToolRequestSchema, ListToolsRequestSchema, MCP_HOST,
      USAGE_POLLING_TOOL_NAMES: new Set(USAGE_POLLING_TOOL_SCHEMAS.map(tool => tool.name)),
      SETTINGS_TOOL_NAMES: new Set(), SESSION_CONTEXT_TOOL_NAMES: new Set(),
      dispatchUsagePollingTool, selectFirstPartyToolsForEndpoint,
      withTrackerSchemaWorkspace: (_workspace: unknown, handler: unknown) => handler,
      buildSessionMetaToolSchemas: async () => [],
      applyCoreAlwaysLoadMeta: (tools: unknown) => tools,
      dedupeAndWarn: (tools: unknown) => tools,
      console: { error: vi.fn(), log: vi.fn() },
    };
    // Other schema producers are irrelevant to this registration; execute the
    // unmodified production server factory with empty sibling tool collections.
    for (const element of registration!.elements) {
      if (!ts.isSpreadElement(element)) throw new Error('Unexpected registration shape');
      const expression = element.expression;
      if (ts.isIdentifier(expression)) {
        if (!(expression.text in context)) context[expression.text] = [];
      } else if (ts.isCallExpression(expression)) {
        if (ts.isIdentifier(expression.expression)) context[expression.expression.text] = () => [];
        else if (ts.isPropertyAccessExpression(expression.expression) && ts.isIdentifier(expression.expression.expression)) context[expression.expression.expression.text] = [];
        else throw new Error('Unexpected producer shape');
      } else throw new Error('Unexpected schema shape');
    }
    const printer = ts.createPrinter();
    const code = ts.transpileModule(printer.printNode(ts.EmitHint.Unspecified, factory!, source), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const createServer = runInNewContext(`${code}; createSharedMcpServer`, context);
    // Exercise real SDK requests through the production list/call handlers.
    // Transport is in-memory: no live app, account, or listening socket.
    for (const endpoint of [
      { kind: 'firstParty', configKey: MCP_HOST },
      { kind: 'firstParty', configKey: MCP_CORE },
      { kind: 'legacy' },
      { kind: 'extension', extensionShortName: 'fixture' },
    ]) {
      getUsage.mockClear();
      const server: Server = createServer('/bound-consumer', 'session', endpoint);
      const client = new Client({ name: 'usage-contract-test', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const host = endpoint.kind === 'firstParty' && endpoint.configKey === MCP_HOST;
        if (endpoint.kind !== 'extension') {
          expect((await client.listTools()).tools.map(tool => tool.name))
            .toEqual(host ? USAGE_POLLING_TOOL_SCHEMAS.map(tool => tool.name) : []);
        }
        for (const tool of USAGE_POLLING_TOOL_SCHEMAS) {
          const request = client.callTool({ name: tool.name, arguments: tool.name === 'get_provider_usage' ? { provider: 'ollama' } : {} });
          if (host) expect((await request).isError).toBe(false);
          else await expect(request).rejects.toThrow('not available');
        }
        if (host) expect(getUsage).toHaveBeenCalledWith('/bound-consumer', false);
        else expect(getUsage).not.toHaveBeenCalled();
      } finally { await client.close(); await server.close(); }
    }
  });
});
