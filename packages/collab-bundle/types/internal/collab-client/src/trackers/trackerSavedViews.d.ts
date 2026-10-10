/**
 * Saved-view definitions and the pure filter/group logic behind them (NIM-788).
 *
 * A saved view is a named snapshot of the tracker view state — which type is
 * selected, which filter chips are active, the display mode, an optional tag
 * filter, and how items are grouped. Definitions are persisted per workspace
 * via the workspace-settings store (see store/atoms/trackers.ts); this module
 * holds only the types and the pure, side-effect-free filter/group functions so
 * they can be unit-tested without React or IPC.
 */
import type { TrackerRecord } from '../../../runtime/src/core/TrackerRecord';
import type { TrackerIdentity } from '../../../runtime/src/core/DocumentService';
import { type TrackerFilterSet, type TrackerFieldFilter } from '../../../runtime/src/plugins/TrackerPlugin/models/trackerFilters';
import type { Readiness } from '../../../runtime/src/plugins/TrackerPlugin/models/trackerReadiness';
import { type SortColumn, type SortDirection, type TrackerFilterChip, type TrackerGroupBy, type TrackerRecordGroup, type TrackerOrdering, type TrackerStatusScope, type TypeColumnConfig } from './model';
import { type TrackerViewMode } from './trackerViewModes';
export declare const STATUS_CHANGED_TO_FILTER_FIELD = "statusChangedTo";
export declare const STATUS_CHANGED_FROM_FILTER_FIELD = "statusChangedFrom";
export interface SavedViewDefinition {
    /** Selected type filter: `'all'` or a specific tracker type. */
    selectedType: string;
    /** Active filter chips (intersection). */
    activeFilters: TrackerFilterChip[];
    /** Display mode. */
    viewMode: TrackerViewMode;
    /** Tag filter (OR match); empty = no tag filter. */
    tagFilter: string[];
    /** Grouping for grouped renderings. */
    groupBy: TrackerGroupBy;
    /** Board/list ordering: manual kanban order, or a sortable field id. */
    ordering: TrackerOrdering;
    /** Flat list/table sort column. */
    sortBy: SortColumn;
    /** Flat list/table sort direction. */
    sortDirection: SortDirection;
    /** Ordered field sorts for placed views; empty uses the legacy single sort. */
    sortColumns?: Array<{
        field: string;
        direction: SortDirection;
    }>;
    /** Explicit timeline dates; absent preserves automatic date discovery. */
    timelineFields?: {
        start?: string;
        end?: string;
    };
    /** Genuine-open lookback in days; null means any time. */
    recentlyViewedDays: 7 | 30 | 90 | null;
    /**
     * Column layout captured with the view, so restoring a view reproduces the
     * whole table state and not just its filters. `null` means "leave the
     * current column config alone" -- views saved before this existed.
     */
    columnConfig: TypeColumnConfig | null;
    /**
     * Per-column filter set, in the shared `{field, op, value}` language. Applies
     * on top of `activeFilters` (the coarse chips).
     */
    columnFilters: TrackerFilterSet | null;
    /** Scope for the triage inbox view: all types, or the selected type only. */
    inboxScope: 'global' | 'type' | null;
    /**
     * Which slice of the lifecycle the view shows. Saved with the view so a
     * "Recently shipped" view can pin itself to closed work while the default
     * views stay on open.
     */
    statusScope: TrackerStatusScope;
}
export interface SavedView {
    id: string;
    name: string;
    definition: SavedViewDefinition;
    /**
     * Whether this view is shared with the team (synced) rather than local-only.
     * Absent on views saved before sharing existed, which are local.
     */
    shared?: boolean;
    /**
     * Ships with the app rather than being saved by a user: it is never
     * persisted, renamed, shared, or deleted, and its definition is rebuilt from
     * code on every load.
     */
    builtIn?: boolean;
}
export declare function createDefaultViewDefinition(): SavedViewDefinition;
/** Whether the current unsaved state contains anything worth naming as a view. */
export declare function hasSavableViewState(definition: SavedViewDefinition): boolean;
/**
 * Coerce a persisted `viewMode` to one this build still renders.
 *
 * `'grid'` was the RevoGrid table's own mode while it sat beside the
 * hand-rolled table; RevoGrid is the table now, so it folds into `'table'`.
 * Saved views also travel between users on different builds, so an unknown
 * literal falls back rather than leaving the main view with no branch to take.
 */
