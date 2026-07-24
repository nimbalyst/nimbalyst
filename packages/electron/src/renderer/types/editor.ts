/**
 * Shared types for multi-editor tab architecture
 */

/**
 * Represents a single editor instance with its associated state
 */
export interface EditorInstance {
  /** Unique file path - serves as the key for this editor */
  filePath: string;

  /** Reference to the editor component/container */
  editorRef: React.RefObject<any> | null;

  /** Current content */
  content: string;

  /** Initial/saved content (for dirty comparison) */
  initialContent: string;

  /** Whether the editor has unsaved changes */
  isDirty: boolean;

  /** Scroll position (0-1 normalized) */
  scrollPosition: number;

  /** Last time this editor was accessed (for LRU eviction) */
  lastAccessed: number;

  /** Whether this editor is currently visible */
  isVisible: boolean;

  /** Whether this editor is sleeping (not rendered, but state preserved) */
  isSleeping: boolean;

  /** Optional: Undo/redo history state */
  historyState?: any;

  /** Autosave timer reference */
  autosaveTimer?: NodeJS.Timeout | null;

  /** Last time content changed (for autosave debouncing) */
  lastChangeTime?: number;

  /** Last time this file was saved (to ignore file change events shortly after) */
  lastSaveTime?: number;

  /** Last saved content - used to detect self-saves vs external changes */
  lastSavedContent?: string;

  /** File watcher cleanup function */
  fileWatcherCleanup?: (() => void) | null;

  /** Reload version - increments only on external file changes to force React remount */
  reloadVersion?: number;
}

/**
 * Configuration for the EditorPool
 */
export interface EditorPoolConfig {
  /** Maximum number of concurrent editor instances */
  maxInstances: number;

  /** Whether to preserve dirty editors from eviction */
  preserveDirty: boolean;

  /** Callback when an editor is evicted */
  onEvict?: (instance: EditorInstance) => void;

  /** Callback when an editor is created */
  onCreate?: (filePath: string) => void;
}

/**
 * Tab metadata (separate from editor instance)
 */
export interface TabMetadata {
  id: string;
  filePath: string;
  fileName: string;
  isDirty: boolean;
  isPinned: boolean;
  lastSaved?: Date;
  isVirtual?: boolean;
}
