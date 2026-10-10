/**
 * The table view: rows through RevoGrid, columns through the shared registry.
 *
 * Kept deliberately thin. `TrackerGridView` on desktop is a thousand lines
 * because it also owns an undo stack, a range-edit clipboard, a row context
 * menu, and a bulk-archive path -- none of which are what makes a tracker
 * readable in a browser tab, and all of which would have to be re-proved against
 * a different mutation path. What is shared is the part that must never fork:
 * `buildGridColumns` / `buildGridSource`, which decide what a cell contains and
 * how it compares, and the gesture that separates opening a row from editing a
 * cell (`handleCellFocus`) -- a table where click means something different in
 * the browser than on the desktop is worse than either answer alone.
 *
 * RevoGrid is a Stencil web component and its custom elements register
 * globally, so the host page owns exactly one copy (externalized peer,
 * `optimizeDeps.exclude`). A second copy under a different Vite `?v=` hash does
 * not throw -- it renders a blank grid with a clean console (NIM-2165). If this
 * surface is empty and the row count is not, look there first.
 */
import React from 'react';
import type { TrackerRecord } from '../../../../runtime/src/core/TrackerRecord';
import { type TypeColumnConfig } from '../../../../runtime/src/plugins/TrackerPlugin/components/trackerColumns';
import { type TrackerFilterSet, type TrackerRelationshipLabelResolver } from '../../../../runtime/src/plugins/TrackerPlugin/models/index';
import { type SortColumn, type SortDirection } from '../../trackers/index';
import './trackerGrid.css';
import { type GridViewSettings } from './useGridViewSettings';
export interface TrackerGridSurfaceProps extends GridViewSettings {
    rows: TrackerRecord[];
    /** `'all'` for a mixed-type grid; a tracker type resolves one schema. */
    trackerType: string;
    columnConfig?: TypeColumnConfig | null;
    sortBy?: SortColumn;
    sortDirection?: SortDirection;
    columnFilters?: TrackerFilterSet | null;
    onColumnFiltersChange?: (filters: TrackerFilterSet) => void;
    /** Names a relationship target from the live record rather than the link snapshot. */
    resolveRelationshipLabel?: TrackerRelationshipLabelResolver;
    /** Omit to render a read-only grid; a permission state, not a milestone. */
    isRowEditable?: (itemId: string) => boolean;
    /** One callback for one cell or a whole pasted range; hosts can batch it. */
    onItemsUpdate?: (entries: readonly TrackerGridUpdateEntry[]) => Promise<unknown> | unknown;
    /** The row the detail pane is showing; highlighted here so the table agrees. */
    selectedItemId?: string | null;
    /** Opens a row into the host's detail. See `handleCellFocus` for the gesture. */
    onOpenItem?: (itemId: string) => void;
    /**
     * Right-click on a row, and the click on its overflow button.
     *
     * Supplying this is what adds the pinned trailing overflow column: that cell
     * dispatches a synthetic `contextmenu` for a host row menu to catch, so a
     * host without a menu would get an inert button and a permanently empty
     * column at the right edge of every row. It used to be a separate
     * `rowActions` boolean and the two could disagree -- the column shipped
     * switched off precisely because nothing was listening. Now the listener *is*
     * the switch.
     *
     * `itemIds` is the right-clicked row, or the whole selected range when that
     * row is inside one, so a host can offer an action over several items.
     */
    onRowContextMenu?: (payload: {
        itemIds: string[];
        point: {
            x: number;
            y: number;
        };
    }) => void;
    /** False until the first snapshot resolves. */
    loaded: boolean;
    /** Read-only columns the host computes per row (a type page's Where), after the field columns unless placed with `after`. */
    derivedColumns?: readonly TrackerGridDerivedColumn[];
}
export interface TrackerGridDerivedColumn {
    /** Row key; must not collide with a field column id. */
    id: string;
    label: string;
    width?: number;
    /** Field column id to sit right after; appended when that column is not shown. */
    after?: string;
    value: (row: TrackerRecord) => string;
}
export interface TrackerGridUpdateEntry {
    itemId: string;
    updates: Record<string, unknown>;
}
export declare function TrackerGridSurface({ rows, trackerType, columnConfig, sortBy, sortDirection, sortColumns, onSortChange, onWidthsChange, columnFilters, onColumnFiltersChange, resolveRelationshipLabel, isRowEditable, onItemsUpdate, selectedItemId, onOpenItem, onRowContextMenu, loaded, derivedColumns, }: TrackerGridSurfaceProps): React.JSX.Element;
