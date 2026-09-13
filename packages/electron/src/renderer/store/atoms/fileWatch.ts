/**
 * File Watch Atoms
 *
 * Per-file-path counter atoms incremented when the main process emits
 * file-watcher events. Consumers (DocumentModel backing stores, TabEditor,
 * tab systems) subscribe to the family entry for their file path.
 *
 * Updated by store/listeners/fileChangeListeners.ts.
 */

import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';
import type { FileWatchHealth } from '../../../shared/fileWatchHealth';

export const fileWatcherHealthAtomFamily = atomFamily((_root: string) => atom<FileWatchHealth | null>(null));
// Ignore signals for disposed registrations instead of resurrecting atom-family entries.
export const activeFileReconciliations = new Set<string>();
export const fileReconciliationAtomFamily = atomFamily((_token: string) =>
  atom<{ status: 'changed' | 'deleted' | 'error'; errorCode?: string } | null>(null));

export const fileChangedOnDiskAtomFamily = atomFamily((_filePath: string) =>
  atom(0)
);

export const historyPendingTagCreatedAtomFamily = atomFamily((_filePath: string) =>
  atom(0)
);

/**
 * Counter atom incremented when a file is deleted (file-deleted IPC).
 *
 * Every tab system that owns a TabsProvider must subscribe and close affected
 * tabs. The DocumentModel backing store also subscribes to mark the model as
 * deleted so saves are refused until reload. Centralizing the listener here
 * is what guarantees Agent Mode workstream tabs close on delete -- without
 * this, autosave from a surviving workstream tab can recreate the file with
 * stale content.
 */
export const fileDeletedAtomFamily = atomFamily((_filePath: string) =>
  atom(0)
);
