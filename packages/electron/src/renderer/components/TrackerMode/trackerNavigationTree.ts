import {
  compareTrackerNavigationEntries,
  type TrackerNavigationEntry,
  type TrackerNavigationFolder,
  type TrackerTypePlacement,
} from '@nimbalyst/runtime/sync';
import type { TrackerDataModel } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';

export interface TrackerNavigationFolderNode {
  folder: TrackerNavigationFolder;
  trackerTypes: Array<{ tracker: TrackerDataModel; placement: TrackerTypePlacement }>;
}

export interface TrackerNavigationTree {
  folders: TrackerNavigationFolderNode[];
  rootTypes: Array<{ tracker: TrackerDataModel; placement: TrackerTypePlacement }>;
}

export function buildTrackerNavigationTree(
  trackerTypes: TrackerDataModel[],
  entries: TrackerNavigationEntry[],
): TrackerNavigationTree {
  const folders = entries
    .filter((entry): entry is TrackerNavigationFolder => entry.kind === 'folder')
    .sort(compareTrackerNavigationEntries);
  const folderIds = new Set(folders.map((folder) => folder.folderId));
  const placementByType = new Map<string, TrackerTypePlacement>();
  for (const entry of entries) {
    if (entry.kind === 'type-placement' && !placementByType.has(entry.trackerType)) {
      placementByType.set(entry.trackerType, entry);
    }
  }

  const fallbackPlacement = (trackerType: string, index: number): TrackerTypePlacement => ({
    entryId: `type:${trackerType}`,
    kind: 'type-placement',
    trackerType,
    folderId: null,
    sortKey: `z${String(index).padStart(8, '0')}`,
  });

  const rows = trackerTypes.map((tracker, index) => {
    const placement = placementByType.get(tracker.type) ?? fallbackPlacement(tracker.type, index);
    return {
      tracker,
      placement: placement.folderId !== null && !folderIds.has(placement.folderId)
        ? { ...placement, folderId: null }
        : placement,
    };
  });

  const byFolder = new Map<string, typeof rows>();
  const rootTypes: typeof rows = [];
  for (const row of rows) {
    if (row.placement.folderId === null) rootTypes.push(row);
    else {
      const current = byFolder.get(row.placement.folderId) ?? [];
      current.push(row);
      byFolder.set(row.placement.folderId, current);
    }
  }
  const sortRows = (a: typeof rows[number], b: typeof rows[number]) =>
    compareTrackerNavigationEntries(a.placement, b.placement);
  rootTypes.sort(sortRows);
  return {
    folders: folders.map((folder) => ({
      folder,
      trackerTypes: (byFolder.get(folder.folderId) ?? []).sort(sortRows),
    })),
    rootTypes,
  };
}
