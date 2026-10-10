/**
 * @vitest-environment node
 *
 * Timeline placement and bucketing.
 *
 * Two things here are invisible on screen and expensive to get wrong: which
 * date field puts an item where it is (including the items nothing dates, which
 * must stay visible rather than silently disappearing off the axis), and
 * whether a bucket is computed in the reader's calendar or in UTC. A timezone
 * slip moves an item to the wrong day and reads as correct.
 */

// Set before any Date is constructed, so the local calendar is not the runner's.
// The sanity assertion below fails loudly if the runtime ignored it, rather than
// letting the timezone tests pass vacuously under UTC.
process.env.TZ = 'America/Los_Angeles';

import { describe, it, expect } from 'vitest';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import {
  buildTrackerTimeline,
  resolveTimelineDates,
  timelineBucketKey,
} from '@nimbalyst/collab-client/trackers';

function record(
  id: string,
  overrides: { type?: string; createdAt?: string; fields?: Record<string, unknown> } = {},
): TrackerRecord {
  return {
    id,
    primaryType: overrides.type ?? 'bug',
    typeTags: [overrides.type ?? 'bug'],
    issueKey: `NIM-${id}`,
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: {
      workspace: '/w',
      createdAt: overrides.createdAt ?? '2026-08-01T12:00:00.000Z',
      updatedAt: '2026-08-01T12:00:00.000Z',
    },
    fields: { title: `Item ${id}`, status: 'to-do', ...overrides.fields },
  } as unknown as TrackerRecord;
}

describe('resolveTimelineDates', () => {
  it('uses explicit view dates and keeps missing dates undated instead of falling back to creation', () => {
    const item = record('selected', { fields: { startDate: '2026-01-01', launchDate: '2026-10-12', finish: '2026-10-15' } });
    expect(resolveTimelineDates(item, { start: 'launchDate', end: 'finish' })).toMatchObject({ startField: 'launchDate', endField: 'finish' });
    expect(resolveTimelineDates(item, { start: 'missing' })).toBeNull();
    expect(resolveTimelineDates(item, { end: 'finish' })).toMatchObject({ startField: 'finish', end: null });
    expect(buildTrackerTimeline([item], 'none', 'manual', undefined, { start: 'missing' }).undatedCount).toBe(1);
  });
  it('places an item by the date fields the schemas declare, then by creation', () => {
    const plan = resolveTimelineDates(record('1', {
      type: 'plan',
      fields: { startDate: '2026-08-03', targetDate: '2026-08-14' },
    }));
    expect(plan).toMatchObject({ startField: 'startDate', endField: 'targetDate' });
    expect(plan!.end).not.toBeNull();

    // A milestone that only names when it is due belongs at that date, not at
    // whenever the row happened to be created.
    const milestone = resolveTimelineDates(record('2', {
      type: 'milestone',
      fields: { targetDate: '2026-09-01' },
    }));
    expect(milestone).toMatchObject({ startField: 'targetDate', end: null });
    expect(milestone!.start.getFullYear()).toBe(2026);
    expect(milestone!.start.getMonth()).toBe(8);
    expect(milestone!.start.getDate()).toBe(1);

    const created = resolveTimelineDates(record('3', { createdAt: '2026-08-11T02:30:00.000Z' }));
    expect(created).toMatchObject({ startField: 'created', end: null });
    expect(created!.start.getTime()).toBe(Date.parse('2026-08-11T02:30:00.000Z'));
  });

  it('treats the absent-date sentinel and a backwards span as no span', () => {
    // trackerItemToRecord stores the epoch for an item with no creation date
    // Placing that at 1970 would stretch the axis across 56 years.
    expect(resolveTimelineDates(record('4', { createdAt: new Date(0).toISOString() }))).toBeNull();

    const backwards = resolveTimelineDates(record('5', {
      fields: { startDate: '2026-08-10', dueDate: '2026-08-01' },
    }));
    expect(backwards).toMatchObject({ startField: 'startDate', end: null });
  });
});

describe('timelineBucketKey', () => {
  it('buckets by the reader local calendar day, not the UTC day', () => {
    expect(new Date('2026-08-11T02:30:00.000Z').getHours()).toBe(19); // TZ actually applied

    // 02:30 UTC on the 11th is the evening of the 10th in Los Angeles.
    const lateEvening = resolveTimelineDates(record('1', { createdAt: '2026-08-11T02:30:00.000Z' }));
    expect(timelineBucketKey(lateEvening!.start, 'day')).toBe('day:2026-08-10');

    // The mirror failure: a date-only field read as UTC midnight would land on
    // the 10th here. It names a calendar day and must stay on it.
    const dateOnly = resolveTimelineDates(record('2', { fields: { startDate: '2026-08-11' } }));
    expect(timelineBucketKey(dateOnly!.start, 'day')).toBe('day:2026-08-11');
  });
});

describe('buildTrackerTimeline', () => {
  it('keeps undated items in their group instead of dropping them off the axis', () => {
    const items = [
      record('a', { fields: { startDate: '2026-08-03' } }),
      record('b', { fields: { startDate: '2026-08-20' } }),
      record('c', { createdAt: new Date(0).toISOString() }),
    ];

    const timeline = buildTrackerTimeline(items, 'none', 'manual');

    expect(timeline.datedCount).toBe(2);
    expect(timeline.undatedCount).toBe(1);
    expect(timeline.rows).toHaveLength(1);
    expect(timeline.rows[0].bars.map(bar => bar.item.id)).toEqual(['a', 'b']);
    expect(timeline.rows[0].undated.map(item => item.id)).toEqual(['c']);

    // The range covers both dated items, and the axis is drawn in local days at
    // this span rather than weeks or months.
    expect(timeline.granularity).toBe('day');
    expect(timeline.range!.start.getDate()).toBe(3);
    expect(timeline.range!.end.getTime()).toBeGreaterThan(timeline.rows[0].bars[1].dates.start.getTime());
    expect(timeline.rows[0].bars[0].startFraction).toBe(0);
    expect(timeline.rows[0].bars[1].endFraction).toBeLessThanOrEqual(1);
  });
});
