/**
 * A query 2x2's points: every item of the view placed by two number fields,
 * then the pinned extra points. An item missing either value is left out and
 * counted, so the chart can say how many it could not place.
 */

import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { getRecordTitle } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import {
  quadrantNumber,
  type QuadrantPin,
  type QuadrantPoint,
} from '@nimbalyst/runtime/core/quadrantModel';

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

export function quadrantData(records: readonly TrackerRecord[], query: QuadrantQuery): QuadrantData {
  const points: QuadrantPoint[] = [];
  let skipped = 0;
  for (const record of records) {
    const x = quadrantNumber(record.fields[query.xField]);
    const y = quadrantNumber(record.fields[query.yField]);
    if (x === null || y === null) {
      skipped += 1;
      continue;
    }
    points.push({ id: record.id, label: getRecordTitle(record).trim() || record.id, x, y, pinned: false });
  }
  query.pins.forEach((pin, index) => points.push({ id: `pin:${index}`, label: pin.label, x: pin.x, y: pin.y, pinned: true }));
  return { points, skipped };
}