export declare function normalizeViewMode(raw: unknown, fallback: TrackerViewMode): TrackerViewMode;
/**
 * Merge a possibly-partial persisted definition with defaults so older saved
 * views (missing fields added later) load safely.
 */
export declare function normalizeViewDefinition(raw: Partial<SavedViewDefinition> | undefined | null): SavedViewDefinition;
/**
 * Serialize a view for the shared-view lane. Only the name and definition
 * travel; `id` rides outside the payload as the row key, and `shared` is a
 * property of *where* the view is stored, not of the view itself.
 */
export declare function serializeSharedSavedView(view: SavedView): string;
/**
 * Rebuild a `SavedView` from a shared-store row. Returns null for a payload we
 * can't make sense of so one bad row from a peer (or a future version) can't
 * take out the whole views list.
 */
export declare function parseSharedSavedView(record: {
    viewId: string;
    payload: string;
}): SavedView | null;
/**
 * The list the sidebar renders: local views plus the team's shared views. A
 * view that exists in both (the machine that shared it keeps no local copy, but
 * a rename race can transiently produce one) resolves to the shared row, since
 * that is the copy the team sees.
 */
export declare function mergeSavedViews(local: SavedView[], shared: SavedView[]): SavedView[];
export interface FilterContext {
    /** Current user identity, required for the `mine` chip. */
    identity?: TrackerIdentity | null;
    /** Dependency readiness derived once from the full tracker corpus. */
    readinessByItemId?: ReadonlyMap<string, Readiness>;
    /** Personal favorite ids for this identity and workspace scope. */
    favoriteItemIds?: ReadonlySet<string>;
    /** Genuine last-opened timestamps by tracker item id. */
    viewedAtByItemId?: ReadonlyMap<string, number>;
    /** Injectable clock for deterministic lookback filtering. */
    nowMs?: number;
}
export type TrackerItemFilterDefinition = Pick<SavedViewDefinition, 'activeFilters' | 'tagFilter'> & {
    /** Selected provenance keys (`native` or an importer provider id). */
    sourceFilter?: string[];
    /** Genuine-open lookback in days; null means any time. */
    recentlyViewedDays?: SavedViewDefinition['recentlyViewedDays'];
    /** Inspectable field clauses used by the right-side filter builder. */
    columnFilters?: TrackerFilterSet | null;
    /** Lifecycle slice; absent reads as `open`, matching the default view. */
    statusScope?: TrackerStatusScope;
};
/** Provenance key for a record: the importer provider id, or `native`. */
export declare function recordSourceKey(record: TrackerRecord): string;
/** Resolve ordinary, role-backed, and per-user structural fields uniformly. */
export declare function getTrackerFilterValue(record: TrackerRecord, field: string, context?: FilterContext): unknown;
/** Status values captured in the record's durable transition history. */
export declare function getStatusTransitionValues(record: TrackerRecord, direction: 'to' | 'from'): string[];
/** Convert removed left-sidebar presets into equivalent inspectable clauses. */
export declare function legacyFilterChipsToClauses(filters: readonly TrackerFilterChip[], recentlyViewedDays?: SavedViewDefinition['recentlyViewedDays']): TrackerFieldFilter[];
/**
 * Apply the row-level predicates of a saved view to a set of items: the `mine`,
 * `unassigned`, `high-priority`, and `recently-updated` chips, plus tag and
 * source filters. This is the pure core of TrackerMainView's filtering.
 * `archived` is handled by the caller because it selects the input item set.
 */
export declare function filterTrackerItems(items: TrackerRecord[], def: TrackerItemFilterDefinition, ctx?: FilterContext): TrackerRecord[];
/**
 * The records a view starts from: archived ones only when it asks for them
 * (the Archived filter, or a column filter on `archived`), otherwise none.
 */
export declare function selectArchivedForView(items: readonly TrackerRecord[], def: TrackerItemFilterDefinition): TrackerRecord[];
/**
 * Count filtered records within a sidebar type or folder scope. The type scope
 * is applied before the row filters so `recently-updated` matches the selected
 * type/folder view rather than a workspace-global top 50.
 */
export declare function countFilteredTrackerItemsByTypes(items: TrackerRecord[], types: readonly string[], def: TrackerItemFilterDefinition, ctx?: FilterContext): number;
/** Backward-compatible name for the canonical runtime grouping result. */
export type TrackerGroup = TrackerRecordGroup;
/** Backward-compatible saved-view entry point for the canonical grouping resolver. */
export declare function groupTrackerItems(items: TrackerRecord[], groupBy: TrackerGroupBy): TrackerGroup[];
