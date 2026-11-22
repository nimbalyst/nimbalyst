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

import type { Doc as YDoc } from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import type { ExtensionStorage } from './panel.js';
import type { CollaborationCommentsService } from './comments.js';

// ============================================================================
// Collaboration types
// ============================================================================

/**
 * Connection status of a collaborative session.
 *
 * Mirrors `DocumentSyncStatus` in `@nimbalyst/runtime`. Extensions should treat
 * any non-`'connected'` value as "not safe to assume the server has our
 * latest edits" for UI purposes; the underlying Y.Doc remains usable
 * regardless (CRDT updates queue locally until reconnection).
 */
export type CollaborationStatus =
  | 'disconnected'
  | 'connecting'
  | 'syncing'
  | 'replaying'
  | 'offline-unsynced'
  | 'connected'
  | 'error';

/**
 * The standard awareness fields the host renders generically (presence
 * avatars, cursors). Extensions may add arbitrary extra keys -- those extras
 * are opaque to the host and handled by the extension itself.
 */
export interface StandardAwarenessState {
  user: { id: string; name: string; color: string };
  pointer?: { x: number; y: number };
  selection?: unknown;
  [k: string]: unknown;
}

/**
 * Snapshot of a remote collaborator currently in awareness. Provided as a
 * convenience for the SDK hook; extensions that need richer per-editor
 * awareness fields should read `host.collaboration.awareness.getStates()`
 * directly.
 */
export interface CollaboratorInfo {
  user: { id: string; name: string; color: string };
}

/**
 * Available on `EditorHost` only when the document was opened collaboratively.
 *
 * When undefined, the extension should fall back to its standard
 * `host.loadContent()` / `host.saveContent()` flow. When defined, the
 * extension MUST drive its state through the Y.Doc (and the host will not
 * call `host.onSaveRequested` for this document -- persistence is the
 * server's encrypted blob store).
 */
export interface CollaborationContext {
  /**
   * The shared Y.Doc. Extensions create their own shared types within it
   * (e.g. `yDoc.getArray('elements')`).
   */
  readonly yDoc: YDoc;

  /**
   * `y-protocols/awareness` instance carrying remote presence. Extension
   * bindings register their own local awareness fields here (cursor, tool,
   * selection) and observe changes via `awareness.on('change', ...)`.
   *
   * The host wires this into the encrypted transport so awareness updates
   * are throttled and end-to-end encrypted on the wire.
   */
  readonly awareness: Awareness;

  /** Identity used to drive `awareness` and presence display. */
  readonly user: { id: string; name: string; color: string };

  /**
   * Host-owned collaborative comments for this document. Absent when the host
   * cannot provide live authorization, hydration, identity, and notification
   * routing for the capability.
   */
  readonly comments?: CollaborationCommentsService;

  /** Current connection status. */
  getStatus(): CollaborationStatus;

  /** Subscribe to status changes. Returns an unsubscribe fn. */
  onStatusChange(cb: (status: CollaborationStatus) => void): () => void;

  /**
   * Returns the file content that should be used to seed the Y.Doc when this
   * client is the first to open it. The host owns reading the bytes (from
   * disk, from in-memory Share-to-Team payload, etc.) so extensions never
   * reason about file paths in collab mode.
   */
  loadInitialContent(): Promise<string | ArrayBuffer>;

  /**
   * Flush the current Y.Doc state upstream and resolve ONLY after the server
   * confirms it persisted the update (not merely after the socket write).
   *
   * The SDK awaits this after seeding a first-open collaborative document so the
   * seed is durably on the server before the provider can tear down. Resolves
   * `true` on a server-acked persist, `false` on timeout / not-yet-connected —
   * the host surfaces a failed flush to the user (pending-seed machinery)
   * rather than silently losing the seed. Required on the collab context: a
   * host that can't guarantee the flush would reintroduce the seed data-loss
   * race that made this method necessary.
   */
  flushWithAck(timeoutMs?: number): Promise<boolean>;

  /**
   * True when the transport skipped server payloads it could not decode
   * (stale key epoch, corruption). An "empty" Y.Doc then does NOT mean the
   * room is empty — the SDK must not run the first-open seed, or a default
   * document gets written over real-but-unreadable content for every client.
   */
  hasUndecodedContent?(): boolean;

