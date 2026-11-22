/**
 * GithubIssueListView — searchable, sortable, filterable issue list, mirroring
 * PullRequestListView.
 *
 * Upstream state drives the cached `issue:list` read; every other filter, the
 * search, and the sort run client-side over those rows (see issueFilters.ts).
 * The list re-reads the cache whenever the poller broadcasts an issue update.
 */

import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import {
  githubIssueListAtom,
  githubIssueListErrorAtom,
  githubIssueListLoadingAtom,
  githubIssueListUpdatedAtom,
} from '../../../store/atoms/githubIssues';
import {
  ghCliStatusAtom,
  prModeLayoutAtom,
  setPrModeLayoutAtom,
  type PrSortKey,
} from '../../../store/atoms/pullRequests';
import { getGithubIssueService } from '../../../services/RendererGithubIssueService';
import { getRecordStatus } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { GithubListToolbar, type GithubListSortOption } from '../GithubListToolbar';
import { useSessionCountsByTrackerItem } from '../usePrTrackerContext';
import { GithubIssueRow } from './GithubIssueRow';
import { issueHtmlUrl } from './issueFormat';
import { findIssueOverlay } from './issueOverlay';
import { useIssueTrackerReferences } from './useIssueTrackerContext';
import {
  issueStateParam,
  selectVisibleIssues,
  type IssueAttentionChip,
  type IssueFilterChip,
} from './issueFilters';

interface GithubIssueListViewProps {
  workspaceId: string;
  remote: string | null;
  /** Whether the issues list is the one currently showing in an active panel. */
  isActive: boolean;
  activeFilters: ReadonlyArray<IssueFilterChip>;
  /** Local investigation statuses to narrow to; empty shows every issue. */
  activeLocalStatusFilters: ReadonlyArray<string>;
  /** Needs-attention queues to narrow to; empty shows every issue. */
  activeAttentionFilters: ReadonlyArray<IssueAttentionChip>;
  /** Needs-attention queues per issue number, resolved by the panel. */
  attentionByIssue: ReadonlyMap<number, ReadonlyArray<IssueAttentionChip>>;
  onClearFilters: () => void;
  /** PR numbers per issue number, resolved by the panel. */
  linkedPrsByIssue: ReadonlyMap<number, ReadonlyArray<number>>;
}

const SORT_OPTIONS: GithubListSortOption<PrSortKey>[] = [
  { id: 'updated', label: 'Last activity' },
  { id: 'created', label: 'Created' },
  { id: 'number', label: 'Number' },
];

