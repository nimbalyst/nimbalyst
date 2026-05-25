import { describe, expect, it } from 'vitest';

import { buildCodexToolLookupId } from '@nimbalyst/runtime/ai/server/toolLookupIds';

import {
  getGitCommitProposalResponseChannel,
  resolveGitCommitProposalPromptIdFromRows,
} from '../gitCommitProposalPromptUtils';

describe('gitCommitProposalPromptUtils', () => {
  it('builds the session-scoped response channel', () => {
    expect(getGitCommitProposalResponseChannel('session-1', 'proposal-1')).toBe(
      'git-commit-proposal-response:session-1:proposal-1',
    );
  });

  it('remaps a synthetic Codex prompt id to the unresolved proposal id', () => {
    const promptId = buildCodexToolLookupId('item_42', 20_500, 7);

    const resolved = resolveGitCommitProposalPromptIdFromRows(
      promptId,
      [
        {
          content: JSON.stringify({
            type: 'git_commit_proposal',
            proposalId: 'proposal-old',
            createdAtMs: 10_000,
          }),
          created_at: new Date(10_000),
        },
        {
          content: JSON.stringify({
            type: 'git_commit_proposal',
            proposalId: 'proposal-new',
            toolUseId: 'item_42',
            createdAtMs: 21_000,
          }),
          created_at: new Date(21_000),
        },
      ],
      [
        {
          content: JSON.stringify({
            type: 'git_commit_proposal_response',
            proposalId: 'proposal-old',
          }),
        },
      ],
    );

    expect(resolved).toBe('proposal-new');
  });
});
