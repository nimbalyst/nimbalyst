/**
 * PullRequestListView — searchable, sortable, filterable PR list. Mirrors the
 * tracker main view's header + list structure.
 *
 * Server-side filters (PR state, awaiting-my-review) drive the `gh api` fetch;
 * the rest (created-by-me, with-conflicts, draft, search, sort) are applied
 * client-side over the cached rows. The list re-fetches when the poll
 * scheduler broadcasts `pr:list-updated`.
 */

import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import {
  prListAtom,
  prListLoadingAtom,
  prListErrorAtom,
  prListUpdatedAtom,
  prModeLayoutAtom,
  setPrModeLayoutAtom,
  ghCliStatusAtom,
  type PrSortKey,
} from '../../store/atoms/pullRequests';
import { getPullRequestService } from '../../services/RendererPullRequestService';
import { PullRequestRow } from './PullRequestRow';
import { getRecordStatus } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { usePrTrackerReferences, useSessionCountsByTrackerItem } from './usePrTrackerContext';
import { GithubListToolbar, type GithubListSortOption } from './GithubListToolbar';
import { matchesGithubListSearch } from './githubListSearch';

interface PullRequestListViewProps {
  workspaceId: string;
  remote: string | null;
  isActive: boolean;
}

const SORT_OPTIONS: GithubListSortOption<PrSortKey>[] = [
  { id: 'updated', label: 'Last activity' },
  { id: 'created', label: 'Created' },
  { id: 'number', label: 'Number' },
];

export function PullRequestListView({
  workspaceId,
  remote,
  isActive,
}: PullRequestListViewProps): JSX.Element {
  const layout = useAtomValue(prModeLayoutAtom);
  const setLayout = useSetAtom(setPrModeLayoutAtom);
  const ghStatus = useAtomValue(ghCliStatusAtom);

  const prList = useAtomValue(prListAtom);
  const setPrList = useSetAtom(prListAtom);
  const loading = useAtomValue(prListLoadingAtom);
  const setLoading = useSetAtom(prListLoadingAtom);
  const error = useAtomValue(prListErrorAtom);
  const setError = useSetAtom(prListErrorAtom);
  const listUpdated = useAtomValue(prListUpdatedAtom);

  const [search, setSearch] = useState('');

  const trackerReferences = usePrTrackerReferences(remote);
  const sessionCountsByItem = useSessionCountsByTrackerItem();

  const { activeFilters, trackerStatusFilters, sortKey, selectedItemId } = layout;
  const stateParam: 'open' | 'closed' = activeFilters.includes('closed') ? 'closed' : 'open';
  const awaitingMyReview = activeFilters.includes('awaiting-review');

  const runFetch = useCallback(async () => {
    if (!remote) return;
    setLoading(true);
    setError(null);
    try {
      const rows = await getPullRequestService().list(workspaceId, remote, {
        state: stateParam,
        awaitingMyReview,
      });
      setPrList(rows);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load pull requests');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, remote, stateParam, awaitingMyReview, setPrList, setLoading, setError]);

  // Fetch on enter / filter change / poll broadcast.
  useEffect(() => {
    if (isActive && remote) {
      void runFetch();
    }
    // listUpdated?.version is the poll-broadcast trigger.
  }, [isActive, remote, runFetch, listUpdated?.version]);

  // Client-side narrowing + sort over the cached rows.
  const visibleRows = useMemo(() => {
    const user = ghStatus?.user;
    let rows = [...prList];
    if (activeFilters.includes('created-by-me') && user) {
      rows = rows.filter((r) => r.authorLogin === user);
    }
    if (activeFilters.includes('with-conflicts')) {
      rows = rows.filter((r) => r.mergeable === 'conflicting');
    }
    if (activeFilters.includes('draft')) {
      rows = rows.filter((r) => r.isDraft);
    }
    if (trackerStatusFilters.length > 0) {
      rows = rows.filter((r) => {
        const items = trackerReferences.get(r.number);
        return items?.some((item) => trackerStatusFilters.includes(getRecordStatus(item)));
      });
    }
    if (search.trim()) {
      rows = rows.filter((r) => matchesGithubListSearch(r, search));
    }
    rows.sort((a, b) => {
      if (sortKey === 'number') return b.number - a.number;
      if (sortKey === 'created') return b.createdAt - a.createdAt;
      return b.updatedAt - a.updatedAt;
    });
    return rows;
  }, [prList, activeFilters, trackerStatusFilters, trackerReferences, ghStatus?.user, search, sortKey]);

  const handleSelect = useCallback(
    (id: string) => setLayout({ selectedItemId: id }),
    [setLayout],
  );

  const hasActiveNarrowing =
    search.trim().length > 0 ||
    activeFilters.some((f) => f === 'created-by-me' || f === 'with-conflicts' || f === 'draft');

  return (
    <div className="pr-list flex flex-col h-full w-full overflow-hidden" data-testid="pr-list">
      <GithubListToolbar
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search title, number, label, or author:login"
        sortOptions={SORT_OPTIONS}
        sortKey={sortKey}
        onSortChange={(key) => setLayout({ sortKey: key })}
        onRefresh={() => void runFetch()}
        loading={loading}
        testIdPrefix="pr"
      />

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {error ? (
          <div className="flex flex-col items-center justify-center py-10 px-5 text-nim-error gap-2 text-sm">
            <MaterialSymbol icon="error" size={28} className="opacity-70" />
            <span className="text-center">{error}</span>
            <button
              className="mt-1 text-xs text-nim-link hover:text-nim-link-hover hover:underline"
              onClick={() => void runFetch()}
            >
              Retry
            </button>
          </div>
        ) : loading && prList.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-10 text-nim-muted text-sm">
            <div className="spinner w-5 h-5 border-[3px] border-nim-secondary border-t-nim-primary rounded-full animate-spin" />
            Loading pull requests…
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-[60px] px-5 text-nim-faint gap-2">
            <MaterialSymbol icon="inbox" size={40} className="opacity-50" />
            <span className="text-sm text-center">
              {hasActiveNarrowing ? 'No pull requests match these filters' : 'No pull requests'}
            </span>
            {hasActiveNarrowing && (
              <button
                className="text-xs text-nim-link hover:text-nim-link-hover hover:underline"
                onClick={() => {
                  setSearch('');
                  setLayout({ activeFilters: ['open'] });
                }}
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          visibleRows.map((pr) => {
            const items = trackerReferences.get(pr.number);
            const hasSessions = Boolean(
              items?.some(
                (item) =>
                  (item.system.linkedSessions?.length ?? 0) > 0 ||
                  sessionCountsByItem.has(item.id),
              ),
            );
            return (
              <PullRequestRow
                key={pr.id}
                pr={pr}
                selected={pr.id === selectedItemId}
                onSelect={handleSelect}
                trackerItem={items?.[0] ?? null}
                hasSessions={hasSessions}
              />
            );
          })
        )}
      </div>
    </div>
  );
}