  /**
   * Host-level reporting hook for first-open seed durability. The SDK calls
   * this when seeding succeeds, throws, or its server-persisted flush is not
   * confirmed, so extension authors do not have to wire their own toast to
   * avoid silent blank-room failures.
   */
  reportSeedOutcome?(outcome: { ok: boolean; error?: unknown }): void;

  /**
   * @deprecated Use {@link flushWithAck}, which awaits a server-persisted ack.
   * `flushLocalState` fires-and-forgets (resolves after the socket write, not
   * the server ack) and rode in the mindmap seed data-loss race. Retained only
   * so existing callers keep compiling.
   */
  flushLocalState?(): Promise<void>;

  /**
   * Register a revision-history snapshot adapter for this collaborative
   * document. Extensions opt in by implementing `exportRevisionSnapshot`
   * and `restoreRevisionSnapshot`; the host wires these into the
   * shared-document History dialog so users can preview and restore past
   * versions of the document.
   *
   * Call this once after binding the editor to the Y.Doc (e.g. inside the
   * same effect that wires `useCollaborativeEditor`). The returned function
   * unregisters the adapter -- call it on unmount.
   *
   * When no adapter is registered, the host falls back to a metadata-only
   * history view: users can see when revisions were taken and by whom, but
   * cannot preview or restore them.
   *
   * Implementations should serialize the editor-native state (e.g. an
   * Excalidraw scene JSON) deterministically so dedupe-on-hash is stable.
   */
  registerRevisionAdapter?(adapter: RevisionSnapshotAdapter): () => void;

  /**
   * Register a synchronous drain of the editor's pending local content into the
   * Y.Doc. The returned function unregisters it -- call it on unmount.
   *
   * A binding that debounces its local pushes holds the newest edit outside the
   * CRDT until the debounce fires. The host awaits this before it reports a
   * write as complete -- notably after every mutating extension AI tool -- so an
   * agent edit is in the Y.Doc and server-acked before the tool returns.
   * Without it the tool reports success while the edit is still in the
   * debounce, and a peer update landing in that window discards it: the same
   * loss window that direct keystrokes close by calling `syncNow()`.
   *
   * Bindings that write through to the Y.Doc synchronously do not need this.
   */
  registerContentFlush?(flush: () => void | Promise<void>): () => void;
}

/**
 * Editor-supplied snapshot round-trip for collaborative revision history.
 * See `CollaborationContext.revisionAdapter`.
 */
export interface RevisionSnapshotAdapter {
  /**
   * Snapshot payload format identifier, e.g. `excalidraw-json` or
   * `mindmap-yaml`. Treated as opaque by the server; used by the dialog to
   * pick a renderer (or fall back to metadata-only display).
   */
  readonly contentFormat: string;

  /** Capture the current document state as bytes. */
  exportRevisionSnapshot(): Uint8Array | Promise<Uint8Array>;

  /**
   * Apply a previously captured snapshot back into the live document.
   * Implementations should produce normal collaborative edits so the
   * change broadcasts to peers via the standard Yjs path.
   */
  restoreRevisionSnapshot(plaintext: Uint8Array): void | Promise<void>;

  /**
   * Optional read-only preview component name for the History dialog. When
   * absent, the dialog shows metadata only.
   */
  readonly previewKind?: 'text' | 'metadata-only';
}

// ============================================================================
// Host capability negotiation
// ============================================================================

/**
 * A thing an editor might want to do that not every host can provide.
 *
 * The same extension bundle now runs in more than one host: the Electron
 * renderer (filesystem, AI panel, Monaco source mode) and a browser host
 * driving a collaborative document (none of those). Optional members of
 * {@link EditorHost} already answer "can I do X" by being absent, but the
 * required ones -- `saveContent`, `onFileChanged`, `storage`,
 * `setEditorContext` -- cannot disappear, and a host that stubs them into
 * resolved no-ops tells the editor a write succeeded when nothing was written.
 *
 * A host that cannot do one of these must both (a) report it here so the
 * editor can branch BEFORE calling, and (b) fail loudly if called anyway.
 */
