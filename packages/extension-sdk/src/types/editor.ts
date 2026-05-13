/**
 * Types for custom editor extensions.
 *
 * The EditorHost interface is the primary API for custom editors.
 * External extensions should import from @nimbalyst/extension-sdk:
 *
 * ```typescript
 * import type { EditorHost, EditorHostProps } from '@nimbalyst/extension-sdk';
 * ```
 *
 * At runtime, Nimbalyst provides the implementation via the externals system.
 * Your extension code imports from @nimbalyst/runtime, which is externalized
 * and provided by the host.
 */

import type { ExtensionStorage } from './panel.js';

// ============================================================================
// EditorHost API - The primary API for custom editors
// ============================================================================

/**
 * Context that an editor pushes to the chat panel.
 * When set, the chat UI shows an indicator and includes this context
 * in the AI prompt when the user sends a message.
 */
export interface EditorContext {
  /** Short label shown in the chat indicator (e.g., "Screen: Login Page") */
  label: string;

  /**
   * Descriptive context included in the AI prompt.
   * Should describe what's selected and any relevant details.
   */
  description: string;
}

/**
 * Menu item that can be added to the editor's "..." actions menu.
 * Extensions can register these to add custom actions to the header bar.
 */
export interface EditorMenuItem {
  /** Display text for the menu item */
  label: string;

  /** Optional Material Symbols icon name (e.g., 'cloud_upload', 'settings') */
  icon?: string;

  /** Callback when the menu item is clicked */
  onClick: () => void;
}

/**
 * Configuration for diff mode display (AI edit review)
 */
export interface DiffConfig {
  /** Pre-edit content (the baseline before AI changes) */
  originalContent: string;

  /** AI's proposed content (what's now on disk) */
  modifiedContent: string;

  /** History tag ID for tracking this diff */
  tagId: string;

  /** AI session ID that made the edit */
  sessionId: string;
}

/**
 * Result of accepting/rejecting a diff
 */
export interface DiffResult {
  /** The content after user's decision */
  content: string;

  /** Whether user accepted or rejected the changes */
  action: 'accept' | 'reject';
}

/**
 * Host service for custom editors.
 *
 * Provides all communication between editor and host (TabEditor).
 * Editors receive this as a prop and use it for all host interactions.
 *
 * @example
 * ```tsx
 * import type { EditorHostProps } from '@nimbalyst/extension-sdk';
 *
 * function MyEditor({ host }: EditorHostProps) {
 *   useEffect(() => {
 *     host.loadContent().then(content => {
 *       // Parse and display content
 *     });
 *   }, [host]);
 *
 *   useEffect(() => {
 *     return host.onSaveRequested(async () => {
 *       const content = serialize(myData);
 *       await host.saveContent(content);
 *     });
 *   }, [host]);
 * }
 * ```
 */
export interface EditorHost {
  // ============ FILE INFO ============

  /** Absolute path to the file being edited */
  readonly filePath: string;

  /** File name (for display) */
  readonly fileName: string;

  /** Current theme */
  readonly theme: string;

  /** Whether this editor's tab is active */
  readonly isActive: boolean;

  /**
   * Whether the editor is in read-only mode.
   * When true, editors should hide editing UI (toolbars, inline editing,
   * keyboard shortcuts for mutation) and only allow viewing interactions
   * (pan, zoom, scroll, select text).
   *
   * Defaults to false (undefined treated as false for backwards compatibility).
   * Set to true by the web share viewer's ReadOnlyEditorHost.
   */
  readonly readOnly?: boolean;

  /**
   * Whether the editor is rendered inline inside another document
   * (i.e. as an embed in a markdown doc rather than as a full tab).
   *
   * Extensions can use this to suppress persistent chrome that doesn't make
   * sense inside another doc (e.g., side panels, sticky toolbars). The
   * `readOnly` flag is a separate axis; an embed is typically both `embedded`
   * and `readOnly`, but an extension that opts into writable embeds will see
   * `embedded` true and `readOnly` false.
   *
   * Defaults to false (undefined treated as false for backwards compatibility).
   */
  readonly embedded?: boolean;

  /**
   * Subscribe to changes to `readOnly`.
   *
   * Optional: hosts where `readOnly` never changes after construction
   * (TabEditor, share viewer) omit this. Hosts that allow the user to
   * flip between view and edit modes (the inline embed frame) implement
   * it so extensions can react -- e.g. Excalidraw toggles
   * `viewModeEnabled` so toolbars hide in view mode and reappear in
   * edit mode without remounting the canvas.
   *
   * Extensions should read `host.readOnly` for the current value (it is
   * a getter on reactive hosts) and subscribe here for subsequent flips.
   * Returns an unsubscribe function.
   */
  onReadOnlyChanged?(callback: (readOnly: boolean) => void): () => void;

