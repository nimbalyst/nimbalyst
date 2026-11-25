/**
 * Handing a draining turn's live query to the next turn.
 *
 * When a lead turn finishes while a backgrounded shell or sub-agent is still
 * running, the turn keeps draining so the task's result is not lost. A
 * follow-up prompt used to have to wait for that drain (up to 30 minutes for
 * a shell), or abort it, which kills the task with the process. The CLI
 * accepts a new user turn on the same stdin while background tasks keep
 * running (verified against Agent SDK 0.3.284), so the follow-up turn adopts
 * the live query instead: the draining turn stops iterating without closing
 * anything and hands over its iterator, any in-flight `next()`, the prompt
 * stream, and the abort controller the process was spawned with.
 *
 * Once a task has settled, the CLI starts a turn of its own to answer the
 * task notification, and a message pushed meanwhile is folded into that turn
 * or runs after it (verified against Agent SDK 0.3.314). So a follow-up that
 * adopts after a settle is pushed with a uuid, and its turn starts at the
 * first frame the CLI stamps as answering it (`answersPushedMessage`).
 *
 * When the last task settles, its result goes back into the same live CLI as
 * a wake that adopts the query (a live wake), instead of closing the process
 * and resuming it cold: closing it cut off the CLI's own turn mid-way, and the
 * resumed CLI filled that turn in with "No response requested.".
 */

import type { PromptStreamController } from './sdkOptionsBuilder';

/** How long a follow-up waits for the draining turn to let go before falling back to a fresh query. */
export const DRAIN_HANDOFF_TIMEOUT_MS = 10_000;

/** How long the drain keeps the query open for a live wake before ending the old way (close, then a cold resume). */
export const LIVE_WAKE_TIMEOUT_MS = 60_000;

/**
 * How long a wake turn waits for the CLI to start its own turn about the settled
 * results before sending the wake itself. The CLI starts that turn right after
 * `result`; silence means it had taken the results in after all.
 */
export const CLI_TURN_START_MS = 15_000;

/**
 * True for a frame that belongs to a CLI turn. Other frames can still trail the
 * previous turn's `result` (a prompt suggestion, an older CLI's duplicate task
 * notification) and do not show that the CLI started one.
 */
export function startsCliTurn(chunk: unknown): boolean {
  if (!chunk || typeof chunk !== 'object') return false;
  const frame = chunk as { type?: unknown; subtype?: unknown };
  if (frame.type === 'system') return frame.subtype === 'init';
  return frame.type === 'assistant' || frame.type === 'user' || frame.type === 'stream_event' || frame.type === 'result';
}

/**
 * Stands in for the next chunk while a draining turn waits behind its live wake
 * without reading. Rejects with an AbortError when the turn is aborted (a turn
 * that could not adopt the query replaced it), so the turn ends the way a read
 * would have ended it.
 */
export function parkedUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    const abort = (): void => {
      const error = new Error('The draining turn was aborted while waiting for its live wake');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

export interface DrainAdoptionFacts {
  hasLeadQuery: boolean;
  draining: boolean;
  promptStreamOpen: boolean;
  hasRunningTasks: boolean;
  /** The last task settled and the wake carrying its result is on its way to take this query. */
  liveWakePending: boolean;
  graceExpired: boolean;
  wasInterrupted: boolean;
  hasPendingUserInteraction: boolean;
  hasTeammateWork: boolean;
  hasPendingContinuation: boolean;
  handoffInProgress: boolean;
}

/**
 * True when the lead answered, a background task is still running or the live
 * wake for the last one is due, and nothing else is waiting on this turn.
 * Tasks that already settled do not block it: the live CLI holds their
 * notifications, and the follow-up binds past the CLI's own turn about them.
 * Anything else keeps the existing drain behavior.
 */
export function canAdoptDrainingQuery(facts: DrainAdoptionFacts): boolean {
  return facts.hasLeadQuery
    && facts.draining
    && facts.promptStreamOpen
    && (facts.hasRunningTasks || facts.liveWakePending)
    && !facts.graceExpired
    && !facts.wasInterrupted
    && !facts.hasPendingUserInteraction
    && !facts.hasTeammateWork
    && !facts.hasPendingContinuation
    && !facts.handoffInProgress;
}

export interface AdoptedQuery<Q, H> {
  query: Q;
  iterator: AsyncIterator<unknown>;
  /** A `next()` the draining loop had in flight; its chunk belongs to the adopting turn. */
  pendingNext: Promise<IteratorResult<unknown>> | null;
  promptController: PromptStreamController;
  abortController: AbortController | null;
  /** The hooks the live process was spawned with are bound to this instance. */
  toolHooksService: H;
  /**
   * A task settled during the drain, so the CLI may be running its own turn
   * about it when the follow-up lands. The follow-up is pushed with a uuid and
   * its turn starts at the first frame stamped with it.
   */
  bindToOwnTurn: boolean;
}

/**
 * True for a frame the CLI stamps as answering the pushed message `uuid`: the
 * first top-level assistant frame of its turn, the first one after it was
 * folded into a running turn, or that turn's result (SDK `user_message_uuid`
 * and `user_message_uuids`).
 */
export function answersPushedMessage(chunk: unknown, uuid: string): boolean {
  if (!chunk || typeof chunk !== 'object') return false;
  const frame = chunk as { type?: unknown; parent_tool_use_id?: unknown; user_message_uuid?: unknown; user_message_uuids?: unknown };
  if (frame.type !== 'assistant' && frame.type !== 'result') return false;
  if (frame.type === 'assistant' && frame.parent_tool_use_id) return false;
  if (frame.user_message_uuid === uuid) return true;
  return Array.isArray(frame.user_message_uuids) && frame.user_message_uuids.includes(uuid);
}

export class DrainHandoff<Q, H> {
  cancelled = false;
  /** Set by the draining loop when it stops iterating. */
  carry: { iterator: AsyncIterator<unknown>; pendingNext: Promise<IteratorResult<unknown>> | null } | null = null;
  readonly adopted: Promise<AdoptedQuery<Q, H>>;
  private resolveAdopted!: (query: AdoptedQuery<Q, H>) => void;

  constructor() {
    this.adopted = new Promise((resolve) => { this.resolveAdopted = resolve; });
  }

  release(query: AdoptedQuery<Q, H>): void {
    this.resolveAdopted(query);
  }
}

/** Resolves with the adopted query, or null if the draining turn did not let go in time. */
export async function awaitDrainHandoff<Q, H>(
  handoff: DrainHandoff<Q, H>,
  timeoutMs: number = DRAIN_HANDOFF_TIMEOUT_MS,
): Promise<AdoptedQuery<Q, H> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  try {
    const adopted = await Promise.race([handoff.adopted, timedOut]);
    if (!adopted) handoff.cancelled = true;
    return adopted;
  } finally {
    clearTimeout(timer);
  }
}
