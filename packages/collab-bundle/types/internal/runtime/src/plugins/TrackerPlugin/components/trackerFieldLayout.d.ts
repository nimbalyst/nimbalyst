/**
 * Shared field-layout rules for tracker metadata surfaces.
 *
 * Every surface that shows a tracker item's fields (the focused document
 * header, the detail pane, document headers) should pick its fields here so
 * the same schema produces the same order and the same omissions everywhere.
 */
import { type FieldDefinition } from '../../../../../tracker-schema/src/browser';
import type { TrackerRecord } from '../../../core/TrackerRecord';
/**
 * Resolve semantic fields first, then type-specific metadata in schema order.
 * Opaque objects, structural fields, and read-only values stay in the ordinary
 * detail view instead of turning a compact header into a second inspector.
 * Custom text fields remain eligible; only the built-in description is omitted.
 *
 * `singleValuedOnly` is for page headers: lists of any kind (arrays, labels,
 * multi-valued links) stay out of them. Every other surface (StatusBar, the
 * classic detail pane, quick create) keeps tags and collections.
 */
export declare function getTrackerFieldLayout(trackerType: string, labelFields?: readonly FieldDefinition[], options?: {
    singleValuedOnly?: boolean;
}): FieldDefinition[];
/** Memoized `getTrackerFieldLayout` for component use. */
export declare function useTrackerFieldLayout(trackerType: string, labelFields?: readonly FieldDefinition[]): FieldDefinition[];
/** Header text for a field: a label property's own label, else the formatted name. */
export declare function trackerFieldDisplayLabel(field: FieldDefinition): string;
/**
 * Format a display label from a camelCase field name.
 * e.g. "publishDate" -> "Publish Date", "storyPoints" -> "Story Points"
 */
export declare function formatTrackerFieldLabel(name: string): string;
/** Empty pills already show their field name. Selected option icons identify compact selects. */
export declare function shouldLabelTrackerField(field: FieldDefinition, value: unknown, labelFields?: boolean): boolean;
/** True when a field value should render as "not set". */
export declare function isTrackerFieldEmpty(value: unknown): boolean;
/**
 * Records that came from a file keep their document as the source of truth, but
 * the known file-backed sources round-trip edits, so they stay editable.
 */
export declare function isTrackerRecordEditable(record: TrackerRecord): boolean;
