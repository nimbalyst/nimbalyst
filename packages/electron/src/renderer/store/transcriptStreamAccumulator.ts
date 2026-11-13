/**
 * TranscriptStreamAccumulator
 *
 * Coalesces high-frequency `transcript:event` IPC updates from the main
 * process into at most one atom write per frame per session. Replaces the
 * inlined per-chunk full-projection loop in `sessionStateListeners.ts` that
 * caused renderer JS heap exhaustion on long Claude Code streaming turns
 * (NIM-411).
 *
 * Semantics
 *  - Each chunk that lands as a "pure text update" (same event id, no
 *    structural change) replaces just that projected message with a copy
 *    carrying the new text; the array is copied once per frame, not per chunk.
 *  - Any structural change (new event id, payload thinking/model added,
 *    eventType/parent/subagent change) marks the session for a full
 *    re-projection on the next flush.
 *  - All updates are flushed at most once per scheduler tick (typically
 *    rAF), so the renderer re-renders the transcript at most ~60 Hz no
 *    matter how many tokens stream in.
 *
 * The class is deliberately framework-free: no React, no Jotai imports.
 * The renderer wires it up by passing `emit` (writes to the session
 * atom), `readDbMessages` (reads the session atom's current messages),
 * and `schedule` (`requestAnimationFrame`). Tests pass a manual scheduler.
 */

import { TranscriptProjector } from '@nimbalyst/runtime/ai/server/transcript/TranscriptProjector';
import { latestTranscriptGeneration, preserveTranscriptMessageIdentity, reconcileTranscriptMessages } from './transcriptReconciliation';
import type {
  TranscriptViewMessage,
} from '@nimbalyst/runtime/ai/server/transcript/TranscriptProjector';
import type {
  AssistantMessagePayload,
  TranscriptEvent,
} from '@nimbalyst/runtime/ai/server/transcript/types';

export interface AccumulatorOutput {
  sessionId: string;
  messages: TranscriptViewMessage[];
}

export type Scheduler = (cb: () => void) => void;

/**
 * Longest a rebuild may stay held behind a complete older snapshot when no
 * reload lands. Past it the rebuild is published as it stands. A 21k-row
 * replay took about 30 s to rebuild under load.
 */
export const TRANSCRIPT_REBUILD_HOLD_LIMIT_MS = 60_000;

interface SessionState {
  transcriptGeneration?: number;
  /** The atom array last seen; differs from our own publication only on snapshot loads. */
  observedSnapshot?: TranscriptViewMessage[];
  /** Newest generation among the rows in the atom. */
  snapshotGeneration?: number;
  /** Canonical rows in the atom. */
  snapshotCanonicalCount: number;
  /** Messages projected from the live events at the last rebuild. */
  liveMessageCount: number;
  /** Canonical rows in `currentMessages`. */
  currentCanonicalCount: number;
  /** When the current hold began (see isRebuildingBehindSnapshot). */
  holdStartedAt?: number;
  /** Generation a reload was last requested for. */
  snapshotRequestedFor?: number;
  /** Live canonical events keyed by id for O(1) lookup. */
  eventsById: Map<number, TranscriptEvent>;
  /** Last published merged messages array (DB messages + live messages, sorted by sequence). */
  currentMessages: TranscriptViewMessage[];
  /** Index of each event id in `currentMessages`, for O(1) text patches. */
  messageIndexById: Map<number, number>;
  /** True when a structural change requires a full re-projection on next flush. */
  needsRebuild: boolean;
  /** True when a flush is already scheduled. */
  flushScheduled: boolean;
  /** True when at least one apply() call has been made since the last flush. */
  dirty: boolean;
  /** `currentMessages` was already copied for this frame's text patches. */
  patchedSinceFlush: boolean;
}

export interface AccumulatorOptions {
  /** Called once per flush to publish the new merged messages list. */
  emit: (output: AccumulatorOutput) => void;
  /**
   * Returns the current DB-loaded messages for the session. Called only
   * during full rebuilds. Implementations should return a stable snapshot;
   * the accumulator does not mutate it.
   */
  readDbMessages: (sessionId: string) => TranscriptViewMessage[];
  /**
   * Defer a callback. In the renderer this is `requestAnimationFrame`;
   * tests pass a manual queue.
   */
  schedule: Scheduler;
  /**
   * Whether this window holds (or is loading) the session's data. Main sends
   * every session's events to every window; events for a session this window
   * has not loaded are dropped instead of retained. Its later load reads the
   * persisted transcript, and later events re-enter here.
   */
  isSessionTracked?: (sessionId: string) => boolean;
  /**
   * Reload the session's snapshot into the atom. Called once when a rebuild
   * starts being held, since some writers (external CLI ingest, rows written
   * while the agent is blocked) send no reload of their own.
   */
  requestSnapshot?: (sessionId: string) => void;
  /** Clock for the hold limit. Defaults to `performance.now`. */
  now?: () => number;
}

