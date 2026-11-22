import { commitProposalOutcome, type CommitProposalOutcome } from './ai/CommitProposalExecution';

/**
 * #1682: what a commit proposal call tells the agent when it did not commit.
 * Whether a commit happened comes only from the proposal's own execution
 * record (CommitProposalExecution.commitProposalOutcome), never from a
 * look-alike commit in git log.
 */
export function isGitLockFailure(error: string | undefined): boolean {
  return !!error && (/timed out waiting for lock/.test(error) || /Repository is locked by another git process/.test(error));
}

export type ReadProposalOutcome = CommitProposalOutcome | { kind: 'unreadable'; reason: string };

/** Never throws: an unreadable record must not leave the tool call unsettled. */
export async function readProposalOutcome(sessionId: string, proposalId: string): Promise<ReadProposalOutcome> {
  try {
    return await commitProposalOutcome(sessionId, proposalId);
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
}

export function noCommitNote(
  outcome: Exclude<ReadProposalOutcome, { kind: 'committed' }>,
  opts: { retryable: boolean },
): string {
  if (outcome.kind === 'unreadable') {
    return `Could not read this proposal's execution record (${outcome.reason}). Check git log before retrying.`;
  }
  return opts.retryable
    ? 'No commit was made by this call. It is safe to retry the commit proposal.'
    : 'No commit was made by this call.';
}
