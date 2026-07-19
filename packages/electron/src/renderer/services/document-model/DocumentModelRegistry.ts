/**
 * DocumentModelRegistry - Singleton registry of DocumentModel instances.
 *
 * Ensures one DocumentModel per file path. Editors call getOrCreate()
 * on mount and release() on unmount. When the ref count drops to zero,
 * the model is disposed.
 *
 * All components that create EditorHosts must go through this registry:
 * - TabEditor (EditorMode, AgentMode)
 * - HiddenTabManager
 * - OffscreenEditorRenderer
 */

import { DocumentModel, type DocumentModelOptions } from './DocumentModel';
import { DiskBackedStore } from './DiskBackedStore';
import type { DocumentModelEditorHandle, DocumentModelState } from './types';

interface RegistryEntry {
  currentPath: string;
  model: DocumentModel;
  refCount: number;
}

export type DocumentModelFactory = (filePath: string) => DocumentModel;

class DocumentModelRegistryImpl {
  private entries = new Map<string, RegistryEntry>();
  private handleEntries = new Map<DocumentModelEditorHandle, RegistryEntry>();
  private modelFactory: DocumentModelFactory | null = null;

  /**
   * Override the default model factory (for testing).
   */
  setModelFactory(factory: DocumentModelFactory | null): void {
    this.modelFactory = factory;
  }

  /**
   * Get or create a DocumentModel for a file path.
   * Increments the ref count. Caller MUST call release() when done.
   *
   * Returns the DocumentModel and an EditorHandle for this attachment.
   */
  getOrCreate(filePath: string, options?: DocumentModelOptions): {
    model: DocumentModel;
    handle: DocumentModelEditorHandle;
  } {
    const normalizedPath = this.normalizePath(filePath);
    let entry = this.entries.get(normalizedPath);

    if (!entry) {
      const model = this.modelFactory
        ? this.modelFactory(normalizedPath)
        : this.createDefaultModel(normalizedPath, options);
      entry = { currentPath: normalizedPath, model, refCount: 0 };
      this.entries.set(normalizedPath, entry);
    }

    entry.refCount++;
    const handle = entry.model.attach();
    this.handleEntries.set(handle, entry);

    return { model: entry.model, handle };
  }

  /**
   * Release a reference to a DocumentModel.
   * When ref count reaches zero, the model is disposed.
   */
  release(_filePath: string, handle: DocumentModelEditorHandle): void {
    const entry = this.handleEntries.get(handle);
    if (!entry) return;

    handle.detach();
    entry.refCount--;
    this.handleEntries.delete(handle);

    if (entry.refCount <= 0) {
      entry.model.dispose();
      this.entries.delete(entry.currentPath);
    }
  }

  /**
   * Get an existing DocumentModel without creating one.
   * Returns null if no model exists for this path.
   */
  get(filePath: string): DocumentModel | null {
    const normalizedPath = this.normalizePath(filePath);
    return this.entries.get(normalizedPath)?.model ?? null;
  }

  /**
   * Check if a model exists for a file path.
   */
  has(filePath: string): boolean {
    return this.entries.has(this.normalizePath(filePath));
  }

  /**
   * Get the state of a specific document model.
   */
  getState(filePath: string): DocumentModelState | null {
    const model = this.get(filePath);
    return model?.getState() ?? null;
  }

  /**
   * Get all registered file paths.
   */
  getRegisteredPaths(): string[] {
    return Array.from(this.entries.keys());
  }

  /**
   * Migrate a model to a new file path in-place (file rename).
   *
   * Moves the registry key from oldPath to newPath and updates the model's
   * backing store so that subsequent loads/saves target the new path. All
   * in-memory state is preserved -- dirty buffer, autosave timer, attached
   * editors -- so callers do NOT lose unsaved edits.
   *
   * If oldPath has no registered model the call is a no-op (file was not open).
   * Must be called BEFORE updating any UI that would cause useDocumentModel()
   * to re-run with newPath; otherwise the hook creates a fresh (clean) model.
   */
  rename(oldPath: string, newPath: string): boolean {
    const normalizedOld = this.normalizePath(oldPath);
    const normalizedNew = this.normalizePath(newPath);
    if (normalizedOld === normalizedNew) return true;

    const entry = this.entries.get(normalizedOld);
    if (!entry) return false;

    const existingDestination = this.entries.get(normalizedNew);
    if (existingDestination && existingDestination !== entry) {
      console.warn(
        '[DocumentModelRegistry] Refusing rename to an already-registered path:',
        normalizedNew,
      );
      return false;
    }

    const newStore = new DiskBackedStore(normalizedNew);
    entry.model.migrateToNewPath(normalizedNew, newStore);

    this.entries.delete(normalizedOld);
    entry.currentPath = normalizedNew;
    this.entries.set(normalizedNew, entry);
    return true;
  }

  /**
   * Flush all dirty editors across all models.
   * Used during mode switches.
   */
  async flushAll(): Promise<void> {
    await this.flushPaths(this.entries.keys());
  }

  /**
   * Flush dirty editors for only the requested file paths.
   * Used when transferring one workspace so unrelated projects are untouched.
   */
  async flushPaths(filePaths: Iterable<string>): Promise<void> {
    const promises: Promise<void>[] = [];
    const visited = new Set<RegistryEntry>();
    for (const filePath of filePaths) {
      const entry = this.entries.get(this.normalizePath(filePath));
      if (!entry || visited.has(entry)) continue;
      visited.add(entry);
      if (entry.model.isDirty()) {
        promises.push(entry.model.flushDirtyEditors());
      }
    }
    await Promise.all(promises);
  }

  /**
   * Clear the entire registry (for testing or cleanup).
   */
  clear(): void {
    for (const entry of this.entries.values()) {
      entry.model.dispose();
    }
    this.entries.clear();
    this.handleEntries.clear();
  }

  // -- Internal -------------------------------------------------------------

  private createDefaultModel(filePath: string, options?: DocumentModelOptions): DocumentModel {
    const backingStore = new DiskBackedStore(filePath);

    // Wire up getPendingTags and updateTagStatus via electronAPI
    const modelOptions: DocumentModelOptions = {
      ...options,
      getPendingTags: options?.getPendingTags ?? (async (fp: string) => {
        try {
          if (window.electronAPI?.history) {
            return await window.electronAPI.history.getPendingTags(fp) ?? [];
          }
        } catch (err) {
          console.error('[DocumentModelRegistry] Failed to get pending tags:', err);
        }
        return [];
      }),
      updateTagStatus: options?.updateTagStatus ?? (async (fp: string, tagId: string, status: string) => {
        try {
          if (window.electronAPI?.history) {
            await window.electronAPI.history.updateTagStatus(fp, tagId, status);
          }
        } catch (err) {
          console.error('[DocumentModelRegistry] Failed to update tag status:', err);
        }
      }),
      getDiffBaseline: options?.getDiffBaseline ?? (async (fp: string) => {
        try {
          return await window.electronAPI.invoke('history:get-diff-baseline', fp) ?? null;
        } catch (err) {
          console.error('[DocumentModelRegistry] Failed to get diff baseline:', err);
          return null;
        }
      }),
    };

    return new DocumentModel(filePath, backingStore, modelOptions);
  }

  /**
   * Normalize a file path for consistent Map lookups.
   * Collapses double slashes and removes trailing slashes.
   */
  private normalizePath(filePath: string): string {
    return filePath.replace(/\/\//g, '/').replace(/\/$/, '');
  }
}

/**
 * Singleton instance of the DocumentModelRegistry.
 */
export const DocumentModelRegistry = new DocumentModelRegistryImpl();
