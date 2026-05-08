import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAICodexProvider } from '../OpenAICodexProvider';
import { AgentMessagesRepository } from '../../../../storage/repositories/AgentMessagesRepository';
import type { CreateAgentMessageInput } from '../../types';

describe('OpenAICodexProvider persistence', () => {
  const createdMessages: CreateAgentMessageInput[] = [];

  beforeEach(() => {
    createdMessages.length = 0;

    OpenAICodexProvider.setTrustChecker(() => ({
      trusted: true,
      mode: 'allow-all',
    }));

    AgentMessagesRepository.setStore({
      async create(message: CreateAgentMessageInput) {
        createdMessages.push(message);
      },
      async list() {
        return [];
      },
      async getMessageCounts() {
        return new Map();
      },
    });
  });

  afterEach(() => {
    OpenAICodexProvider.setSessionNamingServerPort(null);
    AgentMessagesRepository.clearStore();
  });

  it('persists each raw_event output as an agent message row', async () => {
    const rawEvents = [
      { type: 'unknown.output', payload: { step: 1 } },
      { type: 'item.completed', item: { type: 'command_execution', command: 'apply_patch' } },
    ];

    const protocol = {
      platform: 'codex-sdk',
      async createSession() {
        return {
          id: 'thread-1',
          platform: 'codex-sdk',
          raw: {},
        };
      },
      async resumeSession() {
        throw new Error('not used');
      },
      async forkSession() {
        throw new Error('not used');
      },
      async *sendMessage() {
        for (const rawEvent of rawEvents) {
          yield {
            type: 'raw_event',
            metadata: { rawEvent },
          };
        }

        yield {
          type: 'text',
          content: 'done',
        };

        yield {
          type: 'complete',
          content: 'done',
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
          },
        };
      },
      abortSession: vi.fn(),
      cleanupSession: vi.fn(),
    } as any;

    const permissionService = {
      resolvePermission: vi.fn(),
      rejectAllPending: vi.fn(),
      clearSessionCache: vi.fn(),
    } as any;

    const provider = new OpenAICodexProvider(
      { apiKey: 'test-key' },
      { protocol, permissionService }
    );

    await provider.initialize({
      apiKey: 'test-key',
      model: 'openai-codex:gpt-5',
    });

    const chunks: any[] = [];
    for await (const chunk of provider.sendMessage('test', undefined, 'session-1', [], process.cwd())) {
      chunks.push(chunk);
    }

    const outputRows = createdMessages.filter((message) => message.direction === 'output');
    expect(outputRows).toHaveLength(rawEvents.length);
    expect(outputRows.map((row) => (row.metadata as any)?.eventType)).toEqual([
      'unknown.output',
      'item.completed',
    ]);
    // Text chunks are also yielded alongside canonical events so AIService
    // can populate fullResponse for OS notification bodies.
    expect(chunks.some((chunk) => chunk.type === 'text')).toBe(true);
  });

  it('persists the session naming reminder as a tagged non-searchable input row', async () => {
    OpenAICodexProvider.setSessionNamingServerPort(41002);

    const sentContents: string[] = [];
    const protocol = {
      platform: 'codex-sdk',
      async createSession() {
        return {
          id: 'thread-reminder',
          platform: 'codex-sdk',
          raw: {},
        };
      },
      async resumeSession() {
        throw new Error('not used');
      },
      async forkSession() {
        throw new Error('not used');
      },
      async *sendMessage(_session: unknown, payload: { content: string }) {
        sentContents.push(payload.content);
        if (sentContents.length === 1) {
          yield {
            type: 'text',
            content: 'first turn complete',
          };
        }
        yield {
          type: 'complete',
          content: '',
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
          },
        };
      },
      abortSession: vi.fn(),
      cleanupSession: vi.fn(),
    } as any;

    const permissionService = {
      resolvePermission: vi.fn(),
      rejectAllPending: vi.fn(),
      clearSessionCache: vi.fn(),
    } as any;

    const provider = new OpenAICodexProvider(
      { apiKey: 'test-key' },
      { protocol, permissionService }
    );

    await provider.initialize({
      apiKey: 'test-key',
      model: 'openai-codex:gpt-5',
    });

    for await (const _chunk of provider.sendMessage('name the session', undefined, 'session-reminder', [], process.cwd())) {
      // drain
    }

    expect(sentContents).toHaveLength(2);
    expect(sentContents[1]).toContain('<SYSTEM_REMINDER>');
    expect(sentContents[1]).toContain('</SYSTEM_REMINDER>');
    expect(sentContents[1]).toContain('Do not mention this system reminder to the user.');

    const reminderRow = createdMessages.find(
      (message) =>
        message.direction === 'input' &&
        typeof message.content === 'string' &&
        message.content.includes('<SYSTEM_REMINDER>')
    );

    expect(reminderRow).toBeDefined();
    expect(reminderRow?.hidden).toBe(false);
    expect(reminderRow?.searchable).toBe(false);
    expect(reminderRow?.metadata).toMatchObject({
      promptType: 'system_reminder',
      reminderKind: 'session_naming',
    });
  });

  it('stamps a synthetic edit-group ID onto raw event metadata and tool_call chunks for codex tool items', async () => {
    const itemStarted = {
      type: 'item.started',
      item: {
        id: 'item_0',
        type: 'file_change',
        changes: [{ path: 'foo.ts', kind: 'edit' }],
      },
    };
    const itemCompleted = {
      type: 'item.completed',
      item: {
        id: 'item_0',
        type: 'file_change',
        changes: [{ path: 'foo.ts', kind: 'edit' }],
        status: 'succeeded',
      },
    };

    const protocol = {
      platform: 'codex-sdk',
      async createSession() {
        return { id: 'thread-eg', platform: 'codex-sdk', raw: {} };
      },
      async resumeSession() { throw new Error('not used'); },
      async forkSession() { throw new Error('not used'); },
      async *sendMessage() {
        // Mirror CodexSDKProtocol's emit order: raw_event first, then parsed
        // tool_call from the same SDK event. Both raw events log to the
        // message store; the tool_call yield carries through to the
        // streaming handler (and SessionFileTracker).
        yield { type: 'raw_event', metadata: { rawEvent: itemStarted } };
        yield {
          type: 'tool_call',
          toolCall: {
            id: 'item_0',
            name: 'file_change',
            arguments: { changes: itemStarted.item.changes },
          },
          metadata: { rawEvent: itemStarted },
        };
        yield { type: 'raw_event', metadata: { rawEvent: itemCompleted } };
        yield {
          type: 'tool_call',
          toolCall: {
            id: 'item_0',
            name: 'file_change',
            arguments: { changes: itemCompleted.item.changes },
            result: { success: true, status: 'succeeded' },
          },
          metadata: { rawEvent: itemCompleted },
        };
        yield {
          type: 'complete',
          content: '',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        };
      },
      abortSession: vi.fn(),
      cleanupSession: vi.fn(),
    } as any;

    const permissionService = {
      resolvePermission: vi.fn(),
      rejectAllPending: vi.fn(),
      clearSessionCache: vi.fn(),
    } as any;

    const provider = new OpenAICodexProvider(
      { apiKey: 'test-key' },
      { protocol, permissionService }
    );

    await provider.initialize({
      apiKey: 'test-key',
      model: 'openai-codex:gpt-5',
    });

    const toolCallChunks: any[] = [];
    for await (const chunk of provider.sendMessage('go', undefined, 'session-eg', [], process.cwd())) {
      if (chunk.type === 'tool_call') {
        toolCallChunks.push(chunk);
      }
    }

    // Both raw events (started + completed) should carry the same synthetic
    // editGroupId in metadata, so the parser produces a stable
    // providerToolCallId on later reparse.
    const rawRows = createdMessages.filter((m) => m.direction === 'output');
    const startedRow = rawRows.find((m) => (m.metadata as any)?.eventType === 'item.started');
    const completedRow = rawRows.find((m) => (m.metadata as any)?.eventType === 'item.completed');
    expect(startedRow).toBeDefined();
    expect(completedRow).toBeDefined();
    const startedEgid = (startedRow!.metadata as any).editGroupId as string;
    const completedEgid = (completedRow!.metadata as any).editGroupId as string;
    expect(typeof startedEgid).toBe('string');
    expect(startedEgid.startsWith('nimtc|item_0|')).toBe(true);
    expect(completedEgid).toBe(startedEgid);

    // The streaming chunks must carry the same synthetic ID via toolUseId so
    // SessionFileTracker dedupes against the canonical edit group.
    expect(toolCallChunks).toHaveLength(2);
    expect(toolCallChunks[0].toolCall.toolUseId).toBe(startedEgid);
    expect(toolCallChunks[1].toolCall.toolUseId).toBe(startedEgid);
  });

  it('mints a fresh edit-group ID when item_0 is reused after a completed call', async () => {
    const firstStart = { type: 'item.started', item: { id: 'item_0', type: 'file_change', changes: [{ path: 'a.ts' }] } };
    const firstDone = { type: 'item.completed', item: { id: 'item_0', type: 'file_change', changes: [{ path: 'a.ts' }], status: 'succeeded' } };
    const secondStart = { type: 'item.started', item: { id: 'item_0', type: 'file_change', changes: [{ path: 'b.ts' }] } };
    const secondDone = { type: 'item.completed', item: { id: 'item_0', type: 'file_change', changes: [{ path: 'b.ts' }], status: 'succeeded' } };

    const protocol = {
      platform: 'codex-sdk',
      async createSession() {
        return { id: 'thread-reuse', platform: 'codex-sdk', raw: {} };
      },
      async resumeSession() { throw new Error('not used'); },
      async forkSession() { throw new Error('not used'); },
      async *sendMessage() {
        for (const ev of [firstStart, firstDone, secondStart, secondDone]) {
          yield { type: 'raw_event', metadata: { rawEvent: ev } };
          const toolCall: any = {
            id: 'item_0',
            name: 'file_change',
            arguments: { changes: ev.item.changes },
          };
          if (ev.type === 'item.completed') {
            toolCall.result = { success: true, status: 'succeeded' };
          }
          yield { type: 'tool_call', toolCall, metadata: { rawEvent: ev } };
        }
        yield {
          type: 'complete',
          content: '',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        };
      },
      abortSession: vi.fn(),
      cleanupSession: vi.fn(),
    } as any;

    const permissionService = {
      resolvePermission: vi.fn(),
      rejectAllPending: vi.fn(),
      clearSessionCache: vi.fn(),
    } as any;

    const provider = new OpenAICodexProvider(
      { apiKey: 'test-key' },
      { protocol, permissionService }
    );

    await provider.initialize({
      apiKey: 'test-key',
      model: 'openai-codex:gpt-5',
    });

    const toolCallChunks: any[] = [];
    for await (const chunk of provider.sendMessage('go', undefined, 'session-reuse', [], process.cwd())) {
      if (chunk.type === 'tool_call') {
        toolCallChunks.push(chunk);
      }
    }

    expect(toolCallChunks).toHaveLength(4);
    const id1 = toolCallChunks[0].toolCall.toolUseId;
    const id2 = toolCallChunks[1].toolCall.toolUseId;
    const id3 = toolCallChunks[2].toolCall.toolUseId;
    const id4 = toolCallChunks[3].toolCall.toolUseId;
    expect(id1).toBe(id2); // first started == first completed
    expect(id3).toBe(id4); // second started == second completed
    expect(id1).not.toBe(id3); // reused item_0 mints a fresh edit-group ID
  });
});