export class TranscriptStreamAccumulator {
  private sessions = new Map<string, SessionState>();

  constructor(private readonly opts: AccumulatorOptions) {}

  /**
   * Apply a canonical event update. Decides whether the change can be a
   * cheap in-place patch or requires a full re-projection on next flush,
   * then schedules a flush if one is not already pending.
   */
  apply(event: TranscriptEvent): void {
    if (this.opts.isSessionTracked && !this.opts.isSessionTracked(event.sessionId)) {
      this.sessions.delete(event.sessionId);
      return;
    }
    const state = this.ensureSession(event.sessionId);
    // A snapshot can replace the atom while older callbacks are still queued.
    this.observeSnapshot(event.sessionId, state);
    const eventGeneration = latestTranscriptGeneration([event]);
    if (state.transcriptGeneration !== undefined &&
        (eventGeneration === undefined || eventGeneration < state.transcriptGeneration)) return;
    this.acceptGeneration(state, eventGeneration);
    const existing = state.eventsById.get(event.id);

    if (existing && this.canPatchInPlace(existing, event)) {
      // Fast path: text-only update on a known, structurally-stable event.
      // Patch the cached projected message and do not mark a rebuild.
      state.eventsById.set(event.id, event);
      const idx = state.messageIndexById.get(event.id);
      if (idx !== undefined && state.currentMessages[idx]?.id === event.id) {
        // Replace, don't mutate: transcript rows are memoized on message
        // identity, and the published array must change for the atom to fire.
        if (!state.patchedSinceFlush) {
          state.currentMessages = state.currentMessages.slice();
          state.patchedSinceFlush = true;
        }
        state.currentMessages[idx] = withPatchedText(state.currentMessages[idx], event);
      } else {
        // The event id is known to the accumulator but isn't represented
        // as a 1:1 view message -- e.g. the projector fused two adjacent
        // assistant messages into one. Fall back to a full rebuild so the
        // visible message stays correct.
        state.needsRebuild = true;
      }
    } else {
      // Slow path: new event or structural change. Mark for rebuild.
      state.eventsById.set(event.id, event);
      state.needsRebuild = true;
    }

    state.dirty = true;
    this.scheduleFlush(event.sessionId, state);
  }

  /** Release per-session memory when a session is unloaded. */
  unload(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Drop everything (parity with the previous `liveCanonicalEvents.clear()`). */
  clear(): void {
    this.sessions.clear();
  }

  // ---------------- Test seam ----------------
  /**
   * For tests: reveal whether a flush is currently scheduled. Lets the
   * test assert "no extra flushes were created" between simulated frames.
   */
  hasPendingFlush(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.flushScheduled ?? false;
  }

  /** For tests: how many live events are held for a session. */
  retainedEventCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.eventsById.size ?? 0;
  }

  // ---------------- Internals ----------------

