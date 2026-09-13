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
  fileWatcherHealthAtomFamily, fileReconciliationAtomFamily, activeFileReconciliations,
  fileDeletedAtomFamily,
  historyPendingTagCreatedAtomFamily,
} from '../atoms/fileWatch';

import type { FileWatchHealth } from '../../../shared/fileWatchHealth';
import { errorNotificationService } from '../../services/ErrorNotificationService';

let initialized = false;

export function initFileChangeListeners(): () => void {
  if (initialized) {
    return () => {};
  }
  initialized = true;

  const cleanups: Array<() => void> = [];
  const warnings = new Map<string, { timer?: ReturnType<typeof setTimeout>; shown: boolean }>();
  const healthCleanup = window.electronAPI?.on?.('file:watch-health', (data: FileWatchHealth & { root: string }) => {
    if (!data?.root) return;
    store.set(fileWatcherHealthAtomFamily(data.root), data);
    const existing = warnings.get(data.root);
    if (data.state === 'watching' || data.state === 'stopped') {
      if (existing?.timer) clearTimeout(existing.timer);
      if (existing?.shown && data.state === 'watching') errorNotificationService.showInfo('File updates resumed', 'Open files are being checked for changes.');
      warnings.delete(data.root);
    } else if (data.state === 'recovering' && !existing) {
      const warning = { shown: false, timer: undefined as ReturnType<typeof setTimeout> | undefined };
      warning.timer = setTimeout(() => {
        warning.timer = undefined;
        warning.shown = true;
        errorNotificationService.showWarning('File updates delayed', 'Automatic file updates are recovering. Open files will continue to be checked for changes.', { duration: 10_000 });
      }, 10_000);
      warnings.set(data.root, warning);
    }
  });
  if (typeof healthCleanup === 'function') cleanups.push(healthCleanup);
  const reconcileCleanup = window.electronAPI?.on?.('file:reconciled', (data: { token: string; status: 'changed' | 'deleted' | 'error'; errorCode?: string }) => {
    if (data && activeFileReconciliations.has(data.token)) store.set(fileReconciliationAtomFamily(data.token), { status: data.status, errorCode: data.errorCode });
  });
  if (typeof reconcileCleanup === 'function') cleanups.push(reconcileCleanup);
  cleanups.push(() => { for (const warning of warnings.values()) if (warning.timer) clearTimeout(warning.timer); });

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
