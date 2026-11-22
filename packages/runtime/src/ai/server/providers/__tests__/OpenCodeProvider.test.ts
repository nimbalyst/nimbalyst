// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeProvider } from '../OpenCodeProvider';
import { configureMcpServers } from '../../services/mcpServerConfig';
import { EventEmitter } from 'events';
import {
  configureOpenCodeModelCatalog,
  getOpenCodeModelCatalog,
  resetOpenCodeModelCatalogForTests,
  type OpenCodeModelCatalogCache,
} from '../openCode/OpenCodeModelCatalog';
import {
  configureOpenCodeAgentCatalogForTests,
  getOpenCodeAgentCatalog,
} from '../openCode/OpenCodeAgentCatalog';

// Mock child_process.spawn to avoid actually launching opencode
vi.mock('child_process', () => {
  const spawn = vi.fn(() => {
    const proc = new EventEmitter() as any;
    proc.kill = vi.fn();
    proc.stdin = null;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.pid = 12345;
    return proc;
  });
  return { spawn, default: { spawn } };
});

// Mock net.createServer for port finding
vi.mock('net', () => {
  const createServer = vi.fn(() => {
    const server = new EventEmitter() as any;
    server.listen = vi.fn((_port: number, _host: string, cb: () => void) => {
      server.address = () => ({ port: 19999 });
      cb();
    });
    server.close = vi.fn((cb: () => void) => cb());
    return server;
  });
  return { createServer, default: { createServer } };
});

// Mock fetch for server health check
const mockFetch = vi.fn(async () => ({ ok: true }));
vi.stubGlobal('fetch', mockFetch);

function createAsyncEventStream(events: any[]): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function createMockProtocol(sseEvents: any[] = []) {
  const closeFn = vi.fn();
  let permissionHost: any;

  return {
    platform: 'opencode-sdk',
    createSession: vi.fn(async () => ({
      id: 'oc-session-1',
      platform: 'opencode-sdk',
      raw: { baseUrl: 'http://127.0.0.1:19999' },
    })),
    resumeSession: vi.fn(async (sessionId: string) => ({
      id: sessionId,
      platform: 'opencode-sdk',
      raw: { baseUrl: 'http://127.0.0.1:19999', resume: true },
    })),
    forkSession: vi.fn(),
    sendMessage: vi.fn(function* () {
      for (const event of sseEvents) {
        yield event;
      }
    }),
    abortSession: vi.fn(),
    cleanupSession: vi.fn(),
    setPermissionHost: vi.fn((host) => { permissionHost = host; }),
    getPermissionHost: () => permissionHost,
    _closeFn: closeFn,
  } as any;
}

function providerListModel(id: string, name: string) {
  return {
    id,
    name,
    release_date: '2026-08-21',
    attachment: true,
    reasoning: true,
    temperature: true,
    tool_call: true,
    cost: {
      input: 3,
      output: 15,
      cache_read: 0.3,
      cache_write: 3.75,
    },
    limit: { context: 200_000, output: 32_000 },
    modalities: {
      input: ['text', 'image'] as Array<'text' | 'image'>,
      output: ['text'] as Array<'text'>,
    },
    options: {},
  };
}

