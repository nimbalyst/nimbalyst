/**
 * A Pages section's Search: every page, and every typed page of a type placed
 * in the section's tree, as one table, laid out like the old Shared Home list (header with the search box,
 * a row of filter pills, the table, a footer count). The omnibox searches
 * titles here and page text through the section's search index, and turns a
 * field name into a filter clause (type, tags, author, updated, and the
 * chosen type's own fields).
 *
 * The whole state is one `pagesSearchQuery` string the host keeps: the web
 * console keeps it in the URL, the desktop in the tab. Rows come from the
 * host's pages and the tracker records under its `TrackersUIProvider`.
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { PageSearchRequest, PageSearchResponse } from '@nimbalyst/collab-protocol';
import { globalRegistry, type TrackerDataModel } from '@nimbalyst/tracker-schema';
import type { TrackerFilterSet } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerFilters';
import { getRecordTitle } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { TrackerFilterOmnibox, dispatchTrackerFocusSearch } from '../TrackerFilterOmnibox';
import { TrackerActiveFilterPills } from '../TrackerActiveFilterPills';
import { useTrackerDataSelector } from '../useTrackerData';
import { PAGES_BODY_LIMIT, usePagesBodyHits } from './usePagesBodyHits';
import {
  PLAIN_PAGE_TYPE,
  buildPagesFilterFields,
  buildPagesSearchRows,
  matchPagesQuery,
  matchesPagesFilters,
  narrowedType,
  pagesSearchQuery,
  parsePagesSearch,
  pageStatusLabel,
  placedTypeScope,
  bodyHitsHiddenByFilters,
  pagesBodySearchTypeIds,
  snippetRuns,
  type PagesSearchItemInput,
  type PagesSearchMatch,
  type PagesSearchPageInput,
  type PagesSearchState,
} from './pagesSearch';

export type PagesSearchLane = 'team' | 'personal';

/** How an open was asked for, so a host can open in a new tab on Cmd/Ctrl. */
export interface PagesOpenOptions {
  newTab: boolean;
}

export interface PagesSearchViewProps {
  lane: PagesSearchLane;
  /** The project name, or a project switcher, in the header. */
  title?: React.ReactNode;
  /** The section's pages, as its docs session lists them. */
  pages: readonly PagesSearchPageInput[];
  /** The types placed in the section's tree; only their typed pages are listed. */
  typePlacements: ReadonlyArray<{ typeId: string }>;
  /** A member id's email, so pages and typed pages share one Author filter. */
  memberEmail?: (memberId: string) => string | null | undefined;
  /** Who an author value (an email or member id) is, for the column and the filter. */
  authorLabel: (author: string) => string;
  /** The current user's email, for "is me" author filters. */
  me?: string | null;
  /** The current state, as a `pagesSearchQuery` string. */
  search: string;
  onSearchChange: (search: string, options: { replace: boolean }) => void;
  /** The section's page-text search (the docs session's `searchPages`); absent hides body matches. */
  searchPages?: (query: PageSearchRequest) => Promise<PageSearchResponse | null>;
  /** `newTab`: Cmd/Ctrl was held on the click. */
  onOpenPage: (documentId: string, options: PagesOpenOptions) => void;
  onOpenItem: (itemId: string, options: PagesOpenOptions) => void;
  /** Host controls beside the search box. */
  headerActions?: React.ReactNode;
}

type SortColumn = 'relevance' | 'name' | 'type' | 'status' | 'author' | 'updated';

/** Rows drawn at a time: a team's trackers can hold thousands of typed pages, and the table is not virtualized. */
const ROWS_PER_PAGE = 200;

/** Re-renders when a type is defined or changed, so rows and labels follow the registry. */
function useRegistryRevision(): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => globalRegistry.onChange(() => setRevision((value) => value + 1)), []);
  return revision;
}

function inLane(model: TrackerDataModel | undefined, lane: PagesSearchLane): boolean {
  return Boolean(model) && ((model!.sharing ?? 'personal') === 'team') === (lane === 'team');
}

