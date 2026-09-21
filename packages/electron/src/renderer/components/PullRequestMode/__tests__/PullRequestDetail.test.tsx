// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PullRequestRow } from '../../../services/RendererPullRequestService';
import { PullRequestDetail } from '../PullRequestDetail';
import { buildReviewContributionDraft } from '../prFormat';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span>{icon}</span>,
}));

vi.mock('../PullRequestActions', () => ({ PullRequestActions: () => null }));
vi.mock('../PrTrackerStrip', () => ({ PrTrackerStrip: () => null }));
vi.mock('../tabs/ConversationTab', () => ({ ConversationTab: () => null }));
vi.mock('../tabs/FilesChangedTab', () => ({ FilesChangedTab: () => null }));
vi.mock('../tabs/CommitsTab', () => ({ CommitsTab: () => null }));
vi.mock('../tabs/ChecksTab', () => ({ ChecksTab: () => null }));

afterEach(cleanup);

const pr: PullRequestRow = {
  id: 'pr-809',
  workspaceId: '/workspace',
  remote: 'nimbalyst/nimbalyst',
  number: 809,
  title: 'Add PR review sessions',
  body: null,
  state: 'open',
  isDraft: false,
  authorLogin: 'reviewer',
  authorAvatarUrl: null,
  headRef: 'feature/review-session',
  headSha: 'abc123',
  baseRef: 'main',
  mergeable: 'mergeable',
  commentsCount: 0,
  reviewCommentsCount: 0,
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  ciStatus: 'success',
  reviewers: [],
  labels: [],
  raw: { html_url: 'https://github.com/nimbalyst/nimbalyst/pull/809' },
  etag: null,
  createdAt: 1,
  updatedAt: 1,
  fetchedAt: 1,
};

describe('PullRequestDetail review session action', () => {
  it('starts a review session from the PR header', () => {
    const onStartReviewSession = vi.fn();

    render(
      <PullRequestDetail
        workspaceId="/workspace"
        remote="nimbalyst/nimbalyst"
        pr={pr}
        onClose={() => undefined}
        onStartReviewSession={onStartReviewSession}
        trackerContext={{ items: [], primary: null, sessions: [] }}
      />,
    );

    fireEvent.click(screen.getByTestId('pr-start-review-session'));

    expect(onStartReviewSession).toHaveBeenCalledOnce();
  });

  // #1556: the draft used to be `/review-contribution <url>`, a repo-private
  // slash command that shipped builds answer with "Unknown command". The draft
  // must stand on its own and must not lead with a slash command.
  it('builds a self-contained review draft carrying the PR url', () => {
    const draft = buildReviewContributionDraft('nimbalyst/nimbalyst', 809);

    expect(draft).toContain('https://github.com/nimbalyst/nimbalyst/pull/809');
    expect(draft.trimStart().startsWith('/')).toBe(false);
    expect(draft).not.toContain('review-contribution');
  });
});
