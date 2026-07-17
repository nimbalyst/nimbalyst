export type TrackerNavigationEntry = TrackerNavigationFolder | TrackerTypePlacement;

export interface TrackerNavigationFolder {
  entryId: `folder:${string}`;
  kind: 'folder';
  folderId: string;
  name: string;
  sortKey: string;
}

export interface TrackerTypePlacement {
  entryId: `type:${string}`;
  kind: 'type-placement';
  trackerType: string;
  folderId: string | null;
  sortKey: string;
}

export function isTrackerNavigationEntry(value: unknown): value is TrackerNavigationEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<TrackerNavigationEntry>;
  if (typeof entry.entryId !== 'string' || typeof entry.sortKey !== 'string' || !entry.sortKey) return false;
  if (entry.kind === 'folder') {
    return entry.entryId.startsWith('folder:') &&
      typeof entry.folderId === 'string' &&
      entry.folderId.length > 0 &&
      entry.entryId === `folder:${entry.folderId}` &&
      typeof entry.name === 'string' &&
      entry.name.trim().length > 0;
  }
  if (entry.kind === 'type-placement') {
    return entry.entryId.startsWith('type:') &&
      typeof entry.trackerType === 'string' &&
      entry.trackerType.length > 0 &&
      entry.entryId === `type:${entry.trackerType}` &&
      (entry.folderId === null || (typeof entry.folderId === 'string' && entry.folderId.length > 0));
  }
  return false;
}

export function compareTrackerNavigationEntries(a: TrackerNavigationEntry, b: TrackerNavigationEntry): number {
  if (a.sortKey < b.sortKey) return -1;
  if (a.sortKey > b.sortKey) return 1;
  return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0;
}
