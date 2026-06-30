import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeProvider } from '../OpenCodeProvider';
import { configureMcpServers } from '../../services/mcpServerConfig';
import { EventEmitter } from 'events';

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
    _closeFn: closeFn,
  } as any;
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
    OpenCodeProvider.setConfigLoader(null);
  });

  it('returns the curated preset model list from getModels when no opencode.json exists', async () => {
    const models = await OpenCodeProvider.getModels();

    expect(models.length).toBeGreaterThan(0);
    expect(models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'opencode:anthropic/claude-sonnet-4-5', provider: 'opencode' }),
      expect.objectContaining({ id: 'opencode:openai/gpt-5', provider: 'opencode' }),
      expect.objectContaining({ id: 'opencode:google/gemini-2.5-pro', provider: 'opencode' }),
      expect.objectContaining({ id: 'opencode:zai/glm-5.2', provider: 'opencode' }),
      expect.objectContaining({ id: 'opencode:zai-coding-plan/glm-5.2', provider: 'opencode' }),
    ]));
  });

  it('appends user-configured providers from opencode.json to the preset list', async () => {
    OpenCodeProvider.setConfigLoader(async () => ({
      provider: {
        lmstudio: {
          name: 'LM Studio (local)',
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'http://127.0.0.1:1234/v1' },
          models: { 'qwen2.5-coder-7b-instruct': { name: 'Qwen 2.5 Coder 7B' } },
        },
      },
    }));

    const models = await OpenCodeProvider.getModels();

    expect(models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'opencode:lmstudio/qwen2.5-coder-7b-instruct', provider: 'opencode' }),
    ]));
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
    expect(errorChunk.error).toContain('workspacePath is required');
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