  private ensureSession(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        eventsById: new Map(),
        snapshotCanonicalCount: 0,
        liveMessageCount: 0,
        currentCanonicalCount: 0,
        currentMessages: [],
        messageIndexById: new Map(),
        needsRebuild: false,
        flushScheduled: false,
        dirty: false,
        patchedSinceFlush: false,
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private scheduleFlush(sessionId: string, state: SessionState): void {
    if (state.flushScheduled) return;
    state.flushScheduled = true;
    this.opts.schedule(() => this.flush(sessionId));
  }

  private flush(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.flushScheduled = false;
    if (!state.dirty) return;
    state.dirty = false;
    state.patchedSinceFlush = false;
    this.observeSnapshot(sessionId, state);

    if (state.needsRebuild || state.currentMessages.length === 0) {
      this.rebuild(sessionId, state);
      state.needsRebuild = false;
    }

    if (this.isRebuildingBehindSnapshot(state)) {
      const now = this.opts.now?.() ?? performance.now();
      state.holdStartedAt ??= now;
      if (state.snapshotRequestedFor !== state.transcriptGeneration) {
        state.snapshotRequestedFor = state.transcriptGeneration;
        this.opts.requestSnapshot?.(sessionId);
      }
      if (now - state.holdStartedAt < TRANSCRIPT_REBUILD_HOLD_LIMIT_MS) {
        // Check again next frame: the reload replaces the atom without an event.
        state.dirty = true;
        this.scheduleFlush(sessionId, state);
        return;
      }
    }
    state.holdStartedAt = undefined;

    // An unchanged rebuild returns the atom's own array; publishing it would
    // still replace the session object and re-render every subscriber.
    if (this.opts.readDbMessages(sessionId) === state.currentMessages) return;
    this.opts.emit({ sessionId, messages: state.currentMessages });
    // The atom normally holds this exact array after our synchronous emit.
    // Do not treat our own publication as a new external snapshot next frame.
    // If an observer replaced it meanwhile, let observeSnapshot inspect that.
    if (this.opts.readDbMessages(sessionId) === state.currentMessages) {
      state.observedSnapshot = state.currentMessages;
      state.snapshotGeneration = state.transcriptGeneration;
      state.snapshotCanonicalCount = state.currentCanonicalCount;
    }
  }

  private observeSnapshot(sessionId: string, state: SessionState): TranscriptViewMessage[] {
    const snapshot = this.opts.readDbMessages(sessionId);
    if (snapshot !== state.observedSnapshot) {
      state.observedSnapshot = snapshot;
      state.snapshotGeneration = latestTranscriptGeneration(snapshot);
      state.snapshotCanonicalCount = countCanonical(snapshot);
      this.acceptGeneration(state, state.snapshotGeneration);
      state.needsRebuild = true;
    }
    return snapshot;
  }

  /**
   * Main evicts a session from its transcript cache under multi-session load,
   * and the next logged row rebuilds it from the first raw row in a new
   * generation, streaming the events a page at a time (#919). Publishing that
   * rebuild would collapse a complete transcript to its first pages and grow
   * it back over many frames, remounting every row. Keep the complete older
   * snapshot on screen until the rebuild has as many messages, or until a
   * reload brings the new generation. The count is only a shortcut: the screen
   * can show more messages than the rebuild ever will (subagent children that
   * streamed in without their parent sit at top level), so the hold also asks
   * for a reload, and gives up after TRANSCRIPT_REBUILD_HOLD_LIMIT_MS.
   */
  private isRebuildingBehindSnapshot(state: SessionState): boolean {
    return state.snapshotGeneration !== undefined &&
      state.transcriptGeneration !== undefined &&
      state.snapshotGeneration < state.transcriptGeneration &&
      state.liveMessageCount < state.snapshotCanonicalCount;
  }

  private acceptGeneration(state: SessionState, generation: number | undefined): void {
    if (generation === undefined || generation <= (state.transcriptGeneration ?? 0)) return;
    state.transcriptGeneration = generation;
    state.eventsById.clear();
    state.currentMessages = [];
    state.messageIndexById.clear();
    state.needsRebuild = true;
  }

  private rebuild(sessionId: string, state: SessionState): void {
    const dbMessages = this.observeSnapshot(sessionId, state);
    const events = Array.from(state.eventsById.values()).sort((a, b) => a.sequence - b.sequence || a.id - b.id);
    const liveMessages = TranscriptProjector.project(events).messages;
    state.liveMessageCount = liveMessages.length;
    // Filter even when the current generation has no live events yet: a late
    // snapshot must never resurrect the retired generation in the atom.
    const current = dbMessages.filter(message => message.id < 0 ||
      state.transcriptGeneration === undefined || message.transcriptGeneration === state.transcriptGeneration);
    const merged = reconcileTranscriptMessages(current, liveMessages, { stream: true });
    // Compare against the atom, not our last emission: a reload may have
    // inserted the same rows since, and those are the objects on screen.
    state.currentMessages = preserveTranscriptMessageIdentity(dbMessages, merged);
    state.currentCanonicalCount = countCanonical(merged);
    state.messageIndexById = new Map();
    for (let i = 0; i < merged.length; i++) {
      state.messageIndexById.set(merged[i].id, i);
    }
  }

  /**
   * Decide whether `next` is a pure text/payload-metadata update for an
   * existing assistant_message. The TranscriptWriter only coalesces
   * streaming chunks for assistant_messages with no extras (no thinking,
   * no model, no subagent), so the fast path is intentionally narrow:
   * any change in the structural fields below disqualifies a patch.
   */
  private canPatchInPlace(existing: TranscriptEvent, next: TranscriptEvent): boolean {
    if (existing.eventType !== 'assistant_message') return false;
    if (next.eventType !== 'assistant_message') return false;
    if (existing.subagentId !== next.subagentId) return false;
    if (existing.parentEventId !== next.parentEventId) return false;

    // Disallow patch when the payload gains/loses fields that affect the
    // projected view-message's identity (thinking/model). These changes
    // demand a re-projection because the projector's adjacent-coalescing
    // rules treat thinking-bearing messages as their own UI block.
    const ep = (existing.payload ?? {}) as unknown as AssistantMessagePayload;
    const np = (next.payload ?? {}) as unknown as AssistantMessagePayload;
    if ((ep.thinking ?? null) !== (np.thinking ?? null)) return false;
    if ((ep.model ?? null) !== (np.model ?? null)) return false;
    if ((ep.mode ?? null) !== (np.mode ?? null)) return false;

    return true;
  }
}

/** Messages main projected from canonical events, as opposed to optimistic local input. */
function countCanonical(messages: readonly TranscriptViewMessage[]): number {
  let count = 0;
  for (const message of messages) if (message.id >= 0) count++;
  return count;
}

/**
 * A copy of the projected message carrying the new event's text. The other
 * payload fields are unchanged by definition of canPatchInPlace.
 */
function withPatchedText(message: TranscriptViewMessage, event: TranscriptEvent): TranscriptViewMessage {
  return { ...message, text: event.searchableText ?? undefined };
}
