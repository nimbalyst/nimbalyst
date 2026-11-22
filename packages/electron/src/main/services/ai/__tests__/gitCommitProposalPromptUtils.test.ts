import { describe, expect, it } from 'vitest';

import { buildCodexToolLookupId } from '@nimbalyst/runtime/ai/server/toolLookupIds';

import {
  findProposalWorktreeTargetInRows,
  getGitCommitProposalResponseChannel,
  resolveGitCommitProposalPromptIdFromRows,
} from '../gitCommitProposalPromptUtils';

describe('gitCommitProposalPromptUtils', () => {
  it('never substitutes a nearby pending proposal when exact identity is required', () => {
    const rows = [{ content: JSON.stringify({ type: 'git_commit_proposal', proposalId: 'canonical', toolUseId: 'item_42' }), created_at: new Date(21000) }];
    expect(resolveGitCommitProposalPromptIdFromRows(buildCodexToolLookupId('item_42', 20500, 7), rows, [], false)).toBe('canonical');
    expect(resolveGitCommitProposalPromptIdFromRows(buildCodexToolLookupId('item_99', 21000, 8), rows, [], false)).toBeNull();
    expect(resolveGitCommitProposalPromptIdFromRows('missing', rows, [], false)).toBeNull();
  });
  // #1756: the commit runs in the sibling worktree recorded on the exact proposal, never a neighbor's.
  it('reads the sibling worktree target recorded on the exact proposal only', () => {
    const target = { path: '/repo_worktrees/feature', branch: 'feature' };
    const rows = [
      { content: JSON.stringify({ type: 'git_commit_proposal', proposalId: 'p1', targetWorktree: target }) },
      { content: JSON.stringify({ type: 'git_commit_proposal', proposalId: 'p2' }) },
      { content: '{not json' },
    ];
    expect(findProposalWorktreeTargetInRows('p1', rows)).toEqual(target);
    expect(findProposalWorktreeTargetInRows('p2', rows)).toBeNull();
    expect(findProposalWorktreeTargetInRows('p3', rows)).toBeNull();
    expect(findProposalWorktreeTargetInRows('p1', [{ content: JSON.stringify({ type: 'git_commit_proposal', proposalId: 'p1', targetWorktree: { path: 7 } }) }])).toBeNull();
  });

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
