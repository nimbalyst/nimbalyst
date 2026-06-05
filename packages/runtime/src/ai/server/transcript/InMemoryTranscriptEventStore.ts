/**
 * InMemoryTranscriptEventStore -- non-persistent ITranscriptEventStore used by
 * client-side transcript projection (iOS/Android WKWebView bundles).
 *
 * Mobile clients receive raw ai_agent_messages via sync but do not have the
 * canonical ai_transcript_events table. This store backs a one-shot
 * projection: parse raw messages, accumulate canonical events in memory,
 * hand them to TranscriptProjector for rendering.
 *
 * Only implements the methods exercised by TranscriptWriter +
 * processDescriptor. Query methods used by server-side code (search, tail,
 * multi-session, child/subagent lookups, deletes) throw if called.
 */

import type {
  ITranscriptEventStore,
  TranscriptEvent,
  TranscriptEventType,
} from './types';

export class InMemoryTranscriptEventStore implements ITranscriptEventStore {
  private events: TranscriptEvent[] = [];
  private nextId = 1;
  private sequenceBySession = new Map<string, number>();
  // Optional external id allocator. When RoutingStore (TranscriptRuntime)
  // holds per-session stores, multiple stores would otherwise mint id=1, 2,
  // ... in parallel, so cross-store lookups by id (getEventById, mergeEventPayload)
  // can return the wrong session's event. Sharing a single allocator across
  // every per-session store makes ids globally unique within the runtime.
  private idAllocator: (() => number) | null;

  constructor(idAllocator?: () => number) {
    this.idAllocator = idAllocator ?? null;
  }

  async insertEvent(event: Omit<TranscriptEvent, 'id'>): Promise<TranscriptEvent> {
    const id = this.idAllocator ? this.idAllocator() : this.nextId++;
    const inserted: TranscriptEvent = { ...event, id };
    this.events.push(inserted);
    const current = this.sequenceBySession.get(event.sessionId) ?? 0;
    if (event.sequence >= current) {
      this.sequenceBySession.set(event.sessionId, event.sequence + 1);
    }
    return inserted;
  }

  async insertEvents(
    events: Array<Omit<TranscriptEvent, 'id'>>,
  ): Promise<TranscriptEvent[]> {
    const inserted: TranscriptEvent[] = [];
    for (const event of events) inserted.push(await this.insertEvent(event));
    return inserted;
  }

  async updateEventPayload(id: number, payload: Record<string, unknown>): Promise<void> {
    const idx = this.events.findIndex(e => e.id === id);
    if (idx >= 0) {
      this.events[idx] = { ...this.events[idx], payload };
    }
  }

  async mergeEventPayload(id: number, partialPayload: Record<string, unknown>): Promise<void> {
    const idx = this.events.findIndex(e => e.id === id);
    if (idx >= 0) {
      this.events[idx] = {
        ...this.events[idx],
        payload: { ...this.events[idx].payload, ...partialPayload },
      };
    }
  }

  async updateEventText(id: number, searchableText: string): Promise<void> {
    const idx = this.events.findIndex(e => e.id === id);
    if (idx >= 0) {
      this.events[idx] = { ...this.events[idx], searchableText };
    }
  }

  async getSessionEvents(
    sessionId: string,
    options?: { eventTypes?: TranscriptEventType[]; limit?: number; offset?: number },
  ): Promise<TranscriptEvent[]> {
    let filtered = this.events.filter(e => e.sessionId === sessionId);
    if (options?.eventTypes && options.eventTypes.length > 0) {
      const types = new Set(options.eventTypes);
      filtered = filtered.filter(e => types.has(e.eventType));
    }
    filtered.sort((a, b) => a.sequence - b.sequence);
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? filtered.length;
    return filtered.slice(offset, offset + limit);
  }

  async getNextSequence(sessionId: string): Promise<number> {
    return this.sequenceBySession.get(sessionId) ?? 0;
  }

  async findByProviderToolCallId(
    providerToolCallId: string,
    sessionId: string,
  ): Promise<TranscriptEvent | null> {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const event = this.events[i];
      if (
        event.providerToolCallId === providerToolCallId &&
        event.sessionId === sessionId
      ) {
        return event;
      }
    }
    return null;
  }

  async findActiveToolCallByRawProviderId(
    rawProviderToolCallId: string,
    sessionId: string,
  ): Promise<TranscriptEvent | null> {
    const synthPrefix = `nimtc|${encodeURIComponent(rawProviderToolCallId)}|`;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const event = this.events[i];
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
  }

  async getEventById(id: number): Promise<TranscriptEvent | null> {
    return this.events.find(e => e.id === id) ?? null;
  }

  async getChildEvents(parentEventId: number): Promise<TranscriptEvent[]> {
    return this.events
      .filter(e => e.parentEventId === parentEventId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  async getSubagentEvents(subagentId: string, sessionId: string): Promise<TranscriptEvent[]> {
    return this.events
      .filter(e => e.sessionId === sessionId && e.subagentId === subagentId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  async getMultiSessionEvents(): Promise<TranscriptEvent[]> {
    throw new Error('InMemoryTranscriptEventStore: getMultiSessionEvents not supported');
  }

  async searchSessions(): Promise<Array<{ event: TranscriptEvent; sessionId: string }>> {
    throw new Error('InMemoryTranscriptEventStore: searchSessions not supported');
  }

  async getTailEvents(
    sessionId: string,
    count: number,
    options?: { excludeEventTypes?: TranscriptEventType[] },
  ): Promise<TranscriptEvent[]> {
    let filtered = this.events.filter(e => e.sessionId === sessionId);
    if (options?.excludeEventTypes && options.excludeEventTypes.length > 0) {
      const excluded = new Set(options.excludeEventTypes);
      filtered = filtered.filter(e => !excluded.has(e.eventType));
    }
    filtered.sort((a, b) => a.sequence - b.sequence);
    return filtered.slice(-count);
  }

  async deleteSessionEvents(sessionId: string): Promise<void> {
    this.events = this.events.filter(e => e.sessionId !== sessionId);
    this.sequenceBySession.delete(sessionId);
  }

  getAllEvents(): TranscriptEvent[] {
    return [...this.events].sort((a, b) => a.sequence - b.sequence);
  }
}
