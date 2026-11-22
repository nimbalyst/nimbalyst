/**
 * The activity writer the app's tracker save paths use: the shared
 * `appendActivity`, then every stored entry bounded to the current caps.
 *
 * `appendActivity` keeps the newest 100 entries and caps the values of the
 * entry it writes, but entries written before the value cap still carry a
 * whole description on each side. Those dominate the stored trail (one item
 * held 530 KB across 37 entries) and were read, rewritten and synced with every
 * edit. The trail shows at most 80 characters of a value, so capping old
 * values on the next write changes nothing anyone sees.
 */
import { appendActivity as appendSharedActivity, capActivityValue } from '@nimbalyst/tracker-core';

/** Matches the entry cap `appendActivity` applies. */
export const MAX_STORED_ACTIVITY_ENTRIES = 100;

function capValue(value: unknown): unknown {
  return typeof value === 'string' ? capActivityValue(value) : value;
}

/** Bound `data.activity` in place: the newest entries, each value capped. */
export function capStoredActivityTrail(data: Record<string, any>): void {
  const trail = data.activity;
  if (!Array.isArray(trail)) return;
  const kept = trail.length > MAX_STORED_ACTIVITY_ENTRIES
    ? trail.slice(-MAX_STORED_ACTIVITY_ENTRIES)
    : trail;
  data.activity = kept.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const oldValue = capValue(entry.oldValue);
    const newValue = capValue(entry.newValue);
    if (oldValue === entry.oldValue && newValue === entry.newValue) return entry;
    return { ...entry, oldValue, newValue };
  });
}

export function appendActivity(
  data: Record<string, any>,
  authorIdentity: any,
  action: string,
  details?: { field?: string; oldValue?: string; newValue?: string; note?: string },
): void {
  appendSharedActivity(data, authorIdentity, action, details);
  capStoredActivityTrail(data);
}
