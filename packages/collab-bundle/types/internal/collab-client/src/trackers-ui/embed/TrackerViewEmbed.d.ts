/**
 * A tracker view drawn live from the items, in its own mode with its own
 * filters -- e.g. a type page's built-in "All" table. The host mounts it inside
 * a `TrackersUIProvider` and passes how to open the view and an item.
 *
 * Loaded lazily (`LazyTrackerViewEmbed`): it pulls in the list, grid and board
 * surfaces, and a surface that shows no view must not pay for them.
 */
import { type JSX, type ReactNode } from 'react';
import type { CollabOpenOptions } from '../../core/index';
import { type SavedView } from '../../trackers/index';
import { type TrackerGridDerivedColumn } from '../grid/TrackerGridSurface';
import './ViewEmbedHeader.css';
/**
 * A table's body fitted to its rows (compact grid: 32px rows under a header),
 * between `min` and `max`. Past `max` the grid scrolls inside.
 */
export declare function fitTableBodyHeight(rowCount: number, min: number, max: number): number;
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
export declare const TRACKER_EMBEDS_READ_ONLY_ATTRIBUTE = "data-tracker-embeds-read-only";
/** Draws a view the caller supplies, without looking it up among the saved views. */
export declare function TrackerViewEmbed({ view, onOpenAsTable, onOpenItem, variant, height, derivedColumns, typeIds, readOnly, headerActions, headerNotice, hiddenColumns, onSortChange, onWidthsChange, }: TrackerViewEmbedProps): JSX.Element;
