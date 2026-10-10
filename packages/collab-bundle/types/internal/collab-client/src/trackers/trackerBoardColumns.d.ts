/**
 * Pure board-column derivation and drop resolution. `none` retains the legacy
 * status board, status columns preserve schema order, and other axes end with
 * an empty bucket that can remove relationship membership.
 */
import type { TrackerRecord } from '../../../runtime/src/core/TrackerRecord';
import type { TrackerRelationshipValue } from '../../../tracker-schema/src/browser';
import { type TrackerGroupBy, type TrackerGroupingAxis, type TrackerOrdering, type TrackerRelationshipLabelResolver } from './model';
import type { TrackerStatusScope } from './model';
export interface TrackerBoardColumn {
    /**
     * Stable column key. On the status axis this is the bare status value, so the
     * board's long-standing `tracker-kanban-column-<status>` markers are unchanged;
     * on every other axis it is the grouping resolver's namespaced key.
     */
    key: string;
    /** Stored value this column represents, or null for the trailing empty bucket. */
    value: string | null;
    label: string;
    /** True only for the trailing no-value bucket ("No milestone", "Unassigned"). */
    empty: boolean;
    /**
     * The denormalized relationship value a relationship column was derived from.
     * Carried so a drop rewrites the same `title`/`issueKey` other surfaces already
     * display, rather than a label reconstructed from whatever survived.
     */
    ref?: TrackerRelationshipValue;
    fieldValue?: unknown;
}
/** The axis the board actually lays out; `none` is a status board. */
export declare function resolveBoardAxis(groupBy: TrackerGroupBy): TrackerGroupingAxis;
/** The board's columns, left to right. */
export declare function buildTrackerBoardColumns(groupBy: TrackerGroupBy, filterType: string, items: TrackerRecord[], 
/** Names relationship lanes from the referenced record; see the resolver's docs. */
resolveLabel?: TrackerRelationshipLabelResolver, 
/**
 * Lifecycle scope. On `open`, terminal lanes are dropped -- the scope has
 * already removed their cards, so leaving the lanes would render a row of
 * permanently empty columns pushing the working ones off screen.
 * `all` and `closed` keep every lane the schema declares.
 */
statusScope?: TrackerStatusScope): TrackerBoardColumn[];
/**
 * Distribute items into columns, sorted within each.
 *
 * A multi-value axis (tags, and an item in several milestones) intentionally
 * places the same card in every column it belongs to.
 */
export declare function groupItemsIntoBoardColumns(items: TrackerRecord[], columns: TrackerBoardColumn[], axis: TrackerGroupingAxis, ordering: TrackerOrdering): Record<string, TrackerRecord[]>;
/** Order one column's cards by the view's ordering. */
export declare function sortBoardColumnItems(items: TrackerRecord[], ordering: TrackerOrdering): TrackerRecord[];
export interface BoardDropRequest {
    item: TrackerRecord;
    axis: TrackerGroupingAxis;
    /**
     * Key of the column the drag started in, or `null` when the caller cannot say.
     *
     * A multi-value axis renders the same card in every lane it belongs to, so
     * "is the card already in the target column?" does not answer "did this drag
     * cross lanes?" -- a card in Alpha and Beta is in Beta both before and after
     * you drag its Alpha copy there, and reading that as "stayed put" makes the
     * drag a no-op that leaves Alpha behind. Only the source key separates a
     * reorder within one lane from a reassignment between two lanes the card
     * already occupies. `null` falls back to the membership test, which is right
     * for every single-value axis.
     */
    sourceColumnKey: string | null;
    targetColumn: TrackerBoardColumn;
    /** The target column's cards as rendered, including the dragged one. */
    columnItems: TrackerRecord[];
    /** Insertion index measured against `columnItems`; null means "at the end". */
    dropIndex: number | null;
}
/**
 * Everything one drop writes: the new `kanbanSortOrder`, plus the axis field
 * when the card crossed columns. `null` means the drop writes nothing -- the
 * axis is not draggable, so moving the card there would change nothing a
 * reader could see.
 */
export declare function resolveBoardDrop(request: BoardDropRequest): Record<string, unknown> | null;
/**
 * The field updates a drop into `target` must write, or `null` when the axis
 * cannot be reassigned by dragging.
 *
 * `type`, `tag`, and `assignee` return null: a lane's key for those is a derived
 * or lossy form (a lowercased identity, one of several tags), and writing it
 * back would be a guess. Grouping by them still works -- a card just cannot be
 * dragged out of its lane. Dropping into a scalar axis's empty bucket is a
 * no-op for the same reason; only the relationship axes have a defined
 * "belongs to nothing".
 */
export declare function resolveBoardColumnWrite(item: TrackerRecord, axis: TrackerGroupingAxis, target: TrackerBoardColumn): Record<string, unknown> | null;