export type EditorHostCapability =
  /** `host.collaboration` is present and drives document state. */
  | 'collaboration'
  /** Remote presence/awareness is transported to other clients. */
  | 'presence'
  /** `setDirty` reaches a real dirty indicator. */
  | 'dirtyState'
  /** `theme` / `onThemeChanged` reflect the host's real theme. */
  | 'theme'
  /** `readOnly` / `onReadOnlyChanged` reflect a real host mode. */
  | 'readOnly'
  /** `visible` / `onVisibilityChanged` report real on-screen visibility. */
  | 'visibility'
  /** `loadContent` returns the document's own content. */
  | 'initialContent'
  /** `loadBinaryContent` returns real bytes. */
  | 'binaryContent'
  /** `saveContent` writes the document to a local file. */
  | 'localFileSave'
  /** `onFileChanged` fires when the backing file changes out of band. */
  | 'fileChangeNotifications'
  /** `host.fs` is present: workspace-wide compare-and-swap file access. */
  | 'projectFileSystem'
  /** `workspaceId` identifies a real workspace. */
  | 'workspace'
  /** `openHistory` opens document history. */
  | 'history'
  /** `openExternal` opens a URL outside the app. */
  | 'externalLinks'
  /** `getAssetUrl` returns a URL the renderer can load the document from. */
  | 'assetUrls'
  /** Source-mode toggle (`toggleSourceMode` and friends). */
  | 'sourceMode'
  /** AI diff review (`onDiffRequested` and friends). */
  | 'diffMode'
  /** `onFindRequested` delivers the app's Find command. */
  | 'findCommand'
  /** `setEditorContext` / `setEditorContextItems` reach an AI chat surface. */
  | 'aiContext'
  /** `registerEditorAPI` publishes the editor to AI tools. */
  | 'editorApi'
  /** `registerViewport` reaches a host that carries scroll between documents. */
  | 'viewport'
  /** `registerMenuItems` reaches a real actions menu. */
  | 'menuItems'
  /** `storage` survives a reload. */
  | 'persistentStorage'
  /** `storage.getSecret` / `setSecret` reach a real secret store. */
  | 'secretStorage'
  /** `getConfig` reads extension configuration. */
  | 'configuration';

/** Why a host cannot provide a capability. Shown in diagnostics, not to users. */
export interface EditorHostCapabilityGap {
  capability: EditorHostCapability;
  reason: string;
}

/**
 * What this host can and cannot do, answered up front.
 *
 * Present only on hosts that model capabilities. `undefined` means "this host
 * makes no claim" -- see {@link editorHostSupports} for the one place that
 * decision is interpreted, so extensions never re-derive it.
 */
export interface EditorHostCapabilities {
  /** Stable id of the host environment, e.g. `'browser'`. */
  readonly environment: string;

  /** True when this host really provides `capability`. */
  supports(capability: EditorHostCapability): boolean;

  /** Every capability this host cannot provide, each with a reason. */
  readonly unavailable: readonly EditorHostCapabilityGap[];
}

/**
 * An editor's scroll position, expressed so it survives the trip to a document
 * of a different length. See {@link EditorHost.registerViewport}.
 *
 * A **fraction of scrollable height**, never a pixel offset. Two variants of a
 * screen are rarely the same length, and 2000px down a 2400px design is near
 * the end of it while 2000px down a 9000px design is barely started. Carrying
 * pixels would land the reader somewhere arbitrary, and nothing on screen would
 * say why.
 */
export interface EditorViewport {
  /** Current position in `[0, 1]`. Content with nowhere to scroll returns 0. */
  getScrollFraction(): number;
  /** Restore a position captured from a document of any length. */
  setScrollFraction(fraction: number): void;
}

/**
 * Where dictated (speech-to-text) words land in an editor. See
 * {@link EditorHost.registerDictationTarget}.
 *
 * The host owns the microphone and the recognizer; the editor owns its content,
 * so the editor decides how pending and committed text appear. `showPartial`
 * replaces the current uncommitted text (render it as a decoration, never as
 * document content); `commitFinal` inserts committed text at the cursor and
 * clears the pending text; `clearPartial` drops pending text (Esc or stop).
 */
