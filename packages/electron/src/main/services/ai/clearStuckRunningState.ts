/**
 * Escape hatch for the send-now lightning bolt against a zombie session.
 *
 * A session can be left reporting `running` / `isStreaming` with no turn
 * behind it (transport closed, abort raced the stream teardown, ...). In that
 * state the lightning bolt was a permanent no-op: the provider's interrupt
 * found nothing to interrupt, the queue drive deferred on `session-busy`, and
 * the wake it armed (`session:completed` / `session:interrupted`) could never
 * fire because no turn existed to end. The queued prompt was stranded forever
 * while the safety sweep re-deferred every 60s (NIM-2434).
 *
 * So when the interrupt cannot have left a turn behind, force the live state
 * idle. That emits `session:interrupted`, which both unwedges the drive and
 * drops the renderer out of its fake "running". Two cases qualify:
 *
 *  - The provider positively reports it had no active turn.
 *  - The interrupt resolved to the hard-abort fallback, which destroys the turn
 *    outright rather than letting it wind down — no terminal event is coming,
 *    whether or not a turn was live. Codex takes this path (it has no graceful
 *    interrupt), so before this every send-now against a running Codex session
 *    stranded its own prompt behind `session-busy` forever. Cancel already
 *    applies the same policy after `provider.abort()`.
 *
 * A graceful `interrupt` is the case that must NOT be forced: that turn is
 * still winding down and will emit its own terminal transition.
 *
 * Pure module (state manager injected) so the decision is testable without a
 * main process.
 */

interface LiveSessionState {
  status: string;
  isStreaming: boolean;
}

export interface StuckRunningStateDeps {
  getSessionState(sessionId: string): LiveSessionState | null;
  interruptSession(sessionId: string): Promise<void>;
  logWarn(message: string): void;
}

/**
 * @param hadActiveTurn What the provider's interrupt reported. `undefined`
 *   means the provider can't tell, which is NOT permission to force idle.
 * @param method How the provider interrupted. `'abort'` is the hard fallback:
 *   the turn is gone by definition, so nothing will report its end.
 * @returns whether the session was forced idle.
 */
export async function clearStuckRunningState(
  deps: StuckRunningStateDeps,
  {
    sessionId,
    hadActiveTurn,
    method,
  }: { sessionId: string; hadActiveTurn: boolean | undefined; method?: 'interrupt' | 'abort' },
): Promise<boolean> {
  if (hadActiveTurn !== false && method !== 'abort') {
    return false;
  }

  const liveState = deps.getSessionState(sessionId);
  if (!liveState || (liveState.status !== 'running' && !liveState.isStreaming)) {
    return false;
  }

  deps.logWarn(
    `[AIService] interruptCurrentTurn: session ${sessionId} reports ${liveState.status}${liveState.isStreaming ? '/streaming' : ''} but ${
      method === 'abort' ? 'the turn was hard-aborted' : 'the provider had no active turn'
    }; forcing it idle so queued prompts can dispatch`,
  );
  await deps.interruptSession(sessionId);
  return true;
}
