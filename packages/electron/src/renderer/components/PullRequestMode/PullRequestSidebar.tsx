/**
 * PullRequestSidebar — filter chips for the PR review list. Mirrors the
 * tracker sidebar's chip pattern.
 *
 * `open` and `closed` are mutually exclusive (a PR is one or the other);
 * the remaining chips are independent client-side narrowing filters.
 *
 * A second chip group is derived from the workflow statuses of tracker items
 * referencing the listed PRs — nothing is hardcoded to a status vocabulary or
 * tracker type, so projects without PR-referencing items simply don't see it.
 */

import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { getRecordStatus, getStatusOptions } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { prListAtom, type PrFilterChip } from '../../store/atoms/pullRequests';
import { usePrTrackerReferences } from './usePrTrackerContext';

interface PullRequestSidebarProps {
  remote: string | null;
  activeFilters: PrFilterChip[];
  onToggleFilter: (filter: PrFilterChip) => void;
  activeTrackerStatusFilters: string[];
  onToggleTrackerStatusFilter: (status: string) => void;
}

const FILTER_CHIPS: { id: PrFilterChip; label: string; icon: string }[] = [
  { id: 'open', label: 'Open', icon: 'radio_button_unchecked' },
  { id: 'closed', label: 'Closed', icon: 'cancel' },
  { id: 'awaiting-review', label: 'Awaiting my review', icon: 'rate_review' },
  { id: 'created-by-me', label: 'Created by me', icon: 'person' },
  { id: 'with-conflicts', label: 'With conflicts', icon: 'merge_type' },
  { id: 'draft', label: 'Draft', icon: 'edit_note' },
];

interface TrackerStatusChip {
  value: string;
  label: string;
  icon?: string;
  color?: string;
  count: number;
}

export function PullRequestSidebar({
  remote,
  activeFilters,
  onToggleFilter,
  activeTrackerStatusFilters,
  onToggleTrackerStatusFilter,
}: PullRequestSidebarProps): JSX.Element {
  const prList = useAtomValue(prListAtom);
  const trackerReferences = usePrTrackerReferences(remote);

  // One chip per workflow-status value present among items referencing listed
  // PRs, labeled/colored by each item's own schema. Counts are per PR.
  const trackerStatusChips = useMemo(() => {
    const chips = new Map<string, TrackerStatusChip>();
    for (const pr of prList) {
      const items = trackerReferences.get(pr.number);
      if (!items?.length) continue;
      const seenForPr = new Set<string>();
      for (const item of items) {
        const status = getRecordStatus(item);
        if (!status || seenForPr.has(status)) continue;
        seenForPr.add(status);
        const existing = chips.get(status);
        if (existing) {
          existing.count += 1;
        } else {
          const option = getStatusOptions(item.primaryType).find((o) => o.value === status);
          chips.set(status, {
            value: status,
            label: option?.label ?? status,
            icon: option?.icon,
            color: option?.color,
            count: 1,
          });
        }
      }
    }
    for (const status of activeTrackerStatusFilters) {
      if (!chips.has(status)) {
        chips.set(status, {
          value: status,
          label: status,
          count: 0,
        });
      }
    }
    return Array.from(chips.values());
  }, [activeTrackerStatusFilters, prList, trackerReferences]);

  return (
    <div
      className="pr-sidebar w-full shrink-0 flex flex-col bg-nim-secondary"
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

      <div className="px-2 pt-2 pb-1">
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

      {trackerStatusChips.length > 0 && (
        <div className="px-2 pt-2 pb-1" data-testid="pr-tracker-status-filters">
          <div className="text-[10px] font-semibold text-nim-faint uppercase tracking-wider px-1 mb-1.5">
            Review Status
          </div>
          <div className="flex flex-wrap gap-1">
            {trackerStatusChips.map((chip) => {
              const isActive = activeTrackerStatusFilters.includes(chip.value);
              const color = chip.color || '#6b7280';
              return (
                <button
                  key={chip.value}
                  data-testid={`pr-tracker-status-${chip.value}`}
                  className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors ${
                    isActive ? 'text-white' : 'text-nim-muted hover:text-nim hover:bg-nim-active'
                  }`}
                  style={
                    isActive
                      ? { backgroundColor: color }
                      : { backgroundColor: `${color}20`, color }
                  }
                  onClick={() => onToggleTrackerStatusFilter(chip.value)}
                >
                  {chip.icon && <MaterialSymbol icon={chip.icon} size={13} />}
                  {chip.label}
                  <span className="opacity-70">{chip.count}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
