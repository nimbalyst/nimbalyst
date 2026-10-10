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
 */

import type { PromptStreamController } from './sdkOptionsBuilder';

/** How long a follow-up waits for the draining turn to let go before falling back to a fresh query. */
export const DRAIN_HANDOFF_TIMEOUT_MS = 10_000;

export interface DrainAdoptionFacts {
  hasLeadQuery: boolean;
  draining: boolean;
  promptStreamOpen: boolean;
  hasRunningTasks: boolean;
  /** Tasks that already settled during the drain carry results only the drain's own continuation delivers. */
  terminalNotificationCount: number;
  settledThisTurn: boolean;
  graceExpired: boolean;
  wasInterrupted: boolean;
  hasPendingUserInteraction: boolean;
  hasTeammateWork: boolean;
  hasPendingContinuation: boolean;
  handoffInProgress: boolean;
}

/**
 * True only in the plain case: the lead answered, a background task is still
 * running, and nothing else is waiting on this turn. Anything else keeps the
 * existing drain behavior.
 */
export function canAdoptDrainingQuery(facts: DrainAdoptionFacts): boolean {
  return facts.hasLeadQuery
    && facts.draining
    && facts.promptStreamOpen
    && facts.hasRunningTasks
    && facts.terminalNotificationCount === 0
    && !facts.settledThisTurn
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
