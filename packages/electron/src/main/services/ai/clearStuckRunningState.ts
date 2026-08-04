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
 * So when — and only when — the provider positively reports it had no active
 * turn, force the live state idle. That emits `session:interrupted`, which
 * both unwedges the drive and drops the renderer out of its fake "running".
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
 * @returns whether the session was forced idle.
 */
export async function clearStuckRunningState(
  deps: StuckRunningStateDeps,
  { sessionId, hadActiveTurn }: { sessionId: string; hadActiveTurn: boolean | undefined },
): Promise<boolean> {
  if (hadActiveTurn !== false) {
    return false;
  }

  const liveState = deps.getSessionState(sessionId);
  if (!liveState || (liveState.status !== 'running' && !liveState.isStreaming)) {
    return false;
  }

  deps.logWarn(
    `[AIService] interruptCurrentTurn: session ${sessionId} reports ${liveState.status}${liveState.isStreaming ? '/streaming' : ''} with no active provider turn; forcing it idle so queued prompts can dispatch`,
  );
  await deps.interruptSession(sessionId);
  return true;
}
