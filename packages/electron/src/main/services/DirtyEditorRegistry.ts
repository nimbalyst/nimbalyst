/**
 * DirtyEditorRegistry
 *
 * Main-process view of which absolute file paths are currently open in an editor
 * with UNSAVED (dirty) changes. The renderer reports dirty transitions over the
 * `editor:dirty-changed` IPC channel.
 *
 * Personal docs sync (System A) consults this so a remote update never clobbers
 * an editor's unsaved buffer: while a path is dirty the remote write is deferred,
 * and the registry fires a "became clean" event when the editor saves or closes
 * so the deferred write can be re-attempted through the normal conflict guard
 * (NIM-853, Layer 4).
 */
type CleanListener = (filePath: string) => void;

class DirtyEditorRegistry {
  private dirty = new Set<string>();
  private cleanListeners = new Set<CleanListener>();

  /**
   * Mark a path dirty or clean. Transitioning to clean (save or close) notifies
   * listeners so deferred work can flush.
   */
  setDirty(filePath: string, isDirty: boolean): void {
    if (isDirty) {
      this.dirty.add(filePath);
    } else if (this.dirty.delete(filePath)) {
      this.emitClean(filePath);
    }
  }

  isDirty(filePath: string): boolean {
    return this.dirty.has(filePath);
  }

  /** Subscribe to "this path is no longer dirty" transitions. */
  onBecameClean(cb: CleanListener): () => void {
    this.cleanListeners.add(cb);
    return () => this.cleanListeners.delete(cb);
  }

  /** Test/shutdown helper: drop all state and listeners. */
  clear(): void {
    this.dirty.clear();
    this.cleanListeners.clear();
  }

  private emitClean(filePath: string): void {
    for (const cb of this.cleanListeners) {
      try {
        cb(filePath);
      } catch {
        // A listener error must not break the registry or other listeners.
      }
    }
  }
}

export const dirtyEditorRegistry = new DirtyEditorRegistry();
