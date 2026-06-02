/**
 * Reproduction harness for the "all tool_calls stuck at status=running" bug
 * observed against session 42c15b76 in the live dev build.
 *
 * Two layers of testing here:
 *
 *  1. Parser-only: does ClaudeCodeRawParser produce tool_call_completed
 *     descriptors for direction='output' tool_result messages? (PASSES,
 *     verified by the first test below — so parser is not the bug.)
 *
 *  2. Full transformer/store/processDescriptor flow: feed the same
 *     direction='output' rows into TranscriptTransformer.processNewMessages
 *     and check that the canonical tool_call event status ends as
 *     'completed'. This is what the live `aiLoadSession` consumes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ClaudeCodeRawParser } from '../parsers/ClaudeCodeRawParser';
import type {
  CanonicalEventDescriptor,
  ParseContext,
} from '../parsers/IRawMessageParser';
import {
  TranscriptTransformer,
  type IRawMessageStore,
  type ISessionMetadataStore,
  type RawMessage,
} from '../TranscriptTransformer';
import { TranscriptRuntime } from '../TranscriptRuntime';
import { TranscriptProjector } from '../TranscriptProjector';
import type { ITranscriptEventStore, TranscriptEvent } from '../types';

const SESSION_ID = '42c15b76-0ff1-4bb1-845c-95a376c476ce';

// -- Mock stores (lifted from TranscriptTransformer.test.ts) -----------------

function createMockTranscriptStore(): ITranscriptEventStore & { getAll(): TranscriptEvent[] } {
  const events: TranscriptEvent[] = [];
  let nextId = 1;
  const sequenceCounters = new Map<string, number>();

  return {
    getAll: () => [...events],
    async insertEvent(event) {
      const id = nextId++;
      const full: TranscriptEvent = { ...event, id };
      events.push(full);
      const seq = sequenceCounters.get(event.sessionId) ?? 0;
      sequenceCounters.set(event.sessionId, Math.max(seq, event.sequence + 1));
      return full;
    },
    async updateEventPayload(id, payload) {
      const event = events.find((e) => e.id === id);
      if (event) event.payload = payload;
    },
    async mergeEventPayload(id, partialPayload) {
      const event = events.find((e) => e.id === id);
      if (event) event.payload = { ...event.payload, ...partialPayload };
    },
    async updateEventText(id, searchableText) {
      const event = events.find((e) => e.id === id);
      if (event) event.searchableText = searchableText;
    },
    async getSessionEvents(sessionId, options) {
      let result = events
        .filter((e) => e.sessionId === sessionId)
        .sort((a, b) => a.sequence - b.sequence);
      if (options?.eventTypes) {
        result = result.filter((e) => options.eventTypes!.includes(e.eventType));
      }
      return result;
    },
    async getNextSequence(sessionId) {
      return sequenceCounters.get(sessionId) ?? 0;
    },
    async findByProviderToolCallId(providerToolCallId, sessionId) {
      return (
        events.find(
          (e) => e.providerToolCallId === providerToolCallId && e.sessionId === sessionId,
        ) ?? null
      );
    },
    async findActiveToolCallByRawProviderId() { return null; },
    async getEventById(id) {
      return events.find((e) => e.id === id) ?? null;
    },
    async getChildEvents() { return []; },
    async getSubagentEvents() { return []; },
    async getMultiSessionEvents() { return []; },
    async searchSessions() { return []; },
    async getTailEvents() { return []; },
    async deleteSessionEvents(sessionId) {
      const toRemove = events.filter((e) => e.sessionId === sessionId);
      for (const e of toRemove) events.splice(events.indexOf(e), 1);
      sequenceCounters.delete(sessionId);
    },
  };
}

function createMockRawStore(messages: RawMessage[]): IRawMessageStore {
  return {
    async getMessages(sessionId, afterId) {
      return messages
        .filter((m) => m.sessionId === sessionId && (afterId == null || m.id > afterId))
        .sort((a, b) => a.id - b.id);
    },
  };
}

function createMockMetadataStore(): ISessionMetadataStore {
  const statuses = new Map<string, any>();
  return {
    async getTransformStatus(sessionId) {
      return statuses.get(sessionId) ?? {
        transformVersion: null,
        lastRawMessageId: null,
        lastTransformedAt: null,
        transformStatus: null,
      };
    },
    async updateTransformStatus(sessionId, update) {
      statuses.set(sessionId, update);
    },
  };
}

// -- Real raw rows pulled from session 42c15b76 ai_agent_messages -----------

// id=1564618 (claude-code, direction='output') - SDK assistant chunk
// announcing a Read tool_use.
const TOOL_USE_ROW: RawMessage = {
  id: 1564618,
  sessionId: SESSION_ID,
  source: 'claude-code',
  direction: 'output',
  content: JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-opus-4-7',
      id: 'msg_015UrMwAbcjE5gyDzRFJDYic',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_01TSSfPWV8uqRjFyKXK6Mknj',
          name: 'Read',
          input: { file_path: '/tmp/some.log' },
        },
      ],
    },
    parent_tool_use_id: null,
  }),
  createdAt: new Date('2026-06-02T00:57:35Z'),
};

// id=1564619 (claude-code, direction='output') - SDK user-typed envelope
// carrying the matching tool_result.
const TOOL_RESULT_ROW: RawMessage = {
  id: 1564619,
  sessionId: SESSION_ID,
  source: 'claude-code',
  direction: 'output',
  content: JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          content: 'File content exceeds maximum allowed tokens.',
          is_error: true,
          tool_use_id: 'toolu_01TSSfPWV8uqRjFyKXK6Mknj',
        },
      ],
    },
    parent_tool_use_id: null,
  }),
  createdAt: new Date('2026-06-02T00:57:37Z'),
};

// -- Tests ------------------------------------------------------------------

describe('repro: live bug -- canonical tool_call stuck at running', () => {
  describe('layer 1: parser in isolation', () => {
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

    it('produces tool_call_completed for the SDK tool_result row (direction=output)', async () => {
      const parser = new ClaudeCodeRawParser();
      const useDescriptors = await parser.parseMessage(TOOL_USE_ROW, makeContext());
      expect(useDescriptors).toHaveLength(1);
      expect(useDescriptors[0]).toMatchObject({
        type: 'tool_call_started',
        providerToolCallId: 'toolu_01TSSfPWV8uqRjFyKXK6Mknj',
      });

      const resultDescriptors = await parser.parseMessage(
        TOOL_RESULT_ROW,
        makeContext({ hasToolCall: (id) => id === 'toolu_01TSSfPWV8uqRjFyKXK6Mknj' }),
      );
      expect(
        resultDescriptors,
        'parser must emit tool_call_completed when fed direction=output tool_result',
      ).toHaveLength(1);
      expect(resultDescriptors[0]).toMatchObject<Partial<CanonicalEventDescriptor>>({
        type: 'tool_call_completed',
        providerToolCallId: 'toolu_01TSSfPWV8uqRjFyKXK6Mknj',
        status: 'error',
        isError: true,
      });
    });
  });

  describe('layer 2: full transformer / processDescriptor / store', () => {
    let transcriptStore: ReturnType<typeof createMockTranscriptStore>;
    let metadataStore: ISessionMetadataStore;

    beforeEach(() => {
      transcriptStore = createMockTranscriptStore();
      metadataStore = createMockMetadataStore();
    });

    it('processNewMessages in ONE batch ends tool_call at status=completed/error', async () => {
      const rawStore = createMockRawStore([TOOL_USE_ROW, TOOL_RESULT_ROW]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      const written = await transformer.processNewMessages(SESSION_ID, 'claude-code');
      expect(written.length, 'transformer wrote at least one canonical event').toBeGreaterThan(0);

      const toolCalls = transcriptStore.getAll().filter((e) => e.eventType === 'tool_call');
      expect(toolCalls).toHaveLength(1);
      const status = (toolCalls[0].payload as Record<string, unknown>).status;
      expect(
        status,
        'live bug: canonical tool_call stuck at "running" after tool_result was parsed',
      ).toBe('error');
    });

    it('TranscriptRuntime.getViewMessages returns status=error for the projected tool_call', async () => {
      const rawStore = createMockRawStore([TOOL_USE_ROW, TOOL_RESULT_ROW]);
      const runtime = new TranscriptRuntime(rawStore);

      const messages = await runtime.getViewMessages(SESSION_ID, 'claude-code');
      const tc = messages.find((m) => m.type === 'tool_call' && m.toolCall?.providerToolCallId === 'toolu_01TSSfPWV8uqRjFyKXK6Mknj');
      expect(tc, 'projected view should include the tool_call').toBeDefined();
      expect(
        tc!.toolCall!.status,
        'live bug surface: getViewMessages must not return status=running once the tool_result row exists',
      ).toBe('error');
    });

    it('TranscriptRuntime simulating live streaming: tool_use, processNewMessages, tool_result, processNewMessages', async () => {
      // Live streaming simulation. Each call to processNewMessages mimics the
      // ClaudeCodeProvider.scheduleTranscriptProcessing flush. The watermark
      // advances between calls; the second call only sees TOOL_RESULT_ROW.
      const rawMessages: RawMessage[] = [];
      const rawStore: IRawMessageStore = {
        async getMessages(sessionId, afterId) {
          return rawMessages
            .filter((m) => m.sessionId === sessionId && (afterId == null || m.id > afterId))
            .sort((a, b) => a.id - b.id);
        },
      };
      const runtime = new TranscriptRuntime(rawStore);

      // SDK emits the tool_use chunk
      rawMessages.push(TOOL_USE_ROW);
      await runtime.processNewMessages(SESSION_ID, 'claude-code');

      // ... time passes, SDK then emits the tool_result chunk
      rawMessages.push(TOOL_RESULT_ROW);
      await runtime.processNewMessages(SESSION_ID, 'claude-code');

      const messages = await runtime.getViewMessages(SESSION_ID, 'claude-code');
      const tc = messages.find((m) => m.type === 'tool_call' && m.toolCall?.providerToolCallId === 'toolu_01TSSfPWV8uqRjFyKXK6Mknj');
      expect(tc, 'projected view should include the tool_call').toBeDefined();
      expect(
        tc!.toolCall!.status,
        'streaming simulation: cross-batch tool_result must update status off "running"',
      ).toBe('error');
    });

    it('TranscriptRuntime: tool_call completion routes to the correct session when multiple sessions are cached', async () => {
      // ROOT-CAUSE REPRO for the "tool_calls stuck at running" bug.
      //
      // TranscriptRuntime keeps a per-session InMemoryTranscriptEventStore in a
      // RoutingStore-fronted cache. Each per-session store mints its own
      // event ids starting at 1, so two cached sessions hold overlapping
      // numerical ids (session A.event id=1, session B.event id=1, etc.).
      //
      // RoutingStore.getEventById / mergeEventPayload / updateEventPayload all
      // walk `this.cache.values()` (insertion order) and return the FIRST
      // store that contains the id. That means tool_call completion writes
      // for session B silently land on session A's event id=1, leaving
      // session B's event stuck at status='running'.
      //
      // This test simulates session A being opened first (and thus cached
      // first), then session B opening and getting a tool_use + tool_result.
      // The expectation is that session B's tool_call ends at 'error' and
      // session A's tool_call is untouched.
      const SESSION_A = 'session-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const SESSION_B = 'session-bbbbbbbbbbbbbbbbbbbbbbbbbbbb';

      const rawMessages: RawMessage[] = [];
      const rawStore: IRawMessageStore = {
        async getMessages(sessionId, afterId) {
          return rawMessages
            .filter((m) => m.sessionId === sessionId && (afterId == null || m.id > afterId))
            .sort((a, b) => a.id - b.id);
        },
      };
      const runtime = new TranscriptRuntime(rawStore);

      const makeToolUseRow = (
        rowId: number,
        sessionId: string,
        toolUseId: string,
      ): RawMessage => ({
        id: rowId,
        sessionId,
        source: 'claude-code',
        direction: 'output',
        content: JSON.stringify({
          type: 'assistant',
          message: {
            model: 'claude-opus-4-7',
            id: `msg_${toolUseId}`,
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: '/x' } },
            ],
          },
          parent_tool_use_id: null,
        }),
        createdAt: new Date('2026-06-02T00:00:00Z'),
      });

      const makeToolResultRow = (
        rowId: number,
        sessionId: string,
        toolUseId: string,
      ): RawMessage => ({
        id: rowId,
        sessionId,
        source: 'claude-code',
        direction: 'output',
        content: JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                content: 'done',
                is_error: true,
                tool_use_id: toolUseId,
              },
            ],
          },
          parent_tool_use_id: null,
        }),
        createdAt: new Date('2026-06-02T00:00:01Z'),
      });

      // Open session A first (so it gets inserted into the MRU cache first).
      rawMessages.push(makeToolUseRow(1, SESSION_A, 'toolu_aaa_use'));
      await runtime.processNewMessages(SESSION_A, 'claude-code');

      // Now session B opens for the first time and emits its own tool_use.
      // Each per-session InMemoryStore mints event ids starting at 1, so this
      // creates a collision: A.event(1) and B.event(1) both exist.
      rawMessages.push(makeToolUseRow(2, SESSION_B, 'toolu_bbb_use'));
      await runtime.processNewMessages(SESSION_B, 'claude-code');

      // Session B receives the tool_result. The lookup
      // (findByProviderToolCallId scoped to SESSION_B) finds B's event id=1
      // correctly, but writer.updateToolCall(1) bottoms out at
      // RoutingStore.getEventById(1) / mergeEventPayload(1), which scan all
      // stores in insertion order and return SESSION_A's event 1 first.
      rawMessages.push(makeToolResultRow(3, SESSION_B, 'toolu_bbb_use'));
      await runtime.processNewMessages(SESSION_B, 'claude-code');

      const aMessages = await runtime.getViewMessages(SESSION_A, 'claude-code');
      const bMessages = await runtime.getViewMessages(SESSION_B, 'claude-code');

      const aToolCall = aMessages.find(
        (m) => m.type === 'tool_call' && m.toolCall?.providerToolCallId === 'toolu_aaa_use',
      );
      const bToolCall = bMessages.find(
        (m) => m.type === 'tool_call' && m.toolCall?.providerToolCallId === 'toolu_bbb_use',
      );

      expect(aToolCall, 'session A tool_call should exist').toBeDefined();
      expect(bToolCall, 'session B tool_call should exist').toBeDefined();

      expect(
        aToolCall!.toolCall!.status,
        'session A had no tool_result; status must remain running',
      ).toBe('running');
      expect(
        bToolCall!.toolCall!.status,
        'session B tool_result must complete SESSION B event, not silently update session A',
      ).toBe('error');
    });

    it('processNewMessages across TWO batches (tool_use first, tool_result second) still completes', async () => {
      // First batch: only the tool_use exists. Watermark advances.
      const batch1Raw = createMockRawStore([TOOL_USE_ROW]);
      const t1 = new TranscriptTransformer(batch1Raw, transcriptStore, metadataStore);
      await t1.processNewMessages(SESSION_ID, 'claude-code');

      // Second batch: tool_result is now in the raw log.
      const batch2Raw = createMockRawStore([TOOL_USE_ROW, TOOL_RESULT_ROW]);
      const t2 = new TranscriptTransformer(batch2Raw, transcriptStore, metadataStore);
      await t2.processNewMessages(SESSION_ID, 'claude-code');

      const toolCalls = transcriptStore.getAll().filter((e) => e.eventType === 'tool_call');
      expect(toolCalls).toHaveLength(1);
      const status = (toolCalls[0].payload as Record<string, unknown>).status;
      expect(
        status,
        'cross-batch: tool_result in second batch must update the existing event',
      ).toBe('error');
    });
  });
});
