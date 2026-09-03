// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { OpenCodeSDKProtocol, OpenCodeServerManager, OpenCodeClientLike, OpenCodeSSEEvent } from '../OpenCodeSDKProtocol';
import { OpenCodeProvider } from '../../providers/OpenCodeProvider';
import { EventEmitter } from 'events';
import type { ChatAttachment } from '../../types';

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

function createAsyncEventStream(events: OpenCodeSSEEvent[]): AsyncIterable<OpenCodeSSEEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function createMockSdkModule(
  sseEvents: OpenCodeSSEEvent[],
  commands: Array<{
    name: string;
    description?: string;
    agent?: string;
    model?: string;
    template: string;
    subtask?: boolean;
  }> = [],
) {
  const promptFn = vi.fn(async () => ({}));
  const createFn = vi.fn(async () => ({ data: { id: 'oc-session-1' } }));
  const listFn = vi.fn(async () => ({ data: [] }));
  const abortFn = vi.fn(async () => ({}));
  const summarizeFn = vi.fn(async () => ({ data: true }));
  const commandListFn = vi.fn(async () => ({ data: commands }));
  const subscribeFn = vi.fn(async () => ({
    stream: createAsyncEventStream(sseEvents),
  }));

  const mcpAddFn = vi.fn(async () => ({}));

  const mockClient: OpenCodeClientLike = {
    session: {
      create: createFn,
      list: listFn,
      prompt: promptFn,
      abort: abortFn,
      summarize: summarizeFn,
    },
    command: {
      list: commandListFn,
    },
    global: {
      event: subscribeFn,
    },
    event: {
      subscribe: subscribeFn,
    },
    mcp: {
      add: mcpAddFn,
    },
  };

  const loadSdkModule = async () => ({
    createOpencodeClient: () => mockClient,
  });

  return {
    loadSdkModule,
    mockClient,
    promptFn,
    createFn,
    subscribeFn,
    summarizeFn,
    commandListFn,
  };
}

