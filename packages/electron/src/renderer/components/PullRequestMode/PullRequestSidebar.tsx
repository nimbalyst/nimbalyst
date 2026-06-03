/**
 * PullRequestSidebar — filter chips for the PR review list (issue #307,
 * Phase F). Mirrors the tracker sidebar's chip pattern.
 *
 * `open` and `closed` are mutually exclusive (a PR is one or the other);
 * the remaining chips are independent client-side narrowing filters.
 */

import { MaterialSymbol } from '@nimbalyst/runtime';
import type { PrFilterChip } from '../../store/atoms/pullRequests';

interface PullRequestSidebarProps {
  remote: string | null;
  activeFilters: PrFilterChip[];
  onToggleFilter: (filter: PrFilterChip) => void;
}

const FILTER_CHIPS: { id: PrFilterChip; label: string; icon: string }[] = [
  { id: 'open', label: 'Open', icon: 'radio_button_unchecked' },
  { id: 'closed', label: 'Closed', icon: 'cancel' },
  { id: 'awaiting-review', label: 'Awaiting my review', icon: 'rate_review' },
  { id: 'created-by-me', label: 'Created by me', icon: 'person' },
  { id: 'with-conflicts', label: 'With conflicts', icon: 'merge_type' },
  { id: 'draft', label: 'Draft', icon: 'edit_note' },
];

export function PullRequestSidebar({
  remote,
  activeFilters,
  onToggleFilter,
}: PullRequestSidebarProps): JSX.Element {
  return (
    <div
      className="pr-sidebar w-full h-full flex flex-col bg-nim-secondary overflow-hidden"
      data-testid="pr-sidebar"
    >
      <div className="px-3 py-2 border-b border-nim">
        <div className="text-[11px] font-semibold text-nim-muted uppercase tracking-wider">
          Pull Requests
        </div>
        {remote && (
          <div className="text-[11px] text-nim-faint truncate mt-0.5" title={remote}>
            {remote}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-2 pt-2 pb-1">
        <div className="text-[10px] font-semibold text-nim-faint uppercase tracking-wider px-1 mb-1.5">
          Filters
        </div>
        <div className="flex flex-wrap gap-1">
          {FILTER_CHIPS.map((chip) => {
            const isActive = activeFilters.includes(chip.id);
            return (
              <button
                key={chip.id}
                data-testid={`pr-filter-${chip.id}`}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors ${
                  isActive
                    ? 'bg-[var(--nim-primary)] text-white'
                    : 'bg-nim-tertiary text-nim-muted hover:bg-nim-active hover:text-nim'
                }`}
                onClick={() => onToggleFilter(chip.id)}
              >
                <MaterialSymbol icon={chip.icon} size={13} />
                {chip.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
