/**
 * A query 2x2's points: every item of the view placed by two number fields,
 * then the pinned extra points. An item missing either value is left out and
 * counted, so the chart can say how many it could not place.
 */
import type { TrackerRecord } from '../../../../runtime/src/core/TrackerRecord';
import { type QuadrantPin, type QuadrantPoint } from '../../../../runtime/src/core/quadrantModel';
export interface QuadrantQuery {
    xField: string;
    yField: string;
    pins: readonly QuadrantPin[];
}
export interface QuadrantData {
    points: QuadrantPoint[];
    /** Items with no number in one of the two fields. */
    skipped: number;
}
export declare function quadrantData(records: readonly TrackerRecord[], query: QuadrantQuery): QuadrantData;
