/**
 * The app's entry point to the shared activity writer.
 *
 * The logic lives in `@nimbalyst/tracker-core` because the CLI's offline write
 * path has to produce identical stored bytes; keeping a second copy here is how
 * the two drifted on coalescing before. `DirectGateway.write.test.ts` compares a
 * CLI-written row against what this module produces, so the parity claim is
 * checked rather than asserted in a comment.
 */
import type { TrackerItemPayload } from '@nimbalyst/runtime/sync';
import { capActivityValue } from '@nimbalyst/tracker-core';

export { appendActivity } from '@nimbalyst/tracker-core';

type ActivityEntry = NonNullable<TrackerItemPayload['activity']>[number];

/** True when `incoming` is exactly the wire-capped form of a longer `local`. */
function isCappedFormOf(incoming: string | undefined, local: string | undefined): boolean {
  return incoming !== local && local !== undefined && capActivityValue(local) === incoming;
}

/**
 * The wire copy of an oversized item caps activity values, and the room echoes
 * that copy back with the same entry ids. Keep the full local value then, so
 * the trim never reaches local history. Only for the same version of the
 * entry: coalescing keeps the id and moves the timestamp, and a newer edit that
 * shares the first characters caps to the same value.
 */
function preferFullLocalValues(local: ActivityEntry, incoming: ActivityEntry): ActivityEntry {
  if (incoming.timestamp !== local.timestamp) return incoming;
  const keepOld = isCappedFormOf(incoming.oldValue, local.oldValue);
  const keepNew = isCappedFormOf(incoming.newValue, local.newValue);
  if (!keepOld && !keepNew) return incoming;
  return {
    ...incoming,
    ...(keepOld ? { oldValue: local.oldValue } : {}),
    ...(keepNew ? { newValue: local.newValue } : {}),
  };
}

/**
 * Union a synced item's prior and incoming activity trails.
 *
 * Entries are keyed on `id`, so every writer must mint one -- an entry without
 * an id collapses into every other id-less entry on the item the first time it
 * syncs. The sort is numeric, so `timestamp` has to be epoch ms, not an ISO
 * string. `appendActivity` guarantees both; nothing else should build entries.
 */
export function mergeActivity(
  prior: TrackerItemPayload['activity'],
  incoming: TrackerItemPayload['activity'],
): TrackerItemPayload['activity'] {
  if (!prior && !incoming) return undefined;
  const merged = new Map<string, ActivityEntry>();
  for (const entry of prior ?? []) merged.set(entry.id, entry);
  for (const entry of incoming ?? []) {
    const local = merged.get(entry.id);
    merged.set(entry.id, local ? preferFullLocalValues(local, entry) : entry);
  }
  return [...merged.values()]
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-100);
}
