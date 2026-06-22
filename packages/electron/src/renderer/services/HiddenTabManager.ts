/**
 * Hidden Tab Manager
 *
 * Manages hidden editor instances in the main renderer window for AI agent
 * tool execution. When an agent calls an editor-scoped tool (e.g., Excalidraw)
 * against a file that isn't open in a visible tab, this manager mounts the
 * editor offscreen so the tool handler can access the editor's imperative API.
 *
 * Key differences from OffscreenEditorRenderer:
 * - Runs in the MAIN renderer window (not a separate hidden BrowserWindow)
 * - Uses the full createEditorHost() with proper theme, storage, save support
 * - Reference counting with TTL-based cleanup
 * - Auto-saves after tool modifications
 */

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { EditorHost, ExtensionStorage } from '@nimbalyst/runtime';
import { getExtensionLoader, createExtensionStorage, registerEditorAPI, unregisterEditorAPI, hasExtensionEditorAPI } from '@nimbalyst/runtime';
import { store } from '@nimbalyst/runtime/store';
import { DocumentModelRegistry } from './document-model/DocumentModelRegistry';
import type { DocumentModelEditorHandle } from './document-model/types';
import { fileDeletedAtomFamily } from '../store/atoms/fileWatch';

const LOG_PREFIX = '[HiddenTabManager]';
const TTL_MS = 30_000; // 30 seconds after last release before cleanup
const MAX_HIDDEN_EDITORS = 5;
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 10_000;

interface HiddenEditorInstance {
  filePath: string;
  container: HTMLDivElement;
  root: Root;
  host: EditorHost;
  refCount: number;
  ttlTimer: ReturnType<typeof setTimeout> | null;
  extensionId: string;
  /** DocumentModel handle for coordinated save/dirty tracking */
  documentModelHandle: DocumentModelEditorHandle | null;
  /** Cleanup for the file-deleted atom subscription */
  fileDeletedUnsub: (() => void) | null;
}

class HiddenTabManager {
  private hiddenContainer: HTMLDivElement | null = null;
  private editors = new Map<string, HiddenEditorInstance>();

  /**
   * Initialize the hidden container in the DOM.
   * Call once during app startup.
   */
  public initialize(): void {
    if (this.hiddenContainer) return;

    this.hiddenContainer = document.createElement('div');
    this.hiddenContainer.id = 'hidden-editors';
    this.hiddenContainer.style.position = 'absolute';
    this.hiddenContainer.style.left = '-9999px';
    this.hiddenContainer.style.top = '-9999px';
    this.hiddenContainer.style.width = '1280px';
    this.hiddenContainer.style.height = '800px';
    this.hiddenContainer.style.overflow = 'hidden';
    this.hiddenContainer.style.pointerEvents = 'none';

    document.body.appendChild(this.hiddenContainer);

    // console.log(`${LOG_PREFIX} Initialized`);
  }

