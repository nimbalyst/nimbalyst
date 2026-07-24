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
