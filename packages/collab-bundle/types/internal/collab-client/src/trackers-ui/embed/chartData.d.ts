/**
 * A query chart's rows: the view's items bucketed by one field (a select,
 * person, yes/no or date field; dates by month), each bucket counting its
 * items or summing a number field. The rows feed the same small chart spec a
 * ```chart fence compiles, so both draw through one renderer.
 *
 * Values are read through `getTrackerFilterValue`, the accessor filters use,
 * so system fields (created, updated, owner) chart the same value a filter on
 * them matches. Buckets are keyed by stable identity (an option's value, a
 * person's email, a month) and labeled separately; two buckets that would
 * share a label are told apart rather than merged.
 */
import type { TrackerRecord } from '../../../../runtime/src/core/TrackerRecord';
import type { ChartRow } from '../../../../runtime/src/ui/chart/chartSpec';
/**
 * Row keys for the category and the measure. Tracker field names cannot start
 * with `@`, so a schema field (even one named `count`) never collides with them.
 */
export declare const CHART_CATEGORY = "@category";
export declare const CHART_VALUE = "@value";
/** The part of a filter-catalog field the bucketing reads. */
export interface ChartGroupField {
    id: string;
    type?: string;
    options?: ReadonlyArray<string | {
        value: string;
        label?: string;
    }>;
}
export interface ChartQuery {
    by: ChartGroupField;
    /** A number field to sum; counts items when absent. */
    sum?: string;
}
export declare const NO_VALUE_LABEL = "(none)";
/**
 * Buckets in a stable reading order: a select's option order, dates
 * ascending, anything else largest first. The no-value bucket goes last.
 */
export declare function chartData(records: readonly TrackerRecord[], query: ChartQuery): ChartRow[];
