/**
 * TranscriptRuntime -- the per-session in-memory home for canonical
 * transcript events.
 *
 * Phase 3 of the canonical-transcript-deprecation plan. The persisted
 * `ai_transcript_events` table is going away; the canonical-event pipeline
 * (`TranscriptTransformer` + parsers + `TranscriptWriter` + descriptor
 * processing) stays, but its output now lives in memory per-session for the
 * lifetime of an open session tab.
 *
 * Responsibilities:
 *
 * - Hold a per-session `InMemoryTranscriptEventStore` cache (MRU eviction,
 *   default cap N=16 sessions).
 * - Hold a per-session transform watermark (last raw message id processed)
 *   in memory only — no more `canonical_transform_*` columns on `ai_sessions`.
 * - Expose the same surface area `TranscriptMigrationService` used to expose
 *   so consumers (IPC handlers, MCP server, the renderer real-time channel)
 *   keep working unchanged.
 * - Fire `onEventWritten` callbacks during streaming so the renderer still
 *   updates in real time.
 *
 * See plan: `nimbalyst-local/plans/canonical-transcript-deprecation.md`.
 */

import { TranscriptTransformer, type IRawMessageStore, type ISessionMetadataStore, type OnCanonicalEventWritten } from './TranscriptTransformer';
import { TranscriptProjector, type TranscriptViewMessage } from './TranscriptProjector';
import { InMemoryTranscriptEventStore } from './InMemoryTranscriptEventStore';
import type {
  ITranscriptEventStore,
  TranscriptEvent,
  TranscriptEventType,
} from './types';

const DEFAULT_CACHE_CAP = 16;

export interface TranscriptRuntimeOptions {
  /** Maximum number of sessions held in the in-memory canonical cache. Default 16. */
  cacheCap?: number;
}

/**
 * In-memory implementation of the ISessionMetadataStore the transformer
 * consumes. Each session's transform watermark is reset whenever the
 * session is evicted from the cache, which is fine: the next access
 * rebuilds the canonical event list from the raw log.
 */
class InMemoryMetadataStore implements ISessionMetadataStore {
  private state = new Map<string, {
    transformVersion: number | null;
    lastRawMessageId: number | null;
    lastTransformedAt: Date | null;
    transformStatus: 'pending' | 'complete' | 'error' | null;
  }>();

  async getTransformStatus(sessionId: string) {
    const cur = this.state.get(sessionId);
    return cur ?? {
      transformVersion: null,
      lastRawMessageId: null,
      lastTransformedAt: null,
      transformStatus: null,
    };
  }

  async updateTransformStatus(sessionId: string, update: {
    transformVersion: number;
    lastRawMessageId: number;
    lastTransformedAt: Date;
    transformStatus: 'pending' | 'complete' | 'error';
  }) {
    this.state.set(sessionId, { ...update });
  }

  resetSession(sessionId: string): void {
    this.state.delete(sessionId);
  }
}

/**
 * Routing facade that implements ITranscriptEventStore but dispatches every
 * call to the per-session InMemoryTranscriptEventStore held by the runtime.
 * Sessions are looked up lazily; on first access for a session that isn't
 * in the cache, a fresh store is created and tracked for MRU eviction.
 */
class RoutingStore implements ITranscriptEventStore {
  // Globally unique id allocator shared across every per-session
  // InMemoryTranscriptEventStore created by this routing store. Without
  // this, each per-session store mints ids starting at 1, so event ids
  // collide across sessions and id-keyed updates (mergeEventPayload,
  // updateEventPayload, getEventById) silently land on the wrong session.
  private nextEventId = 1;

  constructor(
    private cache: Map<string, InMemoryTranscriptEventStore>,
    private touchMRU: (sessionId: string) => void,
    private ensureCap: () => void,
  ) {}

  private storeFor(sessionId: string): InMemoryTranscriptEventStore {
    let s = this.cache.get(sessionId);
    const isNew = !s;
    if (!s) {
      s = new InMemoryTranscriptEventStore(() => this.nextEventId++);
      this.cache.set(sessionId, s);
    }
    this.touchMRU(sessionId);
    if (isNew) {
      this.ensureCap();
    }
    return s;
  }

