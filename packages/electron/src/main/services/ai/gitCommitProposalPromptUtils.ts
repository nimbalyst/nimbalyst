import {
  resolveGitCommitProposalLookup,
  type GitCommitProposalLookupCandidate,
} from '@nimbalyst/runtime/ai/server/toolLookupIds';

export function getGitCommitProposalResponseChannel(
  sessionId: string,
  proposalId: string,
): string {
  return `git-commit-proposal-response:${sessionId || 'unknown'}:${proposalId}`;
}

export function resolveGitCommitProposalPromptIdFromRows(
  promptId: string,
  proposalRows: Array<{ content: string; created_at: Date | string }>,
  responseRows: Array<{ content: string }>,
): string | null {
  const proposals: GitCommitProposalLookupCandidate[] = [];
  for (const row of proposalRows) {
    try {
      const content = JSON.parse(row.content);
      if (content?.type !== 'git_commit_proposal' || typeof content.proposalId !== 'string') {
        continue;
      }
      proposals.push({
        proposalId: content.proposalId,
        createdAtMs: row.created_at instanceof Date
          ? row.created_at.getTime()
          : new Date(row.created_at).getTime(),
        toolUseId: typeof content.toolUseId === 'string' ? content.toolUseId : undefined,
      });
    } catch {
      // Ignore malformed rows
    }
  }

  const respondedProposalIds = new Set<string>();
  for (const row of responseRows) {
    try {
      const content = JSON.parse(row.content);
      if (content?.type === 'git_commit_proposal_response' && typeof content.proposalId === 'string') {
        respondedProposalIds.add(content.proposalId);
      }
    } catch {
      // Ignore malformed rows
    }
  }

  const unresolvedProposals = proposals.filter(
    (proposal) => !respondedProposalIds.has(proposal.proposalId),
  );

  const resolvedUnresolved = resolveGitCommitProposalLookup(promptId, unresolvedProposals);
  if (resolvedUnresolved) {
    return resolvedUnresolved;
  }

  const resolvedAny = resolveGitCommitProposalLookup(promptId, proposals);
  if (resolvedAny) {
    return resolvedAny;
  }

  if (unresolvedProposals.length === 1) {
    return unresolvedProposals[0].proposalId;
  }

  return null;
}

/**
 * Resolve a git commit proposal prompt ID to the canonical proposalId stored in DB.
 *
 * In Claude Code, promptId matches proposalId directly.
 * In Codex, the widget can send a synthetic tool-call ID while the MCP server stores
 * a generated proposalId. This remaps the incoming ID so the waiting MCP promise can resolve.
 */
export async function resolveGitCommitProposalPromptId(
  sessionId: string,
  promptId: string,
): Promise<string> {
  if (!sessionId || !promptId) {
    return promptId;
  }

  try {
    const { database } = await import('../../database/PGLiteDatabaseWorker');

    const { rows: proposalRows } = await database.query<{ content: string; created_at: Date }>(
      `SELECT content, created_at
       FROM ai_agent_messages
       WHERE session_id = $1
         AND (hidden = FALSE OR hidden IS NULL)
         AND content LIKE '%"type":"git_commit_proposal"%'
       ORDER BY created_at DESC
       LIMIT 50`,
      [sessionId],
    );

    const { rows: responseRows } = await database.query<{ content: string }>(
      `SELECT content
       FROM ai_agent_messages
       WHERE session_id = $1
         AND content LIKE '%"type":"git_commit_proposal_response"%'`,
      [sessionId],
    );

    const resolvedId = resolveGitCommitProposalPromptIdFromRows(promptId, proposalRows, responseRows);
    if (resolvedId) {
      // console.log(
      //   `[gitCommitProposalPromptUtils] Remapped git commit prompt ID from ${promptId} to ${resolvedId}`,
      // );
      return resolvedId;
    }
  } catch (error) {
    console.warn('[gitCommitProposalPromptUtils] Failed to resolve git commit prompt ID:', error);
  }

  return promptId;
}
