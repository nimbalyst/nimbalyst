/**
 * Shared formatting helpers for the PR review panel.
 */

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
