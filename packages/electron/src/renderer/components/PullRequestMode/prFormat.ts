/**
 * Shared formatting helpers for the PR review panel.
 */

import type { EditorContextItem } from '@nimbalyst/runtime';
import type { PullRequestRow } from '../../services/RendererPullRequestService';

/** Compact relative time ("just now", "5m ago", "3d ago", "2mo ago", "1y ago"). */
export function formatRelative(ms: number): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon}mo ago`;
  return `${Math.floor(mon / 12)}y ago`;
}

/** Draft used when starting an agent session from a pull request. */
export function buildReviewContributionDraft(remote: string, prNumber: number): string {
  return `/review-contribution https://github.com/${remote}/pull/${prNumber}`;
}

/** Synthetic document path used to scope the selected PR to its chat pane. */
export function prContextPath(remote: string, prNumber: number): string {
  return `pr://${remote}/${prNumber}`;
}

function htmlUrlOf(pr: PullRequestRow, remote: string): string {
  const raw = pr.raw as { html_url?: unknown } | null;
  return raw && typeof raw.html_url === 'string'
    ? raw.html_url
    : `https://github.com/${remote}/pull/${pr.number}`;
}

/** Compact, bounded identity card sent with each prompt while a PR is selected. */
export function buildPrContextItem(remote: string, pr: PullRequestRow): EditorContextItem {
  const author = pr.authorLogin ?? 'unknown';
  const labels = pr.labels.length > 0 ? pr.labels.join(', ') : 'none';
  const reviewers = pr.reviewers.length > 0
    ? pr.reviewers.map((reviewer) => `${reviewer.login} (${reviewer.state})`).join(', ')
    : 'none';

  return {
    id: `pr-${pr.number}`,
    icon: 'merge',
    label: `PR #${pr.number}`,
    description: [
      `Pull request: #${pr.number} ${pr.title}`,
      `Remote: ${remote}`,
      `State: ${pr.state}`,
      `Draft: ${pr.isDraft ? 'yes' : 'no'}`,
      `Author: ${author}`,
      `Branches: ${pr.headRef} -> ${pr.baseRef}`,
      `Head SHA: ${pr.headSha}`,
      `URL: ${htmlUrlOf(pr, remote)}`,
      `Changes: +${pr.additions} -${pr.deletions} across ${pr.changedFiles} files`,
      `CI: ${pr.ciStatus ?? 'unknown'}`,
      `Mergeable: ${pr.mergeable ?? 'unknown'}`,
      `Labels: ${labels}`,
      `Reviewers: ${reviewers}`,
      `Comments: ${pr.commentsCount} conversation, ${pr.reviewCommentsCount} review`,
    ].join('\n'),
  };
}
