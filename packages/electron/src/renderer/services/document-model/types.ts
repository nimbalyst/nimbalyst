/**
 * Types for the DocumentModel layer.
 *
 * DocumentModel is a coordination layer that sits between the file system
 * and editor instances. It owns:
 * - Last-persisted content
 * - Dirty flag (OR of all attached editors)
 * - Single autosave timer
 * - File-watcher event handling
 * - Diff state (pending AI edits)
 * - Save deduplication
 *
 * Each editor still owns its live in-memory working copy, undo/redo history,
 * scroll position, selection, and parsed state.
 */

// -- Backing Store ----------------------------------------------------------

/**
 * Abstraction over the persistence layer for a document.
 *
 * Phase 1 implements DiskBackedStore (IPC-based file I/O).
 * A future CollabBackedStore will use Y.Doc for collaborative editing.
 */
export interface DocumentBackingStore {
  /** Load the document content from the backing store. */
  load(): Promise<string | ArrayBuffer>;

  /** Save content to the backing store. */
  save(content: string | ArrayBuffer): Promise<void>;

  /**
   * Subscribe to external content changes (e.g. file watcher, collab sync).
   * Returns an unsubscribe function.
   */
  onExternalChange(callback: ExternalChangeCallback): () => void;

  /**
   * Subscribe to deletion notifications (file-deleted IPC).
   * The DocumentModel uses this to flip into a deleted state and refuse
   * saves until a fresh `loadContent()` re-establishes the baseline.
   * Optional -- backing stores that don't support deletion (e.g. collab) can
   * omit it. Returns an unsubscribe function.
   */
  onDeletion?(callback: () => void): () => void;

  /**
   * Release subscriptions and internal resources.
   * Called when the backing store is replaced (e.g. on file rename) or
   * when the DocumentModel is disposed.
   * Optional -- implementations without resources to release can omit it.
   */
  dispose?(): void;
}

export interface ExternalChangeInfo {
  content: string | ArrayBuffer;
  /** Timestamp of the change (ms since epoch). */
  timestamp: number;
  /**
   * When true, forces pending-tag check even if content matches lastPersistedContent.
   * Set by the tag-created signal from HistoryManager.
   */
  checkPendingTags?: boolean;
}

export type ExternalChangeCallback = (info: ExternalChangeInfo) => void;

// -- Diff State -------------------------------------------------------------

export interface DiffState {
  /** History tag ID for this pending diff. */
  tagId: string;
  /** AI session that made the edit. */
  sessionId: string;
  /** Content before the AI edit. */
  oldContent: string;
  /** Content after the AI edit (currently on disk). */
  newContent: string;
  /**
   * Stable fingerprint of `newContent`. Editors compare this against the
   * hash of the diff they last applied to decide whether an incoming diff
   * request is a duplicate of the in-flight one or a fresh subsequent edit
   * (which can carry the same `tagId` because HistoryManager enforces a
   * single pending tag per file/session).
   */
  newContentHash: string;
  /** Timestamp when the AI edit was detected. */
  createdAt: number;
}

// -- Editor Attachment ------------------------------------------------------

/**
 * A handle returned when an editor attaches to a DocumentModel.
 * The editor uses this to communicate with the model.
 */
export interface DocumentModelEditorHandle {
  /** Unique identifier for this attachment (for internal tracking). */
  readonly id: string;

  /**
   * Report dirty state from this editor.
   * DocumentModel ORs all attached editors' dirty flags.
   */
  setDirty(isDirty: boolean): void;

  /**
   * Save content through the DocumentModel.
   * DocumentModel writes to the backing store, updates lastPersistedContent,
   * and notifies other attached editors via their onFileChanged callbacks.
   */
  saveContent(content: string | ArrayBuffer): Promise<void>;

  /**
   * Notify sibling editors that this editor saved content externally
   * (through a path that bypasses saveContent, like saveWithHistory).
   * Updates lastPersistedContent and notifies clean siblings.
   */
  notifySiblingsSaved(content: string | ArrayBuffer): void;

  /**
   * Subscribe to external content changes (file watcher, other editor saves, collab).
   * NOT called when this editor itself saves (echo suppression).
   */
  onFileChanged(callback: (content: string | ArrayBuffer) => void): () => void;

  /**
   * Subscribe to save requests from the DocumentModel's autosave timer.
   * The editor should serialize its content and call saveContent().
   */
  onSaveRequested(callback: () => void | Promise<void>): () => void;

  /**
   * Subscribe to diff mode requests.
   * Called when DocumentModel detects pending AI edits.
   */
  onDiffRequested(callback: (state: DiffState) => void): () => void;

  /**
   * Subscribe to diff resolution by another editor.
   * Called when diff is accepted/rejected in a different editor.
   */
  onDiffResolved(callback: (accepted: boolean) => void): () => void;

  /**
   * Resolve a pending diff (accept or reject).
   * DocumentModel saves the final content and notifies all other editors.
   */
  resolveDiff(accepted: boolean): Promise<void>;

  /**
   * Tell the DocumentModel that the editor has finished applying the current diff target.
   * The DocumentModel transitions the DiffSession from `applying` to `applied` and drains
   * any payload that was queued during the apply -- if a fresh payload was waiting, the
   * model fires `onDiffRequested` again with the drained content. Editors must call this
   * after their own apply work settles, otherwise the queue never drains.
   */
  markDiffApplied(): void;

  /**
   * Notify the DocumentModel that the user has just accepted/rejected a single change
   * group and a new incremental-approval tag has been written. The session is rotated
   * onto the new tag id and re-baselined so a subsequent file-watcher event for the same
   * file diffs against the post-partial state, not the original baseline.
   */
  completePartialResolve(input: { newTagId: string; newBaseline: string }): void;

  /**
   * Detach this editor from the DocumentModel.
   * Equivalent to calling registry.release().
   */
  detach(): void;
}

// -- Document Model ---------------------------------------------------------

export interface DocumentModelState {
  /** Absolute file path. */
  filePath: string;
  /** Whether any attached editor reports dirty. */
  isDirty: boolean;
  /** Current diff state, or null if not in diff mode. */
  diffState: DiffState | null;
  /** Number of attached editors. */
  attachCount: number;
}

// -- Events -----------------------------------------------------------------

export type DocumentModelEventType =
  | 'dirty-changed'
  | 'diff-state-changed'
  | 'content-saved'
  | 'attach-count-changed';

export interface DocumentModelEvent {
  type: DocumentModelEventType;
  filePath: string;
}
