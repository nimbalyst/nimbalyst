/**
 * A tracker view drawn live from the items, in its own mode with its own
 * filters -- e.g. a type page's built-in "All" table. The host mounts it inside
 * a `TrackersUIProvider` and passes how to open the view and an item.
 *
 * Loaded lazily (`LazyTrackerViewEmbed`): it pulls in the list, grid and board
 * surfaces, and a surface that shows no view must not pay for them.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import type { CollabOpenOptions } from '@nimbalyst/collab-client/core';
import { computeReadiness } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerReadiness';
import { globalRegistry, groupTrackerRecordsByAxis } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { getRecordStatus, getRecordTitle } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { selectArchivedForView, type SavedView, type SavedViewDefinition, type TrackerIdentity } from '@nimbalyst/collab-client/trackers';
import { useTrackersUI } from '../TrackersUIProvider';
import { useTrackerDataSelector } from '../useTrackerData';
import { useTrackerViewRows } from '../useTrackerViewRows';
import { resolveViewMode } from '../resolveViewMode';
import { TrackerTimelineView } from '../TrackerTimelineView';
import { TrackerListView } from '../TrackerListView';
import { TrackerBoardSurface } from '../board/TrackerBoardSurface';
import { TrackerGridSurface, type TrackerGridDerivedColumn, type TrackerGridUpdateEntry } from '../grid/TrackerGridSurface';
import { ViewCardFields } from './ViewCardFields';
import { ViewNewItem } from './ViewNewItem';
import { createViewItem } from './createViewItem';
import { isViewRecordEditable, writeViewEdits } from './viewItemEdits';

import './ViewEmbedHeader.css';

const DEFAULT_BODY_HEIGHT_PX = 420;

/**
 * A table's body fitted to its rows (compact grid: 32px rows under a header),
 * between `min` and `max`. Past `max` the grid scrolls inside.
 */
export function fitTableBodyHeight(rowCount: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, 42 + rowCount * 32));
}
const MODE_LABEL: Record<string, string> = {
  list: 'list', table: 'table', kanban: 'board',
  timeline: 'timeline', radar: 'list', 'tag-board': 'list', inbox: 'list',
};

function describeQuery(definition: SavedViewDefinition, mode: string): string {
  const model = definition.selectedType === 'all' ? null : globalRegistry.get(definition.selectedType);
  const subject = definition.selectedType === 'all'
    ? 'All items'
    : model?.displayNamePlural || definition.selectedType;
  const filters = definition.activeFilters.length
    + definition.tagFilter.length
    + (definition.columnFilters?.clauses.length ?? 0);
  return `${subject} · ${MODE_LABEL[mode] ?? mode}${filters > 0 ? ` · ${filters} filter${filters === 1 ? '' : 's'}` : ''}`;
}

export interface TrackerViewEmbedProps {
  /** A view the host already holds, saved or synthetic (e.g. a type page's built-in "All"). */
  view: SavedView;
  onOpenAsTable?: (view: SavedView) => void;
  onOpenItem?: (itemId: string, options?: CollabOpenOptions) => void;
  /**
   * `card` is the bordered block a document embeds at a fixed height; `page`
   * drops the card chrome and fills its container, for a tab that is the view.
   */
  variant?: 'card' | 'page';
  /**
   * Body height in pixels for the `card` variant. Unset, an ungrouped table
   * fits its rows up to the default height and other modes use the default.
   */
  height?: number;
  /** Read-only columns after the fields, in table mode (a type page's Where). */
  derivedColumns?: readonly TrackerGridDerivedColumn[];
  /**
   * Items of any of these types, instead of the view's one type: a type page
   * lists its subtypes' items too. The view's type still picks the columns.
   */
  typeIds?: readonly string[];
  /** Table cells edit their items unless this is set (or the host has no data source). */
  readOnly?: boolean;
  headerActions?: ReactNode;
  headerNotice?: ReactNode;
  hiddenColumns?: readonly string[];
  onSortChange?: (field: string, direction: 'asc' | 'desc') => void;
  onWidthsChange?: (widths: Record<string, number>) => void;
}

