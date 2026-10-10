/**
 * Desktop resolver for tracker types placed in the Pages tree: type names from
 * the tracker registry, items from the tracker records this window holds.
 * Lives on the electron side so collab-client's docs-ui bundle never imports
 * the tracker graph.
 */
import { useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import type { CollabTypeTreeResolver } from '@nimbalyst/collab-client/docs';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { buildCollabTypeResolver, type CollabTypeLane } from './collabTypeResolver';

/**
 * Both sections read the same local tracker atoms; the lane picks the types.
 * `brokenTypes` (Local only) keeps types whose file did not load in the tree.
 */
export function useCollabTypeResolver(
  lane: CollabTypeLane,
  brokenTypes?: Readonly<Record<string, string>>,
): CollabTypeTreeResolver {
  const [registryRevision, setRegistryRevision] = useState(0);
  useEffect(() => globalRegistry.onChange(() => setRegistryRevision((value) => value + 1)), []);
  const records = useAtomValue(trackerItemsMapAtom);

  return useMemo(
    () => buildCollabTypeResolver(globalRegistry, records, lane, brokenTypes ? new Map(Object.entries(brokenTypes)) : undefined),
    // registryRevision invalidates the memo when types change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [records, registryRevision, lane, brokenTypes],
  );
}