export interface DictationTarget {
  /** Kind of editor, reported in usage analytics. */
  readonly kind: 'rich-text' | 'code';
  /** True while this editor holds keyboard focus. */
  hasFocus(): boolean;
  /**
   * Show uncommitted text at the cursor. Optional: when omitted the host
   * paints the partial itself next to `getCaretRect()`.
   */
  showPartial?(text: string): void;
  /** Viewport rect of the caret, for a host-painted partial. */
  getCaretRect?(): DOMRect | null;
  clearPartial(): void;
  commitFinal(text: string): void;
}

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
 * A single selected item an editor pushes to the chat panel.
 *
 * Unlike {@link EditorContext} (a single blob), items are a list — ideal for
 * node-like editors (diagrams, CAD, electronics) where the user can select
 * several nodes at once. Each item renders as its own removable chip in the
 * chat, and the user can dismiss individual items so they are not sent to the
 * model. The editor owns its selection and builds one item per selected node.
 */
export interface EditorContextItem {
  /**
   * Stable id, unique within this editor's current selection.
   * Lets the host track items across pushes and lets the user dismiss a
   * specific item. Use the underlying node/element id when you have one.
   */
  id: string;

  /** Short label shown on the chat chip (e.g., "Rectangle 3", "R12 resistor"). */
  label: string;

  /** Optional Material Symbols icon name for the chip (e.g., 'category'). */
  icon?: string;

  /** Human-readable context injected into the AI prompt for this item. */
  description: string;

  /**
   * Optional JSON-serializable payload describing the node (coordinates, part
   * number, netlist entry, etc.). By default this is NOT sent to the model to
   * keep prompts lean; set {@link includeData} to inline it as JSON. Cyclic,
   * non-JSON, and payloads larger than 32 KiB are omitted safely.
   */
  data?: unknown;

  /** When true, bounded JSON {@link data} is serialized alongside the description. */
  includeData?: boolean;

  /** Optional group label used to cluster a large set of items ("5 shapes"). */
  groupLabel?: string;
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
  // ============ CAPABILITIES ============

  /**
   * What this host can and cannot do. Read it through
   * {@link editorHostSupports} rather than directly, so the "host makes no
   * claim" case is interpreted in exactly one place.
   *
   * Optional: the Electron renderer omits it (it provides everything). A host
   * that cannot honour part of this interface -- the browser collaborative
   * host -- populates it, and rejects the calls it declares unavailable.
   */
  readonly capabilities?: EditorHostCapabilities;

  // ============ FILE INFO ============

  /**
   * Identifier for the document being edited.
   *
   * On the Electron host this is an absolute path on disk. On a host with no
   * filesystem it is a stable synthetic URI for the same document; treat it as
   * an opaque key (registry lookups, React keys) and gate anything that
   * actually touches disk on `projectFileSystem` / `localFileSave`.
   */
  readonly filePath: string;

  /** File name (for display) */
  readonly fileName: string;

  /** Current theme */
  readonly theme: string;

  /** Whether this editor's tab is active */
  readonly isActive: boolean;

  /**
   * Whether the editor is currently rendered on screen.
   *
   * False when the editor is kept mounted but hidden — its tab is inactive,
   * or its whole mode (Files/Agent/Tracker/…) is hidden behind another mode.
   * Hidden editors should stop doing continuous work: pause render loops
   * (requestAnimationFrame), defer expensive recomputation, and release
   * GPU-heavy resources (WebGL contexts) until visible again.
   *
   * Optional: hosts that never hide a mounted editor (share viewer, offscreen
   * AI-tool hosts) omit it; treat undefined as visible.
   */
  readonly visible?: boolean;

  /**
   * Subscribe to visibility changes (see `visible`).
   *
   * Fires with `false` when the editor is hidden while staying mounted, and
   * `true` when it is revealed again. Returns an unsubscribe function.
   */
  onVisibilityChanged?(callback: (visible: boolean) => void): () => void;

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
  onSaveRequested(callback: () => void | Promise<void>): () => void;

  // ============ HISTORY ============