  /**
   * Ensure an editor is mounted and its API is available for the given file.
   * If the editor is already mounted (visible tab or existing hidden editor),
   * this returns immediately. Otherwise it mounts a hidden editor and waits
   * for the extension to register its API.
   */
  public async ensureEditor(filePath: string, workspacePath: string): Promise<void> {
    // Already mounted as hidden editor
    if (this.editors.has(filePath)) {
      const instance = this.editors.get(filePath)!;
      instance.refCount++;
      // Cancel any pending TTL cleanup
      if (instance.ttlTimer) {
        clearTimeout(instance.ttlTimer);
        instance.ttlTimer = null;
      }
      // Refresh from disk so a reused hidden editor reflects any out-of-band
      // (agent) write since it was mounted -- otherwise read tools serve a
      // stale buffer. See NIM-905.
      await (instance.host as { _refreshFromDisk?: () => Promise<void> })._refreshFromDisk?.();
      // console.log(`${LOG_PREFIX} Reusing existing hidden editor for ${filePath} (refCount: ${instance.refCount})`);
      return;
    }

    // Check if a visible editor already has this file open
    if (this.isEditorAPIAvailable(filePath)) {
      // console.log(`${LOG_PREFIX} Visible editor already open for ${filePath}`);
      return;
    }

    // No extension owns this file extension -- it's handled by a built-in editor
    // (e.g. Lexical for .md, Monaco for .ts). The bridge calls ensureEditor for any
    // tool invocation that has a resolved filePath, including filesystem-only tools
    // whose active tab happens to be a built-in-editor file. Returning here lets the
    // tool run with editorAPI === undefined; the bridge tolerates that and the tool's
    // own handler decides whether it needs an editor API. See issue #217.
    const fileName = filePath.split('/').pop() || filePath;
    const firstDotIndex = fileName.indexOf('.');
    const fileExtension = firstDotIndex >= 0 ? fileName.slice(firstDotIndex) : '';
    if (fileExtension && !getExtensionLoader().findEditorForExtension(fileExtension)) {
      return;
    }

    // Evict oldest if at capacity
    if (this.editors.size >= MAX_HIDDEN_EDITORS) {
      this.evictOldest();
    }

    // Mount a new hidden editor
    await this.mountEditor(filePath, workspacePath);
  }

  /**
   * Release a reference to a hidden editor. When refCount drops to 0,
   * schedules TTL-based cleanup.
   */
  public release(filePath: string): void {
    const instance = this.editors.get(filePath);
    if (!instance) return;

    instance.refCount = Math.max(0, instance.refCount - 1);

    if (instance.refCount === 0) {
      // Schedule cleanup after TTL
      instance.ttlTimer = setTimeout(() => {
        this.unmountEditor(filePath);
      }, TTL_MS);
      // console.log(`${LOG_PREFIX} Released ${filePath}, cleanup in ${TTL_MS / 1000}s`);
    }
  }

  /**
   * Check if any editor (visible or hidden) has registered an API for this file.
   * Uses the central ExtensionEditorAPIRegistry.
   */
  private isEditorAPIAvailable(filePath: string): boolean {
    return hasExtensionEditorAPI(filePath);
  }

  /**
   * Wait for the extension's editor API to become available.
   */
  private async waitForEditorAPI(filePath: string): Promise<void> {
    const start = Date.now();

    return new Promise<void>((resolve, reject) => {
      const poll = () => {
        if (this.isEditorAPIAvailable(filePath)) {
          resolve();
          return;
        }

        if (Date.now() - start > POLL_TIMEOUT_MS) {
          reject(new Error(`${LOG_PREFIX} Timed out waiting for editor API for ${filePath} (${POLL_TIMEOUT_MS}ms)`));
          return;
        }

        setTimeout(poll, POLL_INTERVAL_MS);
      };

      poll();
    });
  }

