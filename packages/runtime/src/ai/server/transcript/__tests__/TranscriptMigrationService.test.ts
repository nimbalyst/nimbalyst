import { describe, it, expect, beforeEach } from 'vitest';
import { TranscriptMigrationService } from '../TranscriptMigrationService';
import { TranscriptTransformer } from '../TranscriptTransformer';
import type { IRawMessageStore, RawMessage, ISessionMetadataStore } from '../TranscriptTransformer';
import type { ITranscriptEventStore, TranscriptEvent } from '../types';

// ---------------------------------------------------------------------------
// Mock stores (same pattern as TranscriptTransformer tests)
// ---------------------------------------------------------------------------

function createMockTranscriptStore(): ITranscriptEventStore {
  const events: TranscriptEvent[] = [];
  let nextId = 1;
  const sequenceCounters = new Map<string, number>();

  return {
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
      return events.filter((e) => e.parentEventId === parentEventId).sort((a, b) => a.sequence - b.sequence);
    },
    async getSubagentEvents(subagentId, sessionId) {
      return events.filter((e) => e.subagentId === subagentId && e.sessionId === sessionId).sort((a, b) => a.sequence - b.sequence);
    },
    async getMultiSessionEvents(sessionIds, options) {
      let result = events.filter((e) => sessionIds.includes(e.sessionId)).sort((a, b) => a.sequence - b.sequence);
      if (options?.eventTypes) result = result.filter((e) => options.eventTypes!.includes(e.eventType));
      return result;
    },
    async searchSessions(query, options) {
      let result = events.filter((e) => e.searchable && e.searchableText?.toLowerCase().includes(query.toLowerCase()));
      if (options?.sessionIds) result = result.filter((e) => options.sessionIds!.includes(e.sessionId));
      return result.slice(0, options?.limit ?? 100).map((e) => ({ event: e, sessionId: e.sessionId }));
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
      for (const e of toRemove) events.splice(events.indexOf(e), 1);
      sequenceCounters.delete(sessionId);
    },
    async deleteEventsAtOrAfterSequence(sessionId, sequence) {
      const toRemove = events.filter(
        (e) => e.sessionId === sessionId && e.sequence >= sequence,
      );
      for (const e of toRemove) events.splice(events.indexOf(e), 1);
      const current = sequenceCounters.get(sessionId);
      if (current != null && current > sequence) {
        sequenceCounters.set(sessionId, sequence);
      }
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TranscriptMigrationService', () => {
  const SESSION_ID = 'migration-test-session';
  const PROVIDER = 'claude-code';

  let transcriptStore: ITranscriptEventStore;
  let metadataStore: ISessionMetadataStore;

  beforeEach(() => {
    transcriptStore = createMockTranscriptStore();
    metadataStore = createMockMetadataStore();
  });

  describe('getCanonicalEvents', () => {
    it('triggers transformation for untransformed sessions', async () => {
      const rawStore = createMockRawStore([
        {
          id: 1,
          sessionId: SESSION_ID,
          source: 'claude-code',
          direction: 'input',
          content: 'Hello from migration',
          createdAt: new Date('2024-01-01'),
        },
      ]);

      const service = new TranscriptMigrationService(rawStore, transcriptStore, metadataStore);
      const events = await service.getCanonicalEvents(SESSION_ID, PROVIDER);

      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('user_message');
      expect(events[0].searchableText).toBe('Hello from migration');
    });

    it('skips transformation for already-transformed sessions', async () => {
      const rawStore = createMockRawStore([
        {
          id: 1,
          sessionId: SESSION_ID,
          source: 'claude-code',
          direction: 'input',
          content: 'Already done',
          createdAt: new Date('2024-01-01'),
        },
      ]);

      // Mark as already complete
      await metadataStore.updateTransformStatus(SESSION_ID, {
        transformVersion: TranscriptTransformer.CURRENT_VERSION,
        lastRawMessageId: 1,
        lastTransformedAt: new Date(),
        transformStatus: 'complete',
      });

      const service = new TranscriptMigrationService(rawStore, transcriptStore, metadataStore);
      const events = await service.getCanonicalEvents(SESSION_ID, PROVIDER);

      // No transformation happened, no events in store
      expect(events).toHaveLength(0);
    });

    it('passes options through to store', async () => {
      const rawStore = createMockRawStore([
        {
          id: 1,
          sessionId: SESSION_ID,
          source: 'claude-code',
          direction: 'input',
          content: 'Message 1',
          createdAt: new Date('2024-01-01'),
        },
        {
          id: 2,
          sessionId: SESSION_ID,
          source: 'claude-code',
          direction: 'output',
          content: JSON.stringify({ type: 'text', content: 'Response 1' }),
          createdAt: new Date('2024-01-01'),
        },
      ]);

      const service = new TranscriptMigrationService(rawStore, transcriptStore, metadataStore);
      const events = await service.getCanonicalEvents(SESSION_ID, PROVIDER, {
        eventTypes: ['user_message'],
      });

      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('user_message');
    });
  });

  describe('needsTransformation', () => {
    it('returns true when status is null', async () => {
      const rawStore = createMockRawStore([]);
      const service = new TranscriptMigrationService(rawStore, transcriptStore, metadataStore);

      expect(await service.needsTransformation(SESSION_ID)).toBe(true);
    });

    it('returns false when complete at current version', async () => {
      const rawStore = createMockRawStore([]);
      await metadataStore.updateTransformStatus(SESSION_ID, {
        transformVersion: TranscriptTransformer.CURRENT_VERSION,
        lastRawMessageId: 10,
        lastTransformedAt: new Date(),
        transformStatus: 'complete',
      });

      const service = new TranscriptMigrationService(rawStore, transcriptStore, metadataStore);

      expect(await service.needsTransformation(SESSION_ID)).toBe(false);
    });

    it('returns true when version is outdated', async () => {
      const rawStore = createMockRawStore([]);
      await metadataStore.updateTransformStatus(SESSION_ID, {
        transformVersion: 0,
        lastRawMessageId: 10,
        lastTransformedAt: new Date(),
        transformStatus: 'complete',
      });

      const service = new TranscriptMigrationService(rawStore, transcriptStore, metadataStore);

      expect(await service.needsTransformation(SESSION_ID)).toBe(true);
    });

    it('returns true when status is error', async () => {
      const rawStore = createMockRawStore([]);
      await metadataStore.updateTransformStatus(SESSION_ID, {
        transformVersion: TranscriptTransformer.CURRENT_VERSION,
        lastRawMessageId: 5,
        lastTransformedAt: new Date(),
        transformStatus: 'error',
      });

      const service = new TranscriptMigrationService(rawStore, transcriptStore, metadataStore);

      expect(await service.needsTransformation(SESSION_ID)).toBe(true);
    });
  });
});