  /**
   * Open history dialog for this file.
   */
  openHistory(): void;

  /**
   * Host-backed project filesystem: read files with SHA-256 version tokens,
   * apply compare-and-swap grouped writes, and observe out-of-band changes.
   *
   * Optional because read-only, embedded, offscreen, and collaborative hosts
   * cannot honor raw disk semantics. Undo/redo is intentionally NOT here — a
   * write is a plain filesystem edit; the editor owns its own undo history and
   * reverses an edit by writing the prior content back (see EditorHostFileSystem).
   */
  fs?: EditorHostFileSystem;

  /**
   * Open a reviewed HTTPS URL in the operating system's external browser.
   * The host normalizes and validates the URL before crossing the Electron
   * boundary; custom editors must not navigate the renderer directly.
   */
  openExternal?(url: string): Promise<void>;

  /**
   * A URL the renderer can load this document from directly, for editors whose
   * element wants to fetch the bytes itself rather than be handed them.
   *
   * `loadBinaryContent` is the right call for a format you parse in full -- a
   * PDF, a spreadsheet. It is the wrong call for anything streamed: a `<video>`
   * pointed at a blob built from a whole-file ArrayBuffer pulls a multi-gigabyte
   * screen recording through IPC and into renderer memory before the first frame
   * paints. Handing the element a URL instead lets the host serve byte ranges,
   * so playback starts immediately and seeking costs one range request.
   *
   * The returned URL is same-origin to the renderer and readable only by this
   * app; it is not a `file://` path and must not be treated as one. Hosts that
   * have no such URL to give -- read-only, embedded, and offscreen hosts, and
   * any document not backed by a local file -- omit this method.
   *
   * @example
   * ```tsx
   * const src = host.getAssetUrl?.();
   * return src ? <video src={src} controls /> : <p>Preview unavailable.</p>;
   * ```
   */
  getAssetUrl?(): string | null;

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

  // ============ FIND (OPTIONAL) ============

  /**
   * Subscribe to the app's Find command (Cmd+F).
   *
   * Cmd+F is a native menu accelerator, so the renderer never sees the
   * keystroke -- an extension cannot bind it itself. The command arrives over
   * IPC and the host routes it to whichever editor owns the active file, so an
   * editor with its own find UI opens it from here.
   *
   * Returns an unsubscribe function.
   */
  onFindRequested?(callback: () => void): () => void;

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

  /**
   * Push a list of selected items to the chat panel as removable context chips.
   *
   * Use this instead of {@link setEditorContext} for node-like editors where
   * the user can select multiple things at once (diagrams, CAD, electronics).
   * Each item becomes its own chip that the user can individually dismiss; only
   * the non-dismissed items' descriptions are included in the AI prompt.
   *
   * Call whenever the editor's selection changes. Pass `null` or `[]` to clear.
   * Pushing a new set resets any prior per-item dismissals (a fresh selection
   * is fresh).
   *
   * @example
   * ```tsx
   * // Report selected shapes in a diagram editor
   * host.setEditorContextItems(selectedShapes.map((s) => ({
   *   id: s.id,
   *   label: s.type === 'text' ? `Text: ${s.text}` : `${s.type} ${s.id.slice(0, 4)}`,
   *   description: `A ${s.type} at (${s.x}, ${s.y}), ${s.width}x${s.height}.`,
   *   groupLabel: 'shapes',
   * })));
   *
   * // Clear when nothing is selected
   * host.setEditorContextItems(null);
   * ```
   */
  setEditorContextItems(items: EditorContextItem[] | null): void;

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

  // ============ VIEWPORT (OPTIONAL) ============