  /**
   * Mount a hidden editor for a file.
   */
  private async mountEditor(filePath: string, workspacePath: string): Promise<void> {
    // console.log(`${LOG_PREFIX} Mounting hidden editor for ${filePath}`);

    if (!this.hiddenContainer) {
      this.initialize();
    }

    // Find extension that handles this file
    const extensionLoader = getExtensionLoader();
    const fileName = filePath.split('/').pop() || filePath;
    const firstDotIndex = fileName.indexOf('.');
    const fileExtension = firstDotIndex >= 0 ? fileName.slice(firstDotIndex) : '';

    if (!fileExtension) {
      throw new Error(`${LOG_PREFIX} File has no extension: ${filePath}`);
    }

    const editorInfo = extensionLoader.findEditorForExtension(fileExtension);
    if (!editorInfo) {
      throw new Error(`${LOG_PREFIX} No custom editor registered for ${filePath} (extension: ${fileExtension})`);
    }

    // Create container
    const container = document.createElement('div');
    container.style.width = '100%';
    container.style.height = '100%';

    // Make the container fully visible during initialization.
    // Canvas-based editors (Excalidraw) require real visibility for WebGL/canvas init.
    // Position behind the app content with z-index to minimize visual impact.
    this.hiddenContainer!.style.left = '0px';
    this.hiddenContainer!.style.top = '0px';
    this.hiddenContainer!.style.zIndex = '-9999';
    this.hiddenContainer!.appendChild(container);

    // Acquire a DocumentModel handle for coordinated save/dirty tracking
    const { handle: documentModelHandle } = DocumentModelRegistry.getOrCreate(filePath, {
      autosaveInterval: 0, // Hidden editors save immediately on dirty (100ms debounce)
    });

    // Create EditorHost
    const host = this.createEditorHost(filePath, workspacePath, editorInfo.extensionId, documentModelHandle);

    // Create React root and mount
    const root = createRoot(container);
    const EditorComponent = editorInfo.component as React.ComponentType<{ host: EditorHost }>;
    root.render(React.createElement(EditorComponent, { host }));

    // Subscribe to file-deleted atom: when a delete is detected for this
    // path, unmount immediately so no autosave can recreate the file.
    const deletedAtom = fileDeletedAtomFamily(filePath);
    const initialDeletedVersion = store.get(deletedAtom);
    const fileDeletedUnsub = store.sub(deletedAtom, () => {
      if (store.get(deletedAtom) === initialDeletedVersion) return;
      this.unmountEditor(filePath);
    });

    // Store instance
    this.editors.set(filePath, {
      filePath,
      container,
      root,
      host,
      refCount: 1,
      ttlTimer: null,
      extensionId: editorInfo.extensionId,
      documentModelHandle,
      fileDeletedUnsub,
    });

    // Wait for the editor API to register, then move offscreen
    try {
      await this.waitForEditorAPI(filePath);
      // console.log(`${LOG_PREFIX} Hidden editor ready for ${filePath}`);
    } catch (error) {
      // Cleanup on failure
      this.unmountEditor(filePath);
      throw error;
    } finally {
      // Move back offscreen regardless of success/failure
      this.hiddenContainer!.style.left = '-9999px';
      this.hiddenContainer!.style.top = '-9999px';
      this.hiddenContainer!.style.zIndex = '';
    }
  }

  /**
   * Unmount a hidden editor and clean up.
   */
  private unmountEditor(filePath: string): void {
    const instance = this.editors.get(filePath);
    if (!instance) return;

    // console.log(`${LOG_PREFIX} Unmounting hidden editor for ${filePath}`);

    // Clean up the central editor API registry
    unregisterEditorAPI(filePath);

    // Release DocumentModel handle
    if (instance.documentModelHandle) {
      DocumentModelRegistry.release(filePath, instance.documentModelHandle);
    }

    // Unsubscribe from file-deleted atom
    if (instance.fileDeletedUnsub) {
      instance.fileDeletedUnsub();
    }

    if (instance.ttlTimer) {
      clearTimeout(instance.ttlTimer);
    }

    instance.root.unmount();

    if (instance.container.parentNode) {
      instance.container.parentNode.removeChild(instance.container);
    }

    this.editors.delete(filePath);
  }

  /**
   * Evict the oldest hidden editor (lowest refCount, or oldest by insertion).
   */
  private evictOldest(): void {
    // Find an editor with refCount 0 first
    for (const [filePath, instance] of this.editors) {
      if (instance.refCount === 0) {
        // console.log(`${LOG_PREFIX} Evicting idle hidden editor: ${filePath}`);
        this.unmountEditor(filePath);
        return;
      }
    }

    // All editors are in use -- evict the first one
    const firstKey = this.editors.keys().next().value;
    if (firstKey) {
      // console.log(`${LOG_PREFIX} Evicting oldest hidden editor: ${firstKey}`);
      this.unmountEditor(firstKey);
    }
  }

