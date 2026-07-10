import { describe, it, expect, beforeEach } from 'vitest';
import { TranscriptTransformer } from '../TranscriptTransformer';
import type { IRawMessageStore, RawMessage, ISessionMetadataStore } from '../TranscriptTransformer';
import type { ITranscriptEventStore, TranscriptEvent } from '../types';

// ---------------------------------------------------------------------------
// Mock stores
// ---------------------------------------------------------------------------

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
      if (event) {
        event.payload = payload;
      }
    },

    async mergeEventPayload(id, partialPayload) {
      const event = events.find((e) => e.id === id);
      if (event) {
        event.payload = { ...event.payload, ...partialPayload };
      }
    },

    async updateEventText(id, searchableText) {
      const event = events.find((e) => e.id === id);
      if (event) {
        event.searchableText = searchableText;
      }
    },

    async getSessionEvents(sessionId, options) {
      let result = events
        .filter((e) => e.sessionId === sessionId)
        .sort((a, b) => a.sequence - b.sequence);
      if (options?.eventTypes) {
        result = result.filter((e) => options.eventTypes!.includes(e.eventType));
      }
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? result.length;
      return result.slice(offset, offset + limit);
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

    async findActiveToolCallByRawProviderId(rawProviderToolCallId, sessionId) {
      const synthPrefix = `nimtc|${encodeURIComponent(rawProviderToolCallId)}|`;
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event.sessionId !== sessionId) continue;
        if (event.eventType !== 'tool_call') continue;
        const ptcid = event.providerToolCallId ?? '';
        const matches = ptcid === rawProviderToolCallId || ptcid.startsWith(synthPrefix);
        if (!matches) continue;
        const status = (event.payload as Record<string, unknown> | undefined)?.status;
        if (status === 'running' || status === 'pending' || status == null) {
          return event;
        }
      }
      return null;
    },

    async getEventById(id) {
      return events.find((e) => e.id === id) ?? null;
    },

    async getChildEvents(parentEventId) {
      return events
        .filter((e) => e.parentEventId === parentEventId)
        .sort((a, b) => a.sequence - b.sequence);
    },

    async getSubagentEvents(subagentId, sessionId) {
      return events
        .filter((e) => e.subagentId === subagentId && e.sessionId === sessionId)
        .sort((a, b) => a.sequence - b.sequence);
    },

    async getMultiSessionEvents(sessionIds, options) {
      let result = events
        .filter((e) => sessionIds.includes(e.sessionId))
        .sort((a, b) => a.sequence - b.sequence);
      if (options?.eventTypes) {
        result = result.filter((e) => options.eventTypes!.includes(e.eventType));
      }
      return result;
    },

    async searchSessions(query, options) {
      let result = events.filter(
        (e) => e.searchable && e.searchableText?.toLowerCase().includes(query.toLowerCase()),
      );
      if (options?.sessionIds) {
        result = result.filter((e) => options.sessionIds!.includes(e.sessionId));
      }
      const limit = options?.limit ?? 100;
      return result.slice(0, limit).map((e) => ({ event: e, sessionId: e.sessionId }));
    },

    async getTailEvents(sessionId, count, options) {
      let result = events
        .filter((e) => e.sessionId === sessionId)
        .sort((a, b) => a.sequence - b.sequence);
      if (options?.excludeEventTypes) {
        result = result.filter((e) => !options.excludeEventTypes!.includes(e.eventType));
      }
      return result.slice(-count);
    },

    async deleteSessionEvents(sessionId) {
      const toRemove = events.filter((e) => e.sessionId === sessionId);
      for (const e of toRemove) {
        events.splice(events.indexOf(e), 1);
      }
      sequenceCounters.delete(sessionId);
    },
  };
}

function createMockRawStore(messages: RawMessage[] = []): IRawMessageStore {
  return {
    async getMessages(sessionId, afterId) {
      return messages
        .filter((m) => m.sessionId === sessionId && (afterId == null || m.id > afterId))
        .sort((a, b) => a.id - b.id);
    },
  };
}

type TransformStatusEntry = {
  transformVersion: number | null;
  lastRawMessageId: number | null;
  lastTransformedAt: Date | null;
  transformStatus: 'pending' | 'complete' | 'error' | null;
};

