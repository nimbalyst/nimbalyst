  /**
 * TranscriptTransformer -- the single path from raw ai_agent_messages to
 * canonical ai_transcript_events.
 *
 * Supports two modes:
 * 1. Batch: ensureUpToDate() for lazy migration on session load
 * 2. Incremental: processNewMessages() for real-time processing during streaming
 *
 * The raw ai_agent_messages log is the sole source of truth. This transformer
 * reads it and writes derived canonical events via TranscriptWriter.
 *
 * Parsing logic is delegated to per-provider parsers (ClaudeCodeRawParser,
 * CodexRawParser). The transformer owns the write path: it processes
 * CanonicalEventDescriptors returned by parsers, calls TranscriptWriter,
 * and manages the tool/subagent ID tracking maps.
 */

import { TranscriptWriter } from './TranscriptWriter';
import { InMemoryTranscriptEventStore } from './InMemoryTranscriptEventStore';
import type { ITranscriptEventStore, TranscriptEvent } from './types';
import { ClaudeCodeRawParser } from './parsers/ClaudeCodeRawParser';
import { CodexRawParser } from './parsers/CodexRawParser';
import { CodexRawParserDispatcher } from './parsers/CodexRawParserDispatcher';
import { CodexACPRawParser } from './parsers/CodexACPRawParser';
import { CopilotRawParser } from './parsers/CopilotRawParser';
import { OpenCodeRawParser } from './parsers/OpenCodeRawParser';
import { VoiceRawParser } from './parsers/VoiceRawParser';
import type {
  IRawMessageParser,
  ParseContext,
  CanonicalEventDescriptor,
} from './parsers/IRawMessageParser';
import { processDescriptor as processDescriptorShared, stampUserMessageRawId } from './processDescriptor';

// ---------------------------------------------------------------------------
// Dependencies (injected via interfaces)
// ---------------------------------------------------------------------------

export interface RawMessage {
  id: number;
  sessionId: string;
  source: string;
  direction: 'input' | 'output';
  content: string;
  createdAt: Date;
  metadata?: Record<string, unknown>;
  hidden?: boolean;
}

export interface IRawMessageStore {
  /** Get raw messages for a session, ordered by id, optionally starting after a given id */
  getMessages(sessionId: string, afterId?: number): Promise<RawMessage[]>;
}

