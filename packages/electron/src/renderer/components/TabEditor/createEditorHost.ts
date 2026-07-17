/**
 * EditorHost Factory
 *
 * Creates an EditorHost instance for custom editors.
 * This bridges the EditorHost interface (from runtime) to TabEditor's machinery.
 */

import type {
  EditorHost,
  EditorContext,
  DiffConfig,
  DiffResult,
  ExtensionStorage,
  EditorMenuItem,
  EditorHostFileSystem,
} from '@nimbalyst/runtime';
import { registerEditorAPI, unregisterEditorAPI } from '@nimbalyst/runtime';
import { normalizeExternalHttpsUrl } from './externalUrl';

export interface EditorHostOptions {
  /** Absolute path to the file being edited */
  filePath: string;

  /** File name (for display) */
  fileName: string;

  /** Get current theme value */
  getTheme: () => string;

  /** Subscribe to theme changes */
  subscribeToThemeChanges: (callback: (theme: string) => void) => () => void;

  /** Whether this editor's tab is active */
  isActive: boolean;

  /** Workspace identifier (if in a workspace) */
  workspaceId?: string;

  /** Read file content from disk as string */
  readFile: (path: string) => Promise<string>;

  /** Read file content from disk as binary */
  readBinaryFile: (path: string) => Promise<ArrayBuffer>;

  /** Subscribe to file changes. Returns the new content when file changes on disk. */
  subscribeToFileChanges: (
    callback: (newContent: string) => void
  ) => () => void;

  /** Report dirty state change to host */
  onDirtyChange: (isDirty: boolean) => void;

  /** Save content to disk */
  saveContent: (content: string | ArrayBuffer) => Promise<void>;

  /** Subscribe to save requests from host */
  subscribeToSaveRequests: (callback: () => void | Promise<void>) => () => void;

  /** Trigger an immediate save (bypasses auto-save timer). Used after AI tool execution. */
  triggerSave?: () => void;

  /** Open history dialog */
  openHistory: () => void;

  /** Host-backed project filesystem (read / compare-and-swap write / change subscription). */
  fs?: EditorHostFileSystem;

  /** Open an already host-reviewed URL outside the renderer. */
  openExternal?: (url: string) => Promise<void>;

  /** Optional: Subscribe to diff requests */
  subscribeToDiffRequests?: (
    callback: (config: DiffConfig) => void
  ) => () => void;

  /** Optional: Report diff result */
  reportDiffResult?: (result: DiffResult) => Promise<void>;

  /** Optional: Check if diff mode is active */
  isDiffModeActive?: () => boolean;

  /** Optional: Subscribe to diff being cleared externally */
  subscribeToDiffCleared?: (callback: () => void) => () => void;

  // ============ SOURCE MODE (OPTIONAL) ============

  /** Whether this editor supports source mode */
  supportsSourceMode?: boolean;

  /** Toggle source mode on/off */
  toggleSourceMode?: () => void;

  /** Subscribe to source mode changes */
  subscribeToSourceModeChanges?: (
    callback: (isSourceMode: boolean) => void
  ) => () => void;

  /** Check if source mode is currently active */
  isSourceModeActive?: () => boolean;

  // ============ CONFIGURATION (OPTIONAL) ============

  /** Get a configuration value for the extension */
  getConfig?: <T>(key: string, defaultValue?: T) => T;

  // ============ STORAGE ============

  /** Extension storage instance for persisting state */
  storage: ExtensionStorage;

  // ============ EDITOR CONTEXT ============

  /** Callback when extension pushes context to the chat */
  onEditorContextChanged?: (context: EditorContext | null) => void;

  // ============ MENU ITEMS ============

  /** Callback when extension registers menu items for the header bar */
  onMenuItemsChanged?: (items: EditorMenuItem[]) => void;
}

/**
 * Create an EditorHost instance from TabEditor options.
 *
 * This factory creates a host object that implements the EditorHost interface
 * by wiring up to TabEditor's existing save/load/watch machinery.
 */
export function createEditorHost(options: EditorHostOptions): EditorHost {
  return {
    // ============ FILE INFO ============
    filePath: options.filePath,
    fileName: options.fileName,
    // Use getters for reactive properties that can change after creation
    get theme() { return options.getTheme(); },
    get isActive() { return options.isActive; },
    workspaceId: options.workspaceId,

    // ============ THEME CHANGES ============
    onThemeChanged(callback: (theme: string) => void): () => void {
      return options.subscribeToThemeChanges(callback);
    },

    // ============ CONTENT LOADING ============
    async loadContent(): Promise<string> {
      return options.readFile(options.filePath);
    },

    async loadBinaryContent(): Promise<ArrayBuffer> {
      return options.readBinaryFile(options.filePath);
    },

    // ============ FILE CHANGE NOTIFICATIONS ============
    onFileChanged(callback: (newContent: string) => void): () => void {
      return options.subscribeToFileChanges(callback);
    },

    // ============ DIRTY STATE ============
    setDirty(isDirty: boolean): void {
      options.onDirtyChange(isDirty);
    },

    // ============ SAVING ============
    async saveContent(content: string | ArrayBuffer): Promise<void> {
      // Virtual (fileless) tabs have no disk backing; swallow saves so editors
      // that call saveContent on a virtual path don't hit the disk save IPC.
      if (options.filePath.startsWith('virtual://')) return;
      return options.saveContent(content);
    },

    // ============ SAVE REQUESTS ============
    onSaveRequested(callback: () => void): () => void {
      return options.subscribeToSaveRequests(callback);
    },

    // ============ HISTORY ============
    openHistory(): void {
      options.openHistory();
    },

    fs: options.fs,

    openExternal: options.openExternal
      ? async (url: string): Promise<void> => {
          await options.openExternal!(normalizeExternalHttpsUrl(url));
        }
      : undefined,

    // ============ DIFF MODE (OPTIONAL) ============
    onDiffRequested: options.subscribeToDiffRequests
      ? (callback: (config: DiffConfig) => void) => options.subscribeToDiffRequests!(callback)
      : undefined,

    reportDiffResult: options.reportDiffResult
      ? (result: DiffResult) => {
          options.reportDiffResult!(result);
        }
      : undefined,

    isDiffModeActive: options.isDiffModeActive,

    onDiffCleared: options.subscribeToDiffCleared
      ? (callback: () => void) => options.subscribeToDiffCleared!(callback)
      : undefined,

    // ============ SOURCE MODE (OPTIONAL) ============
    supportsSourceMode: options.supportsSourceMode,

    toggleSourceMode: options.toggleSourceMode,

    onSourceModeChanged: options.subscribeToSourceModeChanges
      ? (callback: (isSourceMode: boolean) => void) =>
          options.subscribeToSourceModeChanges!(callback)
      : undefined,

    isSourceModeActive: options.isSourceModeActive,

    // ============ CONFIGURATION (OPTIONAL) ============
    getConfig: options.getConfig,

    // ============ STORAGE ============
    storage: options.storage,

    // ============ EDITOR CONTEXT ============
    setEditorContext(context: EditorContext | null): void {
      options.onEditorContextChanged?.(context);
    },

    // ============ EDITOR API REGISTRATION ============
    registerEditorAPI(api: unknown | null): void {
      if (api) {
        registerEditorAPI(options.filePath, api, options.triggerSave);
      } else {
        unregisterEditorAPI(options.filePath);
      }
    },

    // ============ MENU ITEMS ============
    registerMenuItems(items: EditorMenuItem[]): void {
      options.onMenuItemsChanged?.(items);
    },
  };
}
