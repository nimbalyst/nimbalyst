import { describe, expect, it } from 'vitest';
import { filterCommits, type FilterableGitCommit } from '../commitFilters';

const commits: FilterableGitCommit[] = [
  { hash: '64aa555abc', message: 'Fix shared comments', author: 'Ada Lovelace' },
  { hash: '662e1e3def', message: 'Make tracker tabs durable', author: 'Grace Hopper' },
];

describe('filterCommits', () => {
  it('matches commit messages, authors, and hash prefixes case-insensitively', () => {
    expect(filterCommits(commits, 'SHARED')).toEqual([commits[0]]);
    expect(filterCommits(commits, 'grace')).toEqual([commits[1]]);
    expect(filterCommits(commits, '662E')).toEqual([commits[1]]);
  });

  it('ignores surrounding whitespace and preserves the unfiltered list', () => {
    expect(filterCommits(commits, '  tracker  ')).toEqual([commits[1]]);
    expect(filterCommits(commits, '   ')).toBe(commits);
  });
});
