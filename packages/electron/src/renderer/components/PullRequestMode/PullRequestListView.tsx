/**
 * PullRequestListView — searchable, sortable, filterable PR list. Mirrors the
 * tracker main view's header + list structure.
 *
 * Server-side filters (PR state, awaiting-my-review) drive the `gh api` fetch;
 * the rest (created-by-me, with-conflicts, draft, search, sort) are applied
 * client-side over the cached rows. The list re-fetches when the poll
 * scheduler broadcasts `pr:list-updated`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { FloatingPortal, useFloatingMenu } from '../../hooks/useFloatingMenu';
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

interface PullRequestListViewProps {
  workspaceId: string;
  remote: string | null;
  isActive: boolean;
}

const SORT_OPTIONS: { id: PrSortKey; label: string }[] = [
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

  const { activeFilters, sortKey, selectedItemId } = layout;
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
    const q = search.trim().toLowerCase();
    if (q) {
      rows = rows.filter(
        (r) => r.title.toLowerCase().includes(q) || String(r.number).includes(q),
      );
    }
    rows.sort((a, b) => {
      if (sortKey === 'number') return b.number - a.number;
      if (sortKey === 'created') return b.createdAt - a.createdAt;
      return b.updatedAt - a.updatedAt;
    });
    return rows;
  }, [prList, activeFilters, ghStatus?.user, search, sortKey]);

  const sortMenu = useFloatingMenu({ placement: 'bottom-end' });
  const activeSortLabel = SORT_OPTIONS.find((o) => o.id === sortKey)?.label ?? 'Last activity';

  const handleSelect = useCallback(
    (id: string) => setLayout({ selectedItemId: id }),
    [setLayout],
  );

  const hasActiveNarrowing =
    search.trim().length > 0 ||
    activeFilters.some((f) => f === 'created-by-me' || f === 'with-conflicts' || f === 'draft');

  return (
    <div className="pr-list flex flex-col h-full w-full overflow-hidden" data-testid="pr-list">
      {/* Header: search + sort + refresh */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-nim shrink-0">
        <div className="relative flex-1 min-w-0">
          <MaterialSymbol
            icon="search"
            size={15}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-nim-faint pointer-events-none"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by title or number"
            data-testid="pr-search-input"
            className="nim-input w-full h-8 text-sm !py-0 !pl-7"
          />
        </div>

        <button
          ref={sortMenu.refs.setReference}
          {...sortMenu.getReferenceProps()}
          onClick={() => sortMenu.setIsOpen(!sortMenu.isOpen)}
          className="flex items-center gap-1 h-8 px-2 text-xs text-nim-muted hover:text-nim border border-nim rounded transition-colors shrink-0"
          data-testid="pr-sort-button"
        >
          <MaterialSymbol icon="sort" size={15} />
          {activeSortLabel}
        </button>
        {sortMenu.isOpen && (
          <FloatingPortal>
            <div
              ref={sortMenu.refs.setFloating}
              style={sortMenu.floatingStyles}
              {...sortMenu.getFloatingProps()}
              className="z-50 min-w-[140px] bg-nim-secondary border border-nim rounded-md shadow-lg py-1"
            >
              {SORT_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                    sortKey === opt.id ? 'text-nim bg-nim-active' : 'text-nim-muted hover:bg-nim-tertiary hover:text-nim'
                  }`}
                  onClick={() => {
                    setLayout({ sortKey: opt.id });
                    sortMenu.setIsOpen(false);
                  }}
                >
                  {sortKey === opt.id && <MaterialSymbol icon="check" size={13} />}
                  <span className={sortKey === opt.id ? '' : 'pl-[21px]'}>{opt.label}</span>
                </button>
              ))}
            </div>
          </FloatingPortal>
        )}

        <button
          onClick={() => void runFetch()}
          disabled={loading}
          className="flex items-center justify-center w-8 h-8 text-nim-muted hover:text-nim border border-nim rounded transition-colors shrink-0 disabled:opacity-50"
          title="Refresh"
          data-testid="pr-refresh-button"
        >
          <MaterialSymbol icon="refresh" size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {error ? (
          <div className="flex flex-col items-center justify-center py-10 px-5 text-nim-error gap-2 text-sm">
            <MaterialSymbol icon="error" size={28} className="opacity-70" />
            <span className="text-center">{error}</span>
            <button
              className="mt-1 text-xs text-nim-accent hover:underline"
              onClick={() => void runFetch()}
            >
              Retry
            </button>
          </div>
        ) : loading && prList.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-10 text-nim-muted text-sm">
            <div className="spinner w-5 h-5 border-[3px] border-nim-secondary border-t-nim-accent rounded-full animate-spin" />
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
                className="text-xs text-nim-accent hover:underline"
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
          visibleRows.map((pr) => (
            <PullRequestRow
              key={pr.id}
              pr={pr}
              selected={pr.id === selectedItemId}
              onSelect={handleSelect}
            />
          ))
        )}
      </div>
    </div>
  );
}
