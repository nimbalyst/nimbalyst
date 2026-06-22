import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { OpenCodeSDKProtocol, OpenCodeClientLike, OpenCodeSSEEvent } from '../OpenCodeSDKProtocol';
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

function createMockSdkModule(sseEvents: OpenCodeSSEEvent[]) {
  const promptFn = vi.fn(async () => ({}));
  const createFn = vi.fn(async () => ({ data: { id: 'oc-session-1' } }));
  const listFn = vi.fn(async () => ({ data: [] }));
  const abortFn = vi.fn(async () => ({}));
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

  return { loadSdkModule, mockClient, promptFn, createFn, subscribeFn };
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