export function GithubIssueListView({
  workspaceId,
  remote,
  isActive,
  activeFilters,
  activeLocalStatusFilters,
  activeAttentionFilters,
  attentionByIssue,
  onClearFilters,
  linkedPrsByIssue,
}: GithubIssueListViewProps): JSX.Element {
  const layout = useAtomValue(prModeLayoutAtom);
  const setLayout = useSetAtom(setPrModeLayoutAtom);
  const ghStatus = useAtomValue(ghCliStatusAtom);

  const issues = useAtomValue(githubIssueListAtom);
  const setIssues = useSetAtom(githubIssueListAtom);
  const loading = useAtomValue(githubIssueListLoadingAtom);
  const setLoading = useSetAtom(githubIssueListLoadingAtom);
  const error = useAtomValue(githubIssueListErrorAtom);
  const setError = useSetAtom(githubIssueListErrorAtom);
  const listUpdated = useAtomValue(githubIssueListUpdatedAtom);

  const [search, setSearch] = useState('');

  // Local state for every listed issue, resolved once here and handed down —
  // rows stay unsubscribed so a tracker write doesn't re-render the whole list
  // through each row's own atom subscription.
  const trackerReferences = useIssueTrackerReferences(remote);
  const sessionCountsByItem = useSessionCountsByTrackerItem();

  const localStatusesByIssue = useMemo(() => {
    const byIssue = new Map<number, string[]>();
    trackerReferences.forEach((items, issueNumber) => {
      const statuses = items.map(getRecordStatus).filter(Boolean);
      if (statuses.length > 0) byIssue.set(issueNumber, statuses);
    });
    return byIssue;
  }, [trackerReferences]);

  const { sortKey, selectedIssueItemId } = layout;
  const stateParam = issueStateParam(activeFilters);

  const runFetch = useCallback(async () => {
    if (!remote) return;
    setLoading(true);
    setError(null);
    try {
      setIssues(await getGithubIssueService().list(workspaceId, remote, { state: stateParam }));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load issues');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, remote, stateParam, setIssues, setLoading, setError]);

  // Read the cache on enter / state change / poll broadcast.
  useEffect(() => {
    if (isActive && remote) {
      void runFetch();
    }
    // listUpdated?.version is the poll-broadcast trigger.
  }, [isActive, remote, runFetch, listUpdated?.version]);

  // Explicit refresh goes upstream first, then re-reads the cache so the
  // client-side filters apply to the freshly written rows.
  const handleRefresh = useCallback(() => {
    if (!remote) return;
    setLoading(true);
    void getGithubIssueService()
      .refresh(workspaceId, remote, { state: stateParam })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Failed to refresh issues'),
      )
      .finally(() => {
        void runFetch();
      });
  }, [workspaceId, remote, stateParam, runFetch, setLoading, setError]);

  const visibleRows = useMemo(
    () =>
      selectVisibleIssues({
        issues,
        activeFilters,
        search,
        sortKey,
        viewerLogin: ghStatus?.user ?? null,
        linkedPrsByIssue,
        localStatusFilters: activeLocalStatusFilters,
        localStatusesByIssue,
        attentionFilters: activeAttentionFilters,
        attentionByIssue,
      }),
    [
      issues,
      activeFilters,
      search,
      sortKey,
      ghStatus?.user,
      linkedPrsByIssue,
      activeLocalStatusFilters,
      localStatusesByIssue,
      activeAttentionFilters,
      attentionByIssue,
    ],
  );

  const handleSelect = useCallback(
    (id: string) => setLayout({ selectedIssueItemId: id }),
    [setLayout],
  );

  const hasActiveNarrowing =
    search.trim().length > 0 ||
    activeLocalStatusFilters.length > 0 ||
    activeAttentionFilters.length > 0 ||
    activeFilters.some((f) => f !== 'open' && f !== 'closed');

  return (
    <div className="issue-list flex flex-col h-full w-full overflow-hidden" data-testid="issue-list">
      <GithubListToolbar
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search title, number, label, or author:login"
        sortOptions={SORT_OPTIONS}
        sortKey={sortKey}
        onSortChange={(key) => setLayout({ sortKey: key })}
        onRefresh={handleRefresh}
        loading={loading}
        testIdPrefix="issue"
      />

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
        ) : loading && issues.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-10 text-nim-muted text-sm">
            <div className="spinner w-5 h-5 border-[3px] border-nim-secondary border-t-nim-primary rounded-full animate-spin" />
            Loading issues…
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-[60px] px-5 text-nim-faint gap-2">
            <MaterialSymbol icon="inbox" size={40} className="opacity-50" />
            <span className="text-sm text-center">
              {hasActiveNarrowing ? 'No issues match these filters' : 'No issues'}
            </span>
            {hasActiveNarrowing && (
              <button
                className="text-xs text-nim-link hover:text-nim-link-hover hover:underline"
                onClick={() => {
                  setSearch('');
                  onClearFilters();
                }}
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          visibleRows.map((issue) => {
            const items = trackerReferences.get(issue.number);
            return (
              <GithubIssueRow
                key={issue.id}
                issue={issue}
                selected={issue.id === selectedIssueItemId}
                onSelect={handleSelect}
                overlay={
                  remote && items ? findIssueOverlay(items, issueHtmlUrl(issue, remote)) : null
                }
                hasSessions={items?.some(
                  (item) =>
                    (item.system.linkedSessions?.length ?? 0) > 0 ||
                    sessionCountsByItem.has(item.id),
                )}
                diverged={attentionByIssue.get(issue.number)?.includes('diverged')}
              />
            );
          })
        )}
      </div>
    </div>
  );
}
