/**
 * Central File Change Listeners
 *
 * Subscribes to per-file IPC events ONCE and dispatches to atom-family
 * entries keyed by file path. Consumers (DocumentModel backing stores,
 * TabEditor instances, tab systems) read their own entry via store.sub or
 * useAtomValue.
 *
 * Events:
 * - file-changed-on-disk -> fileChangedOnDiskAtomFamily(path)
 * - history:pending-tag-created -> historyPendingTagCreatedAtomFamily(path)
 * - file-deleted -> fileDeletedAtomFamily(path)
 *
 * Call initFileChangeListeners() once at app startup.
 */

import { store } from '@nimbalyst/runtime/store';
import { diffTrace } from '@nimbalyst/runtime/utils/debugFlags';
import {
  fileChangedOnDiskAtomFamily,
  fileDeletedAtomFamily,
  historyPendingTagCreatedAtomFamily,
} from '../atoms/fileWatch';

let initialized = false;

export function initFileChangeListeners(): () => void {
  if (initialized) {
    return () => {};
  }
  initialized = true;

  const cleanups: Array<() => void> = [];

  const u1 = window.electronAPI?.on?.('file-changed-on-disk', (data: { path: string }) => {
    if (!data?.path) return;
    // diffTrace('IPC file-changed-on-disk', { path: data.path, t: performance.now() });
    store.set(fileChangedOnDiskAtomFamily(data.path), (v) => v + 1);
  });
  if (typeof u1 === 'function') cleanups.push(u1);

  const u2 = window.electronAPI?.on?.('history:pending-tag-created', (data: { path: string }) => {
    if (!data?.path) return;
    diffTrace('IPC history:pending-tag-created', { path: data.path, t: performance.now() });
    store.set(historyPendingTagCreatedAtomFamily(data.path), (v) => v + 1);
  });
  if (typeof u2 === 'function') cleanups.push(u2);

  // file-deleted: bumped when the main process detects (or is told about) a
  // file deletion. Every tab system + DocumentModel backing store reads the
  // matching atom-family entry to close its tab and refuse further saves.
  const u3 = window.electronAPI?.on?.('file-deleted', (data: { filePath: string }) => {
    if (!data?.filePath) return;
    diffTrace('IPC file-deleted', { path: data.filePath, t: performance.now() });
    store.set(fileDeletedAtomFamily(data.filePath), (v) => v + 1);
  });
  if (typeof u3 === 'function') cleanups.push(u3);

  return () => {
    initialized = false;
    cleanups.forEach((c) => c());
  };
}
