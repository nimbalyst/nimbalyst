/**
 * Shared date derivation and time-axis layout for the tracker timeline.
 *
 * Pure and React-free, because the two things most likely to be wrong here are
 * invisible on screen: which date an item is placed by, and whether a bucket is
 * computed in the user's calendar or in UTC.
 *
 * Three rules worth stating, because they are not obvious from the types:
 *
 *  - **No invented date field.** Placement uses only fields the schemas already
 *    declare -- `startDate` (plan, milestone), `targetDate` (milestone),
 *    `releasedAt` (release), `dueDate` (carried on the legacy item shape) -- plus
 *    any date/datetime field a custom schema declares, and finally the record's
 *    own `system.createdAt`. Nothing new is written or required.
 *  - **The epoch is "no date", not 1970.** `trackerItemToRecord` deliberately
 *    falls back to the epoch for an item with no `created`, so undated
 *    items sort to the bottom instead of churning to "just now". Placing those
 *    at 1970 would stretch every timeline across half a century, so a
 *    non-positive timestamp counts as absent.
 *  - **Every calendar computation is local.** Buckets, keys, and boundaries are
 *    built from `getFullYear`/`getMonth`/`getDate` and `new Date(y, m, d)`, never
 *    from `toISOString`. An item must land on the day the user sees it, and
 *    local-field arithmetic is also what keeps a DST boundary from shifting a
 *    bucket by an hour into the previous day.
 */
import type { TrackerRecord } from '../../../runtime/src/core/TrackerRecord';
import { type TrackerGroupBy, type TrackerOrdering, type TrackerRelationshipLabelResolver } from '../../../runtime/src/plugins/TrackerPlugin/models/index';
export type TrackerTimelineGranularity = 'day' | 'week' | 'month';
export interface TrackerTimelineDates {
    start: Date;
    /** Null when the item names an instant rather than a span; drawn as a point. */
    end: Date | null;
    /** Field the start came from -- a schema field name, or `created`. */
    startField: string;
    endField?: string;
}
/** The synthetic `startField` used when only the record's creation instant places it. */
export declare const TIMELINE_CREATED_FIELD = "created";
/**
 * Where an item sits in time, or null when nothing places it.
 *
 * Preference: a declared start field, then an end-only field (a milestone with
 * only a target date belongs at its target date), then any other date field the
 * type declares, then the record's creation instant.
 */
export interface TrackerTimelineFields {
    start?: string;
    end?: string;
}
export declare function resolveTimelineDates(item: TrackerRecord, fields?: TrackerTimelineFields): TrackerTimelineDates | null;
/** Midnight of the local day containing `date`. */
export declare function startOfLocalDay(date: Date): Date;
/** Midnight of the local Sunday that starts the week containing `date`. */
export declare function startOfLocalWeek(date: Date): Date;
export declare function startOfLocalMonth(date: Date): Date;
/** The start of the bucket `date` falls in, at the given granularity. */
export declare function timelineBucketStart(date: Date, granularity: TrackerTimelineGranularity): Date;
/**
 * Stable identity for the bucket a date falls in.
 *
 * Built from local calendar fields on purpose: an instant late on a local
 * evening is the same day the user is looking at, even when it is already
 * tomorrow in UTC.
 */
export declare function timelineBucketKey(date: Date, granularity: TrackerTimelineGranularity): string;
/** Coarser buckets as the span widens, so a timeline never draws hundreds of ticks. */
export declare function resolveTimelineGranularity(spanDays: number): TrackerTimelineGranularity;
export interface TrackerTimelineRange {
    start: Date;
    end: Date;
}
export interface TrackerTimelineBucket {
    key: string;
    label: string;
    start: Date;
    /** Exclusive: the start of the next bucket. */
    end: Date;
}
/** Every bucket covering `range`, left to right. */
export declare function buildTimelineBuckets(range: TrackerTimelineRange, granularity: TrackerTimelineGranularity): TrackerTimelineBucket[];
/** 0..1 position of an instant within the range, clamped to its ends. */
export declare function resolveTimelineFraction(date: Date, range: TrackerTimelineRange): number;
/** Where "now" sits, or null when the timeline does not cover it. */
export declare function resolveTodayFraction(now: Date, range: TrackerTimelineRange | null): number | null;
export interface TrackerTimelineBar {
    item: TrackerRecord;
    dates: TrackerTimelineDates;
    startFraction: number;
    endFraction: number;
}
export interface TrackerTimelineRow {
    key: string;
    label: string;
    bars: TrackerTimelineBar[];
    /** Items in this group that no date places. Shown, never dropped. */
    undated: TrackerRecord[];
}
export interface TrackerTimelineModel {
    granularity: TrackerTimelineGranularity;
    /** Null when nothing in view carries a usable date. */
    range: TrackerTimelineRange | null;
    buckets: TrackerTimelineBucket[];
    rows: TrackerTimelineRow[];
    /** Counts of distinct items, so a multi-milestone item is not counted twice. */
    datedCount: number;
    undatedCount: number;
}
/**
 * The rows, buckets, and bar positions for one view.
 *
 * Rows come from the saved view's grouping axis, so `Group by: Milestone` is a
 * milestone-per-row timeline with no separate feature behind it.
 */
export declare function buildTrackerTimeline(items: TrackerRecord[], groupBy: TrackerGroupBy, ordering: TrackerOrdering, 
/** Names relationship rows from the referenced record; see the resolver's docs. */
resolveLabel?: TrackerRelationshipLabelResolver, fields?: TrackerTimelineFields): TrackerTimelineModel;
