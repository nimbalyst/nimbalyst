/**
 * Read-Only EditorHost Factory
 *
 * Creates a read-only EditorHost for displaying historical snapshots.
 * This is a minimal implementation that provides content but ignores saves.
 */

import type { EditorHost, ExtensionStorage, EditorMenuItem } from '@nimbalyst/runtime';

export interface ReadOnlyEditorHostOptions {
  /** Absolute path to the file (for language detection, etc.) */
  filePath: string;

  /** File name (for display) */
  fileName: string;

  /** Current theme */
  theme: string;

  /** The content to display */
  content: string;
}

/**
 * Create a read-only EditorHost for viewing historical content.
 *
 * This host:
 * - Returns the provided content from loadContent()
 * - Ignores all save/dirty operations
 * - Returns no-op unsubscribe functions for event subscriptions
 */
export function createReadOnlyEditorHost(options: ReadOnlyEditorHostOptions): EditorHost {
  // Minimal no-op storage
  const noopStorage: ExtensionStorage = {
    get<T>(_key: string): T | undefined {
      return undefined;
    },
    async set(_key: string, _value: unknown): Promise<void> {},
    async delete(_key: string): Promise<void> {},
    getGlobal<T>(_key: string): T | undefined {
      return undefined;
    },
    async setGlobal(_key: string, _value: unknown): Promise<void> {},
    async deleteGlobal(_key: string): Promise<void> {},
    async getSecret(_key: string): Promise<string | undefined> {
      return undefined;
    },
    async setSecret(_key: string, _value: string): Promise<void> {},
    async deleteSecret(_key: string): Promise<void> {},
  };

  return {
    // ============ FILE INFO ============
    filePath: options.filePath,
    fileName: options.fileName,
    theme: options.theme,
    isActive: true,
    workspaceId: undefined,

    // ============ THEME CHANGES ============
    onThemeChanged(_callback: (theme: string) => void): () => void {
      // Read-only view doesn't need theme updates
      return () => {};
    },

    // ============ CONTENT LOADING ============
    async loadContent(): Promise<string> {
      return options.content;
    },

    async loadBinaryContent(): Promise<ArrayBuffer> {
      // Convert string to ArrayBuffer for binary content
      const encoder = new TextEncoder();
      return encoder.encode(options.content).buffer;
    },

    // ============ FILE CHANGE NOTIFICATIONS ============
    onFileChanged(_callback: (newContent: string) => void): () => void {
      // Read-only - no file changes
      return () => {};
    },

    // ============ DIRTY STATE ============
    setDirty(_isDirty: boolean): void {
      // Read-only - ignore dirty state
    },

    // ============ SAVING ============
    async saveContent(_content: string | ArrayBuffer): Promise<void> {
      // Read-only - ignore saves
    },

    // ============ SAVE REQUESTS ============
    onSaveRequested(_callback: () => void): () => void {
      // Read-only - no save requests
      return () => {};
    },

    // ============ HISTORY ============
    openHistory(): void {
      // Already in history view - no-op
    },

    // ============ OPTIONAL FEATURES (all disabled) ============
    onDiffRequested: undefined,
    reportDiffResult: undefined,
    isDiffModeActive: undefined,
    onDiffCleared: undefined,
    supportsSourceMode: false,
    toggleSourceMode: undefined,
    onSourceModeChanged: undefined,
    isSourceModeActive: undefined,
    getConfig: undefined,

    // ============ STORAGE ============
    storage: noopStorage,

    // ============ EDITOR CONTEXT ============
    setEditorContext(): void {
      // Read-only - ignore editor context
    },
    setEditorContextItems(): void {
      // Read-only - ignore editor context
    },

    // ============ EDITOR API REGISTRATION ============
    registerEditorAPI(): void {
      // Read-only - ignore API registration
    },

    // ============ MENU ITEMS ============
    registerMenuItems(_items: EditorMenuItem[]): void {
      // Read-only - ignore menu registration
    },
  };
}