function relativeTime(ms: number): string {
  if (!ms) return '';
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function PagesSearchView({
  lane,
  title,
  pages,
  typePlacements,
  memberEmail,
  authorLabel,
  me,
  search,
  onSearchChange,
  searchPages,
  onOpenPage,
  onOpenItem,
  headerActions,
}: PagesSearchViewProps): React.JSX.Element {
  const state = useMemo(() => parsePagesSearch(new URLSearchParams(search)), [search]);
  const update = (change: Partial<PagesSearchState>, replace = true) => onSearchChange(pagesSearchQuery({ ...state, ...change }), { replace });
  const records = useTrackerDataSelector((store) => store.records);
  const loaded = useTrackerDataSelector((store) => store.loaded);
  const registryRevision = useRegistryRevision();
  const [sort, setSort] = useState<{ column: SortColumn; descending: boolean }>({ column: 'relevance', descending: true });
  const [rowLimit, setRowLimit] = useState(ROWS_PER_PAGE);
  // A new search or sort starts from the top again.
  useEffect(() => setRowLimit(ROWS_PER_PAGE), [search, sort]);

  const typeLabel = useMemo(() => (typeId: string) => (typeId === PLAIN_PAGE_TYPE ? 'Page' : globalRegistry.get(typeId)?.displayName || typeId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registryRevision]);
  const rows = useMemo(() => buildPagesSearchRows(pages, records as readonly PagesSearchItemInput[], {
    inSection: placedTypeScope(typePlacements, (typeId) => inLane(globalRegistry.get(typeId), lane)),
    itemTitle: (item) => getRecordTitle(item as Parameters<typeof getRecordTitle>[0]),
    memberEmail,
  }),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [pages, typePlacements, records, lane, memberEmail, registryRevision]);
  const titleOf = useMemo(() => {
    const byId = new Map(rows.map((row) => [row.id, row.title]));
    return (id: string) => byId.get(id) ?? null;
  }, [rows]);

  const narrowed = narrowedType(state.filters);
  const placedTypeIds = useMemo(
    () => [...new Set(typePlacements.map((placement) => placement.typeId))].filter((typeId) => inLane(globalRegistry.get(typeId), lane)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [typePlacements, lane, registryRevision],
  );
  // Ask again when the section's pages change: a page added or edited since may match.
  const pagesRevision = useMemo(() => `${pages.length}:${pages.reduce((latest, page) => Math.max(latest, page.updatedAt ?? 0), 0)}`, [pages]);
  const body = usePagesBodyHits(state.query, searchPages, { typeIds: pagesBodySearchTypeIds(placedTypeIds, state.filters), pagesRevision });
  // Filter options come from the rows the query keeps, before any clause, so
  // every value the typeahead offers still has rows behind it.
  const queried = useMemo(() => matchPagesQuery(rows, state.query, body?.hits ?? null), [rows, state.query, body]);
  const fields = useMemo(() => buildPagesFilterFields(queried.map((match) => match.row), { type: typeLabel, author: authorLabel }, narrowed
    ? { typeId: narrowed, fields: globalRegistry.get(narrowed)?.fields ?? [], titleOf }
    : null), [queried, typeLabel, authorLabel, narrowed, titleOf]);
  const now = Date.now();
  const filtered = queried.filter((match) => matchesPagesFilters(match.row, state.filters, now, me));
  const shown = sortMatches(filtered, sort, typeLabel, authorLabel, Boolean(state.query.trim()));
  const hiddenByFilters = Boolean(body?.hits) && bodyHitsHiddenByFilters(body!.hits!, PAGES_BODY_LIMIT, new Set(filtered.map((match) => `${match.row.kind}:${match.row.id}`)));

  const setFilters = (filters: TrackerFilterSet) => update({ filters });
  const removeFilter = (index: number) => update({
    filters: { combinator: state.filters?.combinator ?? 'and', clauses: (state.filters?.clauses ?? []).filter((_, position) => position !== index) },
  });
  const toggleSort = (column: SortColumn) => setSort((current) => (current.column === column
    ? { column, descending: !current.descending }
    : { column, descending: column === 'updated' }));
  const open = (match: PagesSearchMatch, options: PagesOpenOptions) => (match.row.kind === 'page' ? onOpenPage(match.row.id, options) : onOpenItem(match.row.id, options));
  const sectionName = lane === 'team' ? 'Team' : 'Personal';
  const note = !state.query.trim() || !searchPages
    ? null
    : body?.status === 'partial'
      ? 'Still indexing page text; some text matches may be missing.'
      : body?.status === 'unavailable'
        ? 'Page text search is unavailable right now; showing title matches.'
        : hiddenByFilters
          ? 'Filters hid some text matches; more may match. Narrow the search text to see them.'
          : null;

  return (
    <div className="pages-search-view shared-docs-list-view flex h-full min-h-0 flex-col bg-nim select-text" data-testid="pages-search-view" data-lane={lane}>
      <div className="pages-search-header flex shrink-0 items-center gap-3 border-b border-nim px-4 py-2.5">
        <div className="pages-search-title flex min-w-0 shrink-0 items-center gap-2">
          <MaterialSymbol icon="manage_search" size={18} className="text-nim-muted" />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-[13px] font-medium text-nim">{title ?? sectionName}</span>
            <span className="truncate text-[11px] text-nim-faint">{title ? `${sectionName} search` : 'Search'}</span>
          </div>
        </div>
        <TrackerFilterOmnibox
          className="pages-search-omnibox mx-auto min-w-[180px] max-w-[520px] flex-1"
          placeholder="Search pages, or type a field name to filter"
          searchQuery={state.query}
          onSearchQueryChange={(query) => update({ query })}
          fields={fields}
          filters={state.filters}
          onFiltersChange={setFilters}
          showPills={false}
        />
        {headerActions}
      </div>
      {(Boolean(state.filters?.clauses.length) || note) && (
        <div className="pages-search-filters flex shrink-0 items-center gap-2 border-b border-nim px-4 py-2">
          <TrackerActiveFilterPills fields={fields} filters={state.filters} onManage={dispatchTrackerFocusSearch} onRemove={removeFilter} />
          {note && <span className="pages-search-note ml-auto text-[11.5px] text-nim-faint">{note}</span>}
        </div>
      )}
      <div className="pages-search-table min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <div className="pages-search-empty flex h-full flex-col items-center justify-center px-6 py-16 text-center">
            <MaterialSymbol icon={rows.length === 0 ? 'description' : 'search_off'} size={36} className="mb-2 text-nim-faint" />
            <p className="m-0 text-[13px] text-nim-muted">
              {rows.length === 0
                ? (loaded ? `No pages in ${sectionName} yet.` : 'Loading pages...')
                : 'Nothing matches. Remove a filter or change the search.'}
            </p>
          </div>
        ) : (
          <table className="w-full table-fixed border-collapse text-[13px]">
            <thead>
              <tr className="pages-search-thead sticky top-0 z-10 border-b border-nim bg-nim text-[11px] uppercase tracking-wide text-nim-muted">
                <SortHeader label="Name" column="name" sort={sort} onSort={toggleSort} className="pl-4" />
                <SortHeader label="Type" column="type" sort={sort} onSort={toggleSort} className="w-[130px]" />
                <SortHeader label="Status" column="status" sort={sort} onSort={toggleSort} className="w-[110px]" />
                <SortHeader label="Author" column="author" sort={sort} onSort={toggleSort} className="w-[140px]" />
                <SortHeader label="Updated" column="updated" sort={sort} onSort={toggleSort} className="w-[100px] pr-4" />
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, rowLimit).map((match) => (
                <PagesSearchRowView key={`${match.row.kind}:${match.row.id}`} match={match} typeLabel={typeLabel} authorLabel={authorLabel} onOpen={(options) => open(match, options)} />
              ))}
            </tbody>
          </table>
        )}
        {shown.length > rowLimit && (
          <div className="pages-search-more flex justify-center py-3">
            <button
              type="button"
              className="cursor-pointer rounded-md border border-nim bg-transparent px-3 py-1 text-[12px] text-nim hover:bg-nim-hover"
              onClick={() => setRowLimit((limit) => limit + ROWS_PER_PAGE)}
            >
              Show more
            </button>
          </div>
        )}
      </div>
      <div className="pages-search-footer flex shrink-0 items-center gap-2 border-t border-nim px-4 py-1.5 text-[11.5px] text-nim-muted">
        {shown.length > rowLimit ? `Showing ${rowLimit} of ${shown.length} matches` : `${shown.length} of ${rows.length} ${rows.length === 1 ? 'page' : 'pages'}`}
      </div>
    </div>
  );
}

