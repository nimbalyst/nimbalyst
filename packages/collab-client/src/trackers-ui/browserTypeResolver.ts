/**
 * The Pages tree's type resolver for a browser host: type names from the
 * tracker registry (the browser schema store fills it from the room), items
 * from the tracker room's records under `TrackersUIProvider`. The desktop
 * builds the same resolver over its own tracker atoms.
 */
import { useEffect, useMemo, useState } from 'react';
import { globalRegistry } from '@nimbalyst/tracker-schema';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { getRecordTitle } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import type { CollabTypeTreeResolver } from '../docs/collabTree';
import { buildCollabTypeResolver, type CollabTypeLane, type CollabTypeRegistry } from '../docs/collabTypeResolver';
import { useTrackerDataSelector } from './useTrackerData';

export function browserTypeResolver(
  records: readonly TrackerRecord[],
  registry: CollabTypeRegistry,
  lane: CollabTypeLane = 'team',
): CollabTypeTreeResolver {
  return buildCollabTypeResolver(registry, records.map((record) => ({
    id: record.id,
    typeId: record.primaryType,
    title: getRecordTitle(record).trim(),
    issueNumber: record.issueNumber,
    archived: record.archived,
  })), lane);
}

/** Rebuilt when the room's records or the registry's types change. */
export function useBrowserTypeResolver(lane: CollabTypeLane = 'team'): CollabTypeTreeResolver {
  const records = useTrackerDataSelector((state) => state.records);
  const [registryRevision, setRegistryRevision] = useState(0);
  useEffect(() => globalRegistry.onChange(() => setRegistryRevision((value) => value + 1)), []);
  return useMemo(
    () => browserTypeResolver(records, globalRegistry, lane),
    // registryRevision invalidates the memo when types change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [records, registryRevision, lane],
  );
}