function createMockMetadataStore(): ISessionMetadataStore & {
  getStatus(sessionId: string): TransformStatusEntry;
} {
  const statuses = new Map<string, TransformStatusEntry>();

  return {
    getStatus(sessionId) {
      return (
        statuses.get(sessionId) ?? {
          transformVersion: null,
          lastRawMessageId: null,
          lastTransformedAt: null,
          transformStatus: null,
        }
      );
    },

    async getTransformStatus(sessionId) {
      return (
        statuses.get(sessionId) ?? {
          transformVersion: null,
          lastRawMessageId: null,
          lastTransformedAt: null,
          transformStatus: null,
        }
      );
    },

    async updateTransformStatus(sessionId, update) {
      statuses.set(sessionId, update);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRawMessage(overrides: Partial<RawMessage> & { id: number; sessionId: string }): RawMessage {
  return {
    source: 'claude-code',
    direction: 'input',
    content: '',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TranscriptTransformer', () => {
  const SESSION_ID = 'test-session-1';
  const PROVIDER = 'claude-code';

  let transcriptStore: ReturnType<typeof createMockTranscriptStore>;
  let metadataStore: ReturnType<typeof createMockMetadataStore>;

  beforeEach(() => {
    transcriptStore = createMockTranscriptStore();
    metadataStore = createMockMetadataStore();
  });

  describe('ensureTransformed', () => {
    it('skips when already complete at current version', async () => {
      const rawStore = createMockRawStore([]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      // Pre-set status as complete
      await metadataStore.updateTransformStatus(SESSION_ID, {
        transformVersion: TranscriptTransformer.CURRENT_VERSION,
        lastRawMessageId: 10,
        lastTransformedAt: new Date(),
        transformStatus: 'complete',
      });

      const result = await transformer.ensureTransformed(SESSION_ID, PROVIDER);
      expect(result).toBe(false);
      expect(transcriptStore.getAll()).toHaveLength(0);
    });

    it('processes live-write sessions (version >= LIVE_WRITE_VERSION) via transformer', async () => {
      const rawStore = createMockRawStore([
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          direction: 'input',
          content: 'Hello world',
        }),
      ]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      // Pre-set version to LIVE_WRITE_VERSION (legacy adapter sessions)
      // These are now processed normally by the transformer
      await metadataStore.updateTransformStatus(SESSION_ID, {
        transformVersion: TranscriptTransformer.LIVE_WRITE_VERSION,
        lastRawMessageId: 0,
        lastTransformedAt: new Date(),
        transformStatus: 'complete',
      });

      const result = await transformer.ensureTransformed(SESSION_ID, PROVIDER);
      expect(result).toBe(true);
      // Raw messages ARE now transformed -- transformer handles all sessions
      expect(transcriptStore.getAll().length).toBeGreaterThan(0);
    });

    it('transforms from beginning when status is null', async () => {
      const rawStore = createMockRawStore([
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          direction: 'input',
          content: 'Hello world',
        }),
      ]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      const result = await transformer.ensureTransformed(SESSION_ID, PROVIDER);
      expect(result).toBe(true);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].eventType).toBe('user_message');
      expect(events[0].searchableText).toBe('Hello world');

      const status = metadataStore.getStatus(SESSION_ID);
      expect(status.transformStatus).toBe('complete');
      expect(status.transformVersion).toBe(TranscriptTransformer.CURRENT_VERSION);
    });

    it('resumes from lastRawMessageId when pending', async () => {
      const rawStore = createMockRawStore([
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          direction: 'input',
          content: 'First message',
        }),
        makeRawMessage({
          id: 2,
          sessionId: SESSION_ID,
          direction: 'input',
          content: 'Second message',
        }),
      ]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      // Pre-set as pending with message 1 already processed
      await metadataStore.updateTransformStatus(SESSION_ID, {
        transformVersion: TranscriptTransformer.CURRENT_VERSION,
        lastRawMessageId: 1,
        lastTransformedAt: new Date(),
        transformStatus: 'pending',
      });

      const result = await transformer.ensureTransformed(SESSION_ID, PROVIDER);
      expect(result).toBe(true);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      // Should only have message 2 (resumed after id 1)
      expect(events).toHaveLength(1);
      expect(events[0].searchableText).toBe('Second message');

      const status = metadataStore.getStatus(SESSION_ID);
      expect(status.transformStatus).toBe('complete');
      expect(status.lastRawMessageId).toBe(2);
    });

    it('re-transforms when version is outdated', async () => {
      const rawStore = createMockRawStore([
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          direction: 'input',
          content: 'Hello',
        }),
      ]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      // Pre-set as complete but at an older version
      await metadataStore.updateTransformStatus(SESSION_ID, {
        transformVersion: 0, // older than CURRENT_VERSION
        lastRawMessageId: 1,
        lastTransformedAt: new Date(),
        transformStatus: 'complete',
      });

      // Pre-insert a stale canonical event (should be deleted on re-transform)
      await transcriptStore.insertEvent({
        sessionId: SESSION_ID,
        sequence: 0,
        createdAt: new Date(),
        eventType: 'user_message',
        searchableText: 'stale',
        payload: { mode: 'agent', inputType: 'user' },
        parentEventId: null,
        searchable: true,
        subagentId: null,
        provider: PROVIDER,
        providerToolCallId: null,
      });

      const result = await transformer.ensureTransformed(SESSION_ID, PROVIDER);
      expect(result).toBe(true);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      // Stale event should have been deleted and replaced with fresh transform
      expect(events).toHaveLength(1);
      expect(events[0].searchableText).toBe('Hello');
    });

    it('handles empty sessions gracefully', async () => {
      const rawStore = createMockRawStore([]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      const result = await transformer.ensureTransformed(SESSION_ID, PROVIDER);
      expect(result).toBe(true);

      const status = metadataStore.getStatus(SESSION_ID);
      expect(status.transformStatus).toBe('complete');
    });

    it('retries after error status', async () => {
      const rawStore = createMockRawStore([
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          direction: 'input',
          content: 'Retry me',
        }),
      ]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      // Pre-set as error
      await metadataStore.updateTransformStatus(SESSION_ID, {
        transformVersion: TranscriptTransformer.CURRENT_VERSION,
        lastRawMessageId: 0,
        lastTransformedAt: new Date(),
        transformStatus: 'error',
      });

      const result = await transformer.ensureTransformed(SESSION_ID, PROVIDER);
      expect(result).toBe(true);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      expect(events).toHaveLength(1);
      expect(events[0].searchableText).toBe('Retry me');
    });
  });

  describe('message transformation', () => {
    it('transforms plain text user messages', async () => {
      const rawStore = createMockRawStore([
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          direction: 'input',
          content: 'What is TypeScript?',
        }),
      ]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      await transformer.ensureTransformed(SESSION_ID, PROVIDER);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('user_message');
      expect(events[0].searchableText).toBe('What is TypeScript?');
      expect(events[0].searchable).toBe(true);
    });

    it('transforms Claude Code format user messages', async () => {
      const rawStore = createMockRawStore([
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          direction: 'input',
          content: JSON.stringify({ prompt: 'Fix the bug' }),
          metadata: { mode: 'agent' },
        }),
      ]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      await transformer.ensureTransformed(SESSION_ID, PROVIDER);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('user_message');
      expect(events[0].searchableText).toBe('Fix the bug');
    });

    it('transforms assistant text messages', async () => {
      const rawStore = createMockRawStore([
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({ type: 'text', content: 'Here is my answer.' }),
        }),
      ]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      await transformer.ensureTransformed(SESSION_ID, PROVIDER);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('assistant_message');
      expect(events[0].searchableText).toBe('Here is my answer.');
    });

    it('transforms structured assistant messages with tool_use content', async () => {
      const rawStore = createMockRawStore([
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({
            type: 'assistant',
            message: {
              content: [
                { type: 'text', text: 'Let me read that file.' },
                {
                  type: 'tool_use',
                  id: 'tool-1',
                  name: 'Read',
                  input: { file_path: '/src/index.ts' },
                },
              ],
            },
          }),
        }),
      ]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      await transformer.ensureTransformed(SESSION_ID, PROVIDER);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      expect(events).toHaveLength(2);
      expect(events[0].eventType).toBe('assistant_message');
      expect(events[0].searchableText).toBe('Let me read that file.');
      expect(events[1].eventType).toBe('tool_call');
      expect(events[1].providerToolCallId).toBe('tool-1');
      const payload = events[1].payload as any;
      expect(payload.toolName).toBe('Read');
      expect(payload.status).toBe('running');
    });

    it('transforms tool result messages and updates tool_call', async () => {
      const rawStore = createMockRawStore([
        // Tool use
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'tool-1',
                  name: 'Read',
                  input: { file_path: '/src/index.ts' },
                },
              ],
            },
          }),
        }),
        // Tool result
        makeRawMessage({
          id: 2,
          sessionId: SESSION_ID,
          direction: 'input',
          content: JSON.stringify({
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tool-1',
                  content: [{ type: 'text', text: 'File contents here' }],
                },
              ],
            },
          }),
        }),
      ]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      await transformer.ensureTransformed(SESSION_ID, PROVIDER);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      expect(events).toHaveLength(1); // tool_call only (result is an update)

      const payload = events[0].payload as any;
      expect(payload.status).toBe('completed');
      expect(payload.result).toBe('File contents here');
    });

    it('preserves image content in tool results as JSON', async () => {
      const imageData = 'iVBORw0KGgoAAAANSUhEUg=='; // fake base64
      const rawStore = createMockRawStore([
        // Tool use
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'tool-img',
                  name: 'mcp__nimbalyst-mcp__capture_editor_screenshot',
                  input: { file_path: '/test.excalidraw' },
                },
              ],
            },
          }),
        }),
        // Tool result with image content block (no text blocks)
        makeRawMessage({
          id: 2,
          sessionId: SESSION_ID,
          direction: 'input',
          content: JSON.stringify({
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tool-img',
                  content: [{ type: 'image', data: imageData, mimeType: 'image/png' }],
                },
              ],
            },
          }),
        }),
      ]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      await transformer.ensureTransformed(SESSION_ID, PROVIDER);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      expect(events).toHaveLength(1);

      const payload = events[0].payload as any;
      expect(payload.status).toBe('completed');
      // Result should be JSON-stringified array preserving image data
      const parsed = JSON.parse(payload.result);
      expect(parsed).toEqual([{ type: 'image', data: imageData, mimeType: 'image/png' }]);
    });

    it('attaches tool result from a resume batch to a tool_use from a previous batch', async () => {
      // Batch 1: only the tool_use
      const batch1Messages = [
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'tool-resume',
                  name: 'Read',
                  input: { file_path: '/src/index.ts' },
                },
              ],
            },
          }),
        }),
      ];
      const rawStore1 = createMockRawStore(batch1Messages);
      const transformer = new TranscriptTransformer(rawStore1, transcriptStore, metadataStore);

      // First transform: processes tool_use only
      await transformer.ensureTransformed(SESSION_ID, PROVIDER);

      const eventsAfterBatch1 = await transcriptStore.getSessionEvents(SESSION_ID);
      expect(eventsAfterBatch1).toHaveLength(1);
      expect((eventsAfterBatch1[0].payload as any).status).toBe('running');

      // Batch 2: tool_result arrives later
      const batch2Messages = [
        ...batch1Messages,
        makeRawMessage({
          id: 2,
          sessionId: SESSION_ID,
          direction: 'input',
          content: JSON.stringify({
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tool-resume',
                  content: [{ type: 'text', text: 'File contents here' }],
                },
              ],
            },
          }),
        }),
      ];
      const rawStore2 = createMockRawStore(batch2Messages);
      const transformer2 = new TranscriptTransformer(rawStore2, transcriptStore, metadataStore);

      // Resume transform: should attach result to existing tool_call event
      await transformer2.ensureTransformed(SESSION_ID, PROVIDER);

      const eventsAfterBatch2 = await transcriptStore.getSessionEvents(SESSION_ID);
      expect(eventsAfterBatch2).toHaveLength(1);
      expect((eventsAfterBatch2[0].payload as any).status).toBe('completed');
      expect((eventsAfterBatch2[0].payload as any).result).toBe('File contents here');
    });

    // Regression: the live incremental processing path keeps a watermark
    // across processNewMessages calls. Session cb82f2eb / 68a60f57: the
    // nimbalyst_tool_use is processed in one batch, the
    // git_commit_proposal_response (source=nimbalyst) arrives later in a
    // subsequent batch. The widget reads toolCall.result, so the second batch
    // must update the existing tool_call event to status=completed.
    it('attaches a git_commit_proposal_response from a resume batch to a tool_use from a previous batch', async () => {
      const proposalId = 'toolu_proposal_incremental';

      const batch1Messages = [
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({
            type: 'nimbalyst_tool_use',
            id: proposalId,
            name: 'developer_git_commit_proposal',
            input: {
              filesToStage: [{ path: 'src/foo.ts', status: 'modified' }],
              commitMessage: 'fix: thing',
            },
          }),
        }),
      ];
      const rawStore1 = createMockRawStore(batch1Messages);
      const transformer1 = new TranscriptTransformer(rawStore1, transcriptStore, metadataStore);

      await transformer1.processNewMessages(SESSION_ID, PROVIDER);

      const eventsAfterBatch1 = await transcriptStore.getSessionEvents(SESSION_ID);
      expect(eventsAfterBatch1).toHaveLength(1);
      expect(eventsAfterBatch1[0].eventType).toBe('tool_call');
      expect((eventsAfterBatch1[0].payload as any).status).toBe('running');

      // Resume batch: the user clicked Commit, the IPC handler wrote a
      // git_commit_proposal_response row with source='nimbalyst'.
      const batch2Messages = [
        ...batch1Messages,
        makeRawMessage({
          id: 2,
          sessionId: SESSION_ID,
          source: 'nimbalyst',
          direction: 'output',
          content: JSON.stringify({
            type: 'git_commit_proposal_response',
            proposalId,
            action: 'committed',
            commitHash: 'abc1234',
            commitDate: '2026-06-01T18:08:59-04:00',
            filesCommitted: ['src/foo.ts'],
            commitMessage: 'fix: thing',
            respondedAt: 1780347621666,
            respondedBy: 'desktop',
          }),
        }),
      ];
      const rawStore2 = createMockRawStore(batch2Messages);
      const transformer2 = new TranscriptTransformer(rawStore2, transcriptStore, metadataStore);

      await transformer2.processNewMessages(SESSION_ID, PROVIDER);

      const eventsAfterBatch2 = await transcriptStore.getSessionEvents(SESSION_ID);
      expect(eventsAfterBatch2).toHaveLength(1);
      const payload = eventsAfterBatch2[0].payload as any;
      expect(payload.status).toBe('completed');
      expect(typeof payload.result).toBe('string');
      const parsedResult = JSON.parse(payload.result);
      expect(parsedResult.action).toBe('committed');
      expect(parsedResult.commitHash).toBe('abc1234');
    });

    it('completes one Codex app-server tool across synthetic and native resume batches', async () => {
      const rawToolUseId = 'call_question_incremental';
      const started = makeRawMessage({
        id: 1,
        sessionId: SESSION_ID,
        source: 'openai-codex',
        direction: 'output',
        metadata: { transport: 'app-server', eventType: 'item/started' },
        content: JSON.stringify({
          method: 'item/started',
          params: {
            turnId: 'turn-question',
            item: {
              id: rawToolUseId,
              type: 'mcpToolCall',
              status: 'in_progress',
              server: 'nimbalyst',
              tool: 'AskUserQuestion',
              arguments: { questions: [{ question: 'Commit everything?' }] },
            },
          },
        }),
      });

      await new TranscriptTransformer(
        createMockRawStore([started]),
        transcriptStore,
        metadataStore,
      ).processNewMessages(SESSION_ID, 'openai-codex');

      const afterStart = await transcriptStore.getSessionEvents(SESSION_ID);
      expect(afterStart).toHaveLength(1);
      const providerToolCallId = afterStart[0].providerToolCallId as string;
      expect(providerToolCallId).toMatch(/^nimtc\|call_question_incremental\|/);

      const syntheticResult = makeRawMessage({
        id: 2,
        sessionId: SESSION_ID,
        source: 'openai-codex',
        direction: 'output',
        content: JSON.stringify({
          type: 'nimbalyst_tool_result',
          tool_use_id: rawToolUseId,
          result: JSON.stringify({ answers: { Scope: 'Everything' }, respondedBy: 'mobile' }),
          is_error: false,
        }),
      });

      await new TranscriptTransformer(
        createMockRawStore([started, syntheticResult]),
        transcriptStore,
        metadataStore,
      ).processNewMessages(SESSION_ID, 'openai-codex');

      const afterSyntheticResult = await transcriptStore.getSessionEvents(SESSION_ID);
      expect(afterSyntheticResult).toHaveLength(1);
      expect((afterSyntheticResult[0].payload as any).status).toBe('completed');

      const nativeCompletion = makeRawMessage({
        id: 3,
        sessionId: SESSION_ID,
        source: 'openai-codex',
        direction: 'output',
        metadata: {
          transport: 'app-server',
          eventType: 'item/completed',
          editGroupId: providerToolCallId,
        },
        content: JSON.stringify({
          method: 'item/completed',
          params: {
            turnId: 'turn-question',
            item: {
              id: rawToolUseId,
              type: 'mcpToolCall',
              status: 'completed',
              server: 'nimbalyst',
              tool: 'AskUserQuestion',
              arguments: { questions: [{ question: 'Commit everything?' }] },
              result: { answers: { Scope: 'Everything' } },
            },
          },
        }),
      });

      await new TranscriptTransformer(
        createMockRawStore([started, syntheticResult, nativeCompletion]),
        transcriptStore,
        metadataStore,
      ).processNewMessages(SESSION_ID, 'openai-codex');

      const finalEvents = await transcriptStore.getSessionEvents(SESSION_ID);
      expect(finalEvents).toHaveLength(1);
      expect(finalEvents[0].providerToolCallId).toBe(providerToolCallId);
      expect((finalEvents[0].payload as any).status).toBe('completed');
    });

    it('transforms system messages', async () => {
      const rawStore = createMockRawStore([
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          direction: 'input',
          content: JSON.stringify({ prompt: '[System: Your previous turn ended]' }),
        }),
      ]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      await transformer.ensureTransformed(SESSION_ID, PROVIDER);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('system_message');
    });

    it('transforms error messages', async () => {
      const rawStore = createMockRawStore([
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({
            type: 'error',
            error: 'Rate limit exceeded',
          }),
        }),
      ]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      await transformer.ensureTransformed(SESSION_ID, PROVIDER);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('system_message');
      expect(events[0].searchableText).toBe('Rate limit exceeded');
      const payload = events[0].payload as any;
      expect(payload.systemType).toBe('error');
    });

    it('transforms MCP tool calls with server/tool parsing', async () => {
      const rawStore = createMockRawStore([
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'mcp-tool-1',
                  name: 'mcp__posthog__query-trends',
                  input: { query: 'test' },
                },
              ],
            },
          }),
        }),
      ]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      await transformer.ensureTransformed(SESSION_ID, PROVIDER);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      expect(events).toHaveLength(1);
      const payload = events[0].payload as any;
      expect(payload.mcpServer).toBe('posthog');
      expect(payload.mcpTool).toBe('query-trends');
    });

    it('skips hidden messages', async () => {
      const rawStore = createMockRawStore([
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          direction: 'input',
          content: 'Visible message',
        }),
        makeRawMessage({
          id: 2,
          sessionId: SESSION_ID,
          direction: 'input',
          content: 'Hidden message',
          hidden: true,
        }),
      ]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      await transformer.ensureTransformed(SESSION_ID, PROVIDER);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      expect(events).toHaveLength(1);
      expect(events[0].searchableText).toBe('Visible message');
    });

    it('transforms nimbalyst_tool_use and nimbalyst_tool_result', async () => {
      const rawStore = createMockRawStore([
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({
            type: 'nimbalyst_tool_use',
            id: 'nim-tool-1',
            name: 'AskUserQuestion',
            input: { question: 'Do you approve?' },
          }),
        }),
        makeRawMessage({
          id: 2,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({
            type: 'nimbalyst_tool_result',
            tool_use_id: 'nim-tool-1',
            result: 'Yes',
          }),
        }),
      ]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      await transformer.ensureTransformed(SESSION_ID, PROVIDER);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      expect(events).toHaveLength(1); // tool_use + result update
      expect(events[0].eventType).toBe('tool_call');
      const payload = events[0].payload as any;
      expect(payload.toolName).toBe('AskUserQuestion');
      expect(payload.status).toBe('completed');
      expect(payload.result).toBe('Yes');
    });

    it('deduplicates nimbalyst_tool_use when assistant message already contains the same tool_use block', async () => {
      const rawStore = createMockRawStore([
        // Assistant message containing a tool_use block for AskUserQuestion
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 'tool-dedup-1', name: 'AskUserQuestion', input: { questions: [{ question: 'Pick one?' }] } },
              ],
            },
          }),
        }),
        // Separate nimbalyst_tool_use with the SAME tool ID
        makeRawMessage({
          id: 2,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({
            type: 'nimbalyst_tool_use',
            id: 'tool-dedup-1',
            name: 'AskUserQuestion',
            input: { questions: [{ question: 'Pick one?' }] },
          }),
        }),
        // Tool result
        makeRawMessage({
          id: 3,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({
            type: 'nimbalyst_tool_result',
            tool_use_id: 'tool-dedup-1',
            result: 'Option A',
          }),
        }),
      ]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      await transformer.ensureTransformed(SESSION_ID, PROVIDER);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      // Should produce exactly 1 tool_call event, not 2
      const toolEvents = events.filter(e => e.eventType === 'tool_call');
      expect(toolEvents).toHaveLength(1);
      expect((toolEvents[0].payload as any).toolName).toBe('AskUserQuestion');
      expect((toolEvents[0].payload as any).status).toBe('completed');
      expect((toolEvents[0].payload as any).result).toBe('Option A');
    });

    it('handles non-JSON output as plain assistant text', async () => {
      const rawStore = createMockRawStore([
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          direction: 'output',
          content: 'Just a plain text response',
        }),
      ]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      await transformer.ensureTransformed(SESSION_ID, PROVIDER);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('assistant_message');
      expect(events[0].searchableText).toBe('Just a plain text response');
    });
  });

  describe('incremental transformation', () => {
    it('advances high-water mark correctly', async () => {
      const rawMessages = [
        makeRawMessage({ id: 1, sessionId: SESSION_ID, direction: 'input', content: 'First' }),
        makeRawMessage({ id: 2, sessionId: SESSION_ID, direction: 'input', content: 'Second' }),
        makeRawMessage({ id: 3, sessionId: SESSION_ID, direction: 'input', content: 'Third' }),
      ];
      const rawStore = createMockRawStore(rawMessages);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      await transformer.ensureTransformed(SESSION_ID, PROVIDER);

      const status = metadataStore.getStatus(SESSION_ID);
      expect(status.lastRawMessageId).toBe(3);
      expect(status.transformStatus).toBe('complete');

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      expect(events).toHaveLength(3);
    });
  });

  describe('subagent transformation', () => {
    it('creates subagent event for Agent tool_use and groups child tools', async () => {
      const rawStore = createMockRawStore([
        // Agent spawn
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'agent-1',
                  name: 'Agent',
                  input: { prompt: 'Search for files', subagent_type: 'Explore' },
                },
              ],
            },
          }),
        }),
        // Child tool call with parent_tool_use_id on the outer wrapper
        makeRawMessage({
          id: 2,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({
            type: 'assistant',
            parent_tool_use_id: 'agent-1',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'child-1',
                  name: 'Glob',
                  input: { pattern: '*.ts' },
                },
              ],
            },
          }),
        }),
        // Agent result
        makeRawMessage({
          id: 3,
          sessionId: SESSION_ID,
          direction: 'input',
          content: JSON.stringify({
            type: 'user',
            message: {
              content: [
                { type: 'tool_result', tool_use_id: 'agent-1', content: 'Found 10 files' },
              ],
            },
          }),
        }),
      ]);

      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);
      await transformer.ensureTransformed(SESSION_ID, PROVIDER);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);

      // Should have: subagent event + child tool_call event
      const subagentEvent = events.find((e) => e.eventType === 'subagent');
      expect(subagentEvent).toBeDefined();
      expect(subagentEvent!.subagentId).toBe('agent-1');
      // Claude Code 2.1.x carries the actual agent kind on input.subagent_type;
      // the parser surfaces that as agentType when present.
      expect((subagentEvent!.payload as any).agentType).toBe('Explore');
      expect((subagentEvent!.payload as any).status).toBe('completed');
      expect((subagentEvent!.payload as any).resultSummary).toBe('Found 10 files');

      const childTool = events.find(
        (e) => e.eventType === 'tool_call' && (e.payload as any).toolName === 'Glob',
      );
      expect(childTool).toBeDefined();
      expect(childTool!.subagentId).toBe('agent-1');
    });

    it('does not set subagentId for tools without parent_tool_use_id', async () => {
      const rawStore = createMockRawStore([
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({
            type: 'assistant',
            message: {
              content: [
                { type: 'tool_use', id: 'agent-1', name: 'Agent', input: { prompt: 'do stuff' } },
              ],
            },
          }),
        }),
        // Regular tool call (no parent_tool_use_id on wrapper)
        makeRawMessage({
          id: 2,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({
            type: 'assistant',
            message: {
              content: [
                { type: 'tool_use', id: 'top-level', name: 'Read', input: { file_path: '/foo.ts' } },
              ],
            },
          }),
        }),
      ]);

      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);
      await transformer.ensureTransformed(SESSION_ID, PROVIDER);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      const readEvent = events.find(
        (e) => e.eventType === 'tool_call' && (e.payload as any).toolName === 'Read',
      );
      expect(readEvent).toBeDefined();
      expect(readEvent!.subagentId).toBeNull();
    });
  });

  describe('deduplication of accumulated chunks', () => {
    it('deduplicates tool_use blocks with the same tool ID', async () => {
      const rawStore = createMockRawStore([
        // Streaming chunk (has message.id)
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({
            type: 'assistant',
            message: {
              model: 'claude-opus-4-6',
              id: 'msg_123',
              content: [
                { type: 'tool_use', id: 'tool-dup', name: 'Read', input: { file_path: '/foo.ts' } },
              ],
            },
          }),
        }),
        // Accumulated echo (no message.id)
        makeRawMessage({
          id: 2,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({
            type: 'assistant',
            message: {
              content: [
                { type: 'tool_use', id: 'tool-dup', name: 'Read', input: { file_path: '/foo.ts' } },
              ],
            },
          }),
        }),
      ]);

      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);
      await transformer.ensureTransformed(SESSION_ID, PROVIDER);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      const toolEvents = events.filter((e) => e.eventType === 'tool_call');
      expect(toolEvents).toHaveLength(1);
    });

    it('deduplicates subagent tool_use blocks', async () => {
      const rawStore = createMockRawStore([
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({
            type: 'assistant',
            message: {
              model: 'claude-opus-4-6',
              id: 'msg_456',
              content: [
                { type: 'tool_use', id: 'agent-dup', name: 'Agent', input: { prompt: 'search' } },
              ],
            },
          }),
        }),
        makeRawMessage({
          id: 2,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({
            type: 'assistant',
            message: {
              content: [
                { type: 'tool_use', id: 'agent-dup', name: 'Agent', input: { prompt: 'search' } },
              ],
            },
          }),
        }),
      ]);

      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);
      await transformer.ensureTransformed(SESSION_ID, PROVIDER);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      const subagentEvents = events.filter((e) => e.eventType === 'subagent');
      expect(subagentEvents).toHaveLength(1);
    });

    it('deduplicates assistant text from accumulated chunks', async () => {
      const rawStore = createMockRawStore([
        // Streaming chunk with text (has message.id)
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({
            type: 'assistant',
            message: {
              model: 'claude-opus-4-6',
              id: 'msg_789',
              content: [
                { type: 'text', text: 'Let me help you.' },
              ],
            },
          }),
        }),
        // Accumulated chunk repeats the text (no message.id)
        makeRawMessage({
          id: 2,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({
            type: 'assistant',
            message: {
              content: [
                { type: 'text', text: 'Let me help you.' },
              ],
            },
          }),
        }),
      ]);

      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);
      await transformer.ensureTransformed(SESSION_ID, PROVIDER);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      const textEvents = events.filter((e) => e.eventType === 'assistant_message');
      expect(textEvents).toHaveLength(1);
    });

    it('deduplicates text when same message ID appears in multiple streaming chunks', async () => {
      const rawStore = createMockRawStore([
        // First streaming chunk: text
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({
            type: 'assistant',
            message: {
              model: 'claude-opus-4-6',
              id: 'msg_same',
              content: [{ type: 'text', text: 'First part.' }],
            },
          }),
        }),
        // Second streaming chunk with same message ID: tool_use
        makeRawMessage({
          id: 2,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({
            type: 'assistant',
            message: {
              model: 'claude-opus-4-6',
              id: 'msg_same',
              content: [
                { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/bar.ts' } },
              ],
            },
          }),
        }),
        // Accumulated chunk repeats both (no message.id)
        makeRawMessage({
          id: 3,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({
            type: 'assistant',
            message: {
              content: [
                { type: 'text', text: 'First part.' },
                { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/bar.ts' } },
              ],
            },
          }),
        }),
      ]);

      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);
      await transformer.ensureTransformed(SESSION_ID, PROVIDER);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      const textEvents = events.filter((e) => e.eventType === 'assistant_message');
      const toolEvents = events.filter((e) => e.eventType === 'tool_call');
      expect(textEvents).toHaveLength(1);
      expect(toolEvents).toHaveLength(1);
    });
  });

  describe('Codex reasoning and todo_list transformation', () => {
    const CODEX_PROVIDER = 'openai-codex';

    it('transforms Codex reasoning events into assistant thinking messages', async () => {
      const rawStore = createMockRawStore([
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          source: 'openai-codex',
          direction: 'output',
          content: JSON.stringify({
            type: 'item.completed',
            item: {
              id: 'reasoning-1',
              type: 'reasoning',
              text: 'Let me think about this problem.',
            },
          }),
        }),
      ]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      await transformer.ensureTransformed(SESSION_ID, CODEX_PROVIDER);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      const assistantEvents = events.filter((e) => e.eventType === 'assistant_message');
      expect(assistantEvents.length).toBeGreaterThanOrEqual(1);
      const reasoningEvent = assistantEvents.find((e) => {
        const payload = e.payload as Record<string, unknown>;
        return payload.thinking === 'Let me think about this problem.';
      });
      expect(reasoningEvent).toBeDefined();
      expect(reasoningEvent?.searchableText).toBe('');
    });

    it('transforms Codex todo_list items as markdown assistant messages', async () => {
      const rawStore = createMockRawStore([
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          source: 'openai-codex',
          direction: 'output',
          content: JSON.stringify({
            type: 'item.updated',
            item: {
              id: 'todo-1',
              type: 'todo_list',
              items: [
                { text: 'Read the file', completed: true },
                { text: 'Fix the bug', completed: false },
                { text: 'Write tests', completed: false },
              ],
            },
          }),
        }),
      ]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      await transformer.ensureTransformed(SESSION_ID, CODEX_PROVIDER);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      const assistantEvents = events.filter((e) => e.eventType === 'assistant_message');
      expect(assistantEvents.length).toBeGreaterThanOrEqual(1);
      const todoEvent = assistantEvents.find(
        (e) => e.searchableText?.includes('- [x] Read the file'),
      );
      expect(todoEvent).toBeDefined();
      expect(todoEvent!.searchableText).toContain('- [ ] Fix the bug');
      expect(todoEvent!.searchableText).toContain('- [ ] Write tests');
    });

    it('skips todo_list with empty items array', async () => {
      const rawStore = createMockRawStore([
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          source: 'openai-codex',
          direction: 'output',
          content: JSON.stringify({
            type: 'item.updated',
            item: {
              id: 'todo-empty',
              type: 'todo_list',
              items: [],
            },
          }),
        }),
      ]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      await transformer.ensureTransformed(SESSION_ID, CODEX_PROVIDER);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      expect(events).toHaveLength(0);
    });
  });

  describe('nimbalyst_tool_use deduplication', () => {
    it('deduplicates nimbalyst_tool_use when SDK also emits tool_use with same ID', async () => {
      const rawStore = createMockRawStore([
        // SDK emits tool_use in the assistant content block
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({
            type: 'assistant',
            message: {
              model: 'claude-opus-4-6',
              id: 'msg_1',
              content: [
                { type: 'tool_use', id: 'ask-123', name: 'AskUserQuestion', input: { questions: [{ text: 'Confirm?' }] } },
              ],
            },
          }),
        }),
        // Nimbalyst also logs the same tool as nimbalyst_tool_use
        makeRawMessage({
          id: 2,
          sessionId: SESSION_ID,
          direction: 'output',
          content: JSON.stringify({
            type: 'nimbalyst_tool_use',
            id: 'ask-123',
            name: 'AskUserQuestion',
            input: { questions: [{ text: 'Confirm?' }] },
          }),
        }),
      ]);

      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);
      await transformer.ensureTransformed(SESSION_ID, PROVIDER);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      const toolEvents = events.filter((e) => e.eventType === 'tool_call');
      expect(toolEvents).toHaveLength(1);
      expect((toolEvents[0].payload as any).toolName).toBe('AskUserQuestion');
    });
  });

  describe('Codex MCP tool result unwrapping', () => {
    const CODEX_PROVIDER = 'openai-codex';

    it('unwraps Codex MCP tool result envelope for session meta', async () => {
      const innerJson = JSON.stringify({ summary: 'Set name', before: { name: null, tags: [], phase: null }, after: { name: 'Test', tags: ['bug-fix'], phase: 'implementing' } });
      // Codex SDK delivers MCP results as the content envelope object
      const mcpContentEnvelope = { content: [{ type: 'text', text: innerJson }], structured_content: null };
      const rawStore = createMockRawStore([
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          source: 'openai-codex',
          direction: 'output',
          content: JSON.stringify({
            type: 'item.completed',
            item: {
              id: 'mcp-1',
              type: 'mcp_tool_call',
              server: 'nimbalyst-session-naming',
              tool: 'update_session_meta',
              arguments: { name: 'Test' },
              result: mcpContentEnvelope,
              status: 'completed',
            },
          }),
        }),
      ]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      await transformer.ensureTransformed(SESSION_ID, CODEX_PROVIDER);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      const toolEvents = events.filter((e) => e.eventType === 'tool_call');
      expect(toolEvents).toHaveLength(1);
      const payload = toolEvents[0].payload as any;
      expect(payload.toolName).toBe('mcp__nimbalyst-session-naming__update_session_meta');
      // Result should be the extracted inner text, not wrapped in envelopes
      expect(payload.result).toBe(innerJson);
      expect(payload.status).toBe('completed');
    });

    it('unwraps string MCP results without content envelope', async () => {
      const mcpResult = JSON.stringify({ summary: 'Set name', before: { name: null, tags: [], phase: null }, after: { name: 'Test', tags: [], phase: null } });
      const rawStore = createMockRawStore([
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          source: 'openai-codex',
          direction: 'output',
          content: JSON.stringify({
            type: 'item.completed',
            item: {
              id: 'mcp-2',
              type: 'mcp_tool_call',
              server: 'nimbalyst-session-naming',
              tool: 'update_session_meta',
              arguments: { name: 'Test' },
              result: mcpResult,
              status: 'completed',
            },
          }),
        }),
      ]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      await transformer.ensureTransformed(SESSION_ID, CODEX_PROVIDER);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      const toolEvents = events.filter((e) => e.eventType === 'tool_call');
      expect(toolEvents).toHaveLength(1);
      const payload = toolEvents[0].payload as any;
      expect(payload.result).toBe(mcpResult);
    });

    it('does not dedupe across sessions when Codex reuses item IDs', async () => {
      // Codex resets item IDs (item_1, item_2, ...) per turn/session, so the
      // same provider_tool_call_id appears in many sessions. A previous
      // session's matching tool name must NOT cause the new session's
      // tool_call_started descriptor to be dropped -- otherwise custom tool
      // widgets (e.g. git commit proposal) never render in later sessions.
      const SESSION_A = 'session-a';
      const SESSION_B = 'session-b';
      const TOOL_NAME = 'mcp__nimbalyst-mcp__developer_git_commit_proposal';

      const buildItemStarted = (sessionId: string) =>
        makeRawMessage({
          id: sessionId === SESSION_A ? 1 : 2,
          sessionId,
          source: 'openai-codex',
          direction: 'output',
          content: JSON.stringify({
            type: 'item.started',
            item: {
              id: 'item_1',
              type: 'mcp_tool_call',
              server: 'nimbalyst-mcp',
              tool: 'developer_git_commit_proposal',
              arguments: { commitMessage: 'first', filesToStage: ['a.ts'] },
              status: 'in_progress',
            },
          }),
        });

      const rawStore = createMockRawStore([
        buildItemStarted(SESSION_A),
        buildItemStarted(SESSION_B),
      ]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      await transformer.ensureTransformed(SESSION_A, CODEX_PROVIDER);
      await transformer.ensureTransformed(SESSION_B, CODEX_PROVIDER);

      const eventsA = await transcriptStore.getSessionEvents(SESSION_A);
      const eventsB = await transcriptStore.getSessionEvents(SESSION_B);

      const toolA = eventsA.filter((e) => e.eventType === 'tool_call');
      const toolB = eventsB.filter((e) => e.eventType === 'tool_call');

      expect(toolA).toHaveLength(1);
      expect(toolB).toHaveLength(1);
      expect((toolA[0].payload as any).toolName).toBe(TOOL_NAME);
      expect((toolB[0].payload as any).toolName).toBe(TOOL_NAME);
      // Distinct events, not the SESSION_A row leaking into SESSION_B
      expect(toolA[0].id).not.toBe(toolB[0].id);
      expect(toolA[0].sessionId).toBe(SESSION_A);
      expect(toolB[0].sessionId).toBe(SESSION_B);
    });

    it('creates separate tool_call events when Codex reuses item_0 for the same MCP tool in later turns', async () => {
      const rawStore = createMockRawStore([
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          source: 'openai-codex',
          direction: 'output',
          content: JSON.stringify({
            type: 'item.started',
            item: {
              id: 'item_0',
              type: 'mcp_tool_call',
              server: 'nimbalyst-mcp',
              tool: 'developer_git_commit_proposal',
              arguments: { commitMessage: 'first commit', filesToStage: ['a.ts'] },
              status: 'in_progress',
            },
          }),
        }),
        makeRawMessage({
          id: 2,
          sessionId: SESSION_ID,
          source: 'openai-codex',
          direction: 'output',
          content: JSON.stringify({
            type: 'item.completed',
            item: {
              id: 'item_0',
              type: 'mcp_tool_call',
              server: 'nimbalyst-mcp',
              tool: 'developer_git_commit_proposal',
              result: {
                content: [{ type: 'text', text: 'Auto-committed 1 file(s).\nCommit hash: first123' }],
              },
              error: null,
              status: 'completed',
            },
          }),
        }),
        makeRawMessage({
          id: 3,
          sessionId: SESSION_ID,
          source: 'openai-codex',
          direction: 'output',
          content: JSON.stringify({
            type: 'item.started',
            item: {
              id: 'item_0',
              type: 'mcp_tool_call',
              server: 'nimbalyst-mcp',
              tool: 'developer_git_commit_proposal',
              arguments: { commitMessage: 'second commit', filesToStage: ['b.ts'] },
              status: 'in_progress',
            },
          }),
        }),
        makeRawMessage({
          id: 4,
          sessionId: SESSION_ID,
          source: 'openai-codex',
          direction: 'output',
          content: JSON.stringify({
            type: 'item.completed',
            item: {
              id: 'item_0',
              type: 'mcp_tool_call',
              server: 'nimbalyst-mcp',
              tool: 'developer_git_commit_proposal',
              result: {
                content: [{ type: 'text', text: 'Auto-committed 1 file(s).\nCommit hash: second456' }],
              },
              error: null,
              status: 'completed',
            },
          }),
        }),
      ]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      await transformer.ensureTransformed(SESSION_ID, CODEX_PROVIDER);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      const toolEvents = events.filter((e) => e.eventType === 'tool_call');

      expect(toolEvents).toHaveLength(2);
      // CodexRawParser now mints a synthetic edit-group ID for each tool call
      // so reuses of the same raw item id (e.g. `item_0` across turns) get
      // distinct, durable canonical IDs. Both must wrap `item_0` in the
      // `nimtc|<rawId>|<ts>|<idx>` form.
      const firstId = toolEvents[0].providerToolCallId ?? '';
      const secondId = toolEvents[1].providerToolCallId ?? '';
      expect(firstId.startsWith('nimtc|item_0|')).toBe(true);
      expect(secondId.startsWith('nimtc|item_0|')).toBe(true);
      expect(firstId).not.toBe(secondId);
      expect(toolEvents[0].id).not.toBe(toolEvents[1].id);
      expect((toolEvents[0].payload as any).arguments.commitMessage).toBe('first commit');
      expect((toolEvents[1].payload as any).arguments.commitMessage).toBe('second commit');
      expect((toolEvents[0].payload as any).result).toContain('first123');
      expect((toolEvents[1].payload as any).result).toContain('second456');
    });

    it('preserves non-MCP Codex tool results as-is', async () => {
      const rawStore = createMockRawStore([
        makeRawMessage({
          id: 1,
          sessionId: SESSION_ID,
          source: 'openai-codex',
          direction: 'output',
          content: JSON.stringify({
            type: 'item.completed',
            item: {
              id: 'cmd-1',
              type: 'command_execution',
              command: 'ls -la',
              aggregated_output: 'file1.txt\nfile2.txt',
              exit_code: 0,
            },
          }),
        }),
      ]);
      const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

      await transformer.ensureTransformed(SESSION_ID, CODEX_PROVIDER);

      const events = await transcriptStore.getSessionEvents(SESSION_ID);
      const toolEvents = events.filter((e) => e.eventType === 'tool_call');
      expect(toolEvents).toHaveLength(1);
      const payload = toolEvents[0].payload as any;
      expect(payload.toolName).toBe('command_execution');
      // Non-MCP results keep their original structure
      const resultObj = JSON.parse(payload.result);
      expect(resultObj.success).toBe(true);
      expect(resultObj.command).toBe('ls -la');
    });
  });

  describe('error handling', () => {
    it('marks session as error when transformation fails', async () => {
      // Create a raw store that throws on getMessages (called before per-message loop)
      const failingRawStore: IRawMessageStore = {
        async getMessages() {
          throw new Error('DB read failed');
        },
      };

      const transformer = new TranscriptTransformer(failingRawStore, transcriptStore, metadataStore);

      await expect(transformer.ensureTransformed(SESSION_ID, PROVIDER)).rejects.toThrow(
        'DB read failed',
      );

      const status = metadataStore.getStatus(SESSION_ID);
      expect(status.transformStatus).toBe('error');
    });
  });
});