function sortMatches(
  matches: PagesSearchMatch[],
  sort: { column: SortColumn; descending: boolean },
  typeLabel: (typeId: string) => string,
  authorLabel: (author: string) => string,
  hasQuery: boolean,
): PagesSearchMatch[] {
  // Relevance is the query's own order; with no query the rows are already newest first.
  if (sort.column === 'relevance' || (!hasQuery && sort.column === 'updated' && sort.descending)) return matches;
  const text = (match: PagesSearchMatch): string => {
    switch (sort.column) {
      case 'type': return typeLabel(match.row.typeId);
      case 'status': return match.row.status ? pageStatusLabel(match.row.status) : '';
      case 'author': return match.row.author ? authorLabel(match.row.author) : '';
      default: return match.row.title;
    }
  };
  const sorted = [...matches].sort((a, b) => (sort.column === 'updated'
    ? a.row.updated - b.row.updated
    : text(a).localeCompare(text(b), undefined, { numeric: true })));
  return sort.descending ? sorted.reverse() : sorted;
}

function SortHeader({ label, column, sort, onSort, className = '' }: {
  label: string;
  column: SortColumn;
  sort: { column: SortColumn; descending: boolean };
  onSort: (column: SortColumn) => void;
  className?: string;
}) {
  const active = sort.column === column;
  return (
    <th className={`pages-search-th px-2 py-1.5 text-left font-medium ${className}`} aria-sort={active ? (sort.descending ? 'descending' : 'ascending') : 'none'}>
      <button type="button" className="inline-flex cursor-pointer items-center gap-0.5 border-none bg-transparent p-0 uppercase tracking-wide text-inherit hover:text-nim" onClick={() => onSort(column)}>
        {label}
        {active && <MaterialSymbol icon={sort.descending ? 'arrow_downward' : 'arrow_upward'} size={12} />}
      </button>
    </th>
  );
}