export interface ISessionMetadataStore {
  getTransformStatus(sessionId: string): Promise<{
    transformVersion: number | null;
    lastRawMessageId: number | null;
    lastTransformedAt: Date | null;
    transformStatus: 'pending' | 'complete' | 'error' | null;
  }>;
  updateTransformStatus(
    sessionId: string,
    update: {
      transformVersion: number;
      lastRawMessageId: number;
      lastTransformedAt: Date;
      transformStatus: 'pending' | 'complete' | 'error';
    },
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Callback type for real-time event notification
// ---------------------------------------------------------------------------

export type OnCanonicalEventWritten = (event: TranscriptEvent) => void;

// ---------------------------------------------------------------------------
// Transformer
// ---------------------------------------------------------------------------

export class TranscriptTransformer {
  /**
   * Version for transformer-managed sessions.
   *
   * DO NOT BUMP THIS to "fix" a parser bug or refresh a single session's
   * transcript. Bumping this number forces a full re-transform of EVERY
   * historical session for EVERY provider on the user's machine -- including
   * sessions that have nothing to do with the change. That's an enormous,
   * irreversible blast radius for a one-off fix.
   *
   * This number is reserved for incompatible changes to the canonical event
   * shape itself. If you're tempted to bump it because new sessions look
   * wrong with an old parser, ship the parser fix instead and accept that
   * already-broken sessions stay broken until the user starts a new one.
   * Tell the user that explicitly -- don't paper over it with a re-transform.
   */
  static readonly CURRENT_VERSION = 4;

  /**
   * @deprecated Kept for backwards compatibility with existing session metadata.
   * Sessions with this version are now processed normally via the transformer.
   * Will be removed once all sessions have been re-transformed.
   */
  static readonly LIVE_WRITE_VERSION = 1000;

  /**
   * Callback fired after each canonical event is written.
   * Used to notify the renderer in real-time during streaming.
   */
  private onEventWritten: OnCanonicalEventWritten | null = null;

  /**
   * Per-session lock to prevent concurrent ensureUpToDate/processNewMessages
   * calls from reading the same watermark and writing duplicate canonical events.
   * Each entry is a promise that resolves when the current processing completes.
   */
  private sessionLocks = new Map<string, Promise<unknown>>();

  constructor(
    private rawStore: IRawMessageStore,
    private transcriptStore: ITranscriptEventStore,
    private metadataStore: ISessionMetadataStore,
  ) {}

  /** Set callback fired after each canonical event write (for UI notification) */
  setOnEventWritten(cb: OnCanonicalEventWritten): void {
    this.onEventWritten = cb;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Ensure a session's canonical events are up to date. Call before reading
   * canonical transcript. Returns true if new events were written.
   *
   * This is the lazy migration entry point: on session load, it processes
   * any raw messages that haven't been transformed yet.
   */
  async ensureUpToDate(sessionId: string, provider: string): Promise<boolean> {
    return this.withSessionLock(sessionId, () => this.ensureUpToDateLocked(sessionId, provider));
  }

  private async ensureUpToDateLocked(sessionId: string, provider: string): Promise<boolean> {
    const status = await this.metadataStore.getTransformStatus(sessionId);

    // Complete at current version -- resume to pick up any new raw messages
    // written since the last transform. resumeTransformation is a no-op
    // when there are no new messages (one DB query, no writes).
    if (
      status.transformStatus === 'complete' &&
      status.transformVersion != null &&
      (status.transformVersion === TranscriptTransformer.CURRENT_VERSION ||
       status.transformVersion >= TranscriptTransformer.LIVE_WRITE_VERSION)
    ) {
      return this.resumeTransformation(sessionId, provider, status.lastRawMessageId ?? undefined, true);
    }

    // Version mismatch (old transformer version, not live) -- re-transform from scratch
    if (
      status.transformVersion != null &&
      status.transformVersion !== TranscriptTransformer.CURRENT_VERSION &&
      status.transformVersion < TranscriptTransformer.LIVE_WRITE_VERSION
    ) {
      await this.transcriptStore.deleteSessionEvents(sessionId);
      return this.transformFromBeginning(sessionId, provider);
    }

    // Never transformed (null status) -- transform from beginning
    if (status.transformStatus == null) {
      return this.transformFromBeginning(sessionId, provider);
    }

    // Pending -- resume from last raw message id
    if (status.transformStatus === 'pending') {
      return this.resumeTransformation(sessionId, provider, status.lastRawMessageId ?? undefined);
    }

    // Error status -- try again from where we left off
    if (status.transformStatus === 'error') {
      return this.resumeTransformation(sessionId, provider, status.lastRawMessageId ?? undefined);
    }

    return false;
  }

  /**
   * @deprecated Use ensureUpToDate instead. Kept for backwards compatibility.
   */
  async ensureTransformed(sessionId: string, provider: string): Promise<boolean> {
    return this.ensureUpToDate(sessionId, provider);
  }

  /**
   * DEV/TESTING: Force a full reparse of one session's canonical events.
   *
   * Wipes existing canonical events for the session and re-runs the parser
   * from scratch on the raw message log. Use this when iterating on parser
   * changes locally to verify the fix against an existing session WITHOUT
   * bumping CURRENT_VERSION (which would reparse every session).
   *
   * Not safe to wire up as a user-facing action -- it's destructive (drops
   * canonical events and rewrites them) and exists only for parser
   * development. Gate any IPC that exposes it on dev mode.
   */
  async forceReparseSession(sessionId: string, provider: string): Promise<boolean> {
    return this.withSessionLock(sessionId, async () => {
      await this.transcriptStore.deleteSessionEvents(sessionId);
      return this.transformFromBeginning(sessionId, provider);
    });
  }

  /**
   * Process new raw messages for a session incrementally.
   * Call after writing raw messages to ai_agent_messages.
   *
   * This reads messages with id > lastRawMessageId (watermark), parses them,
   * writes canonical events, updates the watermark, and fires onEventWritten
   * for each event so the renderer can update in real-time.
   *
   * Returns the canonical events that were written.
   */
  async processNewMessages(
    sessionId: string,
    provider: string,
  ): Promise<TranscriptEvent[]> {
    return this.withSessionLock(sessionId, () => this.processNewMessagesLocked(sessionId, provider));
  }

  private async processNewMessagesLocked(
    sessionId: string,
    provider: string,
  ): Promise<TranscriptEvent[]> {
    const status = await this.metadataStore.getTransformStatus(sessionId);
    const afterId = status.lastRawMessageId ?? 0;

    // If session has never been initialized, set up watermark
    if (status.transformStatus == null) {
      await this.metadataStore.updateTransformStatus(sessionId, {
        transformVersion: TranscriptTransformer.CURRENT_VERSION,
        lastRawMessageId: 0,
        lastTransformedAt: new Date(),
        transformStatus: 'complete',
      });
    }

    const messages = await this.rawStore.getMessages(sessionId, afterId);
    if (messages.length === 0) return [];

    const writer = new TranscriptWriter(this.transcriptStore, provider);
    const parser = this.createParser(provider);

    // Incremental processing always resumes from a prior watermark, so
    // suppress result chunk text to prevent duplicating assistant text
    // that was processed in a previous batch.
    if (afterId > 0 && parser instanceof ClaudeCodeRawParser) {
      parser.setSuppressResultChunkText(true);
    }

    const startSequence = await this.transcriptStore.getNextSequence(sessionId);
    writer.seedSequence(startSequence);

    const writtenEvents: TranscriptEvent[] = [];

    // For incremental processing, use DB lookups for tool ID resolution
    // instead of in-memory maps (no batch state to carry over)
    const toolEventIds = new Map<string, number>();
    const subagentEventIds = new Map<string, number>();

    const context: ParseContext = {
      sessionId,
      hasToolCall: (id: string) => {
        if (toolEventIds.has(id)) return true;
        // No synchronous DB check; the parser should use findByProviderToolCallId for async
        return false;
      },
      hasSubagent: (id: string) => subagentEventIds.has(id),
      findByProviderToolCallId: (id: string) =>
        this.transcriptStore.findByProviderToolCallId(id, sessionId),
      findActiveToolCallByRawProviderId: (rawId: string) =>
        this.transcriptStore.findActiveToolCallByRawProviderId(rawId, sessionId),
    };

    let lastRawMessageId = afterId;

    for (const msg of messages) {
      try {
        const descriptors = await parser.parseMessage(msg, context);
        stampUserMessageRawId(descriptors, msg.id);
        for (const desc of descriptors) {
          const event = await this.processDescriptorWithNotify(
            writer,
            sessionId,
            desc,
            toolEventIds,
            subagentEventIds,
          );
          if (event) writtenEvents.push(event);
        }
      } catch {
        // Skip unparseable messages -- the raw log is preserved
      }
      lastRawMessageId = msg.id;
    }

    await this.metadataStore.updateTransformStatus(sessionId, {
      transformVersion: TranscriptTransformer.CURRENT_VERSION,
      lastRawMessageId,
      lastTransformedAt: new Date(),
      transformStatus: 'complete',
    });

    return writtenEvents;
  }

  // ---------------------------------------------------------------------------
  // Internal: batch transformation
  // ---------------------------------------------------------------------------

  private async transformFromBeginning(sessionId: string, provider: string): Promise<boolean> {
    try {
      await this.metadataStore.updateTransformStatus(sessionId, {
        transformVersion: TranscriptTransformer.CURRENT_VERSION,
        lastRawMessageId: 0,
        lastTransformedAt: new Date(),
        transformStatus: 'pending',
      });

      const messages = await this.rawStore.getMessages(sessionId);
      if (messages.length === 0) {
        await this.metadataStore.updateTransformStatus(sessionId, {
          transformVersion: TranscriptTransformer.CURRENT_VERSION,
          lastRawMessageId: 0,
          lastTransformedAt: new Date(),
          transformStatus: 'complete',
        });
        return true;
      }

      // Fast path: when the real store supports a batch insert, stage every
      // canonical event in an in-memory store, then flush in one IPC round
      // trip. Without staging the transformer issues N writer calls × ~1ms
      // postMessage round-trip each through SQLiteDatabaseProxy, which makes
      // the lazy-migration first-open of any large session feel hung
      // (observed ~14s for ~3k events). Real-store lookups (e.g.
      // `findByProviderToolCallId`) safely return null on the fresh path
      // because `transformFromBeginning` only runs when no canonical events
      // exist for this session yet.
      let result: { lastRawMessageId: number; eventsWritten: number };
      const realInsertEvents = this.transcriptStore.insertEvents?.bind(this.transcriptStore);
      if (realInsertEvents) {
        const staging = new InMemoryTranscriptEventStore();
        result = await this.transformMessages(sessionId, messages, provider, false, staging);
        const staged = staging.getAllEvents();
        if (staged.length > 0) {
          // Split into "simple" events (no parentEventId) and "derived"
          // events (parentEventId points at another event in the same
          // batch). Simple events go through one bulk insert. Derived
          // events — currently just `tool_progress` — are rare and need
          // the parent's real id, so we insert them one-at-a-time after
          // building the staging→real id map.
          const simple = staged.filter((e) => e.parentEventId == null);
          const derived = staged.filter((e) => e.parentEventId != null);

          const flushedSimple = await realInsertEvents(
            simple.map((e) => {
              const { id: _stagingId, ...rest } = e;
              return rest;
            }),
          );

          const stagingIdToReal = new Map<number, number>();
          for (let i = 0; i < simple.length; i++) {
            stagingIdToReal.set(simple[i].id, flushedSimple[i].id);
          }

          const flushedDerived: TranscriptEvent[] = [];
          for (const child of derived) {
            const realParentId = child.parentEventId != null
              ? stagingIdToReal.get(child.parentEventId) ?? null
              : null;
            const { id: _stagingId, ...rest } = child;
            const inserted = await this.transcriptStore.insertEvent({
              ...rest,
              parentEventId: realParentId,
            });
            stagingIdToReal.set(child.id, inserted.id);
            flushedDerived.push(inserted);
          }

          if (this.onEventWritten) {
            for (const ev of flushedSimple) this.onEventWritten(ev);
            for (const ev of flushedDerived) this.onEventWritten(ev);
          }
        }
      } else {
        result = await this.transformMessages(sessionId, messages, provider);
      }

      await this.metadataStore.updateTransformStatus(sessionId, {
        transformVersion: TranscriptTransformer.CURRENT_VERSION,
        lastRawMessageId: result.lastRawMessageId,
        lastTransformedAt: new Date(),
        transformStatus: 'complete',
      });

      return true;
    } catch (err) {
      await this.metadataStore.updateTransformStatus(sessionId, {
        transformVersion: TranscriptTransformer.CURRENT_VERSION,
        lastRawMessageId: 0,
        lastTransformedAt: new Date(),
        transformStatus: 'error',
      });
      throw err;
    }
  }

  private async resumeTransformation(
    sessionId: string,
    provider: string,
    afterId?: number,
    alreadyComplete = false,
  ): Promise<boolean> {
    try {
      const messages = await this.rawStore.getMessages(sessionId, afterId);
      if (messages.length === 0) {
        if (!alreadyComplete) {
          await this.metadataStore.updateTransformStatus(sessionId, {
            transformVersion: TranscriptTransformer.CURRENT_VERSION,
            lastRawMessageId: afterId ?? 0,
            lastTransformedAt: new Date(),
            transformStatus: 'complete',
          });
        }
        return false;
      }

      const result = await this.transformMessages(sessionId, messages, provider, true);

      await this.metadataStore.updateTransformStatus(sessionId, {
        transformVersion: TranscriptTransformer.CURRENT_VERSION,
        lastRawMessageId: result.lastRawMessageId,
        lastTransformedAt: new Date(),
        transformStatus: 'complete',
      });

      return true;
    } catch (err) {
      await this.metadataStore.updateTransformStatus(sessionId, {
        transformVersion: TranscriptTransformer.CURRENT_VERSION,
        lastRawMessageId: afterId ?? 0,
        lastTransformedAt: new Date(),
        transformStatus: 'error',
      });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Parser creation
  // ---------------------------------------------------------------------------

  private createParser(provider: string): IRawMessageParser {
    if (provider === 'copilot-cli') {
      return new CopilotRawParser();
    }
    if (provider === 'openai-codex') {
      // Dispatches per-message between the SDK parser (legacy default) and
      // the app-server parser based on `metadata.transport`. Old sessions
      // with no transport tag stay on the SDK parser; new app-server sessions
      // route to the new parser. No CURRENT_VERSION bump required.
      return new CodexRawParserDispatcher();
    }
    if (provider === 'openai-codex-acp') {
      return new CodexACPRawParser();
    }
    if (provider === 'opencode') {
      return new OpenCodeRawParser();
    }
    if (provider === 'openai-realtime') {
      return new VoiceRawParser();
    }
    return new ClaudeCodeRawParser();
  }

  // ---------------------------------------------------------------------------
  // Core transformation: parse messages -> process descriptors -> write events
  // ---------------------------------------------------------------------------

  private async transformMessages(
    sessionId: string,
    messages: RawMessage[],
    provider: string,
    isResume = false,
    writeStore?: ITranscriptEventStore,
  ): Promise<{ lastRawMessageId: number; eventsWritten: number }> {
    // `writeStore` lets `transformFromBeginning` stage events into an
    // in-memory store so the entire batch can be flushed in one
    // round-trip. When omitted we write straight to the real store.
    const targetStore = writeStore ?? this.transcriptStore;
    const writer = new TranscriptWriter(targetStore, provider);
    const parser = this.createParser(provider);
    // Suppress per-event notifications when staging — `transformFromBeginning`
    // refires onEventWritten with real persisted ids after the flush.
    const suppressNotify = writeStore != null;

    // When resuming from a prior batch, suppress result chunk text emission.
    // The result chunk always echoes the assistant text. If the assistant chunk
    // was processed in a prior batch, this fresh parser instance doesn't know
    // and would emit a duplicate assistant_message. Only slash-command-only
    // turns need result text, and those are always in the first batch.
    if (isResume && parser instanceof ClaudeCodeRawParser) {
      parser.setSuppressResultChunkText(true);
    }

    const startSequence = await targetStore.getNextSequence(sessionId);
    writer.seedSequence(startSequence);

    const toolEventIds = new Map<string, number>();
    const subagentEventIds = new Map<string, number>();
    let eventsWritten = 0;
    let lastRawMessageId = 0;

    const context: ParseContext = {
      sessionId,
      hasToolCall: (id: string) => toolEventIds.has(id),
      hasSubagent: (id: string) => subagentEventIds.has(id),
      findByProviderToolCallId: (id: string) =>
        targetStore.findByProviderToolCallId(id, sessionId),
      findActiveToolCallByRawProviderId: (rawId: string) =>
        targetStore.findActiveToolCallByRawProviderId(rawId, sessionId),
    };

    for (const msg of messages) {
      try {
        const descriptors = await parser.parseMessage(msg, context);
        stampUserMessageRawId(descriptors, msg.id);
        for (const desc of descriptors) {
          const event = suppressNotify
            ? await this.processDescriptor(writer, sessionId, desc, toolEventIds, subagentEventIds, targetStore)
            : await this.processDescriptorWithNotify(
                writer,
                sessionId,
                desc,
                toolEventIds,
                subagentEventIds,
              );
          if (event) eventsWritten++;
        }
      } catch {
        // Skip unparseable messages -- the raw log is preserved
      }

      lastRawMessageId = msg.id;
    }

    return { lastRawMessageId, eventsWritten };
  }

  // ---------------------------------------------------------------------------
  // Descriptor processing: maps descriptors to TranscriptWriter calls
  // ---------------------------------------------------------------------------

  /**
   * Process a descriptor, write the canonical event, update tracking maps,
   * and fire onEventWritten callback. Returns the written event (or null
   * for updates that don't produce a new row).
   */
  private async processDescriptorWithNotify(
    writer: TranscriptWriter,
    sessionId: string,
    desc: CanonicalEventDescriptor,
    toolEventIds: Map<string, number>,
    subagentEventIds: Map<string, number>,
  ): Promise<TranscriptEvent | null> {
    const event = await this.processDescriptor(writer, sessionId, desc, toolEventIds, subagentEventIds);
    if (event) {
      this.onEventWritten?.(event);
    }
    return event;
  }

  private processDescriptor(
    writer: TranscriptWriter,
    sessionId: string,
    desc: CanonicalEventDescriptor,
    toolEventIds: Map<string, number>,
    subagentEventIds: Map<string, number>,
    storeOverride?: ITranscriptEventStore,
  ): Promise<TranscriptEvent | null> {
    return processDescriptorShared(
      writer,
      storeOverride ?? this.transcriptStore,
      sessionId,
      desc,
      toolEventIds,
      subagentEventIds,
    );
  }

  // ---------------------------------------------------------------------------
  // Per-session concurrency control
  // ---------------------------------------------------------------------------

  private async withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.sessionLocks.get(sessionId);
    const ticket = (existing ?? Promise.resolve())
      .catch(() => {})
      .then(() => fn());
    this.sessionLocks.set(sessionId, ticket);
    try {
      return await ticket;
    } finally {
      if (this.sessionLocks.get(sessionId) === ticket) {
        this.sessionLocks.delete(sessionId);
      }
    }
  }
}
