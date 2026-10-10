import type { TrackerRecord } from '../../../core/TrackerRecord';
import { type FieldDefinition, type TrackerRelationshipValue } from '../../../../../tracker-schema/src/browser';
export declare const TRACKER_GROUPING_AXES: readonly ["status", "priority", "assignee", "type", "tag", "milestone", "goal"];
export type BuiltinTrackerGroupingAxis = (typeof TRACKER_GROUPING_AXES)[number];
export type TrackerFieldGrouping = {
    kind: 'field';
    fieldId: string;
};
export type TrackerGroupingAxis = BuiltinTrackerGroupingAxis | TrackerFieldGrouping;
export type TrackerGroupBy = 'none' | TrackerGroupingAxis;
export interface TrackerGroupingOption {
    value: BuiltinTrackerGroupingAxis;
    label: string;
}
export declare const TRACKER_GROUPING_OPTIONS: readonly TrackerGroupingOption[];
export interface ResolvedTrackerGroup {
    /** Axis-namespaced key suitable for React keys, persisted lane ids, and DnD. */
    key: string;
    /** Stored scalar value, relationship item id, or null for the empty bucket. */
    value: string | null;
    /** User-facing bucket label. */
    label: string;
    /** True only for the axis-specific no-value bucket. */
    empty: boolean;
}
export interface TrackerRecordGroup {
    key: string;
    label: string;
    items: TrackerRecord[];
}
/** Schema names for badges and group headings; unknown types keep their id. */
export declare function getTrackerTypeLabel(type: string, plural?: boolean): string;
export declare function resolveEmptyTrackerGroup(axis: TrackerGroupingAxis): ResolvedTrackerGroup;
/** Axes whose membership is a relationship rather than a scalar field. */
export type TrackerRelationshipGroupingAxis = 'milestone' | 'goal';
/**
 * The schema field an item uses to name its milestone(s) or goal(s).
 *
 * Writers need the definition itself (for `multiValue` and the relationship
 * vocabulary keys), so this is exported alongside the name-only form the
 * read path uses.
 */
export declare function resolveGroupingRelationshipField(type: string, axis: TrackerRelationshipGroupingAxis): FieldDefinition | undefined;
/** Field name for {@link resolveGroupingRelationshipField}, falling back to the built-in name. */
export declare function resolveGroupingRelationshipFieldName(type: string, axis: TrackerRelationshipGroupingAxis): string;
/**
 * The relationship values that place an item on a relationship axis.
 *
 * The board reuses this so a lane's stored membership and its drag target are
 * filtered by one rule, not two.
 */
export declare function resolveGroupingRelationshipValues(item: TrackerRecord, axis: TrackerRelationshipGroupingAxis): TrackerRelationshipValue[];
/**
 * Reads the current title of a referenced item, when the caller can see it.
 *
 * The `title` stored on a relationship is a snapshot taken when the link was
 * written: it is absent when the link was written from the other side, and
 * stale after the target is renamed. Surfaces with the tracker's records in
 * hand pass this so a milestone lane reads "Onboarding" rather than
 * `milestone_1786137761427_n9d75j`.
 */
export type TrackerRelationshipLabelResolver = (itemId: string) => string | undefined;
/** The best available name for a relationship value: live title, then snapshot. */
export declare function resolveRelationshipLabel(value: Pick<TrackerRelationshipValue, 'itemId' | 'title' | 'issueKey'>, resolveLabel?: TrackerRelationshipLabelResolver): string;
/** Resolve every bucket an item belongs to for one grouping axis. */
export declare function resolveTrackerGroups(item: TrackerRecord, axis: TrackerGroupingAxis, resolveLabel?: TrackerRelationshipLabelResolver): ResolvedTrackerGroup[];
/** Group records in first-seen order; multi-value axes intentionally duplicate membership. */
export declare function groupTrackerRecordsByAxis(items: TrackerRecord[], groupBy: TrackerGroupBy, resolveLabel?: TrackerRelationshipLabelResolver): TrackerRecordGroup[];
export declare function normalizeTrackerGroupBy(value: unknown): TrackerGroupBy;
