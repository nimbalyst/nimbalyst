import {
  loadGitCommitProposalRecord,
  resolveGitCommitProposalPromptId,
} from '../ai/gitCommitProposalPromptUtils';
import { VOICE_WORKTREE_COMMIT_REFUSAL } from './mobileVoicePromptContract';
import { proposalHasOtherSessionFiles } from '../ai/proposalCommitTarget';

/**
 * #1955 (D-A2): files under an expanded directory that another session edited
 * arrive unchecked in the desktop widget. A spoken approval commits the whole
 * list and cannot show which files those are, so it is refused.
 */
export const VOICE_OTHER_SESSION_COMMIT_REFUSAL =
  "This commit includes files another session edited. Review it in the commit card on desktop.";

/** Desktop realtime voice answers by prompt id only; read the target from the proposal row. */
export async function refuseVoiceWorktreeCommit(
  sessionId: string,
  params: { promptId: string; promptType: string; answer: string },
): Promise<string | null> {
  if (params.promptType !== 'git_commit_proposal_request' || params.answer.toLowerCase() !== 'approve') return null;
  const proposalId = await resolveGitCommitProposalPromptId(sessionId, params.promptId, false);
  const record = await loadGitCommitProposalRecord(sessionId, proposalId);
  if (typeof record?.targetWorktree?.path === 'string') return VOICE_WORKTREE_COMMIT_REFUSAL;
  if (proposalHasOtherSessionFiles(record)) return VOICE_OTHER_SESSION_COMMIT_REFUSAL;
  return null;
}