describe('OpenCodeProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true });

    // Reset shared MCP config + provider loader
    configureMcpServers({ mcpServerPort: null, extensionDevServerPort: null });
    OpenCodeProvider.setMcpConfigLoader(null);
    OpenCodeProvider.setShellEnvironmentLoader(null);
    OpenCodeProvider.setEnhancedPathLoader(null);
    OpenCodeProvider.setTrustChecker(null);
    OpenCodeProvider.setPermissionPatternSaver(null);
    OpenCodeProvider.setPermissionPatternChecker(null);
    OpenCodeProvider.resetCachedSdkSlashCommandsForTests();
    resetOpenCodeModelCatalogForTests();
    configureOpenCodeAgentCatalogForTests();
  });

  it('returns offline presets from a cold cache without acquiring or spawning a server', async () => {
    const ensureRunning = vi.fn();
    const createClient = vi.fn();
    configureOpenCodeModelCatalog({
      getCacheKey: () => 'binary-a:auth-a',
      loadCache: () => null,
      getServerManager: () => ({
        isRunning: false,
        baseUrl: 'http://127.0.0.1:19999',
        ensureRunning,
        release: vi.fn(),
      }),
      createClient,
    });

    const models = await OpenCodeProvider.getModels('/workspace-a');

    expect(models.length).toBeGreaterThan(0);
    expect(models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'opencode:anthropic/claude-sonnet-4-5', provider: 'opencode' }),
      expect.objectContaining({ id: 'opencode:openai/gpt-5', provider: 'opencode' }),
      expect.objectContaining({ id: 'opencode:google/gemini-2.5-pro', provider: 'opencode' }),
      expect.objectContaining({ id: 'opencode:zai/glm-5.2', provider: 'opencode' }),
      expect.objectContaining({ id: 'opencode:zai-coding-plan/glm-5.2', provider: 'opencode' }),
    ]));
    expect(ensureRunning).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  // #1382: getModels() used to take no workspace at all, so the session model
  // picker read a context-free catalog and every install saw the hardcoded
  // presets no matter what discovery had already persisted.
  it('serves the discovered catalog to the session model picker, not presets', async () => {
    const discovered = {
      id: 'opencode:local-gateway/acme-17b',
      name: 'Acme 17B',
      provider: 'opencode' as const,
    };
    configureOpenCodeModelCatalog({
      getCacheKey: (workspacePath) => `identity:${workspacePath}`,
      loadCache: (workspacePath) =>
        workspacePath === '/workspace-a'
          ? {
              version: 2,
              cacheKey: 'identity:/workspace-a',
              workspacePath: '/workspace-a',
              models: [discovered],
              refreshedAt: Date.now(),
            }
          : null,
      getServerManager: () => ({
        isRunning: false,
        baseUrl: 'http://127.0.0.1:19999',
        ensureRunning: vi.fn(),
        release: vi.fn(),
      }),
    });

    expect(await OpenCodeProvider.getModels('/workspace-a')).toContainEqual(discovered);
    // A caller with genuinely no workspace still gets presets -- but it has to
    // say so, and it must not borrow workspace A's discovery result.
    expect(await OpenCodeProvider.getModels(undefined)).not.toContainEqual(discovered);
  });

  it('replaces presets with provider.list results once discovery succeeds', async () => {
    const savedCaches: OpenCodeModelCatalogCache[] = [];
    const ensureRunning = vi.fn();
    configureOpenCodeModelCatalog({
      getCacheKey: () => 'binary-a:auth-a',
      loadCache: () => savedCaches.at(-1) ?? null,
      saveCache: (cache) => { savedCaches.push(cache); },
      getServerManager: () => ({
        isRunning: true,
        baseUrl: 'http://127.0.0.1:19999',
        ensureRunning,
        release: vi.fn(),
      }),
      createClient: async () => ({
        provider: {
          list: async () => ({
            data: {
              all: [{
                id: 'anthropic',
                name: 'Anthropic',
                env: ['ANTHROPIC_API_KEY'],
                models: {
                  'claude-sonnet-4-5': providerListModel('claude-sonnet-4-5', 'Live Sonnet 4.5'),
                } as Record<string, ReturnType<typeof providerListModel>>,
              }, {
                id: 'openrouter',
                name: 'OpenRouter',
                env: ['OPENROUTER_API_KEY'],
                models: {
                  'acme/novel-model': providerListModel('acme/novel-model', 'Novel Model'),
                } as Record<string, ReturnType<typeof providerListModel>>,
              }],
              default: {},
              connected: ['anthropic', 'openrouter'],
            },
          }),
        },
      }),
    });

    const { models } = await getOpenCodeModelCatalog('/workspace-a');

    expect(models.filter((model) => model.id === 'opencode:anthropic/claude-sonnet-4-5')).toEqual([
      expect.objectContaining({
        name: 'Live Sonnet 4.5',
        contextWindow: 200_000,
        maxTokens: 32_000,
        status: 'active',
        cost: {
          input: 3,
          output: 15,
          cache: { read: 0.3, write: 3.75 },
        },
        capabilities: expect.objectContaining({ reasoning: true, toolcall: true }),
      }),
    ]);
    expect(models).toContainEqual(expect.objectContaining({
      id: 'opencode:openrouter/acme/novel-model',
      name: 'Novel Model',
    }));
    // Presets are an offline fallback, not padding: a discovered catalog must
    // not carry hardcoded models this install never reported.
    expect(models.map((model) => model.id)).not.toContain('opencode:openai/gpt-5');
    expect(ensureRunning).not.toHaveBeenCalled();
    expect(savedCaches.at(-1)?.models).toHaveLength(2);
  });

  it('lists only connected providers, keeping a retained selection marked unavailable', async () => {
    const savedCaches: OpenCodeModelCatalogCache[] = [];
    configureOpenCodeModelCatalog({
      getCacheKey: () => 'binary-a:auth-a',
      loadCache: () => savedCaches.at(-1) ?? null,
      saveCache: (cache) => { savedCaches.push(cache); },
      // The user's opencode.json default points at a provider they have since
      // stopped being authenticated for.
      getRetainedModelIds: () => ['google/gemini-2.5-pro'],
      getServerManager: () => ({
        isRunning: true,
        baseUrl: 'http://127.0.0.1:19999',
        ensureRunning: vi.fn(),
        release: vi.fn(),
      }),
      createClient: async () => ({
        provider: {
          list: async () => ({
            data: {
              all: [{
                id: 'anthropic',
                name: 'Anthropic',
                env: ['ANTHROPIC_API_KEY'],
                models: {
                  'claude-sonnet-4-5': providerListModel('claude-sonnet-4-5', 'Live Sonnet 4.5'),
                } as Record<string, ReturnType<typeof providerListModel>>,
              }, {
                id: 'google',
                name: 'Google',
                env: ['GEMINI_API_KEY'],
                models: {
                  'gemini-2.5-pro': providerListModel('gemini-2.5-pro', 'Gemini 2.5 Pro'),
                  'gemini-2.5-flash': providerListModel('gemini-2.5-flash', 'Gemini 2.5 Flash'),
                } as Record<string, ReturnType<typeof providerListModel>>,
              }],
              default: {},
              connected: ['anthropic'],
            },
          }),
        },
      }),
    });

    const { models } = await getOpenCodeModelCatalog('/workspace-a');

    // `all` is OpenCode's whole registry; only `connected` providers can run.
    expect(models.map((model) => model.id)).not.toContain('opencode:google/gemini-2.5-flash');
    expect(savedCaches.at(-1)?.models.map((model) => model.id)).toEqual([
      'opencode:anthropic/claude-sonnet-4-5',
    ]);
    expect(models).toContainEqual(expect.objectContaining({
      id: 'opencode:google/gemini-2.5-pro',
      unavailable: true,
    }));
  });

  it('invalidates discovered cache entries when the auth identity changes', async () => {
    let cacheKey = 'binary-a:auth-a';
    const cachedModel = {
      id: 'opencode:openrouter/acme/novel-model',
      name: 'Novel Model',
      provider: 'opencode' as const,
      contextWindow: 128_000,
    };
    const cache: OpenCodeModelCatalogCache = {
      version: 2,
      cacheKey,
      workspacePath: '/workspace-a',
      models: [cachedModel],
      refreshedAt: Date.now(),
    };
    const ensureRunning = vi.fn();
    configureOpenCodeModelCatalog({
      getCacheKey: () => cacheKey,
      loadCache: () => cache,
      getServerManager: () => ({
        isRunning: false,
        baseUrl: 'http://127.0.0.1:19999',
        ensureRunning,
        release: vi.fn(),
      }),
    });

    expect((await getOpenCodeModelCatalog('/workspace-a')).models).toContainEqual(cachedModel);

    cacheKey = 'binary-a:auth-b';
    const snapshot = await getOpenCodeModelCatalog('/workspace-a');
    expect(snapshot).toMatchObject({
      cacheStatus: 'stale',
      staleReason: 'identity-changed',
    });
    expect(snapshot.models).not.toContainEqual(cachedModel);
    expect(ensureRunning).not.toHaveBeenCalled();
  });

  it('does not expose one workspace model cache to another workspace', async () => {
    const privateModel = {
      id: 'opencode:private/project-a-model',
      name: 'Project A model',
      provider: 'opencode' as const,
    };
    configureOpenCodeModelCatalog({
      getCacheKey: (workspacePath) => `identity:${workspacePath}`,
      loadCache: () => ({
        version: 2,
        cacheKey: 'identity:/workspace-a',
        workspacePath: '/workspace-a',
        models: [privateModel],
        refreshedAt: Date.now(),
      }),
      getServerManager: () => ({
        isRunning: false,
        baseUrl: 'http://127.0.0.1:19999',
        ensureRunning: vi.fn(),
        release: vi.fn(),
      }),
    });

    const projectB = await getOpenCodeModelCatalog('/workspace-b');

    expect(projectB.models).not.toContainEqual(privateModel);
  });

  it('rejects malformed persisted entries and caps a discovered catalog at 5000 models', async () => {
    configureOpenCodeModelCatalog({
      getCacheKey: () => 'identity:/workspace',
      loadCache: () => ({
        version: 2,
        cacheKey: 'identity:/workspace',
        workspacePath: '/workspace',
        models: [{}],
        refreshedAt: Date.now(),
      }),
      getServerManager: () => ({
        isRunning: false,
        baseUrl: 'http://127.0.0.1:19999',
        ensureRunning: vi.fn(),
        release: vi.fn(),
      }),
    });
    const malformedRead = await getOpenCodeModelCatalog('/workspace');

    const persisted: OpenCodeModelCatalogCache[] = [];
    const models = Object.fromEntries(
      Array.from({ length: 5_001 }, (_, index) => {
        const id = `model-${index}`;
        return [id, providerListModel(id, `Model ${index}`)];
      }),
    );
    configureOpenCodeModelCatalog({
      getCacheKey: () => 'identity:/workspace',
      loadCache: () => null,
      saveCache: (cache) => { persisted.push(cache); },
      getServerManager: () => ({
        isRunning: true,
        baseUrl: 'http://127.0.0.1:19999',
        ensureRunning: vi.fn(),
        release: vi.fn(),
      }),
      createClient: () => ({
        provider: {
          list: async () => ({
            data: {
              all: [{ id: 'local', name: 'Local', env: [], models }],
              default: {},
              connected: ['local'],
            },
          }),
        },
      }),
    });
    await getOpenCodeModelCatalog('/workspace');

    expect({
      malformedStatus: malformedRead.cacheStatus,
      persistedModels: persisted.at(-1)?.models.length,
    }).toEqual({ malformedStatus: 'cold', persistedModels: 5_000 });
  });

  it('offers only the agents that can be a session role, with the model each declares', async () => {
    const agents = vi.fn(async () => ({
      data: [
        {
          name: 'build', mode: 'primary', builtIn: true, tools: {}, options: {},
          permission: { edit: 'allow', bash: { '*': 'allow' } },
        },
        {
          name: 'plan', mode: 'primary', builtIn: true, tools: {}, options: {},
          description: 'Read-only planning',
          model: { providerID: 'anthropic', modelID: 'claude-opus-4-1' },
          permission: { edit: 'deny', bash: { '*': 'deny' }, webfetch: 'allow' },
        },
        {
          name: 'flexible', mode: 'all', builtIn: false, tools: {}, options: {},
          permission: { edit: 'ask', bash: {} },
        },
        {
          name: 'general', mode: 'subagent', builtIn: true, tools: {}, options: {},
          permission: { edit: 'allow', bash: { '*': 'allow' } },
        },
      ],
    }));
    configureOpenCodeAgentCatalogForTests({
      getServerManager: () => ({ isRunning: true, baseUrl: 'http://127.0.0.1:19999', serverGeneration: 1 }),
      createClient: () => ({ app: { agents } }) as any,
    });

    const snapshot = await getOpenCodeAgentCatalog('/workspace');

    // `subagent` is the teammate surface, not a role the session runs as; `all`
    // is usable in either position, so it qualifies.
    expect(snapshot.agents.map((entry) => entry.name)).toEqual(['build', 'plan', 'flexible']);
    expect(snapshot.discovered).toBe(true);
    expect(agents).toHaveBeenCalledWith({ query: { directory: '/workspace' } });
    expect(snapshot.agents[1]).toMatchObject({
      model: { providerID: 'anthropic', modelID: 'claude-opus-4-1' },
      permission: { edit: 'deny', bash: { '*': 'deny' }, webfetch: 'allow' },
    });
  });

  it('never starts a server to answer for roles', async () => {
    const createClient = vi.fn();
    configureOpenCodeAgentCatalogForTests({
      getServerManager: () => ({ isRunning: false, baseUrl: 'http://127.0.0.1:19999', serverGeneration: 0 }),
      createClient,
    });

    expect(await getOpenCodeAgentCatalog('/workspace')).toEqual({ agents: [], discovered: false });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('returns correct capabilities', () => {
    const protocol = createMockProtocol();
    const provider = new OpenCodeProvider({ protocol });

    const caps = provider.getCapabilities();

    expect(caps).toEqual({
      streaming: true,
      tools: true,
      mcpSupport: true,
      edits: true,
      resumeSession: true,
      supportsFileTools: true,
    });
  });

  it('returns opencode as provider name', () => {
    const protocol = createMockProtocol();
    const provider = new OpenCodeProvider({ protocol });

    expect(provider.getProviderName()).toBe('opencode');
  });

  it('returns OpenCode as display name', () => {
    const protocol = createMockProtocol();
    const provider = new OpenCodeProvider({ protocol });

    expect(provider.getDisplayName()).toBe('OpenCode');
  });

  it('routes native permission asks through ToolPermissionService with exact reusable scope', async () => {
    const protocol = createMockProtocol();
    const permissionService = {
      requestToolPermission: vi.fn(async () => ({ decision: 'allow', scope: 'session' })),
      resolvePermission: vi.fn(), rejectAllPending: vi.fn(), clearSessionCache: vi.fn(),
    } as any;
    const provider = new OpenCodeProvider({ protocol, permissionService });
    const signal = new AbortController().signal;
    const decision = await protocol.getPermissionHost().resolvePermission({
      id: 'permission-1', sessionId: 'oc-session-1', permission: 'external_directory',
      patterns: ['/tmp/*'], always: ['/tmp/*'], metadata: { path: '/tmp/scratch.txt' },
    }, { sessionId: 'nim-session-1', workspacePath: '/workspace', permissionsPath: '/project', signal });
    expect(decision).toEqual({ decision: 'allow', scope: 'session' });
    expect(permissionService.requestToolPermission).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'permission-1', sessionId: 'nim-session-1', permissionsPath: '/project',
      toolName: 'external_directory', pattern: 'OpenCode(external_directory:/tmp/*)',
      suppressAlwaysAllowRule: false, signal,
    }));
    provider.resolveToolPermission('permission-1', { decision: 'allow', scope: 'once' });
    expect(permissionService.resolvePermission).toHaveBeenCalledWith('permission-1', { decision: 'allow', scope: 'once' });
  });

  it('emits pending and resolved permission events through the production service wiring', async () => {
    const patternSaver = vi.fn(async () => {});
    OpenCodeProvider.setTrustChecker(() => ({ trusted: true, mode: 'ask' }));
    OpenCodeProvider.setPermissionPatternSaver(patternSaver);
    OpenCodeProvider.setPermissionPatternChecker(async () => false);
    const protocol = createMockProtocol();
    const provider = new OpenCodeProvider({ protocol });
    const pending = vi.fn();
    const resolved = vi.fn();
    provider.on('toolPermission:pending', pending);
    provider.on('toolPermission:resolved', resolved);
    const decisionPromise = protocol.getPermissionHost().resolvePermission({
      id: 'permission-1', sessionId: 'oc-session-1', permission: 'external_directory',
      patterns: ['/tmp/*'], always: ['/tmp/*'], metadata: {},
    }, {
      sessionId: 'nim-session-1', workspacePath: '/workspace', permissionsPath: '/project',
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(pending).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'permission-1', sessionId: 'nim-session-1', workspacePath: '/workspace',
    })));
    provider.resolveToolPermission('permission-1', { decision: 'allow', scope: 'always' });
    await expect(decisionPromise).resolves.toEqual({ decision: 'allow', scope: 'always' });
    expect(resolved).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'permission-1', response: { decision: 'allow', scope: 'always' },
    }));
    expect(patternSaver).toHaveBeenCalledWith('/project', 'OpenCode(external_directory:/tmp/*)');
  });

  it('writes a result row for a waiting prompt that another "Always" answer settled', async () => {
    OpenCodeProvider.setTrustChecker(() => ({ trusted: true, mode: 'ask' }));
    OpenCodeProvider.setPermissionPatternSaver(vi.fn(async () => {}));
    OpenCodeProvider.setPermissionPatternChecker(async () => false);
    const protocol = createMockProtocol();
    const provider = new OpenCodeProvider({ protocol });
    const logged = vi.spyOn(provider as any, 'logAgentMessageBestEffort').mockResolvedValue(undefined);
    const pending = vi.fn();
    provider.on('toolPermission:pending', pending);
    const ask = (id: string) => protocol.getPermissionHost().resolvePermission({
      id, sessionId: 'oc-session-1', permission: 'external_directory',
      patterns: ['/tmp/*'], always: ['/tmp/*'], metadata: {},
    }, {
      sessionId: 'nim-session-1', workspacePath: '/workspace', permissionsPath: '/project',
      signal: new AbortController().signal,
    });
    const first = ask('permission-1');
    const second = ask('permission-2');
    await vi.waitFor(() => expect(pending).toHaveBeenCalledTimes(2));

    provider.resolveToolPermission('permission-1', { decision: 'allow', scope: 'always' }, 'nim-session-1');
    await first;
    await expect(second).resolves.toEqual({ decision: 'allow', scope: 'session' });

    // Without this row the second prompt card would look unanswered after a reload.
    const releasedRows = logged.mock.calls.filter(([, , content]) => String(content).includes('permission-2'));
    expect(releasedRows).toHaveLength(1);
    expect(releasedRows[0][0]).toBe('nim-session-1');
    expect(JSON.parse(JSON.parse(releasedRows[0][2] as string).result)).toMatchObject({ decision: 'allow', scope: 'session' });
  });

  it('streams text chunks from protocol text events', async () => {
    const protocol = createMockProtocol([
      { type: 'text', content: 'hello from opencode' },
      { type: 'complete', content: 'hello from opencode', usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 } },
    ]);

    const provider = new OpenCodeProvider({ protocol });
    await provider.initialize({ model: 'opencode:default' });

    const chunks: any[] = [];
    for await (const chunk of provider.sendMessage('test', undefined, 'session-1', [], process.cwd())) {
      chunks.push(chunk);
    }

    // Text chunks are also yielded alongside canonical events so AIService
    // can populate fullResponse for OS notification bodies.
    expect(chunks.some((c) => c.type === 'text')).toBe(true);
    expect(chunks.some((c) => c.type === 'complete')).toBe(true);
  });

  it('adds the cache-backed context window for the model OpenCode actually ran', async () => {
    const ensureRunning = vi.fn();
    configureOpenCodeModelCatalog({
      getCacheKey: () => 'binary-a:auth-a',
      loadCache: () => ({
        version: 2,
        cacheKey: 'binary-a:auth-a',
        workspacePath: process.cwd(),
        refreshedAt: Date.now(),
        models: [{
          id: 'opencode:anthropic/claude-sonnet-4',
          name: 'Claude Sonnet 4',
          provider: 'opencode',
          contextWindow: 200_000,
        }],
      }),
      getServerManager: () => ({
        isRunning: false,
        baseUrl: 'http://127.0.0.1:19999',
        ensureRunning,
        release: vi.fn(),
      }),
    });
    const protocol = createMockProtocol([{
      type: 'complete',
      content: '',
      usage: { input_tokens: 1_000, output_tokens: 200, total_tokens: 1_200 },
      contextFillTokens: 12_500,
      metadata: { openCodeModelId: 'opencode:anthropic/claude-sonnet-4' },
    }]);
    const provider = new OpenCodeProvider({ protocol });
    await provider.initialize({ model: 'default' });
    const chunks: any[] = [];

    for await (const chunk of provider.sendMessage(
      'test',
      undefined,
      'session-context',
      [],
      process.cwd(),
    )) {
      chunks.push(chunk);
    }

    expect(chunks.find((chunk) => chunk.type === 'complete')).toMatchObject({
      usage: { input_tokens: 1_000, output_tokens: 200, total_tokens: 1_200 },
      contextFillTokens: 12_500,
      contextWindow: 200_000,
    });
    expect(ensureRunning).not.toHaveBeenCalled();
  });

  it('streams tool_call chunks from protocol tool events', async () => {
    const protocol = createMockProtocol([
      {
        type: 'tool_call',
        toolCall: { id: 'tool-1', name: 'file_edit', arguments: { path: '/foo.ts' } },
      },
      {
        type: 'tool_result',
        toolResult: { id: 'tool-1', name: 'file_edit', result: { success: true, result: 'done' } },
      },
      { type: 'complete', content: '', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
    ]);

    const provider = new OpenCodeProvider({ protocol });
    await provider.initialize({ model: 'opencode:default' });

    const chunks: any[] = [];
    for await (const chunk of provider.sendMessage('edit file', undefined, 'session-2', [], process.cwd())) {
      chunks.push(chunk);
    }

    // tool_call from tool.execute.before
    expect(chunks.some((c) => c.type === 'tool_call' && c.toolCall?.name === 'file_edit')).toBe(true);
    // tool_result is also emitted as tool_call chunk with result
    const resultChunk = chunks.find((c) => c.type === 'tool_call' && c.toolCall?.result);
    expect(resultChunk).toBeDefined();
  });

  it('yields error when workspacePath is missing', async () => {
    const protocol = createMockProtocol([]);
    const provider = new OpenCodeProvider({ protocol });
    await provider.initialize({ model: 'opencode:default' });

    const chunks: any[] = [];
    for await (const chunk of provider.sendMessage('test', undefined, 'session-3', [])) {
      chunks.push(chunk);
    }

    const errorChunk = chunks.find((c) => c.type === 'error');
    expect(errorChunk).toBeDefined();
    expect(errorChunk.error).toMatch(/no project folder/i);
  });

  it('saves provider session ID after stream completes', async () => {
    const protocol = createMockProtocol([
      { type: 'text', content: 'done' },
      { type: 'complete', content: 'done' },
    ]);

    const provider = new OpenCodeProvider({ protocol });
    await provider.initialize({ model: 'opencode:default' });

    for await (const _chunk of provider.sendMessage('test', undefined, 'session-save', [], process.cwd())) {
      // drain
    }

    const sessionData = provider.getProviderSessionData('session-save');
    expect(sessionData.providerSessionId).toBe('oc-session-1');
    expect(sessionData.openCodeSessionId).toBe('oc-session-1');
  });

  it('resumes existing session when provider session data exists', async () => {
    const protocol = createMockProtocol([
      { type: 'text', content: 'resumed' },
      { type: 'complete', content: 'resumed' },
    ]);

    const provider = new OpenCodeProvider({ protocol });
    await provider.initialize({ model: 'opencode:default' });

    // First message creates a session
    for await (const _chunk of provider.sendMessage('first', undefined, 'session-resume', [], process.cwd())) {
      // drain
    }

    // Reset mock to track second call
    protocol.sendMessage.mockImplementation(function* () {
      yield { type: 'text', content: 'second' };
      yield { type: 'complete', content: 'second' };
    });

    // Second message should resume
    for await (const _chunk of provider.sendMessage('second', undefined, 'session-resume', [], process.cwd())) {
      // drain
    }

    expect(protocol.resumeSession).toHaveBeenCalledWith('oc-session-1', expect.anything());
  });
});
