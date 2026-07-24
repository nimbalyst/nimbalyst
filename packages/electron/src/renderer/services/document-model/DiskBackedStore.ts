/**
 * DiskBackedStore - File system backing store for DocumentModel.
 *
 * Reads/writes files via the Electron IPC bridge (window.electronAPI).
 * Subscribes to file-watcher events for external change notifications.
 */

import { store } from '@nimbalyst/runtime/store';
import { diffTrace } from '@nimbalyst/runtime/utils/debugFlags';
import type { DocumentBackingStore, ExternalChangeCallback, ExternalChangeInfo } from './types';
import {
  fileChangedOnDiskAtomFamily,
  fileDeletedAtomFamily,
  historyPendingTagCreatedAtomFamily,
} from '../../store/atoms/fileWatch';

export class DiskBackedStore implements DocumentBackingStore {
  private readonly filePath: string;
  private changeCallbacks = new Set<ExternalChangeCallback>();
  private deletionCallbacks = new Set<() => void>();
  private ipcCleanup: (() => void) | null = null;
  private deletionCleanup: (() => void) | null = null;

  /**
   * Timestamps of recent saves made through this store.
   * Used to suppress echo events from the file watcher
   * (our own saves come back as external changes).
   */
  private recentSaveTimestamps = new Set<number>();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.setupFileWatcher();
    this.setupDeletionWatcher();
  }

  async load(): Promise<string | ArrayBuffer> {
    const result = await window.electronAPI.readFileContent(this.filePath);
    if (!result || !result.success) {
      throw new Error(`Failed to load file: ${this.filePath}`);
    }
    return result.content;
  }

  async save(content: string | ArrayBuffer): Promise<void> {
    const now = Date.now();
    this.recentSaveTimestamps.add(now);

    // Clean up old timestamps after 5s
    setTimeout(() => {
      this.recentSaveTimestamps.delete(now);
    }, 5000);

    if (typeof content === 'string') {
      await window.electronAPI.saveFile(content, this.filePath);
    } else {
      // Binary content -- convert ArrayBuffer to base64 for IPC
      // This path is for future binary file support
      const uint8 = new Uint8Array(content);
      const binary = Array.from(uint8, (b) => String.fromCharCode(b)).join('');
      const base64 = btoa(binary);
      await window.electronAPI.saveFile(base64, this.filePath);
    }
  }

  onExternalChange(callback: ExternalChangeCallback): () => void {
    this.changeCallbacks.add(callback);
    return () => {
      this.changeCallbacks.delete(callback);
    };
  }

  onDeletion(callback: () => void): () => void {
    this.deletionCallbacks.add(callback);
    return () => {
      this.deletionCallbacks.delete(callback);
    };
  }

  /**
   * Subscribe to per-path atoms updated by store/listeners/fileChangeListeners.ts.
   *
   * Two events surface as separate atom families:
   * - `file-changed-on-disk`: normal file watcher events
   * - `history:pending-tag-created`: signals echo suppression should be
   *    bypassed to check for AI edits
   */
  private setupFileWatcher(): void {
    const emitChange = async (checkPendingTags: boolean) => {
      const tStart = performance.now();
      diffTrace('DiskBackedStore.emitChange start', { path: this.filePath, checkPendingTags, t: tStart });
      let content: string;
      try {
        const result = await window.electronAPI.readFileContent(this.filePath);
        if (!result || !result.success) return;
        content = result.content ?? '';
      } catch (err) {
        console.error('[DiskBackedStore] Failed to read file after change:', err);
        return;
      }
      diffTrace('DiskBackedStore.emitChange read', {
        path: this.filePath,
        checkPendingTags,
        contentLen: content.length,
        contentHead: content.slice(0, 80),
        readMs: performance.now() - tStart,
        t: performance.now(),
      });

      const info: ExternalChangeInfo = {
        content,
        timestamp: Date.now(),
        checkPendingTags,
      };

      for (const cb of this.changeCallbacks) {
        try {
          cb(info);
        } catch (err) {
          console.error('[DiskBackedStore] Error in external change callback:', err);
        }
      }
    };

    const fileChangeAtom = fileChangedOnDiskAtomFamily(this.filePath);
    const tagCreatedAtom = historyPendingTagCreatedAtomFamily(this.filePath);
    const initialFileChangeVersion = store.get(fileChangeAtom);
    const initialTagCreatedVersion = store.get(tagCreatedAtom);

    const unsubFileChange = store.sub(fileChangeAtom, () => {
      if (store.get(fileChangeAtom) === initialFileChangeVersion) return;
      void emitChange(false);
    });
    const unsubTagCreated = store.sub(tagCreatedAtom, () => {
      if (store.get(tagCreatedAtom) === initialTagCreatedVersion) return;
      void emitChange(true);
    });

    this.ipcCleanup = () => {
      unsubFileChange();
      unsubTagCreated();
    };
  }

  /**
   * Subscribe to per-path file-deleted atom updated by
   * store/listeners/fileChangeListeners.ts. When a delete is observed,
   * notify the DocumentModel so it can refuse subsequent saves until a
   * fresh load re-establishes the baseline.
   */
  private setupDeletionWatcher(): void {
    const deletedAtom = fileDeletedAtomFamily(this.filePath);
    const initial = store.get(deletedAtom);
    const unsub = store.sub(deletedAtom, () => {
      if (store.get(deletedAtom) === initial) return;
      diffTrace('DiskBackedStore.deletion observed', { path: this.filePath, t: performance.now() });
      for (const cb of this.deletionCallbacks) {
        try {
          cb();
        } catch (err) {
          console.error('[DiskBackedStore] Error in deletion callback:', err);
        }
      }
    });
    this.deletionCleanup = unsub;
  }

  /**
   * Clean up IPC listeners. Called when the DocumentModel is disposed.
   */
  dispose(): void {
    this.ipcCleanup?.();
    this.ipcCleanup = null;
    this.deletionCleanup?.();
    this.deletionCleanup = null;
    this.changeCallbacks.clear();
    this.deletionCallbacks.clear();
    this.recentSaveTimestamps.clear();
  }
}
