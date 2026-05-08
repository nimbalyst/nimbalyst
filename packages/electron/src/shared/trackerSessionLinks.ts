export type TrackerSyncStatusValue = 'local' | 'pending' | 'synced' | string | null | undefined;

type TrackerSyncStatusLike =
  | TrackerSyncStatusValue
  | {
      sync_status?: TrackerSyncStatusValue;
      syncStatus?: TrackerSyncStatusValue;
    };

function normalizeTrackerSyncStatus(source: TrackerSyncStatusLike): TrackerSyncStatusValue {
  if (typeof source === 'string' || source == null) return source;
  return source.syncStatus ?? source.sync_status;
}

export function shouldPersistTrackerLinkedSessions(source: TrackerSyncStatusLike): boolean {
  const syncStatus = normalizeTrackerSyncStatus(source);
  return syncStatus !== 'pending' && syncStatus !== 'synced';
}

export function getVisibleTrackerLinkedSessions(
  source: TrackerSyncStatusLike,
  linkedSessions: string[] | null | undefined,
): string[] {
  if (!shouldPersistTrackerLinkedSessions(source)) return [];
  return Array.isArray(linkedSessions) ? linkedSessions : [];
}
