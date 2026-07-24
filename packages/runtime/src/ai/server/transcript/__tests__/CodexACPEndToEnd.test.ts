/**
 * End-to-end integration test for the Codex ACP transcript pipeline.
 *
 * Runs the chunked mock ACP agent through:
 *   CodexACPProtocol -> raw ai_agent_messages -> TranscriptTransformer
 *   -> TranscriptProjector
 *
 * Asserts that the projected view contains a single assistant_message
 * with the chunks joined into one coherent reply -- the rendering bug
 * from session bb51b79b is exactly the failure of this assertion.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { CodexACPProtocol } from '../../protocols/CodexACPProtocol';
import {
  TranscriptTransformer,
  type IRawMessageStore,
  type ISessionMetadataStore,
  type RawMessage,
} from '../TranscriptTransformer';
import { TranscriptMigrationService } from '../TranscriptMigrationService';
import { TranscriptProjector } from '../TranscriptProjector';
import { createMockStore } from './helpers/createMockStore';
import { safeJSONSerialize } from '../../../../utils/serialization';
import { TranscriptMigrationRepository } from '../../../../storage/repositories/TranscriptMigrationRepository';
import { AgentMessagesRepository } from '../../../../storage/repositories/AgentMessagesRepository';
import { OpenAICodexACPProvider } from '../../providers/OpenAICodexACPProvider';
import { BaseAgentProvider } from '../../providers/BaseAgentProvider';

function fixturePath(): string {
  return fileURLToPath(new URL('./fixtures/chunkedCodexAcpAgent.mjs', import.meta.url));
}

function createRawStore(): IRawMessageStore & {
  append(msg: Omit<RawMessage, 'id'>): RawMessage;
  all(): RawMessage[];
} {
  const messages: RawMessage[] = [];
  let nextId = 1;

  return {
    append(msg) {
      const full: RawMessage = { ...msg, id: nextId++ };
      messages.push(full);
      return full;
    },
    all: () => [...messages],
    async getMessages(sessionId, afterId) {
      return messages
        .filter((m) => m.sessionId === sessionId && (afterId == null || m.id > afterId))
        .sort((a, b) => a.id - b.id);
    },
  };
}

function createMetadataStore(): ISessionMetadataStore {
  const state = new Map<string, {
    transformVersion: number | null;
    lastRawMessageId: number | null;
    lastTransformedAt: Date | null;
    transformStatus: 'pending' | 'complete' | 'error' | null;
  }>();

  return {
    async getTransformStatus(sessionId) {
      return state.get(sessionId) ?? {
        transformVersion: null,
        lastRawMessageId: null,
        lastTransformedAt: null,
        transformStatus: null,
      };
    },
    async updateTransformStatus(sessionId, update) {
      state.set(sessionId, update);
    },
  };
}

describe('Codex ACP transcript end-to-end', () => {
  it('chunked agent reply renders as a single assistant_message bubble', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-acp-e2e-'));
    const sessionId = 'session-under-test';

    const protocol = new CodexACPProtocol('test-key', {
      command: process.execPath,
      args: [fixturePath()],
    });

    const rawStore = createRawStore();
    const transcriptStore = createMockStore();
    const metadataStore = createMetadataStore();

    try {
      const session = await protocol.createSession({ workspacePath });

      // Mirror OpenAICodexACPProvider: log the user prompt, then store every
      // raw_event the protocol yields. This is the same write path that
      // populates ai_agent_messages in production.
      rawStore.append({
        sessionId,
        source: 'openai-codex-acp',
        direction: 'input',
        content: 'testing. say hi',
        createdAt: new Date(),
      });

      for await (const event of protocol.sendMessage(session, {
        content: 'testing. say hi',
      })) {
        if (event.type !== 'raw_event' || !event.metadata?.rawEvent) continue;
        const { content } = safeJSONSerialize(event.metadata.rawEvent);
        rawStore.append({
          sessionId,
          source: 'openai-codex-acp',
          direction: 'output',
          content,
          createdAt: new Date(),
          metadata: {
            eventType: (event.metadata.rawEvent as { type?: string })?.type ?? 'unknown',
          },
        });
      }
    } finally {
      protocol.destroy();
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }

    // Sanity: confirm the agent did emit per-chunk raw events. If this fails,
    // the fixture or protocol layer is broken before the transformer ever runs.
    const chunkRaws = rawStore
      .all()
      .filter((m) => m.direction === 'output')
      .filter((m) => {
        try {
          const parsed = JSON.parse(m.content);
          return parsed?.update?.sessionUpdate === 'agent_message_chunk';
        } catch {
          return false;
        }
      });
    expect(chunkRaws.length).toBeGreaterThan(1);

    const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);
    await transformer.processNewMessages(sessionId, 'openai-codex-acp');

    const events = await transcriptStore.getSessionEvents(sessionId);
    const view = TranscriptProjector.project(events);

    const assistantMessages = view.messages.filter((m) => m.type === 'assistant_message');
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].text).toBe("I'm reading the repo instructions first.");

    const userMessages = view.messages.filter((m) => m.type === 'user_message');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].text).toBe('testing. say hi');
  }, 15000);

  // Mirrors the live IPC streaming path: handleTranscriptEvent receives canonical
  // events one at a time and re-projects after each. If the projector coalesce is
  // sound, the final messages should be the same as the batch projection. If we
  // ever introduce per-event projection logic that loses coalesce, this test
  // catches it.
  it('live IPC streaming (event-by-event) yields a single assistant_message', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-acp-e2e-live-'));
    const sessionId = 'session-live';

    const protocol = new CodexACPProtocol('test-key', {
      command: process.execPath,
      args: [fixturePath()],
    });

    const rawStore = createRawStore();
    const transcriptStore = createMockStore();
    const metadataStore = createMetadataStore();
    const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

    // Simulate the renderer: every onEventWritten call re-projects all
    // accumulated events. Final messages are read from the simulated store.
    const accumulated: Awaited<ReturnType<typeof transcriptStore.getSessionEvents>> = [];
    let lastViewMessages: ReturnType<typeof TranscriptProjector.project>['messages'] = [];
    transformer.setOnEventWritten((event) => {
      const existingIdx = accumulated.findIndex((e) => e.id === event.id);
      if (existingIdx >= 0) accumulated[existingIdx] = event;
      else accumulated.push(event);
      lastViewMessages = TranscriptProjector.project(accumulated).messages;
    });

    try {
      const session = await protocol.createSession({ workspacePath });
      rawStore.append({
        sessionId,
        source: 'openai-codex-acp',
        direction: 'input',
        content: 'testing. say hi',
        createdAt: new Date(),
      });
      // Process the user message immediately so it lands in the accumulator
      // before assistant chunks arrive (mirrors the production write order).
      await transformer.processNewMessages(sessionId, 'openai-codex-acp');

      for await (const event of protocol.sendMessage(session, { content: 'testing. say hi' })) {
        if (event.type !== 'raw_event' || !event.metadata?.rawEvent) continue;
        const { content } = safeJSONSerialize(event.metadata.rawEvent);
        rawStore.append({
          sessionId,
          source: 'openai-codex-acp',
          direction: 'output',
          content,
          createdAt: new Date(),
        });
        // Production wiring (when present): provider triggers transformer on
        // each raw event. For now the test triggers it inline so we exercise
        // the per-event projection path.
        await transformer.processNewMessages(sessionId, 'openai-codex-acp');
      }
    } finally {
      protocol.destroy();
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }

    const assistantMessages = lastViewMessages.filter((m) => m.type === 'assistant_message');
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].text).toBe("I'm reading the repo instructions first.");
  }, 15000);

  // Mirrors the renderer race: live transcript:event events fire one at a time
  // (handleTranscriptEvent in sessionStateListeners.ts) while a throttled DB
  // reload is also setting sessionStoreAtom.messages from getViewMessages
  // (which returns ALREADY coalesced messages with a single id from the first
  // chunk in each run). The merge logic in handleTranscriptEvent must not lose
  // text when dbMessages contains the coalesced bubble and live events have
  // partial chunks.
  it('merge between coalesced DB messages and live chunk events does not lose text', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-acp-e2e-merge-'));
    const sessionId = 'session-merge';

    const protocol = new CodexACPProtocol('test-key', {
      command: process.execPath,
      args: [fixturePath()],
    });

    const rawStore = createRawStore();
    const transcriptStore = createMockStore();
    const metadataStore = createMetadataStore();
    const transformer = new TranscriptTransformer(rawStore, transcriptStore, metadataStore);

    // Simulate the renderer's two state inputs:
    //   liveEvents = events arriving via 'transcript:event' IPC (per-event)
    //   currentMessages = sessionStoreAtom.messages (mutated by both the live
    //     handler and DB reloads)
    const liveEvents: Awaited<ReturnType<typeof transcriptStore.getSessionEvents>> = [];
    let currentMessages: ReturnType<typeof TranscriptProjector.project>['messages'] = [];

    const handleTranscriptEvent = (event: typeof liveEvents[number]) => {
      const idx = liveEvents.findIndex((e) => e.id === event.id);
      if (idx >= 0) liveEvents[idx] = event;
      else liveEvents.push(event);

      const liveView = TranscriptProjector.project(liveEvents);
      const liveMessages = liveView.messages;
      const liveIds = new Set(liveMessages.map((m) => m.id));
      const hasLiveUserMessage = liveMessages.some((m) => m.type === 'user_message');
      const merged = [
        ...currentMessages.filter(
          (m) => !liveIds.has(m.id) && !(m.id < 0 && hasLiveUserMessage),
        ),
        ...liveMessages,
      ];
      merged.sort((a, b) => a.id - b.id);
      currentMessages = merged;
    };

    transformer.setOnEventWritten(handleTranscriptEvent);

    const reloadFromDb = async () => {
      // Mirrors aiLoadSession -> getViewMessages: read all canonical events,
      // project + coalesce, replace currentMessages with the result.
      const allEvents = await transcriptStore.getSessionEvents(sessionId);
      const dbView = TranscriptProjector.project(allEvents);
      currentMessages = dbView.messages;
    };

    try {
      const session = await protocol.createSession({ workspacePath });
      rawStore.append({
        sessionId,
        source: 'openai-codex-acp',
        direction: 'input',
        content: 'testing. say hi',
        createdAt: new Date(),
      });
      await transformer.processNewMessages(sessionId, 'openai-codex-acp');

      let chunkCount = 0;
      for await (const event of protocol.sendMessage(session, { content: 'testing. say hi' })) {
        if (event.type !== 'raw_event' || !event.metadata?.rawEvent) continue;
        const { content } = safeJSONSerialize(event.metadata.rawEvent);
        rawStore.append({
          sessionId,
          source: 'openai-codex-acp',
          direction: 'output',
          content,
          createdAt: new Date(),
        });
        await transformer.processNewMessages(sessionId, 'openai-codex-acp');
        chunkCount++;

        // Simulate a DB reload after the 3rd chunk -- this is the race the
        // renderer experiences: throttled reloads land while live events keep
        // arriving. The reload's dbMessages have id=<first chunk id> with the
        // full text-so-far; subsequent live events bring in chunks with later
        // ids.
        if (chunkCount === 3) {
          await reloadFromDb();
        }
      }
    } finally {
      protocol.destroy();
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }

    const assistantMessages = currentMessages.filter((m) => m.type === 'assistant_message');
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].text).toBe("I'm reading the repo instructions first.");
  }, 15000);

  // Tests the full provider wiring: OpenAICodexACPProvider.sendMessage must
  // drive the transcript transformer incrementally so live canonical events
  // (and the onEventWritten notifications that drive UI updates) fire AS chunks
  // stream, not only after the next session reload. Without the
  // processTranscriptMessages call inside the provider's stream loop, the
  // sessionId-bound onEventWritten count stays at 0 throughout streaming.
  it('OpenAICodexACPProvider drives live canonical events while streaming', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-acp-e2e-provider-'));
    const sessionId = 'session-provider';

    // Shared in-memory message log: AgentMessagesRepository.create() pushes into
    // it (provider's write path); IRawMessageStore.getMessages() reads from it
    // (transformer's read path). This mirrors the production wiring where both
    // stores hit the same ai_agent_messages table.
    interface StoredMessage {
      id: number;
      sessionId: string;
      source: string;
      direction: 'input' | 'output';
      content: string;
      createdAt: Date;
      metadata?: Record<string, unknown>;
      hidden: boolean;
    }
    const messages: StoredMessage[] = [];
    let nextMessageId = 1;

    AgentMessagesRepository.setStore({
      async create(message) {
        messages.push({
          id: nextMessageId++,
          sessionId: message.sessionId,
          source: message.source,
          direction: message.direction,
          content: message.content,
          createdAt: message.createdAt instanceof Date
            ? message.createdAt
            : message.createdAt
              ? new Date(message.createdAt)
              : new Date(),
          metadata: message.metadata,
          hidden: message.hidden ?? false,
        });
      },
      async list(sid) {
        return messages.filter((m) => m.sessionId === sid).map((m) => ({
          id: String(m.id),
          sessionId: m.sessionId,
          source: m.source,
          direction: m.direction,
          content: m.content,
          createdAt: m.createdAt,
          metadata: m.metadata,
          hidden: m.hidden,
        })) as any;
      },
    });

    const rawStore: IRawMessageStore = {
      async getMessages(sid, afterId) {
        return messages
          .filter((m) => m.sessionId === sid && (afterId == null || m.id > afterId))
          .sort((a, b) => a.id - b.id)
          .map((m) => ({
            id: m.id,
            sessionId: m.sessionId,
            source: m.source,
            direction: m.direction,
            content: m.content,
            createdAt: m.createdAt,
            metadata: m.metadata,
            hidden: m.hidden,
          }));
      },
    };

    const transcriptStore = createMockStore();
    const metadataStore = createMetadataStore();
    const migrationService = new TranscriptMigrationService(rawStore, transcriptStore, metadataStore);
    TranscriptMigrationRepository.setService(migrationService);

    let liveEventCount = 0;
    const liveEventTimeline: Array<{ count: number; messageCount: number }> = [];
    migrationService.setOnEventWritten(() => {
      liveEventCount++;
      liveEventTimeline.push({ count: liveEventCount, messageCount: messages.length });
    });

    BaseAgentProvider.setTrustChecker(() => ({ trusted: true, mode: 'allow-all' }));
    BaseAgentProvider.setPermissionPatternSaver(() => Promise.resolve());
    BaseAgentProvider.setPermissionPatternChecker(() => Promise.resolve(false));

    const protocol = new CodexACPProtocol('test-key', {
      command: process.execPath,
      args: [fixturePath()],
    });

    const provider = new OpenAICodexACPProvider({}, { protocol });
    await provider.initialize({ apiKey: 'test', model: 'openai-codex-acp:gpt-5.5' });

    try {
      const chunks: any[] = [];
      for await (const chunk of provider.sendMessage(
        'testing. say hi',
        undefined,
        sessionId,
        [],
        workspacePath,
      )) {
        chunks.push(chunk);
        if (chunk.type === 'text') {
          // While text chunks are still being yielded, live events should be
          // firing in tandem (provider drives processNewMessages each chunk).
          // We capture the running totals to assert below that liveEventCount
          // is non-zero before the stream completes.
        }
      }

      // The transformer fired onEventWritten as messages were stored, not in
      // a single burst at the end. Snapshot the timeline to make sure live
      // events appeared while messages were still being written.
      const liveBeforeFinalMessage = liveEventTimeline.filter(
        (t) => t.messageCount < messages.length,
      );
      expect(liveBeforeFinalMessage.length).toBeGreaterThan(0);

      // Phase 3 of canonical-transcript-deprecation: canonical events live
      // in TranscriptRuntime's in-memory cache, not on the persisted
      // transcriptStore. Fetch via the service so we see what the renderer
      // would receive.
      const events = await migrationService.getCanonicalEvents(sessionId, 'openai-codex-acp');
      const view = TranscriptProjector.project(events);
      const assistantMessages = view.messages.filter((m) => m.type === 'assistant_message');
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].text).toBe("I'm reading the repo instructions first.");
    } finally {
      provider.destroy();
      protocol.destroy();
      AgentMessagesRepository.clearStore();
      TranscriptMigrationRepository.clearService();
      BaseAgentProvider.setTrustChecker(null);
      BaseAgentProvider.setPermissionPatternSaver(null);
      BaseAgentProvider.setPermissionPatternChecker(null);
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  }, 15000);
});
