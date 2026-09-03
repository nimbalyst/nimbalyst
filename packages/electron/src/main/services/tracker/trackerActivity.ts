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

export { appendActivity } from '@nimbalyst/tracker-core';

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
  const merged = new Map<string, NonNullable<TrackerItemPayload['activity']>[number]>();
  for (const entry of [...(prior ?? []), ...(incoming ?? [])]) merged.set(entry.id, entry);
  return [...merged.values()]
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-100);
}