/**
 * A host marks a subtree read-only by setting this attribute to "true" on any
 * ancestor element. It reaches embeds the host does not construct itself (a
 * type page's table, views placed in a page body, which the editor paints in
 * its own React root), where no prop can be threaded through.
 */
export const TRACKER_EMBEDS_READ_ONLY_ATTRIBUTE = 'data-tracker-embeds-read-only';

/** Draws a view the caller supplies, without looking it up among the saved views. */
export function TrackerViewEmbed({
  view,
  onOpenAsTable,
  onOpenItem,
  variant = 'card',
  height,
  derivedColumns,
  typeIds,
  readOnly,
  headerActions,
  headerNotice,
  hiddenColumns,
  onSortChange,
  onWidthsChange,
}: TrackerViewEmbedProps): JSX.Element {
  const { identity, capabilities, dataSource } = useTrackersUI();
  const anchor = useRef<HTMLDivElement>(null);
  const [hostReadOnly, setHostReadOnly] = useState(false);
  const readHostReadOnly = useCallback(
    () => Boolean(anchor.current?.closest(`[${TRACKER_EMBEDS_READ_ONLY_ATTRIBUTE}="true"]`)),
    [],
  );
  // Before paint, so a read-only host never shows an editable frame.
  useLayoutEffect(() => {
    setHostReadOnly(readHostReadOnly());
  }, [readHostReadOnly]);
  /**
   * Re-read at write time: the mount-time check cannot see an ancestor marked
   * read-only later, and a callback captured before that (a portal button, an
   * open editor) must refuse too. Flips the frame read-only as it refuses.
   */
  const refuseIfHostReadOnly = useCallback((): void => {
    if (!readHostReadOnly()) return;
    setHostReadOnly(true);
    throw new Error('This view is read-only here.');
  }, [readHostReadOnly]);
  const writable = !readOnly && !hostReadOnly && dataSource !== null;
  const records = useTrackerDataSelector((state) => state.records);
  const loaded = useTrackerDataSelector((state) => state.loaded);
  const writeEdits = useCallback(
    async (entries: readonly TrackerGridUpdateEntry[]) => {
      refuseIfHostReadOnly();
      if (dataSource) await writeViewEdits(dataSource, entries);
    },
    [dataSource, refuseIfHostReadOnly],
  );
  return (
    <div ref={anchor} className="tracker-view-embed-host" style={{ display: 'contents' }}>
    <LoadedViewEmbed
      view={view}
      records={records}
      loaded={loaded}
      identity={identity}
      renderableViewModes={capabilities.renderableViewModes}
      onOpenAsTable={onOpenAsTable}
      onOpenItem={onOpenItem}
      height={height}
      variant={variant}
      derivedColumns={derivedColumns}
      typeIds={typeIds}
      headerActions={headerActions}
      headerNotice={headerNotice}
      hiddenColumns={hiddenColumns}
      onSortChange={onSortChange}
      onWidthsChange={onWidthsChange}
      onItemsUpdate={writable ? writeEdits : undefined}
      onCreate={!writable || !dataSource || view.definition.selectedType === 'all' ? undefined : async (title, fields, requestId) => {
        refuseIfHostReadOnly();
        await createViewItem(dataSource, view.definition, title, fields, requestId);
      }}
    />
    </div>
  );
}

