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

/**
 * Draft used when starting an agent session from a pull request.
 *
 * #1556: this must be a self-contained prompt. It previously invoked
 * `/review-contribution`, a slash command that only exists in this repo's
 * `.claude/commands/`, so shipped builds answered "Unknown command".
 */
export function buildReviewContributionDraft(remote: string, prNumber: number): string {
  const url = `https://github.com/${remote}/pull/${prNumber}`;
  return [
    `Review pull request ${url} (repo ${remote}, PR #${prNumber}) and report your findings here.`,
    '',
    'This is a read-only review. Do not edit, commit, push, merge, or post anything to GitHub.',
    '',
    `1. Read the PR: \`gh pr view ${prNumber} --repo ${remote}\` and \`gh pr diff ${prNumber} --repo ${remote}\`, plus the surrounding code for context.`,
    '2. Look for correctness bugs, regressions, missing tests, and mismatches with the conventions already used in the files it touches.',
    '3. Reply with a one-line recommendation, then the findings most important first, each citing file and line.',
  ].join('\n');
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