  /**
   * Create an EditorHost for a hidden editor.
   * This creates a functional host with file I/O and auto-save support.
   */
  private createEditorHost(filePath: string, workspacePath: string, extensionId: string, documentModelHandle?: DocumentModelEditorHandle | null): EditorHost {
    const fileName = filePath.split('/').pop() || filePath;
    const electronAPI = (window as any).electronAPI;

    // Track dirty state and the content this hidden editor last loaded/saved.
    // `lastKnownContent` is the per-hidden-editor conflict baseline (NIM-905):
    // the content we believe is on disk. NOT the shared DocumentModel's
    // lastPersistedContent, which the file watcher may advance to an agent's
    // out-of-band write and thereby mask a divergence.
    let isDirty = false;
    let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
    let lastKnownContent: string | null = null;

    // Subscribers
    const fileChangeCallbacks: Array<(content: string) => void> = [];
    const saveRequestCallbacks: Array<() => void | Promise<void>> = [];
    const themeChangeCallbacks: Array<(theme: string) => void> = [];

    // Get current theme from document
    const getCurrentTheme = (): string => {
      return document.documentElement.getAttribute('data-theme') || 'dark';
    };

    // Extension storage
    let storage: ExtensionStorage;
    try {
      storage = createExtensionStorage(extensionId);
    } catch {
      // Fallback to stub storage
      storage = {
        get: () => undefined,
        set: async () => {},
        delete: async () => {},
        getGlobal: () => undefined,
        setGlobal: async () => {},
        deleteGlobal: async () => {},
        getSecret: async () => undefined,
        setSecret: async () => {},
        deleteSecret: async () => {},
      };
    }

    // Read current disk content (text). Returns null on failure.
    const readDiskContent = async (): Promise<string | null> => {
      try {
        const result = await electronAPI.readFileContent(filePath);
        return result?.success ? (result.content || '') : null;
      } catch {
        return null;
      }
    };

    // Reload the hidden editor from disk if it diverged from what we last knew.
    // Hidden editors are read replicas: they must reflect out-of-band (agent)
    // writes, including ones routed through DocumentModel's diff branch that the
    // hidden host never observes via onFileChanged. See NIM-905.
    const refreshFromDisk = async (): Promise<void> => {
      const diskContent = await readDiskContent();
      if (diskContent !== null && diskContent !== lastKnownContent) {
        lastKnownContent = diskContent;
        for (const cb of fileChangeCallbacks) {
          try { cb(diskContent); } catch (err) { console.warn(`${LOG_PREFIX} reload callback failed`, err); }
        }
      }
    };

    // Conflict-aware flush -- the ONLY path that writes a hidden editor to disk.
    // Save-on-dirty is intentionally disarmed (NIM-905): a hidden editor must
    // never autosave a stale buffer over an out-of-band write. At flush time we
    // read disk fresh; if it diverged from our baseline an external write landed
    // and we reload instead of overwriting. Only when disk still matches our
    // baseline do we let the editor persist its (genuinely mutated) content.
    const conflictAwareFlush = () => {
      if (autoSaveTimer) clearTimeout(autoSaveTimer);
      // Small debounce to batch rapid consecutive changes (e.g., add_elements batches)
      autoSaveTimer = setTimeout(async () => {
        const diskContent = await readDiskContent();
        if (diskContent !== null && lastKnownContent !== null && diskContent !== lastKnownContent) {
          // External write landed since we loaded -- do not clobber it; reload.
          lastKnownContent = diskContent;
          for (const cb of fileChangeCallbacks) {
            try { cb(diskContent); } catch (err) { console.warn(`${LOG_PREFIX} reload callback failed`, err); }
          }
          return;
        }
        // Only persist when the editor actually has pending edits. A read-only
        // tool leaves the editor clean; flushing its (possibly mid-reload)
        // buffer would be a needless and potentially clobbering write. This is
        // the extension-agnostic safety net behind the `readOnly` tool flag.
        if (!isDirty) return;
        for (const cb of saveRequestCallbacks) {
          try { await cb(); } catch (err) { console.warn(`${LOG_PREFIX} save request failed`, err); }
        }
      }, 100);
    };

    const host: EditorHost = {
      filePath,
      fileName,
      get theme() { return getCurrentTheme(); },
      isActive: false,
      workspaceId: workspacePath,

      async loadContent(): Promise<string> {
        const result = await electronAPI.readFileContent(filePath);
        if (!result || !result.success) {
          throw new Error(result?.error || 'Failed to load file');
        }
        const content = result.content || '';
        // Establish the conflict baseline for this hidden editor.
        lastKnownContent = content;
        return content;
      },

      async loadBinaryContent(): Promise<ArrayBuffer> {
        const result = await electronAPI.readFileContent(filePath, { binary: true });
        if (!result || !result.success) {
          throw new Error(result?.error || 'Failed to load binary file');
        }
        const binaryString = atob(result.content);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
      },

      onFileChanged(callback: (newContent: string) => void): () => void {
        fileChangeCallbacks.push(callback);
        // Also register with DocumentModel handle for coordinated notifications
        const handleCleanup = documentModelHandle?.onFileChanged((content) => {
          if (typeof content === 'string') {
            callback(content);
          }
        });
        return () => {
          const index = fileChangeCallbacks.indexOf(callback);
          if (index >= 0) fileChangeCallbacks.splice(index, 1);
          handleCleanup?.();
        };
      },

      setDirty(dirty: boolean): void {
        isDirty = dirty;
        documentModelHandle?.setDirty(dirty);
        // NOTE (NIM-905): deliberately NOT triggering a save here. Save-on-dirty
        // let a stale hidden buffer clobber an out-of-band write. Hidden editors
        // persist only via the explicit, conflict-aware post-tool flush.
      },

      async saveContent(content: string | ArrayBuffer): Promise<void> {
        if (documentModelHandle) {
          // Delegate to DocumentModel for coordinated save
          await documentModelHandle.saveContent(content);
        } else if (typeof content === 'string') {
          await electronAPI.saveFile(content, filePath);
        } else {
          throw new Error('Binary content saving not yet implemented for hidden editors');
        }
        // Advance the conflict baseline to what we just wrote so a subsequent
        // flush doesn't mistake our own save for an external divergence.
        if (typeof content === 'string') {
          lastKnownContent = content;
        }
        isDirty = false;
      },

      onSaveRequested(callback: () => void | Promise<void>): () => void {
        saveRequestCallbacks.push(callback);
        // Also register with DocumentModel handle
        const handleCleanup = documentModelHandle?.onSaveRequested(callback);
        return () => {
          const index = saveRequestCallbacks.indexOf(callback);
          if (index >= 0) saveRequestCallbacks.splice(index, 1);
          handleCleanup?.();
        };
      },

      openHistory(): void {
        // Not applicable for hidden editors
      },

      onThemeChanged(callback: (theme: string) => void): () => void {
        themeChangeCallbacks.push(callback);
        return () => {
          const index = themeChangeCallbacks.indexOf(callback);
          if (index >= 0) themeChangeCallbacks.splice(index, 1);
        };
      },

      storage,

      setEditorContext(): void {
        // Hidden editors don't push context to chat
      },

      registerEditorAPI(api: unknown | null): void {
        if (api) {
          registerEditorAPI(filePath, api, conflictAwareFlush);
        } else {
          unregisterEditorAPI(filePath);
        }
      },

      registerMenuItems(): void {
        // Hidden editors don't register menu items
      },
    };

    // Internal hook so the manager can force a disk refresh on reuse (NIM-905).
    (host as { _refreshFromDisk?: () => Promise<void> })._refreshFromDisk = refreshFromDisk;

    return host;
  }
}

// Singleton instance
export const hiddenTabManager = new HiddenTabManager();
