/**
 * Contract tests for CodexRawParser.
 *
 * Verifies that representative raw messages produce the expected
 * canonical event descriptors for Codex SDK format messages.
 */

import { describe, it, expect } from 'vitest';
import { CodexRawParser } from '../parsers/CodexRawParser';
import type { ParseContext } from '../parsers/IRawMessageParser';
import type { RawMessage } from '../TranscriptTransformer';

const SESSION_ID = 'test-session';

function makeRawMessage(overrides: Partial<RawMessage>): RawMessage {
  return {
    id: 1,
    sessionId: SESSION_ID,
    source: 'openai-codex',
    direction: 'output',
    content: '',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeContext(overrides?: Partial<ParseContext>): ParseContext {
  return {
    sessionId: SESSION_ID,
    hasToolCall: () => false,
    hasSubagent: () => false,
    findByProviderToolCallId: async () => null,
    findActiveToolCallByRawProviderId: async () => null,
    ...overrides,
  };
}

describe('CodexRawParser', () => {
  describe('input messages', () => {
    it('parses user prompt from { prompt: "..." } format', async () => {
      const parser = new CodexRawParser();
      const msg = makeRawMessage({
        direction: 'input',
        content: JSON.stringify({ prompt: 'Hello codex' }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'user_message',
        text: 'Hello codex',
      });
    });

    it('treats plain text input as user_message', async () => {
      const parser = new CodexRawParser();
      const msg = makeRawMessage({
        direction: 'input',
        content: 'Plain prompt',
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'user_message',
        text: 'Plain prompt',
      });
    });
  });

  describe('output messages', () => {
    it('parses todo_list items as markdown checklist', async () => {
      const parser = new CodexRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          item: {
            type: 'todo_list',
            items: [
              { text: 'First task', completed: false },
              { text: 'Second task', completed: true },
            ],
          },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'assistant_message',
        text: '- [ ] First task\n- [x] Second task',
      });
    });

    it('parses tool calls with results', async () => {
      const parser = new CodexRawParser();
      // Simulate a Codex event that parseCodexEvent would interpret as a tool call
      // The item.completed format with function_call
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'function_call',
            id: 'fc-1',
            name: 'Read',
            arguments: JSON.stringify({ file_path: '/test.ts' }),
            output: 'file contents here',
            status: 'completed',
          },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      // Should produce tool_call_started + tool_call_completed (result is inline)
      const started = descriptors.find(d => d.type === 'tool_call_started');
      expect(started).toBeDefined();
      expect(started).toMatchObject({
        toolName: 'Read',
      });
    });

    it('parses error events', async () => {
      const parser = new CodexRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'error',
          error: { message: 'Rate limited' },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      const errorDesc = descriptors.find(d => d.type === 'system_message');
      expect(errorDesc).toBeDefined();
      expect(errorDesc).toMatchObject({
        systemType: 'error',
      });
    });

    it('treats plain text output as assistant_message', async () => {
      const parser = new CodexRawParser();
      const msg = makeRawMessage({
        content: 'Plain text response',
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'assistant_message',
        text: 'Plain text response',
      });
    });

    it('skips hidden messages', async () => {
      const parser = new CodexRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({ type: 'text', text: 'Hidden' }),
        hidden: true,
      });

      const descriptors = await parser.parseMessage(msg, makeContext());
      expect(descriptors).toHaveLength(0);
    });
  });

  describe('synthetic edit-group IDs', () => {
    it('emits a nimtc|<encoded>|<ts>|<idx> providerToolCallId for tool calls', async () => {
      const parser = new CodexRawParser();
      const msg = makeRawMessage({
        id: 42,
        createdAt: new Date('2026-04-01T12:00:00Z'),
        content: JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'function_call',
            id: 'item_0',
            name: 'Read',
            arguments: JSON.stringify({ file_path: '/x.ts' }),
            output: 'ok',
            status: 'completed',
          },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());
      const started = descriptors.find(d => d.type === 'tool_call_started') as any;
      const completed = descriptors.find(d => d.type === 'tool_call_completed') as any;
      expect(started.providerToolCallId).toBe(`nimtc|item_0|${msg.createdAt.getTime()}|42`);
      expect(completed.providerToolCallId).toBe(started.providerToolCallId);
    });

    it('reuses the same edit-group ID for started+completed in one batch', async () => {
      const parser = new CodexRawParser();
      const startedMsg = makeRawMessage({
        id: 10,
        createdAt: new Date('2026-04-01T12:00:00Z'),
        content: JSON.stringify({
          type: 'item.started',
          item: {
            type: 'function_call',
            id: 'item_0',
            name: 'Read',
            arguments: JSON.stringify({ file_path: '/y.ts' }),
            status: 'in_progress',
          },
        }),
      });
      const completedMsg = makeRawMessage({
        id: 11,
        createdAt: new Date('2026-04-01T12:00:01Z'),
        content: JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'function_call',
            id: 'item_0',
            name: 'Read',
            arguments: JSON.stringify({ file_path: '/y.ts' }),
            output: 'ok',
            status: 'completed',
          },
        }),
      });

      const ctx = makeContext();
      const startedDescriptors = await parser.parseMessage(startedMsg, ctx);
      const completedDescriptors = await parser.parseMessage(completedMsg, ctx);

      const started = startedDescriptors.find(d => d.type === 'tool_call_started') as any;
      const completed = completedDescriptors.find(d => d.type === 'tool_call_completed') as any;
      expect(started.providerToolCallId).toBe(`nimtc|item_0|${startedMsg.createdAt.getTime()}|10`);
      // Completed must reuse the started ID even though the completed message
      // has a later timestamp / different msg.id.
      expect(completed.providerToolCallId).toBe(started.providerToolCallId);
    });

    it('mints a fresh edit-group ID when a raw item id is reused after completion', async () => {
      const parser = new CodexRawParser();
      const firstMsg = makeRawMessage({
        id: 20,
        createdAt: new Date('2026-04-01T12:00:00Z'),
        content: JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'function_call',
            id: 'item_0',
            name: 'Read',
            arguments: JSON.stringify({ file_path: '/a.ts' }),
            output: 'ok',
            status: 'completed',
          },
        }),
      });
      const secondMsg = makeRawMessage({
        id: 21,
        createdAt: new Date('2026-04-01T12:01:00Z'),
        content: JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'function_call',
            id: 'item_0',
            name: 'Edit',
            arguments: JSON.stringify({ file_path: '/b.ts' }),
            output: 'ok',
            status: 'completed',
          },
        }),
      });

      const ctx = makeContext();
      const firstDescriptors = await parser.parseMessage(firstMsg, ctx);
      const secondDescriptors = await parser.parseMessage(secondMsg, ctx);

      const firstStarted = firstDescriptors.find(d => d.type === 'tool_call_started') as any;
      const secondStarted = secondDescriptors.find(d => d.type === 'tool_call_started') as any;
      expect(firstStarted.providerToolCallId).not.toEqual(secondStarted.providerToolCallId);
      expect(secondStarted.providerToolCallId).toBe(`nimtc|item_0|${secondMsg.createdAt.getTime()}|21`);
    });

    it('reads editGroupId from raw message metadata when present', async () => {
      const stampedSyntheticId = 'nimtc|item_0|1700000000000|42';
      const parser = new CodexRawParser();
      const startedMsg = makeRawMessage({
        id: 100,
        createdAt: new Date('2026-04-01T15:00:00Z'),
        metadata: { editGroupId: stampedSyntheticId },
        content: JSON.stringify({
          type: 'item.started',
          item: {
            type: 'function_call',
            id: 'item_0',
            name: 'Edit',
            arguments: JSON.stringify({ file_path: '/x.ts' }),
            status: 'in_progress',
          },
        }),
      });
      const completedMsg = makeRawMessage({
        id: 101,
        createdAt: new Date('2026-04-01T15:00:01Z'),
        metadata: { editGroupId: stampedSyntheticId },
        content: JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'function_call',
            id: 'item_0',
            name: 'Edit',
            arguments: JSON.stringify({ file_path: '/x.ts' }),
            output: 'ok',
            status: 'completed',
          },
        }),
      });

      const ctx = makeContext();
      const startedDescriptors = await parser.parseMessage(startedMsg, ctx);
      const completedDescriptors = await parser.parseMessage(completedMsg, ctx);

      const started = startedDescriptors.find(d => d.type === 'tool_call_started') as any;
      const completed = completedDescriptors.find(d => d.type === 'tool_call_completed') as any;
      // The metadata-stamped ID wins over freshly-minted IDs so the streaming
      // layer's SessionFileTracker writes match the parser's canonical events.
      expect(started.providerToolCallId).toBe(stampedSyntheticId);
      expect(completed.providerToolCallId).toBe(stampedSyntheticId);
    });

    it('ignores editGroupId metadata that is not a synthetic nimtc ID', async () => {
      const parser = new CodexRawParser();
      const msg = makeRawMessage({
        id: 200,
        createdAt: new Date('2026-04-01T16:00:00Z'),
        metadata: { editGroupId: 'item_0' }, // raw item id, not synthetic
        content: JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'function_call',
            id: 'item_0',
            name: 'Read',
            output: 'ok',
            status: 'completed',
          },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());
      const started = descriptors.find(d => d.type === 'tool_call_started') as any;
      // Falls through to minting since the metadata value is not a synthetic ID.
      expect(started.providerToolCallId).toBe(`nimtc|item_0|${msg.createdAt.getTime()}|200`);
    });

    it('reuses the synthetic ID from an active prior-batch event for cross-batch correlation', async () => {
      const priorSyntheticId = 'nimtc|item_0|1700000000000|7';
      const ctx = makeContext({
        findActiveToolCallByRawProviderId: async (rawId) => {
          if (rawId !== 'item_0') return null;
          return {
            id: 999,
            sessionId: SESSION_ID,
            sequence: 0,
            createdAt: new Date(),
            eventType: 'tool_call',
            searchableText: null,
            payload: { status: 'running', toolName: 'Read' },
            parentEventId: null,
            searchable: false,
            subagentId: null,
            provider: 'openai-codex',
            providerToolCallId: priorSyntheticId,
          } as any;
        },
      });

      const parser = new CodexRawParser();
      const msg = makeRawMessage({
        id: 50,
        createdAt: new Date('2026-04-01T13:00:00Z'),
        content: JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'function_call',
            id: 'item_0',
            name: 'Read',
            output: 'ok',
            status: 'completed',
          },
        }),
      });

      const descriptors = await parser.parseMessage(msg, ctx);
      const started = descriptors.find(d => d.type === 'tool_call_started') as any;
      const completed = descriptors.find(d => d.type === 'tool_call_completed') as any;
      expect(started.providerToolCallId).toBe(priorSyntheticId);
      expect(completed.providerToolCallId).toBe(priorSyntheticId);
    });
  });
});
