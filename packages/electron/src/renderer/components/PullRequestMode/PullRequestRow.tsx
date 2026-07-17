/**
 * PullRequestRow — one row in the PR list.
 *
 * Columns: number, title, author, branch, state, CI status, reviewers,
 * last activity. Kept as its own component so list scrolling doesn't
 * re-render every row (re-render isolation rule).
 */

import type { JSX } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import type { PullRequestRow as PullRequestRowData } from '../../services/RendererPullRequestService';
import { formatRelative } from './prFormat';
import { PrTrackerBadge } from './PrTrackerBadge';

interface PullRequestRowProps {
  pr: PullRequestRowData;
  selected: boolean;
  onSelect: (id: string) => void;
  /** Primary tracker item referencing this PR (badge source); null when untracked. */
  trackerItem?: TrackerRecord | null;
  /** Whether any session is linked to this PR's tracker items. */
  hasSessions?: boolean;
}

function stateBadge(
  pr: PullRequestRowData,
): { label: string; className: string; icon: string } | null {
  if (pr.isDraft) {
    return { label: 'Draft', className: 'text-nim-muted bg-nim-tertiary', icon: 'edit_note' };
  }
  switch (pr.state) {
    case 'merged':
      return { label: 'Merged', className: 'text-white bg-[var(--nim-primary)]', icon: 'merge' };
    case 'closed':
      return { label: 'Closed', className: 'text-white bg-[var(--nim-error)]', icon: 'cancel' };
    default:
      return null;
  }
}

function ciIcon(ci: PullRequestRowData['ciStatus']): { icon: string; className: string } | null {
  switch (ci) {
    case 'success':
      return { icon: 'check_circle', className: 'text-nim-success' };
    case 'failure':
      return { icon: 'error', className: 'text-nim-error' };
    case 'pending':
      return { icon: 'pending', className: 'text-nim-warning' };
    default:
      return null;
  }
}

export function PullRequestRow({ pr, selected, onSelect, trackerItem, hasSessions }: PullRequestRowProps): JSX.Element {
  const badge = stateBadge(pr);
  const ci = ciIcon(pr.ciStatus);
  const conflicting = pr.mergeable === 'conflicting';

  return (
    <button
      type="button"
      data-testid="pr-row"
      data-pr-number={pr.number}
      onClick={() => onSelect(pr.id)}
      className={`pr-row w-full flex items-center gap-2 px-3 py-2 text-left border-b border-nim transition-colors ${
        selected ? 'bg-nim-active' : 'hover:bg-nim-tertiary'
      }`}
    >
      <span className="flex-1 min-w-0 overflow-hidden">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="truncate text-sm text-nim">{pr.title}</span>
          {conflicting && (
            <MaterialSymbol
              icon="merge_type"
              size={14}
              className="text-nim-error shrink-0"
            />
          )}
        </span>
        <span className="flex items-center gap-2 mt-0.5 text-[11px] text-nim-faint min-w-0">
          <span className="font-bold font-mono">#{pr.number}</span>
          {pr.authorLogin && <span className="truncate max-w-[120px]">{pr.authorLogin}</span>}
          <span className="truncate min-w-0 font-mono" title={pr.headRef}>
            {pr.headRef}
          </span>
          {pr.reviewers.length > 0 && (
            <span className="flex items-center gap-0.5">
              <MaterialSymbol icon="group" size={12} />
              {pr.reviewers.length}
            </span>
          )}
          <span className="ml-auto shrink-0 flex items-center gap-2">
            {hasSessions && (
              <MaterialSymbol
                icon="smart_toy"
                size={13}
                className="text-nim-accent"
                title="Has linked review sessions"
              />
            )}
            {trackerItem && <PrTrackerBadge record={trackerItem} compact />}
            {ci && (
              <MaterialSymbol icon={ci.icon} size={14} className={ci.className} />
            )}
            {badge && (
              <span
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ${badge.className}`}
              >
                <MaterialSymbol icon={badge.icon} size={12} />
                {badge.label}
              </span>
            )}
            <span className="shrink-0">{formatRelative(pr.updatedAt)}</span>
          </span>
        </span>
      </span>
    </button>
  );
}