function PagesSearchRowView({ match, typeLabel, authorLabel, onOpen }: {
  match: PagesSearchMatch;
  typeLabel: (typeId: string) => string;
  authorLabel: (author: string) => string;
  onOpen: (options: PagesOpenOptions) => void;
}) {
  const { row, snippet } = match;
  const model = row.kind === 'typed' ? globalRegistry.get(row.typeId) : undefined;
  return (
    <tr
      className="pages-search-row group cursor-pointer border-b border-nim hover:bg-nim-hover"
      data-row-kind={row.kind}
      data-row-id={row.id}
      tabIndex={0}
      onClick={(event) => onOpen({ newTab: event.metaKey || event.ctrlKey })}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onOpen({ newTab: event.metaKey || event.ctrlKey });
      }}
    >
      <td className="py-2 pl-4 pr-2 align-top">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-px flex size-6 shrink-0 items-center justify-center rounded-md bg-nim-secondary text-nim-muted">
            <MaterialSymbol icon={model?.icon || 'description'} size={15} style={model?.color ? { color: model.color } : undefined} />
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[13.5px] text-nim">{row.title}</span>
              {row.issueKey && <span className="shrink-0 text-[11.5px] text-nim-faint">{row.issueKey}</span>}
            </div>
            {!snippet && row.summary && (
              <div className="pages-search-summary mt-0.5 truncate text-[12px] text-nim-muted">{row.summary}</div>
            )}
            {snippet && (
              <div className="pages-search-snippet mt-0.5 line-clamp-2 text-[12px] text-nim-muted">
                {snippetRuns(snippet.text, snippet.highlights).map((run, index) => (run.hit
                  ? <mark key={index} className="rounded-sm bg-[color-mix(in_srgb,var(--nim-primary)_22%,transparent)] px-px text-nim">{run.text}</mark>
                  : <span key={index}>{run.text}</span>))}
              </div>
            )}
          </div>
        </div>
      </td>
      <td className="px-2 py-2 align-top">
        <span className="pages-search-type-chip inline-block max-w-full truncate whitespace-nowrap rounded-md bg-nim-secondary px-1.5 py-0.5 align-top text-[11.5px] font-medium text-nim-muted">
          {typeLabel(row.typeId)}
        </span>
      </td>
      <td className="truncate px-2 py-2 align-top text-nim-muted">{row.status ? pageStatusLabel(row.status) : ''}</td>
      <td className="truncate px-2 py-2 align-top text-nim-muted">{row.author ? authorLabel(row.author) : ''}</td>
      <td className="truncate py-2 pl-2 pr-4 align-top text-nim-muted">{relativeTime(row.updated)}</td>
    </tr>
  );
}
