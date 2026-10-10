/**
 * Translates the tracker column registry into RevoGrid columns and rows.
 *
 * Source rows carry the *raw stored values* (not display strings) so cell
 * editors seed from real values and sorting/comparison stay type-correct;
 * `cellTemplate` is responsible for turning those into display text.
 */
import type { ColumnRegular } from '@revolist/revogrid';
import { type TrackerColumnDef } from '../../../../runtime/src/plugins/TrackerPlugin/components/trackerColumns';
import { type TrackerRelationshipLabelResolver } from '../../../../runtime/src/plugins/TrackerPlugin/models/index';
import { type TrackerEditorContext } from './trackerGridEditors';
import { buildGridSource, ROW_ACTIONS, ROW_ITEM_ID, ROW_ITEM_TYPE } from '../../trackers/index';
export { buildGridSource, ROW_ACTIONS, ROW_ITEM_ID, ROW_ITEM_TYPE };
/** Human-readable text for a stored value, by column render type. */
export declare function formatValue(col: TrackerColumnDef, value: unknown, trackerType: string, resolveLabel?: TrackerRelationshipLabelResolver): string;
export interface FavoritesOptions {
    favoriteItemIds: ReadonlySet<string>;
    onToggleFavorite: (itemId: string) => void;
}
/** Turns the Key cell into the row's open affordance; omit to leave it plain text. */
export interface KeyLinkOptions {
    /** Clicking the key opens the row in the detail pane. */
    onOpenDetail: (itemId: string) => void;
    /** Hover affordance inside the key cell; omit where documents are unavailable. */
    onOpenDocument?: (itemId: string) => void;
}
export interface BuildGridColumnsOptions {
    /** Active tracker type; `'all'` means a mixed-type view. */
    trackerType: string;
    /** Persisted per-column width overrides. */
    columnWidths?: Record<string, number>;
    /** Whether this record's cells may be edited at all (source/permission gate). */
    isRowEditable: (itemId: string) => boolean;
    /** Extra context handed to editors (relationship candidates). */
    editorContext?: TrackerEditorContext;
    /** Column ids that currently have an active filter, for the header indicator. */
    filteredColumnIds?: ReadonlySet<string>;
    /** Open the column filter popover, anchored to the clicked header cell. */
    onOpenFilter?: (columnId: string, anchorRect: DOMRect) => void;
    /** Let RevoGrid own sortable header clicks and its built-in sort indicator. */
    sortingEnabled?: boolean;
    /** Renders the favorite star in the title cell; omit to hide it. */
    favorites?: FavoritesOptions;
    /** Also renders the overflow trigger inside the title cell. */
    rowActions?: boolean;
    /** Makes the Key cell the row's open affordance. */
    keyLink?: KeyLinkOptions;
    /** Names a relationship target from the live record rather than the link snapshot. */
    resolveRelationshipLabel?: TrackerRelationshipLabelResolver;
}
/** Always-present trailing action column, separate from editable tracker fields. */
export declare function buildGridActionsColumn(): ColumnRegular;
/** A read-only text column whose value the host computed into the row under `id`. */
export declare function buildDerivedGridColumn(column: {
    id: string;
    label: string;
    width?: number;
}): ColumnRegular;
/**
 * Map visible tracker columns to RevoGrid columns, attaching the per-field
 * editor and a per-cell readonly gate.
 */
export declare function buildGridColumns(columns: TrackerColumnDef[], { trackerType, columnWidths, isRowEditable, editorContext, filteredColumnIds, onOpenFilter, sortingEnabled, favorites, rowActions, keyLink, resolveRelationshipLabel: resolveLabel, }: BuildGridColumnsOptions): ColumnRegular[];
