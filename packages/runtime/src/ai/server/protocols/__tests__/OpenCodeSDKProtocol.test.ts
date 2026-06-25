import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { OpenCodeSDKProtocol, OpenCodeClientLike, OpenCodeSSEEvent } from '../OpenCodeSDKProtocol';
import { EventEmitter } from 'events';
import type { ChatAttachment } from '../../types';

// Mock child_process.spawn to avoid actually launching opencode
vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const proc = new EventEmitter() as any;
    proc.kill = vi.fn();
    proc.stdin = null;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.pid = 12345;
    return proc;
  }),
}));

// Mock net.createServer for port finding
vi.mock('net', () => ({
  createServer: vi.fn(() => {
    const server = new EventEmitter() as any;
    server.listen = vi.fn((_port: number, _host: string, cb: () => void) => {
      server.address = () => ({ port: 19999 });
      cb();
    });
    server.close = vi.fn((cb: () => void) => cb());
    return server;
  }),
}));

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

function createMockSdkModule(sseEvents: OpenCodeSSEEvent[]) {
  const promptFn = vi.fn(async () => ({}));
  const createFn = vi.fn(async () => ({ data: { id: 'oc-session-1' } }));
  const listFn = vi.fn(async () => ({ data: [] }));
  const abortFn = vi.fn(async () => ({}));
  const postPermissionFn = vi.fn(async () => ({}));
  const subscribeFn = vi.fn(async () => ({
    stream: createAsyncEventStream(sseEvents),
  }));

  const mcpAddFn = vi.fn(async () => ({}));

  const mockClient: OpenCodeClientLike = {
    postSessionIdPermissionsPermissionId: postPermissionFn,
    session: {
      create: createFn,
      list: listFn,
      prompt: promptFn,
      abort: abortFn,
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

  return { loadSdkModule, mockClient, promptFn, createFn, subscribeFn, postPermissionFn };
}

describe('OpenCodeSDKProtocol', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true });
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

  it('parses versioned OpenCode SSE event names', async () => {
    const sseEvents: OpenCodeSSEEvent[] = [
      {
        type: 'message.updated.1',
        properties: {
          sessionID: 'oc-session-1',
          info: { id: 'm1', sessionID: 'oc-session-1', role: 'assistant' },
        },
      },
      {
        type: 'message.part.updated.1',
        properties: {
          sessionID: 'oc-session-1',
          part: {
            type: 'tool',
            id: 'p-tool',
            sessionID: 'oc-session-1',
            messageID: 'm1',
            callID: 'call-1',
            tool: 'grep',
            state: { status: 'running', input: { pattern: 'fugu', path: '/tmp' } },
          },
        },
      },
      {
        type: 'message.part.delta.1',
        properties: {
          sessionID: 'oc-session-1',
          messageID: 'm1',
          partID: 'p-text',
          field: 'text',
          delta: 'visible response',
        },
      },
      { type: 'session.idle.1', properties: { sessionID: 'oc-session-1' } },
    ];

    const { loadSdkModule } = createMockSdkModule(sseEvents);
    const protocol = new OpenCodeSDKProtocol(loadSdkModule);
    const session = await protocol.createSession({ workspacePath: '/tmp/test' });
    const emitted: any[] = [];

    for await (const event of protocol.sendMessage(session, { content: 'test' })) {
      emitted.push(event);
    }

    const toolCall = emitted.find((e) => e.type === 'tool_call' && e.toolCall?.id === 'call-1');
    expect(toolCall?.toolCall?.arguments).toEqual({ pattern: 'fugu', path: '/tmp' });
    expect(emitted.some((e) => e.type === 'text' && e.content === 'visible response')).toBe(true);
    expect(emitted.some((e) => e.type === 'complete')).toBe(true);
  });

  it('does not emit user prompt snapshots as assistant text', async () => {
    const sseEvents: OpenCodeSSEEvent[] = [
      { type: 'message.updated', properties: { info: { id: 'm-user', role: 'user', sessionID: 'oc-session-1' } } },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'text',
            text: 'this is the user prompt',
            sessionID: 'oc-session-1',
            messageID: 'm-user',
            id: 'p-user',
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

    expect(emitted.filter((e) => e.type === 'text')).toHaveLength(0);
  });

  it('does not re-emit a final full-text snapshot after deltas', async () => {
    const sseEvents: OpenCodeSSEEvent[] = [
      { type: 'message.updated', properties: { info: { id: 'm-assistant', role: 'assistant', sessionID: 'oc-session-1' } } },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'text',
            text: '',
            sessionID: 'oc-session-1',
            messageID: 'm-assistant',
            id: 'p-text',
          },
        },
      },
      {
        type: 'message.part.delta',
        properties: {
          sessionID: 'oc-session-1',
          messageID: 'm-assistant',
          partID: 'p-text',
          field: 'text',
          delta: 'O',
        },
      },
      {
        type: 'message.part.delta',
        properties: {
          sessionID: 'oc-session-1',
          messageID: 'm-assistant',
          partID: 'p-text',
          field: 'text',
          delta: 'K',
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'text',
            text: 'OK',
            sessionID: 'oc-session-1',
            messageID: 'm-assistant',
            id: 'p-text',
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

    expect(emitted.filter((e) => e.type === 'text').map((e) => e.content)).toEqual(['O', 'K']);
  });

  it('turns assistant full-text snapshots into append-only chunks', async () => {
    const sseEvents: OpenCodeSSEEvent[] = [
      { type: 'message.updated', properties: { info: { id: 'm-assistant', role: 'assistant', sessionID: 'oc-session-1' } } },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'text',
            text: 'Hello',
            sessionID: 'oc-session-1',
            messageID: 'm-assistant',
            id: 'p-text',
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'text',
            text: 'Hello world',
            sessionID: 'oc-session-1',
            messageID: 'm-assistant',
            id: 'p-text',
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'text',
            text: 'Hello world',
            sessionID: 'oc-session-1',
            messageID: 'm-assistant',
            id: 'p-text',
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

    expect(emitted.filter((e) => e.type === 'text').map((e) => e.content)).toEqual(['Hello', ' world']);
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

  it('parses OpenCode permission requests as ToolPermission calls', async () => {
    const sseEvents: OpenCodeSSEEvent[] = [
      {
        type: 'permission.updated',
        properties: {
          sessionID: 'oc-session-1',
          id: 'perm-1',
          type: 'external_directory',
          title: 'Access external directory',
          pattern: ['/tmp/*'],
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

    const permissionCall = emitted.find((e) => e.type === 'tool_call' && e.toolCall?.name === 'ToolPermission');
    expect(permissionCall).toBeDefined();
    expect(permissionCall.toolCall.id).toBe('perm-1');
    expect(permissionCall.toolCall.arguments.requestId).toBe('perm-1');
    expect(permissionCall.toolCall.arguments.openCodePermissionType).toBe('external_directory');
    expect(permissionCall.toolCall.arguments.openCodePermissionPattern).toEqual(['/tmp/*']);
    expect(permissionCall.metadata).toMatchObject({
      openCodePermissionRequest: true,
      permissionId: 'perm-1',
    });
  });

  it('parses OpenCode v2 permission.asked requests as ToolPermission calls', async () => {
    const sseEvents: OpenCodeSSEEvent[] = [
      {
        type: 'permission.asked',
        properties: {
          sessionID: 'oc-session-1',
          id: 'perm-v2',
          permission: 'external_directory',
          patterns: ['/mnt/traderbot-nvme/*', '/home/reyn/trader_local_archive/*'],
          metadata: {},
          always: [],
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

    const permissionCall = emitted.find((e) => e.type === 'tool_call' && e.toolCall?.name === 'ToolPermission');
    expect(permissionCall).toBeDefined();
    expect(permissionCall.toolCall.id).toBe('perm-v2');
    expect(permissionCall.toolCall.arguments.requestId).toBe('perm-v2');
    expect(permissionCall.toolCall.arguments.openCodePermissionType).toBe('external_directory');
    expect(permissionCall.toolCall.arguments.openCodePermissionPattern).toEqual([
      '/mnt/traderbot-nvme/*',
      '/home/reyn/trader_local_archive/*',
    ]);
  });

  it('parses OpenCode permission replies as ToolPermission results', async () => {
    const sseEvents: OpenCodeSSEEvent[] = [
      {
        type: 'permission.replied',
        properties: {
          sessionID: 'oc-session-1',
          permissionID: 'perm-1',
          response: 'always',
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

    const permissionResult = emitted.find((e) => e.type === 'tool_result' && e.toolResult?.name === 'ToolPermission');
    expect(permissionResult).toBeDefined();
    expect(permissionResult.toolResult.id).toBe('perm-1');
    expect(permissionResult.toolResult.result.success).toBe(true);
    expect(JSON.parse(permissionResult.toolResult.result.result)).toEqual({
      decision: 'allow',
      scope: 'always',
    });
  });

  it('parses OpenCode v2 permission replies as ToolPermission results', async () => {
    const sseEvents: OpenCodeSSEEvent[] = [
      {
        type: 'permission.replied',
        properties: {
          sessionID: 'oc-session-1',
          requestID: 'perm-v2',
          reply: 'once',
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

    const permissionResult = emitted.find((e) => e.type === 'tool_result' && e.toolResult?.name === 'ToolPermission');
    expect(permissionResult).toBeDefined();
    expect(permissionResult.toolResult.id).toBe('perm-v2');
    expect(permissionResult.toolResult.result.success).toBe(true);
    expect(JSON.parse(permissionResult.toolResult.result.result)).toEqual({
      decision: 'allow',
      scope: 'once',
    });
  });

  it('responds to OpenCode permission requests via the SDK endpoint', async () => {
    const { loadSdkModule, postPermissionFn } = createMockSdkModule([]);
    const protocol = new OpenCodeSDKProtocol(loadSdkModule);
    const session = await protocol.createSession({ workspacePath: '/tmp/test' });

    await protocol.respondToPermission(session, 'perm-1', 'once');

    expect(postPermissionFn).toHaveBeenCalledWith({
      path: { id: 'oc-session-1', permissionID: 'perm-1' },
      query: { directory: '/tmp/test' },
      body: { response: 'once' },
    });
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

  it('attaches usage from message.updated info to the idle completion event', async () => {
    const sseEvents: OpenCodeSSEEvent[] = [
      {
        type: 'message.updated',
        properties: {
          sessionID: 'oc-session-1',
          info: {
            id: 'm-assistant',
            role: 'assistant',
            sessionID: 'oc-session-1',
            usage: {
              input_tokens: 120,
              output_tokens: 80,
              total_tokens: 200,
            },
            model_context_window: 1_000_000,
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

    const completeEvent = emitted.find((e) => e.type === 'complete');
    expect(completeEvent?.usage).toEqual({
      input_tokens: 120,
      output_tokens: 80,
      total_tokens: 200,
    });
    expect(completeEvent?.contextFillTokens).toBe(200);
    expect(completeEvent?.contextWindow).toBe(1_000_000);
  });

  it('attaches usage from message.part.updated to the idle completion event', async () => {
    const sseEvents: OpenCodeSSEEvent[] = [
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'text',
            text: 'done',
            sessionID: 'oc-session-1',
            messageID: 'm1',
            id: 'p1',
            usage: {
              prompt_tokens: 12,
              completion_tokens: 5,
              total_tokens: 17,
            },
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

    const completeEvent = emitted.find((e) => e.type === 'complete');
    expect(completeEvent?.usage).toEqual({
      input_tokens: 12,
      output_tokens: 5,
      total_tokens: 17,
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