  // ============ THEME CHANGES ============

  /**
   * Subscribe to theme changes.
   * Called when the application theme changes.
   * Editor should update its visual appearance in response.
   *
   * @param callback Called with new theme when it changes
   * @returns Unsubscribe function
   */
  onThemeChanged(callback: (theme: string) => void): () => void;

  /** Workspace identifier (if in a workspace) */
  readonly workspaceId?: string;

  // ============ CONTENT LOADING ============

  /**
   * Load file content from disk as a string.
   * Editor should call this on mount instead of receiving initialContent.
   * For text files (code, markdown, HTML, etc.)
   */
  loadContent(): Promise<string>;

  /**
   * Load file content from disk as binary data.
   * For binary files (PDFs, images, etc.)
   * Returns an ArrayBuffer containing the raw file bytes.
   */
  loadBinaryContent(): Promise<ArrayBuffer>;

  // ============ FILE CHANGE NOTIFICATIONS ============

  /**
   * Subscribe to file change notifications.
   * Called when the file changes on disk (external edit, AI edit, etc.)
   *
   * Editor decides whether to reload based on comparing against its
   * last known disk state. Returns unsubscribe function.
   *
   * @param callback Called with new content when file changes
   * @returns Unsubscribe function
   */
  onFileChanged(callback: (newContent: string) => void): () => void;

  // ============ DIRTY STATE ============

  /**
   * Report dirty state to host.
   * Host uses this for tab indicator and save prompts.
   */
  setDirty(isDirty: boolean): void;

  // ============ SAVING ============

  /**
   * Save content to disk.
   * Editor calls this when it wants to save (autosave, manual save, etc.)
   * Host handles writing to disk and creating history snapshots.
   * Content can be string (text files) or ArrayBuffer (binary files).
   */
  saveContent(content: string | ArrayBuffer): Promise<void>;

  // ============ SAVE REQUESTS ============

  /**
   * Subscribe to save requests from the host.
   * Host calls this when autosave timer fires or user triggers manual save.
   * Editor should call saveContent() in response.
   * Returns unsubscribe function.
   */
  onSaveRequested(callback: () => void): () => void;

  // ============ HISTORY ============

  /**
   * Open history dialog for this file.
   */
  openHistory(): void;

  // ============ DIFF MODE (OPTIONAL) ============

  /**
   * Subscribe to diff mode requests.
   * Called when AI edits are pending review.
   * Only implement if editor supports diff display.
   *
   * @param callback Called with diff config when diff should be shown
   * @returns Unsubscribe function
   */
  onDiffRequested?(callback: (config: DiffConfig) => void): () => void;

  /**
   * Report diff result when user accepts or rejects.
   * Host will save the resulting content and update history.
   */
  reportDiffResult?(result: DiffResult): void;

  /**
   * Check if diff mode is currently active.
   */
  isDiffModeActive?(): boolean;

  /**
   * Subscribe to diff mode being cleared externally.
   * Called when the user accepts/rejects diff via the unified diff header.
   * Editor should clear its diff state when this fires.
   *
   * @param callback Called when diff mode should be cleared
   * @returns Unsubscribe function
   */
  onDiffCleared?(callback: () => void): () => void;

  // ============ SOURCE MODE (OPTIONAL) ============

  /**
   * Request to toggle source mode on/off.
   * When source mode is active, TabEditor renders Monaco to edit raw source
   * instead of the custom editor's visual representation.
   *
   * Only available if supportsSourceMode is true.
   */
  toggleSourceMode?(): void;

  /**
   * Subscribe to source mode state changes.
   * Called when source mode is toggled (either by editor request or external).
   *
   * @param callback Called with new source mode state
   * @returns Unsubscribe function
   */
  onSourceModeChanged?(callback: (isSourceMode: boolean) => void): () => void;

  /**
   * Check if source mode is currently active.
   */
  isSourceModeActive?(): boolean;

  /**
   * Whether this editor supports source mode.
   * If true, a "View Source" button will be available.
   */
  readonly supportsSourceMode?: boolean;

  // ============ CONFIGURATION (OPTIONAL) ============

  /**
   * Get a configuration value for the extension.
   * Only available if the extension has configuration contributions defined.
   * Returns the workspace value if set, otherwise the user value, otherwise the default.
   */
  getConfig?<T>(key: string, defaultValue?: T): T;

  // ============ STORAGE ============

  /**
   * Namespaced storage for persisting editor state.
   * Automatically scoped to this extension.
   * Use for preferences, history, cached data, etc.
   */
  readonly storage: ExtensionStorage;

  // ============ EDITOR CONTEXT ============

