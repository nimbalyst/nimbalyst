/**
 * DiskBackedStore - File system backing store for DocumentModel.
 *
 * Reads/writes files via the Electron IPC bridge (window.electronAPI).
 * Subscribes to file-watcher events for external change notifications.
 */

import type { DocumentBackingStore, ExternalChangeCallback } from './types';
import { DiskChangeSubscription } from './DiskChangeSubscription';
import { assertFileSaveSucceeded } from '../../utils/fileSaveResult';

export class DiskBackedStore implements DocumentBackingStore {
  private readonly filePath: string;
  private changeCallbacks = new Set<ExternalChangeCallback>();
  private deletionCallbacks = new Set<() => void>();
  private subscription: DiskChangeSubscription;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.subscription = new DiskChangeSubscription(filePath, () => this.load(), info => {
      for (const callback of this.changeCallbacks) callback(info);
    }, () => {
      for (const callback of this.deletionCallbacks) callback();
    });
  }

  async load(): Promise<string | ArrayBuffer> {
    const result = await window.electronAPI.readFileContent(this.filePath);
    if (!result || !result.success) {
      throw new Error(`Failed to load file: ${this.filePath}`);
    }
    if (typeof result.content !== 'string') throw new Error(`Invalid file read: ${this.filePath}`);
    return result.content;
  }

  /**
   * `expectedDiskContent` reaches the main process as `lastKnownContent` and
   * arms the conflict check in `FileHandlers.saveFile`. This used to be
   * hardcoded `undefined`, which made every write through this store an
   * unconditional overwrite -- including the autosaves of custom editors and
   * every hidden editor (#3684).
   */
  async save(content: string | ArrayBuffer, expectedDiskContent?: string): Promise<void> {
    if (typeof content === 'string') {
      const result = await window.electronAPI.saveFile(content, this.filePath, expectedDiskContent, 'auto');
      assertFileSaveSucceeded(result);
    } else {
      // Binary content -- convert ArrayBuffer to base64 for IPC
      // This path is for future binary file support
      const uint8 = new Uint8Array(content);
      const binary = Array.from(uint8, (b) => String.fromCharCode(b)).join('');
      const base64 = btoa(binary);
      const result = await window.electronAPI.saveFile(base64, this.filePath, expectedDiskContent, 'auto');
      assertFileSaveSucceeded(result);
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

  dispose(): void {
    this.subscription.dispose();
    this.changeCallbacks.clear();
    this.deletionCallbacks.clear();
  }
}