function LoadedViewEmbed({
  view,
  records,
  loaded,
  identity,
  renderableViewModes,
  onOpenAsTable,
  onOpenItem,
  height,
  variant,
  derivedColumns,
  typeIds,
  onItemsUpdate,
  onCreate,
  headerActions,
  headerNotice,
  hiddenColumns,
  onSortChange,
  onWidthsChange,
}: {
  view: SavedView;
  records: TrackerRecord[];
  loaded: boolean;
  identity: TrackerIdentity | null;
  renderableViewModes: ReadonlySet<SavedViewDefinition['viewMode']>;
  onOpenAsTable?: (view: SavedView) => void;
  onOpenItem?: (itemId: string, options?: CollabOpenOptions) => void;
  height?: number;
  variant: 'card' | 'page';
  derivedColumns?: readonly TrackerGridDerivedColumn[];
  typeIds?: readonly string[];
  onItemsUpdate?: (entries: readonly TrackerGridUpdateEntry[]) => Promise<void>;
  headerActions?: ReactNode;
  headerNotice?: ReactNode;
  hiddenColumns?: readonly string[];
  onSortChange?: (field: string, direction: 'asc' | 'desc') => void;
  onWidthsChange?: (widths: Record<string, number>) => void;
  onCreate?: (title: string, fields?: Record<string, unknown>, requestId?: string) => Promise<void>;
}): JSX.Element {
  const { definition } = view;
  // Readiness is a property of the whole dependency graph, so it reads every record.
  const readinessByItemId = useMemo(() => computeReadiness(records, getRecordStatus), [records]);
  const typeKey = typeIds?.join('\u001f');
  const scoped = useMemo(() => {
    // An archived item is out of every view that does not ask for it, as in
    // Tracker mode; a type page then drops a typed page once it is archived.
    const active = selectArchivedForView(records, definition);
    if (!typeIds) return { records: active, definition };
    const wanted = new Set(typeIds);
    return {
      records: active.filter((record) => record.typeTags.some((tag) => wanted.has(tag))),
      definition: { ...definition, selectedType: 'all' },
    };
    // typeKey stands for typeIds, which callers rebuild on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, definition, typeKey]);
  const { rows } = useTrackerViewRows(scoped.records, scoped.definition, { identity, readinessByItemId });
  const { mode } = resolveViewMode(definition.viewMode, { renderableViewModes });
  const titles = useMemo(() => new Map(records.map((record) => [record.id, getRecordTitle(record).trim()])), [records]);
  const resolveRelationshipLabel = useCallback((itemId: string) => titles.get(itemId) || undefined, [titles]);
  const openItem = useCallback((itemId: string, options?: CollabOpenOptions) => onOpenItem?.(itemId, options), [onOpenItem]);
  const byId = useMemo(() => new Map(records.map((record) => [record.id, record])), [records]);
  const isRowEditable = useCallback((itemId: string) => {
    const record = byId.get(itemId);
    return record ? isViewRecordEditable(record) : false;
  }, [byId]);

  let body: ReactNode;
  switch (mode) {
    case 'table': {
      const grid = (groupRows: TrackerRecord[]) => (
        <TrackerGridSurface
          rows={groupRows}
          trackerType={definition.selectedType}
          columnConfig={definition.columnConfig}
          sortBy={definition.sortBy}
          sortDirection={definition.sortDirection}
          sortColumns={definition.sortColumns}
          onSortChange={onSortChange}
          onWidthsChange={onWidthsChange}
          columnFilters={definition.columnFilters}
          resolveRelationshipLabel={resolveRelationshipLabel}
          onOpenItem={onOpenItem}
          loaded={loaded}
          derivedColumns={derivedColumns}
          isRowEditable={onItemsUpdate ? isRowEditable : undefined}
          onItemsUpdate={onItemsUpdate}
        />
      );
      body = definition.groupBy === 'none' || !rows.length ? grid(rows) : <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {groupTrackerRecordsByAxis(rows, definition.groupBy, resolveRelationshipLabel).map(group => <details key={group.key} open className="border-b border-nim">
          <summary className="cursor-pointer bg-nim-secondary px-3 py-2 text-xs">{group.label} · {group.items.length}</summary>
          <div style={{ height: fitTableBodyHeight(group.items.length, 100, 360) }}>{grid(group.items)}</div>
        </details>)}
      </div>;
      break;
    }
    case 'kanban':
      body = (
        <TrackerBoardSurface
          rows={rows}
          trackerType={definition.selectedType}
          groupBy={definition.groupBy}
          ordering={definition.ordering}
          statusScope={definition.statusScope}
          resolveRelationshipLabel={resolveRelationshipLabel}
          onOpenItem={openItem}
          currentIdentity={identity}
          sortDirection={definition.sortDirection}
          onCreateItem={onCreate}
          hiddenColumns={hiddenColumns}
          preserveRowOrder={!!definition.sortColumns?.length}
          renderCardFields={definition.columnConfig ? item => <ViewCardFields item={item} columns={definition.columnConfig!.visibleColumns} resolveLabel={resolveRelationshipLabel} /> : undefined}
          onItemUpdate={onItemsUpdate ? (item, updates) => {
            if (!isViewRecordEditable(item)) return Promise.reject(new Error('This item is read-only'));
            return onItemsUpdate([{ itemId: item.id, updates }]);
          } : undefined}
        />
      );
      break;
    case 'timeline':
      body = <TrackerTimelineView fields={definition.timelineFields} items={rows} groupBy={definition.groupBy} ordering={definition.ordering} onItemSelect={openItem} resolveRelationshipLabel={resolveRelationshipLabel} />;
      break;
    default:
      body = (
        <TrackerListView
          rows={!definition.sortColumns?.length && definition.ordering !== 'manual' && definition.sortDirection === 'desc' ? [...rows].reverse() : rows}
          groupBy={definition.groupBy}
          showType={definition.selectedType === 'all'}
          onOpenItem={openItem}
          loaded={loaded}
        />
      );
  }

  const isPage = variant === 'page';
  // Before the items load the row count says nothing, so keep the default rather than collapse.
  const fitsRows = mode === 'table' && definition.groupBy === 'none' && loaded;
  const bodyHeight = height ?? (fitsRows ? fitTableBodyHeight(rows.length, 120, DEFAULT_BODY_HEIGHT_PX) : DEFAULT_BODY_HEIGHT_PX);
  return (
    <div
      className={isPage
        ? 'tracker-saved-view-embed tracker-saved-view-embed--page flex min-h-0 flex-1 flex-col overflow-hidden'
        : 'tracker-saved-view-embed my-3 flex flex-col overflow-hidden rounded-lg border border-nim bg-nim-secondary'}
      data-testid="tracker-saved-view-embed"
      data-view-id={view.id}
      data-view-mode={mode}
      contentEditable={false}
    >
      {isPage && !headerActions ? null : (
        <div className="tracker-saved-view-embed-head flex shrink-0 items-center gap-2.5 border-b border-nim px-3 py-1.5 text-xs">
          <span className="min-w-0 truncate font-medium text-nim" title={view.name}>{view.name}</span>
          <span className="placed-view-query min-w-0 truncate rounded bg-nim-tertiary px-2 py-0.5 font-mono text-[11px] text-nim-muted">
            {describeQuery(definition, mode)}
          </span>
          <div className="tracker-saved-view-embed-actions ml-auto flex shrink-0 items-center gap-2.5">
            <span className="placed-view-live flex shrink-0 items-center gap-1.5 text-[11px] text-nim-success">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--nim-success)]" aria-hidden />
              live
            </span>
            {headerActions}
          </div>
        </div>
      )}
      {headerNotice}
      <div
        className={isPage
          ? 'tracker-saved-view-embed-body flex min-h-0 flex-1 flex-col bg-nim'
          : 'tracker-saved-view-embed-body flex min-h-0 flex-col bg-nim'}
        style={isPage ? undefined : { height: bodyHeight }}
        data-placed-view-body={isPage ? undefined : ''}
      >
        {body}
      </div>
      {onCreate && mode !== 'kanban' ? <ViewNewItem onCreate={(title, requestId) => onCreate(title, undefined, requestId)} /> : null}
      <div className="tracker-saved-view-embed-foot flex items-center gap-3.5 px-3 py-1.5 text-[11px] text-nim-faint">
        <span>{rows.length} {rows.length === 1 ? 'item' : 'items'}</span>
        {onOpenAsTable ? (
          <button
            type="button"
            className="ml-auto cursor-pointer border-none bg-transparent p-0 text-[11px] text-nim-link hover:underline"
            data-testid="tracker-saved-view-embed-open"
            onClick={() => onOpenAsTable(view)}
          >
            Open as table
          </button>
        ) : null}
      </div>
    </div>
  );
}