  /**
   * Cross-session lookups need a "best effort over what's in memory" path.
   * We only know about sessions currently in the MRU cache; lookups for
   * other sessions return null/empty. That matches the design: in-memory
   * runtime, queryable while live.
   */
  private allStores(): InMemoryTranscriptEventStore[] {
    return [...this.cache.values()];
  }

  insertEvent(event: Omit<TranscriptEvent, 'id'>): Promise<TranscriptEvent> {
    return this.storeFor(event.sessionId).insertEvent(event);
  }

  async insertEvents(events: Array<Omit<TranscriptEvent, 'id'>>): Promise<TranscriptEvent[]> {
    if (events.length === 0) return [];
    // Bulk-insert path used by transformFromBeginning. All events belong to
    // the same session (the transformer batch processes one session at a time).
    return this.storeFor(events[0].sessionId).insertEvents(events);
  }

  async updateEventPayload(id: number, payload: Record<string, unknown>): Promise<void> {
    for (const s of this.allStores()) {
      const event = await s.getEventById(id);
      if (event) {
        await s.updateEventPayload(id, payload);
        return;
      }
    }
  }

  async mergeEventPayload(id: number, partial: Record<string, unknown>): Promise<void> {
    for (const s of this.allStores()) {
      const event = await s.getEventById(id);
      if (event) {
        await s.mergeEventPayload(id, partial);
        return;
      }
    }
  }

  async updateEventText(id: number, searchableText: string): Promise<void> {
    for (const s of this.allStores()) {
      const event = await s.getEventById(id);
      if (event) {
        await s.updateEventText(id, searchableText);
        return;
      }
    }
  }

  getSessionEvents(
    sessionId: string,
    options?: { eventTypes?: TranscriptEventType[]; limit?: number; offset?: number; createdAfter?: Date; createdBefore?: Date },
  ): Promise<TranscriptEvent[]> {
    return this.storeFor(sessionId).getSessionEvents(sessionId, options);
  }

  getNextSequence(sessionId: string): Promise<number> {
    return this.storeFor(sessionId).getNextSequence(sessionId);
  }

  findByProviderToolCallId(providerToolCallId: string, sessionId: string): Promise<TranscriptEvent | null> {
    return this.storeFor(sessionId).findByProviderToolCallId(providerToolCallId, sessionId);
  }

  findActiveToolCallByRawProviderId(rawProviderToolCallId: string, sessionId: string): Promise<TranscriptEvent | null> {
    return this.storeFor(sessionId).findActiveToolCallByRawProviderId(rawProviderToolCallId, sessionId);
  }

  async getEventById(id: number): Promise<TranscriptEvent | null> {
    for (const s of this.allStores()) {
      const event = await s.getEventById(id);
      if (event) return event;
    }
    return null;
  }

  async getChildEvents(parentEventId: number): Promise<TranscriptEvent[]> {
    for (const s of this.allStores()) {
      const children = await s.getChildEvents(parentEventId);
      if (children.length > 0) return children;
    }
    return [];
  }

  getSubagentEvents(subagentId: string, sessionId: string): Promise<TranscriptEvent[]> {
    return this.storeFor(sessionId).getSubagentEvents(subagentId, sessionId);
  }

  async getMultiSessionEvents(
    sessionIds: string[],
    options?: { eventTypes?: TranscriptEventType[]; createdAfter?: Date; createdBefore?: Date },
  ): Promise<TranscriptEvent[]> {
    const out: TranscriptEvent[] = [];
    for (const sid of sessionIds) {
      const events = await this.storeFor(sid).getSessionEvents(sid, options);
      out.push(...events);
    }
    return out;
  }

  async searchSessions(): Promise<Array<{ event: TranscriptEvent; sessionId: string }>> {
    // Search is now served by FTS over ai_agent_messages.searchable_text
    // (Phase 2 of canonical-transcript-deprecation). This method is no
    // longer the search entry point.
    return [];
  }

  getTailEvents(
    sessionId: string,
    count: number,
    options?: { excludeEventTypes?: TranscriptEventType[] },
  ): Promise<TranscriptEvent[]> {
    return this.storeFor(sessionId).getTailEvents(sessionId, count, options);
  }

  async deleteSessionEvents(sessionId: string): Promise<void> {
    const s = this.cache.get(sessionId);
    if (s) await s.deleteSessionEvents(sessionId);
  }
}

