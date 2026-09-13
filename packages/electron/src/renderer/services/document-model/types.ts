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

  /**
   * Save content to the backing store.
   *
   * `expectedDiskContent` is the conflict baseline: what the caller believes is
   * currently persisted. Stores that can detect a conflict must refuse the
   * write when it does not match. Passing `undefined` disables that check and
   * is an unconditional overwrite -- #3684 was partly caused by three callers
   * omitting this argument by accident, so pass it unless you specifically
   * intend to clobber.
   */
  save(content: string | ArrayBuffer, expectedDiskContent?: string): Promise<void>;

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
   * Monotonic order stamp for the signal that produced this change, captured
   * before the store's own asynchronous read. The model uses it to recognise a
   * read that resolved out of order and drop the older observation rather than
   * accepting it as the newest payload (NIM-5359, defect E). `timestamp` cannot
   * serve that purpose -- it is assigned after the read.
   *
   * Optional: a store that delivers strictly in order may omit it, and the model
   * falls back to counting arrivals itself.
   */
  sequence?: number;
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
  /**
   * Monotonic, per-model counter identifying this published target. Bumped every
   * time the model starts presenting new content, so a presenter's completion can
   * be matched against the generation it actually received -- a late completion
   * for generation N must not settle generation N+1 (NIM-5359, defect F).
   */
  generation: number;
}

/**
 * How a presenter finished with a generation it was handed.
 *
 * - `applied`                    -- inline diff verifiably rendered for this target
 * - `presented-without-inline`   -- deliberately no inline diff (large-document
 *                                   fallback); the buffer was verified against disk
 *                                   truth and the approval bar stays pending
 * - `failed`                     -- the apply threw or could not be verified; the
 *                                   generation must NOT advance the conflict baseline
 * - `detached`                   -- the presenter went away mid-apply
 */
export type DiffApplyOutcome =
  | 'applied'
  | 'presented-without-inline'
  | 'failed'
  | 'detached';

export interface DiffApplyCompletion {
  /** Attachment that received the generation. */
  editorId: string;
  /** `DiffState.generation` the presenter was handed. Stale values are ignored. */
  generation: number;
  outcome: DiffApplyOutcome;
}

export type DiffResolutionDecision = 'accept' | 'reject';

/**
 * Retained state for an in-flight or half-finished diff resolution.
 *
 * The disk write and the history-tag update are two stores and cannot be atomic,
 * so the model keeps which half is confirmed. A save that failed leaves the tag
 * pending; a tag update that failed after a successful save leaves
 * `diskCommitted: true` and blocks saves until the idempotent tag retry lands
 * (NIM-5359, defects C and I).
 */
export interface DiffResolutionSnapshot {
  decision: DiffResolutionDecision;
  /**
   * The tag this decision ends, captured when the decision was claimed.
   *
   * Read from the snapshot rather than from the live session, because a retry of
   * the tag half can run after a second agent session has replaced the session
   * with one carrying a different tag -- and marking *that* tag reviewed silently
   * ends a review the user never saw (NIM-5359, defect I).
   */
  tagId: string;
  finalContent: string;
  /** What the model believes disk holds -- the latest observed agent content. */
  expectedDiskContent: string;
  diskCommitted: boolean;
  tagCommitted: boolean;
}

/**
 * Optional detail an editor attaches to its accept/reject.
 *
 * A Lexical accept-all is not "write the session's applied content": the buffer
 * may carry per-group decisions the user made by hand, so the editor serializes
 * it and hands those exact bytes over. That buffer is only honest for the
 * generation it was serialized from, which is why `generation` travels with it --
 * the model refuses the decision outright rather than writing a buffer that a
 * newer agent write has already outdated (NIM-5359, defects C/F/I).
 */
export interface DiffResolutionRequest {
  /**
   * Bytes to write. Omitted for a plain accept/reject, where the model uses the
   * session's applied (accept) or baseline (reject) content.
   */
  finalContent?: string;
  /**
   * `DiffState.generation` the user acted on. When it no longer matches the
   * model's session the decision is refused without writing.
   */
  generation?: number;
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
  /** Return false when the editor could not verify application; its baseline must stay unchanged. */
  onFileChanged(callback: (content: string | ArrayBuffer) => unknown): () => void;

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
   *
   * DocumentModel owns the whole transaction: it writes the final content with
   * the latest observed agent content as the conflict baseline, marks the history
   * tag reviewed, and only then tears the session down and notifies siblings.
   * Editors must not sequence those steps themselves -- doing so reads the
   * baseline outside the model's serial queue, so a write that lands between the
   * two silently disappears.
   *
   * Pass `request.finalContent` when the editor has its own serialized buffer
   * (a Lexical accept-all after per-group edits), together with the
   * `request.generation` it was serialized from.
   */
  resolveDiff(accepted: boolean, request?: DiffResolutionRequest): Promise<void>;

  /**
   * Tell the DocumentModel that the editor has finished applying the current diff target.
   * The DocumentModel transitions the DiffSession from `applying` to `applied` and drains
   * any payload that was queued during the apply -- if a fresh payload was waiting, the
   * model fires `onDiffRequested` again with the drained content. Editors must call this
   * after their own apply work settles, otherwise the queue never drains.
   *
   * @deprecated Parameterless acknowledgement cannot say *which* generation
   * settled, so a late completion from one attachment silently settles another
   * attachment's newer in-flight generation (NIM-5359, defect F). Use
   * `completeDiffApply` instead; this remains only until TabEditor is migrated.
   */
  markDiffApplied(): void;

  /**
   * Report the outcome of applying one specific diff generation.
   *
   * Replaces `markDiffApplied`. The model matches `generation` against what it
   * currently has in flight, tracks which recipients still owe a completion, and
   * only drains queued disk content once every participating recipient has
   * finished successfully. A `failed` or `detached` outcome must never advance
   * the conflict baseline or mark the generation applied.
   */
  completeDiffApply(input: Omit<DiffApplyCompletion, 'editorId'>): void;

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
  | 'external-conflict'
  | 'dirty-changed'
  | 'diff-state-changed'
  | 'content-saved'
  | 'attach-count-changed';

export interface DocumentModelEvent {
  diskContent?: string;
  type: DocumentModelEventType;
  filePath: string;
}