describe('OpenCodeSDKProtocol', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true });
    OpenCodeProvider.resetCachedSdkSlashCommandsForTests();
  });

  it('emits a raw_event for every SSE event', async () => {
    const sseEvents: OpenCodeSSEEvent[] = [
      { type: 'unknown.custom', properties: { foo: 'bar' } },
      { type: 'message.part.updated', properties: { part: { type: 'text', text: 'hello', sessionID: 'oc-session-1', messageID: 'm1', id: 'p1' }, delta: 'hello' } },
      { type: 'session.idle', properties: { sessionID: 'oc-session-1' } },
    ];

    const { loadSdkModule } = createMockSdkModule(sseEvents);
    const protocol = new OpenCodeSDKProtocol(loadSdkModule);
    const session = await protocol.createSession({ workspacePath: '/tmp/test' });
    const emitted: any[] = [];

    for await (const event of protocol.sendMessage(session, { content: 'test' })) {
      emitted.push(event);
    }

    const rawEvents = emitted.filter((e) => e.type === 'raw_event');
    expect(rawEvents).toHaveLength(sseEvents.length);
  });

  it('parses text part using delta', async () => {
    const sseEvents: OpenCodeSSEEvent[] = [
      { type: 'message.part.updated', properties: { part: { type: 'text', text: 'full', sessionID: 'oc-session-1', messageID: 'm1', id: 'p1' }, delta: 'hello opencode' } },
      { type: 'session.idle', properties: { sessionID: 'oc-session-1' } },
    ];

    const { loadSdkModule } = createMockSdkModule(sseEvents);
    const protocol = new OpenCodeSDKProtocol(loadSdkModule);
    const session = await protocol.createSession({ workspacePath: '/tmp/test' });
    const emitted: any[] = [];

    for await (const event of protocol.sendMessage(session, { content: 'test' })) {
      emitted.push(event);
    }

    expect(emitted.some((e) => e.type === 'text' && e.content === 'hello opencode')).toBe(true);
  });

  it('parses reasoning part', async () => {
    const sseEvents: OpenCodeSSEEvent[] = [
      { type: 'message.part.updated', properties: { part: { type: 'reasoning', text: 'thinking...', sessionID: 'oc-session-1', messageID: 'm1', id: 'p1' }, delta: 'thinking...' } },
      { type: 'session.idle', properties: { sessionID: 'oc-session-1' } },
    ];

    const { loadSdkModule } = createMockSdkModule(sseEvents);
    const protocol = new OpenCodeSDKProtocol(loadSdkModule);
    const session = await protocol.createSession({ workspacePath: '/tmp/test' });
    const emitted: any[] = [];

    for await (const event of protocol.sendMessage(session, { content: 'test' })) {
      emitted.push(event);
    }

    expect(emitted.some((e) => e.type === 'reasoning' && e.content === 'thinking...')).toBe(true);
  });

  it('parses tool part in running state as tool_call', async () => {
    const sseEvents: OpenCodeSSEEvent[] = [
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool', id: 'p1', sessionID: 'oc-session-1', messageID: 'm1',
            callID: 'call-1', tool: 'file_edit',
            state: { status: 'running', input: { path: '/foo.ts' } },
          },
        },
      },
      { type: 'session.idle', properties: { sessionID: 'oc-session-1' } },
    ];

    const { loadSdkModule } = createMockSdkModule(sseEvents);
    const protocol = new OpenCodeSDKProtocol(loadSdkModule);
    const session = await protocol.createSession({ workspacePath: '/tmp/test' });
    const emitted: any[] = [];

    for await (const event of protocol.sendMessage(session, { content: 'test' })) {
      emitted.push(event);
    }

    const toolCall = emitted.find((e) => e.type === 'tool_call' && e.toolCall?.name === 'file_edit');
    expect(toolCall).toBeDefined();
    expect(toolCall.toolCall.id).toBe('call-1');
    expect(toolCall.toolCall.arguments).toEqual({ path: '/foo.ts' });
  });

  it('parses tool part in completed state as tool_result', async () => {
    const sseEvents: OpenCodeSSEEvent[] = [
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool', id: 'p1', sessionID: 'oc-session-1', messageID: 'm1',
            callID: 'call-1', tool: 'file_edit',
            state: { status: 'completed', output: 'File edited successfully' },
          },
        },
      },
      { type: 'session.idle', properties: { sessionID: 'oc-session-1' } },
    ];

    const { loadSdkModule } = createMockSdkModule(sseEvents);
    const protocol = new OpenCodeSDKProtocol(loadSdkModule);
    const session = await protocol.createSession({ workspacePath: '/tmp/test' });
    const emitted: any[] = [];

    for await (const event of protocol.sendMessage(session, { content: 'test' })) {
      emitted.push(event);
    }

    const toolResult = emitted.find((e) => e.type === 'tool_result');
    expect(toolResult).toBeDefined();
    expect(toolResult.toolResult.name).toBe('file_edit');
    expect(toolResult.toolResult.result.success).toBe(true);
  });

  it('parses tool part in error state', async () => {
    const sseEvents: OpenCodeSSEEvent[] = [
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool', id: 'p1', sessionID: 'oc-session-1', messageID: 'm1',
            callID: 'call-1', tool: 'file_edit',
            state: { status: 'error', error: 'Permission denied' },
          },
        },
      },
      { type: 'session.idle', properties: { sessionID: 'oc-session-1' } },
    ];

    const { loadSdkModule } = createMockSdkModule(sseEvents);
    const protocol = new OpenCodeSDKProtocol(loadSdkModule);
    const session = await protocol.createSession({ workspacePath: '/tmp/test' });
    const emitted: any[] = [];

    for await (const event of protocol.sendMessage(session, { content: 'test' })) {
      emitted.push(event);
    }

    const toolResult = emitted.find((e) => e.type === 'tool_result');
    expect(toolResult).toBeDefined();
    expect(toolResult.toolResult.result.success).toBe(false);
    expect(toolResult.toolResult.result.error).toBe('Permission denied');
  });

  it('parses file.edited with file property', async () => {
    const sseEvents: OpenCodeSSEEvent[] = [
      { type: 'file.edited', properties: { file: '/bar.ts' } },
      { type: 'session.idle', properties: { sessionID: 'oc-session-1' } },
    ];

    const { loadSdkModule } = createMockSdkModule(sseEvents);
    const protocol = new OpenCodeSDKProtocol(loadSdkModule);
    const session = await protocol.createSession({ workspacePath: '/tmp/test' });
    const emitted: any[] = [];

    for await (const event of protocol.sendMessage(session, { content: 'test' })) {
      emitted.push(event);
    }

    const fileEdit = emitted.find((e) => e.type === 'tool_call' && e.metadata?.isFileEditNotification);
    expect(fileEdit).toBeDefined();
    expect(fileEdit.toolCall.arguments).toEqual({ file_path: '/bar.ts' });
  });

  it('parses session.idle as complete event', async () => {
    const sseEvents: OpenCodeSSEEvent[] = [
      { type: 'message.part.updated', properties: { part: { type: 'text', text: 'done', sessionID: 'oc-session-1', messageID: 'm1', id: 'p1' }, delta: 'done' } },
      { type: 'session.idle', properties: { sessionID: 'oc-session-1' } },
    ];

    const { loadSdkModule } = createMockSdkModule(sseEvents);
    const protocol = new OpenCodeSDKProtocol(loadSdkModule);
    const session = await protocol.createSession({ workspacePath: '/tmp/test' });
    const emitted: any[] = [];

    for await (const event of protocol.sendMessage(session, { content: 'test' })) {
      emitted.push(event);
    }

    const completeEvent = emitted.find((e) => e.type === 'complete');
    expect(completeEvent).toBeDefined();
    const eventsAfterComplete = emitted.slice(emitted.indexOf(completeEvent) + 1);
    expect(eventsAfterComplete).toHaveLength(0);
  });

  it('normalizes assistant usage and keeps the latest message as current context', async () => {
    const assistantUsage = (
      id: string,
      modelID: string,
      input: number,
      output: number,
      cacheRead: number,
      cacheWrite: number,
    ): OpenCodeSSEEvent => ({
      type: 'message.updated',
      properties: {
        info: {
          id,
          sessionID: 'oc-session-1',
          role: 'assistant',
          providerID: 'anthropic',
          modelID,
          tokens: {
            input,
            output,
            reasoning: 0,
            cache: { read: cacheRead, write: cacheWrite },
          },
        },
      },
    });
    const sseEvents = [
      assistantUsage('message-1', 'claude-sonnet-4', 100, 20, 1_000, 50),
      // The same message can be updated with final counts; it must replace,
      // not double-count, the earlier snapshot.
      assistantUsage('message-1', 'claude-sonnet-4', 120, 25, 1_100, 55),
      assistantUsage('message-2', 'claude-sonnet-4', 200, 30, 2_000, 75),
      { type: 'session.idle', properties: { sessionID: 'oc-session-1' } },
    ];

    const { loadSdkModule } = createMockSdkModule(sseEvents);
    const protocol = new OpenCodeSDKProtocol(loadSdkModule);
    const session = await protocol.createSession({ workspacePath: '/tmp/test' });
    const emitted: any[] = [];

    for await (const event of protocol.sendMessage(session, { content: 'test' })) {
      emitted.push(event);
    }

    expect(emitted.find((event) => event.type === 'complete')).toMatchObject({
      usage: {
        input_tokens: 320,
        output_tokens: 55,
        total_tokens: 375,
      },
      contextFillTokens: 2_275,
      metadata: {
        openCodeModelId: 'opencode:anthropic/claude-sonnet-4',
      },
    });
  });

  it('parses session.error with error object', async () => {
    const sseEvents: OpenCodeSSEEvent[] = [
      { type: 'session.error', properties: { sessionID: 'oc-session-1', error: { type: 'api', message: 'rate limited' } } },
    ];

    const { loadSdkModule } = createMockSdkModule(sseEvents);
    const protocol = new OpenCodeSDKProtocol(loadSdkModule);
    const session = await protocol.createSession({ workspacePath: '/tmp/test' });
    const emitted: any[] = [];

    for await (const event of protocol.sendMessage(session, { content: 'test' })) {
      emitted.push(event);
    }

    expect(emitted.some((e) => e.type === 'error' && e.error === 'rate limited')).toBe(true);
  });

  it('filters events by session ID', async () => {
    const sseEvents: OpenCodeSSEEvent[] = [
      { type: 'message.part.updated', properties: { part: { type: 'text', text: 'other', sessionID: 'other-session', messageID: 'm1', id: 'p1' }, delta: 'other' } },
      { type: 'message.part.updated', properties: { part: { type: 'text', text: 'mine', sessionID: 'oc-session-1', messageID: 'm2', id: 'p2' }, delta: 'mine' } },
      { type: 'session.idle', properties: { sessionID: 'oc-session-1' } },
    ];

    const { loadSdkModule } = createMockSdkModule(sseEvents);
    const protocol = new OpenCodeSDKProtocol(loadSdkModule);
    const session = await protocol.createSession({ workspacePath: '/tmp/test' });
    const emitted: any[] = [];

    for await (const event of protocol.sendMessage(session, { content: 'test' })) {
      emitted.push(event);
    }

    const textEvents = emitted.filter((e) => e.type === 'text');
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0].content).toBe('mine');
  });

  it('creates session via SDK client', async () => {
    const { loadSdkModule, createFn } = createMockSdkModule([]);
    const protocol = new OpenCodeSDKProtocol(loadSdkModule);
    const session = await protocol.createSession({ workspacePath: '/tmp/test' });

    expect(session.id).toBe('oc-session-1');
    expect(session.platform).toBe('opencode-sdk');
    expect(createFn).toHaveBeenCalledTimes(1);
  });

  it('keeps declared slash-command support aligned with command.list and its cross-instance cache', async () => {
    const workspacePath = tmpdir();
    const commands = [
      { name: 'review', description: 'Review changes', template: 'Review the current changes' },
      { name: 'handoff', template: 'Prepare a handoff', subtask: true },
    ];
    const sseEvents: OpenCodeSSEEvent[] = [
      { type: 'session.idle', properties: { sessionID: 'oc-session-1' } },
    ];
    const { loadSdkModule, commandListFn } = createMockSdkModule(sseEvents, commands);
    const provider = new OpenCodeProvider({ protocol: new OpenCodeSDKProtocol(loadSdkModule) });

    for await (const _chunk of provider.sendMessage(
      'load workflows',
      undefined,
      'nimbalyst-session-commands',
      undefined,
      workspacePath,
    )) {
      // drain
    }

    // A second turn must not re-fetch: the catalog belongs to the server
    // process, so it is fetched once per server rather than once per message.
    for await (const _chunk of provider.sendMessage(
      'second turn',
      undefined,
      'nimbalyst-session-commands',
      undefined,
      workspacePath,
    )) {
      // drain
    }

    expect(provider.getAgentCapabilities().slashCommands).toBe(true);
    expect(provider.getSlashCommands()).toEqual(['review', 'handoff']);
    expect(OpenCodeProvider.getCachedSdkSlashCommands(workspacePath)).toEqual(['review', 'handoff']);
    expect(OpenCodeProvider.getCachedSdkSlashCommands('/another/project')).toEqual([]);
    expect(new OpenCodeProvider().getSlashCommands()).toEqual([]);
    expect(commandListFn).toHaveBeenCalledTimes(1);
    expect(commandListFn).toHaveBeenCalledWith({ query: { directory: workspacePath } });
  });

  it('compacts a default-model session with its observed assistant model', async () => {
    const workspacePath = tmpdir();
    const sseEvents: OpenCodeSSEEvent[] = [
      {
        type: 'message.updated',
        properties: {
          info: {
            id: 'message-compact',
            sessionID: 'oc-session-1',
            role: 'assistant',
            providerID: 'anthropic',
            modelID: 'claude-sonnet-4-5',
            tokens: {
              input: 100,
              output: 20,
              reasoning: 0,
              cache: { read: 500, write: 10 },
            },
          },
        },
      },
      { type: 'session.idle', properties: { sessionID: 'oc-session-1' } },
    ];
    const { loadSdkModule, summarizeFn } = createMockSdkModule(sseEvents);
    const provider = new OpenCodeProvider({ protocol: new OpenCodeSDKProtocol(loadSdkModule) });
    await provider.initialize({ model: 'default' });

    expect(provider.getAgentCapabilities().compaction).toBe('rpc');
    // Nothing has ever been sent for this session, so there is no OpenCode
    // conversation to compact -- the only case the RPC legitimately refuses.
    await expect(provider.compactSession('cold-session')).rejects.toThrow(/no OpenCode conversation/i);

    for await (const _chunk of provider.sendMessage(
      'start session',
      undefined,
      'nimbalyst-session-compact',
      undefined,
      workspacePath,
    )) {
      // drain
    }
    await provider.compactSession('nimbalyst-session-compact');

    expect(summarizeFn).toHaveBeenCalledWith({
      path: { id: 'oc-session-1' },
      query: { directory: workspacePath },
      body: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
    });
  });

  it('compacts a session restored from storage that has sent nothing through this instance', async () => {
    // The Compact button is offered for every OpenCode session, so a session
    // restored after a restart has to compact through a resume rather than
    // failing on "no live session".
    const workspacePath = tmpdir();
    const { loadSdkModule, summarizeFn } = createMockSdkModule([]);
    const provider = new OpenCodeProvider({ protocol: new OpenCodeSDKProtocol(loadSdkModule) });
    await provider.initialize({ model: 'opencode:openai/gpt-5' });

    await provider.compactSession('nimbalyst-session-restored', {
      workspacePath,
      providerSessionId: 'oc-session-restored',
    });

    expect(summarizeFn).toHaveBeenCalledWith({
      path: { id: 'oc-session-restored' },
      query: { directory: workspacePath },
      body: { providerID: 'openai', modelID: 'gpt-5' },
    });
  });

  it('balances the server reference when session creation fails before a retry', async () => {
    OpenCodeServerManager.resetForTests();
    const { loadSdkModule, createFn } = createMockSdkModule([]);
    createFn.mockRejectedValueOnce(new Error('transient session.create failure'));
    const protocol = new OpenCodeSDKProtocol(loadSdkModule);

    await expect(protocol.createSession({ workspacePath: '/tmp/test' })).rejects.toThrow(
      'transient session.create failure',
    );

    const session = await protocol.createSession({ workspacePath: '/tmp/test' });
    protocol.cleanupSession(session);

    expect(OpenCodeServerManager.getInstance().isRunning).toBe(false);
  });

  it('releases the OpenCode server reference when the provider is destroyed', async () => {
    // Nothing calls the provider's own cleanup hooks; destroy() is what
    // ProviderFactory reaches, so it has to be the point where live protocol
    // sessions -- and the server they hold open -- are handed back.
    OpenCodeServerManager.resetForTests();
    const sseEvents: OpenCodeSSEEvent[] = [
      { type: 'session.idle', properties: { sessionID: 'oc-session-1' } },
    ];
    const { loadSdkModule } = createMockSdkModule(sseEvents);
    const provider = new OpenCodeProvider({ protocol: new OpenCodeSDKProtocol(loadSdkModule) });

    for (const turn of ['first', 'second']) {
      for await (const _chunk of provider.sendMessage(
        turn,
        undefined,
        'nimbalyst-session-destroy',
        undefined,
        tmpdir(),
      )) {
        // drain
      }
    }
    expect(OpenCodeServerManager.getInstance().isRunning).toBe(true);

    provider.destroy();

    expect(OpenCodeServerManager.getInstance().isRunning).toBe(false);
  });

  it('resumes session with existing ID', async () => {
    const { loadSdkModule } = createMockSdkModule([]);
    const protocol = new OpenCodeSDKProtocol(loadSdkModule);
    const session = await protocol.resumeSession('existing-session', { workspacePath: '/tmp/test' });

    expect(session.id).toBe('existing-session');
    expect(session.platform).toBe('opencode-sdk');
    expect(session.raw?.resume).toBe(true);
  });

  it('forkSession falls back to createSession', async () => {
    const { loadSdkModule, createFn } = createMockSdkModule([]);
    const protocol = new OpenCodeSDKProtocol(loadSdkModule);
    const session = await protocol.forkSession('old-session', { workspacePath: '/tmp/test' });

    expect(session.id).toBe('oc-session-1');
    expect(createFn).toHaveBeenCalledTimes(1);
  });

  it('sends prompt with text parts', async () => {
    const sseEvents: OpenCodeSSEEvent[] = [
      { type: 'session.idle', properties: { sessionID: 'oc-session-1' } },
    ];

    const { loadSdkModule, promptFn } = createMockSdkModule(sseEvents);
    const protocol = new OpenCodeSDKProtocol(loadSdkModule);
    const session = await protocol.createSession({ workspacePath: '/tmp/test' });

    for await (const _event of protocol.sendMessage(session, { content: 'hello world' })) {
      // drain
    }

    expect(promptFn).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: 'oc-session-1' },
        body: {
          parts: [{ type: 'text', text: 'hello world' }],
        },
      })
    );
  });

  it('sends the session role on the prompt body, never on session creation', async () => {
    const sseEvents: OpenCodeSSEEvent[] = [
      { type: 'session.idle', properties: { sessionID: 'oc-session-1' } },
    ];

    const { loadSdkModule, promptFn, createFn } = createMockSdkModule(sseEvents);
    const protocol = new OpenCodeSDKProtocol(loadSdkModule);
    const session = await protocol.createSession({
      workspacePath: '/tmp/test',
      model: 'opencode:anthropic/claude-sonnet-4-5',
      raw: { openCodeAgent: 'plan' },
    });

    for await (const _event of protocol.sendMessage(session, { content: 'review this' })) {
      // drain
    }

    // `POST /session` accepts only parentID/title -- an agent passed there is
    // silently dropped, which is why PR #624 never activated the role.
    const createBody = (createFn.mock.calls[0] as unknown as Array<{ body?: Record<string, unknown> }>)[0]?.body;
    expect(createBody ?? {}).not.toHaveProperty('agent');

    const promptBody = (promptFn.mock.calls[0] as unknown as Array<{ body: Record<string, unknown> }>)[0].body;
    expect(promptBody.agent).toBe('plan');
    // Model precedence: OpenCode resolves input.model ?? agent.model ?? session
    // model, and Nimbalyst keeps sending its own model so the picker still
    // describes what runs (#730). The role does not displace it.
    expect(promptBody.model).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4-5' });
  });

  it('omits the role when the session has none, leaving OpenCode its default agent', async () => {
    const sseEvents: OpenCodeSSEEvent[] = [
      { type: 'session.idle', properties: { sessionID: 'oc-session-1' } },
    ];

    const { loadSdkModule, promptFn } = createMockSdkModule(sseEvents);
    const protocol = new OpenCodeSDKProtocol(loadSdkModule);
    const session = await protocol.createSession({
      workspacePath: '/tmp/test',
      raw: { openCodeAgent: '   ' },
    });

    for await (const _event of protocol.sendMessage(session, { content: 'hello' })) {
      // drain
    }

    const promptBody = (promptFn.mock.calls[0] as unknown as Array<{ body: Record<string, unknown> }>)[0].body;
    expect(promptBody).not.toHaveProperty('agent');
  });

  it('rejects an unparseable configured model instead of prompting with the OpenCode default', async () => {
    const invalidModel = 'opencode:claude-sonnet-4-5';
    const sseEvents: OpenCodeSSEEvent[] = [
      { type: 'session.idle', properties: { sessionID: 'oc-session-1' } },
    ];

    const { loadSdkModule, promptFn } = createMockSdkModule(sseEvents);
    const protocol = new OpenCodeSDKProtocol(loadSdkModule);
    const session = await protocol.createSession({ workspacePath: '/tmp/test', model: invalidModel });
    const emitted: any[] = [];

    for await (const event of protocol.sendMessage(session, { content: 'use my selected model' })) {
      emitted.push(event);
    }

    expect(promptFn).not.toHaveBeenCalled();
    expect(emitted).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringContaining(invalidModel) }));
  });

  it('inlines a pasted-text document attachment as a second text part', async () => {
    const sseEvents: OpenCodeSSEEvent[] = [
      { type: 'session.idle', properties: { sessionID: 'oc-session-1' } },
    ];

    const tmpFile = join(tmpdir(), `nimbalyst-opencode-paste-${Date.now()}.txt`);
    await fs.writeFile(tmpFile, 'pasted body content', 'utf-8');

    const attachment: ChatAttachment = {
      id: 'att-1',
      filename: 'pasted-text-2026-05-01.txt',
      filepath: tmpFile,
      mimeType: 'text/plain',
      size: 19,
      type: 'document',
      addedAt: Date.now(),
    };

    try {
      const { loadSdkModule, promptFn } = createMockSdkModule(sseEvents);
      const protocol = new OpenCodeSDKProtocol(loadSdkModule);
      const session = await protocol.createSession({ workspacePath: '/tmp/test' });

      for await (const _event of protocol.sendMessage(session, {
        content: 'look at @pasted-text-2026-05-01.txt',
        attachments: [attachment],
      })) {
        // drain
      }

      const callBody = ((promptFn.mock.calls[0] as unknown as Array<{ body: { parts: Array<{ type: string; text?: string }> } }>)[0]).body;
      expect(callBody.parts).toHaveLength(2);
      expect(callBody.parts[0]).toEqual({ type: 'text', text: 'look at @pasted-text-2026-05-01.txt' });
      expect(callBody.parts[1].type).toBe('text');
      expect(callBody.parts[1].text).toContain('<file name="pasted-text-2026-05-01.txt">');
      expect(callBody.parts[1].text).toContain('pasted body content');
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  });

  it('inlines an image attachment as a base64 data: file part', async () => {
    const sseEvents: OpenCodeSSEEvent[] = [
      { type: 'session.idle', properties: { sessionID: 'oc-session-1' } },
    ];

    const tmpFile = join(tmpdir(), `nimbalyst-opencode-paste-${Date.now()}.png`);
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await fs.writeFile(tmpFile, pngBytes);

    const attachment: ChatAttachment = {
      id: 'att-img-1',
      filename: 'pasted-image.png',
      filepath: tmpFile,
      mimeType: 'image/png',
      size: pngBytes.length,
      type: 'image',
      addedAt: Date.now(),
    };

    try {
      const { loadSdkModule, promptFn } = createMockSdkModule(sseEvents);
      const protocol = new OpenCodeSDKProtocol(loadSdkModule);
      const session = await protocol.createSession({ workspacePath: '/tmp/test' });

      for await (const _event of protocol.sendMessage(session, {
        content: 'see @pasted-image.png',
        attachments: [attachment],
      })) {
        // drain
      }

      const callBody = ((promptFn.mock.calls[0] as unknown as Array<{ body: { parts: Array<Record<string, unknown>> } }>)[0]).body;
      expect(callBody.parts).toHaveLength(2);
      expect(callBody.parts[1]).toEqual({
        type: 'file',
        mime: 'image/png',
        filename: 'pasted-image.png',
        url: `data:image/png;base64,${pngBytes.toString('base64')}`,
      });
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  });

  describe('server startup recovery', () => {
    beforeEach(() => {
      OpenCodeServerManager.resetForTests();
      // Keep the health-check deadline tiny so the timeout path is fast in tests.
      OpenCodeServerManager.startupTimeoutOverrideMs = 250;
    });

    afterEach(() => {
      OpenCodeServerManager.resetForTests();
      OpenCodeServerManager.startupTimeoutOverrideMs = null;
      mockFetch.mockResolvedValue({ ok: true });
    });

    it('retries after a startup timeout instead of caching the rejection for the whole session', async () => {
      // First attempt: server never passes its health check -> startup throws.
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const { loadSdkModule } = createMockSdkModule([]);
      const protocol = new OpenCodeSDKProtocol(loadSdkModule);

      await expect(protocol.createSession({ workspacePath: '/tmp/test' })).rejects.toThrow();

      // Server is healthy now; a new message must re-spawn and succeed rather than
      // instantly re-failing on the cached rejected readyPromise.
      mockFetch.mockResolvedValue({ ok: true });
      const session = await protocol.createSession({ workspacePath: '/tmp/test' });
      expect(session.id).toBe('oc-session-1');
    });

    it('adopts a server that only becomes healthy at the deadline instead of orphaning it', async () => {
      // Force an immediate timeout so the health poll never succeeds, then let
      // the last-chance probe find the server healthy.
      OpenCodeServerManager.startupTimeoutOverrideMs = 0;
      mockFetch.mockResolvedValue({ ok: true });

      const { loadSdkModule } = createMockSdkModule([]);
      const protocol = new OpenCodeSDKProtocol(loadSdkModule);

      const session = await protocol.createSession({ workspacePath: '/tmp/test' });
      expect(session.id).toBe('oc-session-1');
      // Adopted, not killed-and-respawned: the original process is still running.
      expect(OpenCodeServerManager.getInstance().isRunning).toBe(true);
    });

    it('abandons a hung health probe and adopts the server on a later tick instead of at the deadline (#1428)', async () => {
      vi.useFakeTimers();
      try {
        // Deadline far away: if the hung probe is not abandoned, adoption only
        // happens via the late-ready fallback at this deadline.
        OpenCodeServerManager.startupTimeoutOverrideMs = 60_000;

        // First probe: an ESTABLISHED connection that never answers. It only
        // settles when the caller aborts it via the request signal.
        let hungProbeAborted = false;
        mockFetch.mockImplementationOnce(((_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              hungProbeAborted = true;
              reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError'));
            });
          })) as any);

        const { loadSdkModule } = createMockSdkModule([]);
        const protocol = new OpenCodeSDKProtocol(loadSdkModule);

        let settled = false;
        const sessionPromise = protocol.createSession({ workspacePath: '/tmp/test' }).finally(() => {
          settled = true;
        });

        // A few seconds covers the per-probe budget plus several poll ticks,
        // and is nowhere near the 60s startup deadline.
        await vi.advanceTimersByTimeAsync(5_000);

        expect(hungProbeAborted).toBe(true);
        expect(settled).toBe(true);
        const session = await sessionPromise;
        expect(session.id).toBe('oc-session-1');
        expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(OpenCodeServerManager.getInstance().isRunning).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('surfaces a missing-CLI spawn error instead of a generic timeout', async () => {
      const childProcess = await import('child_process');
      (childProcess.spawn as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        const proc = new EventEmitter() as any;
        proc.kill = vi.fn();
        proc.stdin = null;
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.pid = undefined;
        queueMicrotask(() => {
          const err: NodeJS.ErrnoException = new Error('spawn opencode ENOENT');
          err.code = 'ENOENT';
          proc.emit('error', err);
        });
        return proc;
      });
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const { loadSdkModule } = createMockSdkModule([]);
      const protocol = new OpenCodeSDKProtocol(loadSdkModule);

      await expect(protocol.createSession({ workspacePath: '/tmp/test' })).rejects.toThrow(/not found|ENOENT/i);
    });
  });

  it('falls back to an inline error note when an attachment cannot be read', async () => {
    const sseEvents: OpenCodeSSEEvent[] = [
      { type: 'session.idle', properties: { sessionID: 'oc-session-1' } },
    ];

    const attachment: ChatAttachment = {
      id: 'att-missing',
      filename: 'missing.txt',
      filepath: join(tmpdir(), `nimbalyst-opencode-missing-${Date.now()}.txt`),
      mimeType: 'text/plain',
      size: 0,
      type: 'document',
      addedAt: Date.now(),
    };

    const { loadSdkModule, promptFn } = createMockSdkModule(sseEvents);
    const protocol = new OpenCodeSDKProtocol(loadSdkModule);
    const session = await protocol.createSession({ workspacePath: '/tmp/test' });

    for await (const _event of protocol.sendMessage(session, {
      content: 'see @missing.txt',
      attachments: [attachment],
    })) {
      // drain
    }

    const callBody = ((promptFn.mock.calls[0] as unknown as Array<{ body: { parts: Array<{ type: string; text?: string }> } }>)[0]).body;
    expect(callBody.parts).toHaveLength(2);
    expect(callBody.parts[1].type).toBe('text');
    expect(callBody.parts[1].text).toContain('<file name="missing.txt"');
    expect(callBody.parts[1].text).toContain('failed to read attachment');
  });
});
