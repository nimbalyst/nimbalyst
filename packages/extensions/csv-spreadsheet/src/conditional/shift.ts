import type { StructuralEdit } from '../structure/structuralEdit';
import { shiftRangeKeys } from './rangeKeys';
import type { ConditionalFormat } from './types';

/**
 * Conditional formats rewritten for a structural edit. Each format's ranges
 * follow their cells (see `shiftRangeKey`); a format whose ranges were all
 * deleted is dropped. Order is preserved, and formats whose ranges did not
 * change keep their identity.
 */
export function shiftConditionalFormatsForStructuralEdit(
  formats: readonly ConditionalFormat[],
  edit: StructuralEdit,
): ConditionalFormat[] {
  const next: ConditionalFormat[] = [];
  for (const format of formats) {
    const ranges = shiftRangeKeys(format.ranges, edit);
    if (ranges.length === 0) continue;
    const unchanged = ranges.length === format.ranges.length && ranges.every((key, i) => key === format.ranges[i]);
    next.push(unchanged ? format : { ...format, ranges });
  }
  return next;
}
