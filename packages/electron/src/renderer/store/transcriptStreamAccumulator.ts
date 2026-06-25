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
 *    structural change) is applied as an in-place patch to the cached
 *    projected message: O(1) work per chunk.
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

interface SessionState {
  /** Live canonical events keyed by id for O(1) lookup. */
  eventsById: Map<number, TranscriptEvent>;
  /** Last published merged messages array (DB messages, then live messages). */
  currentMessages: TranscriptViewMessage[];
  /** Index of each event id in `currentMessages`, for O(1) in-place patches. */
  messageIndexById: Map<number, number>;
  /** True when a structural change requires a full re-projection on next flush. */
  needsRebuild: boolean;
  /** True when a flush is already scheduled. */
  flushScheduled: boolean;
  /** True when at least one apply() call has been made since the last flush. */
  dirty: boolean;
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
    const state = this.ensureSession(event.sessionId);
    const existing = state.eventsById.get(event.id);

    if (existing && this.canPatchInPlace(existing, event)) {
      // Fast path: text-only update on a known, structurally-stable event.
      // Patch the cached projected message and do not mark a rebuild.
      state.eventsById.set(event.id, event);
      const idx = state.messageIndexById.get(event.id);
      if (idx !== undefined && state.currentMessages[idx]?.id === event.id) {
        applyTextPatch(state.currentMessages[idx], event);
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

  // ---------------- Internals ----------------

  private ensureSession(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        eventsById: new Map(),
        currentMessages: [],
        messageIndexById: new Map(),
        needsRebuild: false,
        flushScheduled: false,
        dirty: false,
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

    if (state.needsRebuild || state.currentMessages.length === 0) {
      this.rebuild(sessionId, state);
      state.needsRebuild = false;
    }

    this.opts.emit({ sessionId, messages: state.currentMessages });
  }

  private rebuild(sessionId: string, state: SessionState): void {
    const events = Array.from(state.eventsById.values()).sort((a, b) => a.id - b.id);
    const liveViewModel = TranscriptProjector.project(events);
    const liveMessages = liveViewModel.messages;
    const dbMessages = this.opts.readDbMessages(sessionId);

    const hasLiveUserMessage = liveMessages.some((m) => m.type === 'user_message');

    // DB view-message ids and live event ids come from different id spaces
    // when the session loads as a partial raw tail (raw-anchored stabilized
    // ids vs in-memory event sequence ids), so the two sets must never be
    // ordered or deduped against each other by id. Instead: the live set
    // owns the transcript from its first event's timestamp onward, and DB
    // rows own everything strictly before. DB copies of live messages
    // (pulled in by reloads mid-turn) carry the same raw timestamps, so the
    // cut drops them in favor of the live versions.
    let liveStartMs = Infinity;
    for (const m of liveMessages) {
      const ms = toEpochMs(m.createdAt);
      if (Number.isFinite(ms) && ms < liveStartMs) liveStartMs = ms;
    }

    const merged: TranscriptViewMessage[] = [];
    for (const m of dbMessages) {
      // Drop optimistic messages (negative ids) once a real user_message
      // is in the live set -- the real version replaces the optimistic
      // copy we'd otherwise duplicate.
      if (m.id < 0) {
        if (!hasLiveUserMessage) merged.push(m);
        continue;
      }
      if (toEpochMs(m.createdAt) >= liveStartMs) continue;
      merged.push(m);
    }
    const liveOffset = merged.length;
    for (const m of liveMessages) merged.push(m);

    state.currentMessages = merged;
    // Index only the live span: in-place text patches target live event
    // ids, and a DB row whose id happens to collide numerically with a
    // live event id must never receive the patch.
    state.messageIndexById = new Map();
    for (let i = liveOffset; i < merged.length; i++) {
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

function toEpochMs(value: Date | string | number | null | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return new Date(value).getTime();
  return NaN;
}

/**
 * Update the projected message in-place to reflect the new event's text
 * and any payload metadata that the projector's per-event mapping would
 * have copied from the assistant_message payload.
 */
function applyTextPatch(message: TranscriptViewMessage, event: TranscriptEvent): void {
  message.text = event.searchableText ?? undefined;
  // mode/thinking/model are unchanged by definition of canPatchInPlace,
  // so we don't touch them here.
}
