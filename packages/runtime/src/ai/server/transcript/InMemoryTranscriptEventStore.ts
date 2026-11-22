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

const SYNTH_PREFIX = 'nimtc|';

export class InMemoryTranscriptEventStore implements ITranscriptEventStore {
  private events: TranscriptEvent[] = [];
  private nextId = 1;
  private sequenceBySession = new Map<string, number>();
  // Indexes that keep per-tool-call lookups O(1). A full transcript rebuild
  // does several lookups per tool call; scanning `events` for each one made
  // rebuilding a large session quadratic (GitHub #1581).
  private indexById = new Map<number, number>();
  // providerToolCallId -> event position(s), ascending. Keyed on the id string
  // the event already holds, and a lone position is stored unboxed, because
  // runtime stores stay cached per session. Synthetic `nimtc|<encoded raw>|...`
  // ids are also filed under the decoded raw id so both lookup forms hit.
  private positionsByToolCallId = new Map<string, number | number[]>();
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
    this.indexEvent(inserted, this.events.length - 1);
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
    const idx = this.indexById.get(id) ?? -1;
    if (idx >= 0) {
      this.events[idx] = { ...this.events[idx], payload };
    }
  }

  async mergeEventPayload(id: number, partialPayload: Record<string, unknown>): Promise<void> {
    const idx = this.indexById.get(id) ?? -1;
    if (idx >= 0) {
      this.events[idx] = {
        ...this.events[idx],
        payload: { ...this.events[idx].payload, ...partialPayload },
      };
      for (const alias of this.toolCallAliases(this.events[idx])) {
        if (!this.toolCallPositions(alias).includes(idx)) this.addToolCallPosition(alias, idx);
      }
    }
  }

  async updateEventText(id: number, searchableText: string): Promise<void> {
    const idx = this.indexById.get(id) ?? -1;
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
    const positions = this.toolCallPositions(providerToolCallId);
    for (let i = positions.length - 1; i >= 0; i--) {
      const event = this.events[positions[i]];
      if ((event.providerToolCallId === providerToolCallId || this.toolCallAliases(event).includes(providerToolCallId))
        && event.sessionId === sessionId) {
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
    const positions = this.toolCallPositions(rawProviderToolCallId);
    for (let i = positions.length - 1; i >= 0; i--) {
      const event = this.events[positions[i]];
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
    const idx = this.indexById.get(id);
    return idx === undefined ? null : this.events[idx];
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
    this.indexById.clear();
    this.positionsByToolCallId.clear();
    this.events.forEach((event, position) => this.indexEvent(event, position));
  }

  private indexEvent(event: TranscriptEvent, position: number): void {
    this.indexById.set(event.id, position);
    for (const alias of this.toolCallAliases(event)) this.addToolCallPosition(alias, position);
    const ptcid = event.providerToolCallId;
    if (!ptcid) return;
    this.addToolCallPosition(ptcid, position);
    if (ptcid.startsWith(SYNTH_PREFIX)) {
      const encodedRaw = ptcid.slice(SYNTH_PREFIX.length).split('|')[0];
      let raw: string;
      try {
        raw = decodeURIComponent(encodedRaw);
      } catch {
        return;
      }
      if (raw !== ptcid) this.addToolCallPosition(raw, position);
    }
  }

  private toolCallAliases(event: TranscriptEvent): string[] {
    const aliases = (event.payload as Record<string, unknown>).providerToolCallAliases;
    return Array.isArray(aliases) ? aliases.filter((id): id is string => typeof id === 'string') : [];
  }

  private addToolCallPosition(key: string, position: number): void {
    const existing = this.positionsByToolCallId.get(key);
    if (existing === undefined) this.positionsByToolCallId.set(key, position);
    else if (typeof existing === 'number') this.positionsByToolCallId.set(key, [existing, position]);
    else existing.push(position);
  }

  private toolCallPositions(providerToolCallId: string): readonly number[] {
    const positions = this.positionsByToolCallId.get(providerToolCallId);
    if (positions === undefined) return [];
    return typeof positions === 'number' ? [positions] : positions;
  }

  getAllEvents(): TranscriptEvent[] {
    return [...this.events].sort((a, b) => a.sequence - b.sequence);
  }
}
