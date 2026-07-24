import { describe, expect, it } from 'vitest';
import { buildPullRequestActivityQuery, derivePullRequestActivityAt } from '../GhApiService';

describe('pull request activity timestamps', () => {
  it('queries activity events instead of relying on GitHub pull-request updatedAt', () => {
    const query = buildPullRequestActivityQuery([935, 920]);

    expect(query).toContain('pr0:pullRequest(number:935)');
    expect(query).toContain('pr1:pullRequest(number:920)');
    expect(query).toContain('itemTypes:[PULL_REQUEST_COMMIT,ISSUE_COMMENT,PULL_REQUEST_REVIEW]');
  });

  it('derives distinct meaningful activity when GitHub batch-updates every PR', () => {
    const githubBatchUpdatedAt = '2026-07-23T00:25:10Z';
    const first = derivePullRequestActivityAt({
      number: 935,
      createdAt: '2026-07-21T04:07:24Z',
      updatedAt: githubBatchUpdatedAt,
      timelineItems: {
        nodes: [
          {
            __typename: 'PullRequestCommit',
            commit: { committedDate: '2026-07-22T01:27:19Z', pushedDate: null },
          },
        ],
      },
    });
    const second = derivePullRequestActivityAt({
      number: 920,
      createdAt: '2026-07-19T04:15:06Z',
      updatedAt: githubBatchUpdatedAt,
      timelineItems: {
        nodes: [
          {
            __typename: 'PullRequestCommit',
            commit: { committedDate: '2026-07-19T03:55:51Z', pushedDate: null },
          },
        ],
      },
    });

    expect(first).toBe(Date.parse('2026-07-22T01:27:19Z'));
    expect(second).toBe(Date.parse('2026-07-19T04:15:06Z'));
    expect(first).not.toBe(Date.parse(githubBatchUpdatedAt));
    expect(second).not.toBe(Date.parse(githubBatchUpdatedAt));
  });

  it('uses the latest comment timestamp and falls back to creation time', () => {
    expect(
      derivePullRequestActivityAt({
        number: 867,
        createdAt: '2026-07-14T00:00:00Z',
        timelineItems: {
          nodes: [
            {
              __typename: 'IssueComment',
              createdAt: '2026-07-15T04:35:00Z',
              updatedAt: '2026-07-15T04:35:23Z',
            },
          ],
        },
      }),
    ).toBe(Date.parse('2026-07-15T04:35:23Z'));

    expect(
      derivePullRequestActivityAt({
        number: 1,
        createdAt: '2026-07-01T00:00:00Z',
        timelineItems: { nodes: [] },
      }),
    ).toBe(Date.parse('2026-07-01T00:00:00Z'));
  });
});
