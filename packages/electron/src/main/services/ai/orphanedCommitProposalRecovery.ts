import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import {
  hasCommitProposalCall,
  reapOrphanedCommitProposalCalls,
} from '@nimbalyst/runtime/ai/server/commitProposalInFlight';
import { hasActiveSessionTurn, isTurnAdmissionBlocked } from './sessionTurnControl';
import { hasRunningCommitProposalExecution } from './CommitProposalExecution';

/** A short grace for the proposal's normal close/settle path before orphan recovery. */
export const COMMIT_PROPOSAL_CLOSE_GRACE_MS = 1_000;

/**
 * A marker without a host turn or running provider cannot settle through the
 * original tool call. Retire only that orphan; a live commit keeps its guard.
 */
export function reapIdleCommitProposalMarker(sessionId: string, logWarn: (message: string) => void): boolean {
  if (!hasCommitProposalCall(sessionId) || hasActiveSessionTurn(sessionId) || isTurnAdmissionBlocked(sessionId)) return false;
  const state = getSessionStateManager().getSessionState(sessionId);
  if (state?.status === 'running' || state?.status === 'waiting_for_input' || state?.isStreaming) return false;
  const reaped = reapOrphanedCommitProposalCalls(sessionId,
    proposalId => hasRunningCommitProposalExecution(sessionId, proposalId));
  if (reaped) logWarn(`[AIService] Reaped orphaned commit proposal call(s) for idle session ${sessionId}`);
  return reaped;
}

/** Let a human Send dismiss a proposal, then recover a marker with no owner. */
export async function closeProposalForHumanSend(
  sessionId: string,
  close: () => Promise<number>,
  logWarn: (message: string) => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closing = Promise.resolve().then(close).catch(error => {
    logWarn(`[AIService] Waiting commit proposal close failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
  });
  try {
    await Promise.race([closing, new Promise<void>(resolve => {
      timer = setTimeout(resolve, COMMIT_PROPOSAL_CLOSE_GRACE_MS);
    })]);
  } finally { if (timer) clearTimeout(timer); }
  reapIdleCommitProposalMarker(sessionId, logWarn);
}