  /**
   * Publish this editor's scroll position, so a host showing several documents
   * in sequence can carry the reader's place from one to the next.
   *
   * The case this exists for: comparing design alternatives. Open option A,
   * scroll to the pricing table, step to option B, and land on B's pricing
   * table. Without it, stepping between options is three separate lookups and
   * the reader is comparing against memory again.
   *
   * The host cannot do this itself. An editor that paints into an iframe --
   * which every mockup does -- owns a scroll position in a document the host
   * has no business reaching into, and an editor that scrolls a `<div>` owns
   * one the host cannot find. Only the editor knows what scrolls.
   *
   * Optional on both sides, and silence is a supported answer: an editor that
   * never calls this simply does not carry scroll, and each document opens at
   * the top. Call with `null` to unregister, as with `registerEditorAPI`.
   *
   * @example
   * ```tsx
   * useEffect(() => {
   *   host.registerViewport?.({
   *     getScrollFraction: () => {
   *       const doc = iframeRef.current?.contentDocument?.documentElement;
   *       if (!doc) return 0;
   *       return scrollFractionOf(doc.scrollTop, doc.scrollHeight - doc.clientHeight);
   *     },
   *     setScrollFraction: (fraction) => {
   *       const doc = iframeRef.current?.contentDocument?.documentElement;
   *       if (doc) doc.scrollTop = fraction * (doc.scrollHeight - doc.clientHeight);
   *     },
   *   });
   *   return () => host.registerViewport?.(null);
   * }, [host]);
   * ```
   */
  registerViewport?(viewport: EditorViewport | null): void;

  // ============ DICTATION (OPTIONAL) ============

  /**
   * Accept dictated text. An editor that registers a target receives speech
   * at its cursor when the user dictates while it has focus; one that never
   * calls this is simply not a dictation surface. Call with `null` to
   * unregister. Hosts without dictation omit this method.
   */
  registerDictationTarget?(target: DictationTarget | null): void;

  // ============ MENU ITEMS ============

  // ============ COLLABORATION (OPTIONAL) ============

  /**
   * Present only when this document was opened collaboratively.
   *
   * When defined, the extension MUST drive its state through `collaboration.yDoc`
   * and use the SDK's `useCollaborativeEditor` hook to manage the binding
   * lifecycle. In collab mode, the host does not invoke `onSaveRequested` --
   * persistence is the server's encrypted blob store.
   *
   * When undefined, the extension operates in local-only mode (load from
   * disk via `loadContent()`, save via `saveContent()`).
   *
   * Extensions opt in by declaring `collaboration.supported: true` in their
   * editor contribution manifest entry.
   */
  readonly collaboration?: CollaborationContext;

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

export type ProjectFileActor = 'user' | 'agent';

export interface ProjectFileSnapshot {
  path: string;
  exists: boolean;
  content: string | null;
  sha256: string | null;
}

export interface ProjectFileChange {
  path: string;
  /** SHA-256 from a prior read, or null to require the file does not yet exist. */
  expectedSha256: string | null;
  /** New UTF-8 content, or null to delete the file (e.g. to reverse a creation). */
  content: string | null;
}

export interface ProjectFileEdit {
  label: string;
  actor: ProjectFileActor;
  changes: ProjectFileChange[];
}

export interface ProjectFileWriteReceiptFile {
  path: string;
  beforeSha256: string | null;
  afterSha256: string | null;
}

export interface ProjectFileWriteReceipt {
  id: string;
  label: string;
  actor: ProjectFileActor;
  timestamp: number;
  files: ProjectFileWriteReceiptFile[];
  /**
   * Multi-file writes are coordinated and rolled back on failure, not
   * filesystem-atomic. A receipt is only returned for a fully-applied write;
   * a failure rejects (restoring prior content when it can), so callers observe
   * failure as a thrown error, never a partial receipt.
   */
  atomic: false;
}

export interface EditorHostFileSystem {
  /**
   * Read a bounded set of UTF-8 files with stable SHA-256 version tokens. Paths
   * may be absolute or workspace-relative; paths that escape the workspace
   * (including through a symlink) are rejected. Missing files come back with
   * `exists: false` and a null hash.
   */
  read(paths: string[]): Promise<ProjectFileSnapshot[]>;

  /**
   * Apply one labeled, compare-and-swap grouped write. Every change is recorded
   * in Nimbalyst document history. The host refuses the write if any affected
   * file is dirty in an open editor or no longer matches its expected hash.
   */
  write(edit: ProjectFileEdit): Promise<ProjectFileWriteReceipt>;

  /** Subscribe to workspace file changes outside the active document. */
  onChanged(callback: (paths: string[]) => void): () => void;
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