  /**
   * Push context to the chat panel.
   * When set, the chat UI shows an indicator (e.g., "+ Screen: Login Page")
   * and includes the description in the AI prompt on the next message.
   *
   * Call with null to clear the context (e.g., when selection is deselected).
   *
   * @example
   * ```tsx
   * // Report selected screen in a project editor
   * host.setEditorContext({
   *   label: 'Screen: Login Page',
   *   description: 'Selected screen "Login Page" (login.mockup.html) in the mockup project.'
   * });
   *
   * // Clear when nothing is selected
   * host.setEditorContext(null);
   * ```
   */
  setEditorContext(context: EditorContext | null): void;

  // ============ EDITOR API REGISTRATION ============

  /**
   * Register an imperative API that AI tools can use to interact with this editor.
   *
   * Call this when your editor's library has fully initialized and its API is ready.
   * The host makes this API available to AI tool handlers via a central registry
   * keyed by filePath. This enables AI tools to work against files that aren't
   * open in a visible tab (the system mounts a hidden editor on demand).
   *
   * Call with `null` to unregister (e.g., in a cleanup function).
   *
   * @example
   * ```tsx
   * // In your editor component, register when the library callback fires:
   * <MyLibrary
   *   onReady={(api) => {
   *     host.registerEditorAPI(api);
   *   }}
   * />
   *
   * // Clean up on unmount:
   * useEffect(() => {
   *   return () => host.registerEditorAPI(null);
   * }, [host]);
   * ```
   */
  registerEditorAPI(api: unknown | null): void;

  // ============ MENU ITEMS ============

  /**
   * Register menu items to appear in the editor's "..." actions menu.
   * Items appear in a dedicated "Extension" section of the dropdown.
   *
   * Call this once during editor initialization.
   * Call again with an empty array to remove all items.
   *
   * @param items Array of menu items to register
   *
   * @example
   * ```tsx
   * useEffect(() => {
   *   host.registerMenuItems([
   *     {
   *       label: 'Save to Cloud',
   *       icon: 'cloud_upload',
   *       onClick: () => saveToCloud()
   *     },
   *     {
   *       label: 'Export as PDF',
   *       icon: 'picture_as_pdf',
   *       onClick: () => exportPdf()
   *     }
   *   ]);
   *
   *   return () => host.registerMenuItems([]); // Cleanup
   * }, [host]);
   * ```
   */
  registerMenuItems(items: EditorMenuItem[]): void;
}

/**
 * Props for custom editor components using the EditorHost API.
 */
export interface EditorHostProps {
  /** Host service for all editor-host communication */
  host: EditorHost;
}

// ============================================================================
// Legacy API - Deprecated
// ============================================================================

/**
 * @deprecated Use EditorHostProps instead.
 *
 * The old CustomEditorProps used a pull-based model where the host would call
 * onGetContentReady to get content. The new EditorHost uses a push-based model
 * where the editor calls host.saveContent() directly.
 *
 * Old pattern (deprecated):
 * ```typescript
 * function MyEditor({ initialContent, onContentChange, onGetContentReady }: CustomEditorProps) {
 *   useEffect(() => {
 *     onGetContentReady?.(() => getContent());
 *   }, []);
 * }
 * ```
 *
 * New pattern (recommended):
 * ```typescript
 * import type { EditorHostProps } from '@nimbalyst/runtime';
 *
 * function MyEditor({ host }: EditorHostProps) {
 *   useEffect(() => {
 *     return host.onSaveRequested(async () => {
 *       const content = getContent();
 *       await host.saveContent(content);
 *     });
 *   }, [host]);
 * }
 * ```
 */
export interface CustomEditorProps {
  /** Absolute path to the file being edited */
  filePath: string;

  /** File name (basename) */
  fileName: string;

  /** Initial file content (may be empty for binary files) */
  initialContent: string;

  /** Current theme */
  theme: string;

  /** Whether this editor tab is currently active/focused */
  isActive: boolean;

  /** Workspace path (if in a workspace) */
  workspaceId?: string;

  /**
   * @deprecated Use host.setDirty() instead
   */
  onContentChange?: () => void;

  /**
   * @deprecated Use host.setDirty() instead
   */
  onDirtyChange?: (isDirty: boolean) => void;

  /**
   * @deprecated Use host.onSaveRequested() and host.saveContent() instead
   */
  onGetContentReady?: (getContentFn: () => string) => void;

  /** Called when user requests to view file history */
  onViewHistory?: () => void;

  /** Called when user requests to rename the document */
  onRenameDocument?: () => void;
}

/**
 * For editors that support the Monaco-style wrapper interface.
 */
export interface EditorWrapper {
  /** Get current content */
  getContent: () => string;

  /** Set content programmatically */
  setContent: (content: string) => void;

  /** Focus the editor */
  focus: () => void;
}
