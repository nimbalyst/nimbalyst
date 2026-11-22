import {
  afterCommitProposalSettles,
  closeWaitingCommitProposals,
  isCommitProposalInFlight,
} from '@nimbalyst/runtime/ai/server/commitProposalInFlight';

export interface DeferredSendNowDeps {
  hasPendingPrompts(sessionId: string): Promise<boolean>;
  interrupt(sessionId: string): Promise<unknown>;
  drive(sessionId: string): Promise<unknown>;
  logWarn(message: string): void;
}

const scheduled = new Set<string>();

/**
 * #1682: send-now and meta-agent interrupts must not land while a
 * `developer_git_commit_proposal` call is in flight. Returns true when the
 * interrupt was deferred; once the call settles, a still-queued prompt is sent
 * the way send-now would have sent it (interrupt, then drive).
 */
export function deferInterruptDuringCommit(sessionId: string, deps: DeferredSendNowDeps): boolean {
  if (!isCommitProposalInFlight(sessionId)) return false;
  if (scheduled.has(sessionId)) return true;
  scheduled.add(sessionId);
  void afterCommitProposalSettles(sessionId, async () => {
    scheduled.delete(sessionId);
    if (!(await deps.hasPendingPrompts(sessionId))) return;
    await deps.interrupt(sessionId);
    await deps.drive(sessionId);
  }).catch(error => {
    scheduled.delete(sessionId);
    deps.logWarn(`[AIService] deferred send-now after commit proposal failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
  });
  return true;
}

/**
 * NIM-7642: the user's own send-now. A proposal still waiting on the user is
 * closed first instead of holding their message until they answer it; the
 * send-now is then deferred only until that call returns, or for as long as a
 * commit they already confirmed runs. Meta-agent and teammate interrupts use
 * `deferInterruptDuringCommit` and still wait for the user.
 */
export async function deferUserSendNowDuringCommit(sessionId: string, deps: DeferredSendNowDeps): Promise<boolean> {
  await closeWaitingCommitProposals(sessionId);
  return deferInterruptDuringCommit(sessionId, deps);
}
