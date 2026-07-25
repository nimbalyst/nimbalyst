import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';

function timestampMillis(value: unknown): number {
  if (
    typeof value !== 'string'
    && typeof value !== 'number'
    && !(value instanceof Date)
  ) {
    return 0;
  }
  const millis = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(millis) ? 0 : millis;
}

export function compareTrackerUpdatedAtDesc(
  a: TrackerRecord,
  b: TrackerRecord,
): number {
  return timestampMillis(b.system.updatedAt) - timestampMillis(a.system.updatedAt);
}
