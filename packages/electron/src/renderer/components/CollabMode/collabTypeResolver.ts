/**
 * The desktop's records fed to collab-client's `buildCollabTypeResolver`, which
 * the web console shares. Callers pass the tracker atoms' record map.
 */
import {
  buildCollabTypeResolver as buildSharedCollabTypeResolver,
  type CollabTypeLane,
  type CollabTypeRegistry,
  type CollabTypeTreeResolver,
} from '@nimbalyst/collab-client/docs';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { getRecordTitle } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';

export type { CollabTypeLane, CollabTypeRegistry };

export function buildCollabTypeResolver(
  registry: CollabTypeRegistry,
  records: ReadonlyMap<string, TrackerRecord>,
  lane: CollabTypeLane = 'team',
  brokenTypes?: ReadonlyMap<string, string>,
): CollabTypeTreeResolver {
  const items = Array.from(records.values(), (record) => ({
    id: record.id,
    typeId: record.primaryType,
    title: getRecordTitle(record).trim(),
    issueNumber: record.issueNumber,
    archived: record.archived,
    // 'pending' is a shared item on its way to the room; 'local' never left
    // this machine (unshared items and frontmatter projections of local files).
    localOnly: record.syncStatus === 'local',
  }));
  return buildSharedCollabTypeResolver(registry, items, lane, brokenTypes);
}
