import { describe, expect, it } from 'vitest';

import {
  buildCodexToolLookupId,
  parseCodexToolLookupId,
  resolveGitCommitProposalLookup,
} from '../toolLookupIds';

describe('toolLookupIds', () => {
  it('round-trips Codex synthetic lookup IDs', () => {
    const lookupId = buildCodexToolLookupId('item_0', 1234567890, 42);

    expect(parseCodexToolLookupId(lookupId)).toEqual({
      itemId: 'item_0',
      timestampMs: 1234567890,
      index: 42,
    });
  });

  it('prefers direct toolUseId matches', () => {
    const resolved = resolveGitCommitProposalLookup('item_0', [
      {
        proposalId: 'proposal-a',
        createdAtMs: 1000,
        toolUseId: 'item_0',
      },
      {
        proposalId: 'proposal-b',
        createdAtMs: 2000,
      },
    ]);

    expect(resolved).toBe('proposal-a');
  });

  it('uses timestamp proximity for synthetic Codex lookup IDs', () => {
    const resolved = resolveGitCommitProposalLookup(
      buildCodexToolLookupId('item_0', 20_500, 7),
      [
        {
          proposalId: 'proposal-old',
          createdAtMs: 10_000,
        },
        {
          proposalId: 'proposal-new',
          createdAtMs: 21_000,
        },
      ],
    );

    expect(resolved).toBe('proposal-new');
  });
});