export class TranscriptRuntime {
  private cache = new Map<string, InMemoryTranscriptEventStore>();
  private mru: string[] = [];
  private cacheCap: number;
  private metadataStore = new InMemoryMetadataStore();
  private routingStore: RoutingStore;
  private transformer: TranscriptTransformer;

  constructor(
    private rawStore: IRawMessageStore,
    options: TranscriptRuntimeOptions = {},
  ) {
    this.cacheCap = options.cacheCap ?? DEFAULT_CACHE_CAP;
    this.routingStore = new RoutingStore(
      this.cache,
      (sessionId) => this.touchMRU(sessionId),
      () => this.ensureCap(),
    );
    this.transformer = new TranscriptTransformer(rawStore, this.routingStore, this.metadataStore);
  }

  setOnEventWritten(cb: OnCanonicalEventWritten): void {
    this.transformer.setOnEventWritten(cb);
  }

  // ---------------------------------------------------------------------------
  // Public API (matches the legacy TranscriptMigrationService surface)
  // ---------------------------------------------------------------------------

  async getCanonicalEvents(
    sessionId: string,
    provider: string,
    options?: { eventTypes?: TranscriptEventType[]; limit?: number; offset?: number },
  ): Promise<TranscriptEvent[]> {
    await this.transformer.ensureUpToDate(sessionId, provider);
    return this.routingStore.getSessionEvents(sessionId, options);
  }

  async getViewMessages(sessionId: string, provider: string): Promise<TranscriptViewMessage[]> {
    const events = await this.getCanonicalEvents(sessionId, provider);
    const viewModel = TranscriptProjector.project(events);
    return viewModel.messages;
  }

  async ensureTransformed(sessionId: string, provider: string): Promise<void> {
    await this.transformer.ensureUpToDate(sessionId, provider);
  }

  async processNewMessages(sessionId: string, provider: string): Promise<TranscriptEvent[]> {
    return this.transformer.processNewMessages(sessionId, provider);
  }

  async getTailEvents(
    sessionId: string,
    provider: string,
    count: number,
    options?: { excludeEventTypes?: TranscriptEventType[] },
  ): Promise<TranscriptEvent[]> {
    await this.transformer.ensureUpToDate(sessionId, provider);
    return this.routingStore.getTailEvents(sessionId, count, options);
  }

  /**
   * Backwards-compatible probe; the in-memory cache is always rebuildable on
   * demand, so we return false (no migration needed) for any session that's
   * been seen, true otherwise. Kept so existing callers don't change.
   */
  async needsTransformation(sessionId: string): Promise<boolean> {
    return !this.cache.has(sessionId);
  }

  /**
   * Evict the session from the in-memory cache so the next read rebuilds
   * from the raw log. Replaces the previous "drop ai_transcript_events
   * rows" implementation now that canonical events live only in memory.
   */
  async forceReparseSession(sessionId: string, _provider: string): Promise<boolean> {
    this.evict(sessionId);
    return true;
  }

  /**
   * Look up the canonical tool-call event for a provider tool-call id within
   * a specific session. Used by ToolCallMatcher to enrich diff results with
   * the saved canonical payload (description, MCP labels, etc.). Returns
   * null when the session isn't cached or no matching event exists.
   */
  async findToolCallByProviderId(
    sessionId: string,
    providerToolCallId: string,
    provider: string,
  ): Promise<TranscriptEvent | null> {
    await this.transformer.ensureUpToDate(sessionId, provider);
    return this.routingStore.findByProviderToolCallId(providerToolCallId, sessionId);
  }

  /**
   * @deprecated Kept so existing callers don't need to change. The
   * transformer treats every session uniformly now.
   */
  async markSessionAsLive(_sessionId: string): Promise<void> {
    // no-op
  }

  // ---------------------------------------------------------------------------
  // MRU cache management
  // ---------------------------------------------------------------------------

  private touchMRU(sessionId: string): void {
    const i = this.mru.indexOf(sessionId);
    if (i >= 0) this.mru.splice(i, 1);
    this.mru.push(sessionId);
  }

  private ensureCap(): void {
    while (this.mru.length > this.cacheCap) {
      const stale = this.mru.shift();
      if (stale != null) {
        this.evict(stale);
      }
    }
  }

  private evict(sessionId: string): void {
    this.cache.delete(sessionId);
    this.metadataStore.resetSession(sessionId);
    const i = this.mru.indexOf(sessionId);
    if (i >= 0) this.mru.splice(i, 1);
  }
}
