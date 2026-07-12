import { atom } from 'jotai';
import type { TrackerNavigationEntry } from '@nimbalyst/runtime/sync';

export const trackerNavigationEntriesAtom = atom<TrackerNavigationEntry[]>([]);
export const trackerNavigationWorkspaceAtom = atom<string | null>(null);

export const loadTrackerNavigationAtom = atom(
  null,
  async (_get, set, workspacePath: string) => {
    const result = await window.electronAPI.invoke(
      'tracker-navigation:list',
      workspacePath,
    ) as TrackerNavigationEntry[] | undefined;
    set(trackerNavigationWorkspaceAtom, workspacePath);
    set(trackerNavigationEntriesAtom, Array.isArray(result) ? result : []);
  },
);

export const ensureTrackerTypePlacementsAtom = atom(
  null,
  async (_get, set, input: { workspacePath: string; trackerTypes: string[] }) => {
    const entries = await window.electronAPI.invoke(
      'tracker-navigation:ensure-types',
      input.workspacePath,
      input.trackerTypes,
    ) as TrackerNavigationEntry[];
    set(trackerNavigationWorkspaceAtom, input.workspacePath);
    set(trackerNavigationEntriesAtom, entries);
  },
);

export const saveTrackerNavigationEntryAtom = atom(
  null,
  async (get, set, input: { workspacePath: string; entry: TrackerNavigationEntry }) => {
    const previous = get(trackerNavigationEntriesAtom);
    const optimistic = previous.filter((entry) => entry.entryId !== input.entry.entryId);
    set(trackerNavigationEntriesAtom, [...optimistic, input.entry]);
    try {
      const entries = await window.electronAPI.invoke(
        'tracker-navigation:save',
        input.workspacePath,
        input.entry,
      ) as TrackerNavigationEntry[];
      set(trackerNavigationEntriesAtom, entries);
    } catch (error) {
      set(trackerNavigationEntriesAtom, previous);
      throw error;
    }
  },
);

export const deleteTrackerFolderAtom = atom(
  null,
  async (get, set, input: { workspacePath: string; folderId: string }) => {
    const previous = get(trackerNavigationEntriesAtom);
    set(
      trackerNavigationEntriesAtom,
      previous
        .filter((entry) => entry.entryId !== `folder:${input.folderId}`)
        .map((entry) => entry.kind === 'type-placement' && entry.folderId === input.folderId
          ? { ...entry, folderId: null }
          : entry),
    );
    try {
      const entries = await window.electronAPI.invoke(
        'tracker-navigation:delete-folder',
        input.workspacePath,
        input.folderId,
      ) as TrackerNavigationEntry[];
      set(trackerNavigationEntriesAtom, entries);
    } catch (error) {
      set(trackerNavigationEntriesAtom, previous);
      throw error;
    }
  },
);
