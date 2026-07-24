/**
 * DocumentModel - Coordination layer for a single file.
 *
 * One DocumentModel exists per open file (shared across all editor instances
 * that have the same file open -- e.g. EditorMode tab + AgentMode tab).
 *
 * Responsibilities:
 * - Holds last-persisted content (updated after each save)
 * - Aggregates dirty state from all attached editors
 * - Runs a single autosave timer (triggers onSaveRequested on a dirty editor)
 * - Handles file-watcher events (single handler, notifies all editors)
 * - Manages diff state (pending AI edits, accept/reject coordination)
 * - Deduplicates saves (one at a time)
 * - Ref-counts attached editors for lifecycle management
 *
 * NOT a live editing buffer. Each editor owns its own in-memory working copy.
 */

import type {
  DocumentBackingStore,
  DocumentModelEditorHandle,
  DocumentModelEvent,
  DocumentModelEventType,
  DocumentModelState,
  DiffState,
  ExternalChangeInfo,
} from './types';
import { diffTrace } from '@nimbalyst/runtime/utils/debugFlags';
import { DiffSession } from './DiffSession';

let nextAttachmentId = 0;

/**
 * Thrown by `saveFromEditor` when the model is in the deleted state.
 * Callers (TabEditor.saveWithHistory, etc.) treat this as a non-fatal block:
 * the user's buffer is preserved; the disk file is not overwritten.
 */
export class FileDeletedError extends Error {
  readonly filePath: string;
  constructor(filePath: string) {
    super(`Cannot save: file was deleted (${filePath}). Reload to re-establish baseline.`);
    this.name = 'FileDeletedError';
    this.filePath = filePath;
  }
}

interface EditorAttachment {
  id: string;
  isDirty: boolean;
  fileChangedCallbacks: Set<(content: string | ArrayBuffer) => void>;
  saveRequestedCallbacks: Set<() => void>;
  diffRequestedCallbacks: Set<(state: DiffState) => void>;
  diffResolvedCallbacks: Set<(accepted: boolean) => void>;
}

export interface DocumentModelOptions {
  /** Autosave interval in ms. 0 disables autosave. Default: 2000 */
  autosaveInterval?: number;
  /** Minimum time since last edit before autosave fires. Default: 200 */
  autosaveDebounce?: number;
  /**
   * Optional callback to check for pending AI edit tags on a file.
   * Used during external change handling to detect diff mode entry.
   * Returns pending tags array or empty.
   */
  getPendingTags?: (filePath: string) => Promise<Array<{ id: string; sessionId: string; createdAt?: string }>>;
  /**
   * Optional callback to update a tag's status (e.g. mark as reviewed).
   */
  updateTagStatus?: (filePath: string, tagId: string, status: string) => Promise<void>;
  /**
   * Optional callback to get the diff baseline for a file.
   * Returns the content that should be used as the "old" side of the diff.
   * If not provided, falls back to lastPersistedContent.
   */
  getDiffBaseline?: (filePath: string) => Promise<{ content: string } | null>;
}

export class DocumentModel {
  filePath: string;
  private backingStore: DocumentBackingStore;
  private options: Required<DocumentModelOptions>;

  // -- Coordination state ---------------------------------------------------

  /** Last content that was persisted to the backing store. */
  private lastPersistedContent: string | ArrayBuffer | null = null;

  /**
   * Diff state (pending AI edits).
   *
   * Always derived from `currentSession` when one exists. Kept as a separate field for
   * backward compatibility with consumers that expect the flat `DiffState` shape; the
   * `DiffSession` state machine is the single source of truth for lifecycle decisions.
   */
  private diffState: DiffState | null = null;

  /**
   * State machine for the active diff lifecycle. `null` when no AI edit is pending.
   * Owns the duplicate-suppression and re-baseline logic; see DiffSession.ts.
   */
  private currentSession: DiffSession | null = null;

  /** All attached editors. */
  private attachments = new Map<string, EditorAttachment>();

  /** Event listeners on the model itself (for Jotai atoms, etc.). */
  private eventListeners = new Map<DocumentModelEventType, Set<(event: DocumentModelEvent) => void>>();

  // -- Save coordination ----------------------------------------------------

  private isSaving = false;
  private pendingSave: { editorId: string; content: string | ArrayBuffer; resolve: () => void; reject: (err: unknown) => void } | null = null;
  private autosaveTimer: ReturnType<typeof setInterval> | null = null;
  private lastEditTime = 0;

  // -- File watcher ---------------------------------------------------------

  private externalChangeCleanup: (() => void) | null = null;
  private fileDeletedCleanup: (() => void) | null = null;

  // -- Disposed flag --------------------------------------------------------

  private disposed = false;

  // -- Deleted flag ---------------------------------------------------------
  /**
   * True when the file has been observed deleted (file-deleted IPC) and a
   * fresh `loadContent()` has not yet been observed. While deleted is true,
   * `saveFromEditor` rejects without writing and the autosave timer no-ops.
   * This is the model-side defense in depth: even if a tab system fails to
   * close its tab, the model refuses to silently overwrite a recreated file.
   */
  private deleted = false;

  constructor(
    filePath: string,
    backingStore: DocumentBackingStore,
    options: DocumentModelOptions = {},
  ) {
    this.filePath = filePath;
    this.backingStore = backingStore;
    this.options = {
      autosaveInterval: options.autosaveInterval ?? 2000,
      autosaveDebounce: options.autosaveDebounce ?? 200,
      getPendingTags: options.getPendingTags ?? (async () => []),
      updateTagStatus: options.updateTagStatus ?? (async () => {}),
      getDiffBaseline: options.getDiffBaseline ?? (async () => null),
    };

    // Subscribe to external changes from the backing store
    this.externalChangeCleanup = backingStore.onExternalChange(
      this.handleExternalChange.bind(this),
    );

    // Subscribe to deletion notifications. Backing stores that don't support
    // deletion (e.g. collab) leave onDeletion undefined.
    if (typeof backingStore.onDeletion === 'function') {
      this.fileDeletedCleanup = backingStore.onDeletion(this.markDeleted.bind(this));
    }

    // Start autosave timer
    this.startAutosaveTimer();
  }

  // -- Attachment lifecycle -------------------------------------------------

  /**
   * Attach a new editor to this document model.
   * Returns a handle the editor uses for all communication.
   */
  attach(): DocumentModelEditorHandle {
    const id = `editor-${++nextAttachmentId}`;
    const attachment: EditorAttachment = {
      id,
      isDirty: false,
      fileChangedCallbacks: new Set(),
      saveRequestedCallbacks: new Set(),
      diffRequestedCallbacks: new Set(),
      diffResolvedCallbacks: new Set(),
    };
    this.attachments.set(id, attachment);
    this.emit('attach-count-changed');

    const handle: DocumentModelEditorHandle = {
      id,

      setDirty: (isDirty: boolean) => {
        const att = this.attachments.get(id);
        if (!att) return;
        const wasDirty = this.isDirty();
        att.isDirty = isDirty;
        if (isDirty) {
          this.lastEditTime = Date.now();
        }
        if (wasDirty !== this.isDirty()) {
          this.emit('dirty-changed');
        }
      },

      saveContent: async (content: string | ArrayBuffer) => {
        await this.saveFromEditor(id, content);
      },

      /**
       * Notify sibling editors that this editor saved content externally
       * (i.e. through a path that bypasses handle.saveContent, like saveWithHistory).
       * Updates lastPersistedContent and notifies clean siblings.
       */
      notifySiblingsSaved: (content: string | ArrayBuffer) => {
        this.lastPersistedContent = content;
        this.notifyFileChanged(content, id);
      },

      onFileChanged: (callback) => {
        const att = this.attachments.get(id);
        if (!att) return () => {};
        att.fileChangedCallbacks.add(callback);
        return () => {
          att.fileChangedCallbacks.delete(callback);
        };
      },

      onSaveRequested: (callback) => {
        const att = this.attachments.get(id);
        if (!att) return () => {};
        att.saveRequestedCallbacks.add(callback);
        return () => {
          att.saveRequestedCallbacks.delete(callback);
        };
      },

      onDiffRequested: (callback) => {
        const att = this.attachments.get(id);
        if (!att) return () => {};
        att.diffRequestedCallbacks.add(callback);
        // If we're already in diff mode, immediately notify this new subscriber
        if (this.diffState) {
          try {
            callback(this.diffState);
          } catch (err) {
            console.error('[DocumentModel] Error in immediate diff callback:', err);
          }
        }
        return () => {
          att.diffRequestedCallbacks.delete(callback);
        };
      },

      onDiffResolved: (callback) => {
        const att = this.attachments.get(id);
        if (!att) return () => {};
        att.diffResolvedCallbacks.add(callback);
        return () => {
          att.diffResolvedCallbacks.delete(callback);
        };
      },

      resolveDiff: async (accepted: boolean) => {
        await this.resolveDiffFromEditor(id, accepted);
      },

      markDiffApplied: () => {
        this.markDiffApplied();
      },

      completePartialResolve: (input: { newTagId: string; newBaseline: string }) => {
        this.applyPartialResolve(input);
      },

      detach: () => {
        this.detach(id);
      },
    };

    return handle;
  }

  /**
   * Detach an editor. Clears its dirty state and callbacks.
   */
  private detach(editorId: string): void {
    const att = this.attachments.get(editorId);
    if (!att) return;

    const wasDirty = this.isDirty();
    att.fileChangedCallbacks.clear();
    att.saveRequestedCallbacks.clear();
    att.diffRequestedCallbacks.clear();
    att.diffResolvedCallbacks.clear();
    this.attachments.delete(editorId);

    if (wasDirty !== this.isDirty()) {
      this.emit('dirty-changed');
    }
    this.emit('attach-count-changed');
  }

  // -- State queries --------------------------------------------------------

  /** True if any attached editor is dirty. */
  isDirty(): boolean {
    for (const att of this.attachments.values()) {
      if (att.isDirty) return true;
    }
    return false;
  }

  /** Current diff state. */
  getDiffState(): DiffState | null {
    return this.diffState;
  }

  /**
   * Snapshot of the active diff session, or `null` if not in diff mode.
   * Exposes the state machine's phase + queued payload for consumers that need
   * lifecycle visibility (e.g. tests, future TabEditor integration).
   */
  getDiffSessionSnapshot() {
    return this.currentSession?.snapshot() ?? null;
  }

  /** Last-persisted content. */
  getLastPersistedContent(): string | ArrayBuffer | null {
    return this.lastPersistedContent;
  }

  /**
   * Set the last-persisted content without saving.
   * Used to initialize the echo-suppression baseline when the
   * DocumentModel is created for a file that's already loaded.
   */
  setLastPersistedContent(content: string | ArrayBuffer): void {
    this.lastPersistedContent = content;
  }

  /**
   * Whether the file backing this model has been observed deleted and not
   * yet reloaded via `loadContent()`. While true, saves are refused.
   */
  isDeleted(): boolean {
    return this.deleted;
  }

  /**
   * Mark the model as deleted. While set, `saveFromEditor` rejects without
   * writing and the autosave timer skips this model. Cleared automatically
   * on a successful `loadContent()` (which establishes a fresh baseline).
   */
  markDeleted(): void {
    if (this.deleted) return;
    this.deleted = true;
    // Don't preserve a stale lastPersistedContent baseline -- if a recreated
    // file later arrives via the watcher, echo suppression must NOT compare
    // against the pre-deletion content.
    this.lastPersistedContent = null;
  }

  /**
   * Clear diff state without triggering a save.
   * Used when the editor resolves diffs through its own save path
   * (e.g. Lexical's CLEAR_DIFF_TAG_COMMAND flow).
   *
   * `excludeEditorId` lets the resolving editor opt itself out of the
   * diff-resolved fan-out. Sibling attachments still receive the callback so
   * they can dismiss their own diff UI (clear pendingAIEditTagRef, repaint
   * editor content) -- without this, a file open in both Files mode and Agent
   * mode stays stuck in diff mode on whichever side did not click Approve.
   * `accepted` defaults to `true` since Lexical's CLEAR_DIFF_TAG_COMMAND only
   * fires after the resolving editor has approved (or has manually deleted
   * all diff content, which is functionally the same outcome for siblings).
   */
  clearDiffState(excludeEditorId?: string, accepted: boolean = true): void {
    if (this.diffState || this.currentSession) {
      this.diffState = null;
      this.currentSession = null;
      this.emit('diff-state-changed');

      // Fan out to siblings so they exit diff mode too.
      for (const [attId, att] of this.attachments) {
        if (attId === excludeEditorId) continue;
        for (const cb of att.diffResolvedCallbacks) {
          try {
            cb(accepted);
          } catch (err) {
            console.error('[DocumentModel] Error in diff resolved callback:', err);
          }
        }
      }
    }
  }

  /** Number of attached editors. */
  getAttachCount(): number {
    return this.attachments.size;
  }

  /** Full state snapshot (for Jotai atoms). */
  getState(): DocumentModelState {
    return {
      filePath: this.filePath,
      isDirty: this.isDirty(),
      diffState: this.diffState,
      attachCount: this.attachments.size,
    };
  }

  // -- Content loading ------------------------------------------------------

  /**
   * Load content from the backing store and cache it as lastPersistedContent.
   * Also clears the `deleted` flag and notifies main process that this
   * editor instance has observed a fresh load (so the recently-deleted-files
   * lifecycle entry can be released).
   */
  async loadContent(): Promise<string | ArrayBuffer> {
    const content = await this.backingStore.load();
    this.lastPersistedContent = content;

    // A successful load means the file is back. Reopen for saves and let
    // the main process know we've observed the recreation (for lifecycle
    // bookkeeping of recentlyDeletedFiles).
    if (this.deleted) {
      this.deleted = false;
      this.notifyMainEditorReleasedDeletedPath();
    }

    return content;
  }

  private notifyMainEditorReleasedDeletedPath(): void {
    try {
      const api = (window as { electronAPI?: { send?: (channel: string, ...args: unknown[]) => void } }).electronAPI;
      api?.send?.('editor:released-deleted-path', this.filePath);
    } catch {
      // Best effort -- main process is canonical owner of the lifecycle map.
    }
  }

  // -- Save handling --------------------------------------------------------

  /**
   * Save content from a specific editor.
   * Updates lastPersistedContent and notifies all OTHER attached editors.
   */
  private async saveFromEditor(editorId: string, content: string | ArrayBuffer): Promise<void> {
    if (this.deleted) {
      // The file was deleted. Refuse to save until the user explicitly
      // reloads (which calls loadContent and clears the flag). This is the
      // model-side guard against autosave overwriting an AI-recreated file.
      throw new FileDeletedError(this.filePath);
    }

    if (this.isSaving) {
      // Queue this save -- it will run after the current save completes.
      // Only the latest content matters. If a previous save was already queued,
      // resolve it now (the newer content supersedes it).
      if (this.pendingSave) {
        this.pendingSave.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        this.pendingSave = { editorId, content, resolve, reject };
      });
    }

    this.isSaving = true;
    try {
      // Update lastPersistedContent BEFORE writing to disk.
      // The file watcher can fire before save() returns, and we need
      // echo suppression to see the new content as "ours".
      this.lastPersistedContent = content;
      await this.backingStore.save(content);

      // Clear dirty flag for the saving editor
      const att = this.attachments.get(editorId);
      if (att) {
        const wasDirty = this.isDirty();
        att.isDirty = false;
        if (wasDirty !== this.isDirty()) {
          this.emit('dirty-changed');
        }
      }

      this.emit('content-saved');

      // Notify clean sibling editors so they pick up the new content.
      // Dirty siblings are skipped by notifyFileChanged to preserve in-flight edits.
      this.notifyFileChanged(content, editorId);
    } finally {
      this.isSaving = false;

      // Process any queued save
      if (this.pendingSave) {
        const { editorId: queuedEditorId, content: queuedContent, resolve, reject } = this.pendingSave;
        this.pendingSave = null;
        try {
          await this.saveFromEditor(queuedEditorId, queuedContent);
          resolve();
        } catch (err) {
          reject(err);
        }
      }
    }
  }

  /**
   * Trigger a save-on-demand (e.g. mode switch flush).
   * Finds the first dirty editor and requests a save from it.
   */
  async flushDirtyEditors(): Promise<void> {
    for (const att of this.attachments.values()) {
      if (att.isDirty) {
        for (const cb of att.saveRequestedCallbacks) {
          try {
            await cb();
          } catch (err) {
            console.error('[DocumentModel] Error in flushDirtyEditors save request:', err);
          }
        }
      }
    }
  }

  // -- External change handling ---------------------------------------------

  private async handleExternalChange(info: ExternalChangeInfo): Promise<void> {
    if (this.disposed) return;

    const lastLen = typeof this.lastPersistedContent === 'string' ? this.lastPersistedContent.length : -1;
    diffTrace('DocumentModel.handleExternalChange enter', {
      path: this.filePath,
      checkPendingTags: info.checkPendingTags,
      contentLen: typeof info.content === 'string' ? info.content.length : -1,
      lastPersistedLen: lastLen,
      t: performance.now(),
    });

    // Echo suppression: skip if content matches last-persisted.
    // This catches our own saves echoing back through the file watcher.
    const isEcho = this.lastPersistedContent !== null && info.content === this.lastPersistedContent;
    if (isEcho && !info.checkPendingTags) {
      diffTrace('DocumentModel.handleExternalChange echo-skip', { path: this.filePath, t: performance.now() });
      return;
    }

    // Check for pending AI edit tags.
    // For echoed content: only reached when checkPendingTags is set (tag-created signal).
    // For changed content: always check.
    const pendingTags = await this.options.getPendingTags(this.filePath);
    const activeTags = pendingTags.filter(
      (tag: { id: string; sessionId: string; createdAt?: string; status?: string }) =>
        (tag as any).status !== 'reviewed' && (tag as any).status !== 'rejected',
    );
    diffTrace('DocumentModel.handleExternalChange tags', {
      path: this.filePath,
      activeTagCount: activeTags.length,
      isEcho,
      checkPendingTags: info.checkPendingTags,
      branch: activeTags.length > 0 ? 'diff' : 'fileChanged',
      t: performance.now(),
    });

    if (activeTags.length > 0) {
      // Enter diff mode
      const tag = activeTags[0];
      const newContent = info.content;
      const newContentString = typeof newContent === 'string' ? newContent : '';

      // Get the diff baseline -- this is the content BEFORE the AI edit.
      // May come from a history tag (for incremental approvals) or lastPersistedContent.
      let oldContent: string;
      try {
        const baseline = await this.options.getDiffBaseline(this.filePath);
        oldContent = baseline?.content ?? (typeof this.lastPersistedContent === 'string' ? this.lastPersistedContent : '');
      } catch {
        oldContent = typeof this.lastPersistedContent === 'string' ? this.lastPersistedContent : '';
      }

      // Race guard: when the renderer reads disk on the `history:pending-tag-created`
      // signal, the agent may not yet have written. Claude's AgentToolHooks fires the
      // pre-edit tag BEFORE its own write; Codex's chokidar event can outrun the
      // OS-level write completion. In both cases we land here with info.content equal
      // to the baseline. Creating an empty-diff DiffSession would lock the editor into
      // an `applying` phase with appliedContent === baselineContent; the real
      // disk-write event that arrives a moment later then either gets queued (and
      // sometimes never drains) or applies an "X -> Y" transition over an editor that
      // never visibly entered diff mode. Defer instead -- the next file-changed-on-disk
      // event will arrive with the actual new content and create the session correctly.
      if (!this.currentSession && newContentString === oldContent) {
        diffTrace('DocumentModel.handleExternalChange skip empty-diff session', {
          path: this.filePath,
          tagId: tag.id,
          contentLen: newContentString.length,
          checkPendingTags: info.checkPendingTags,
          t: performance.now(),
        });
        return;
      }

      // Drive the DiffSession state machine. It owns duplicate-suppression and
      // baseline-rotation logic; only `apply` / `fresh` outcomes notify editors.
      // `queued` payloads sit in the session and are drained when the editor reports
      // its current apply has settled via `markDiffApplied()`.
      let ingestKind: 'apply' | 'queued' | 'duplicate' | 'fresh';
      if (!this.currentSession || this.currentSession.tagId !== tag.id) {
        this.currentSession = DiffSession.create({
          tagId: tag.id,
          sessionId: tag.sessionId,
          baselineContent: oldContent,
          initialContent: newContentString,
          createdAt: tag.createdAt ? new Date(tag.createdAt).getTime() : Date.now(),
        });
        ingestKind = 'fresh';
      } else {
        const result = this.currentSession.ingest(newContentString);
        ingestKind = result.kind;
        // The session may have re-baselined since creation (partial approval); use its
        // current baseline rather than what getDiffBaseline returned.
        if (this.currentSession.baselineContent !== oldContent) {
          oldContent = this.currentSession.baselineContent;
        }
      }

      this.refreshDiffStateFromSession();

      diffTrace('DocumentModel diff-state set', {
        path: this.filePath,
        tagId: tag.id,
        ingestKind,
        phase: this.currentSession.phase,
        oldLen: this.currentSession.baselineContent.length,
        oldHead: this.currentSession.baselineContent.slice(0, 80),
        newLen: this.currentSession.appliedContent.length,
        newHead: this.currentSession.appliedContent.slice(0, 80),
        sameOldNew: this.currentSession.baselineContent === this.currentSession.appliedContent,
        attachCount: this.attachments.size,
        t: performance.now(),
      });

      // Only notify editors when the state machine says new work is needed.
      // 'queued' payloads wait for the in-flight apply to settle; 'duplicate' is a no-op.
      if (ingestKind === 'apply' || ingestKind === 'fresh') {
        this.notifyDiffRequested();
      }
    } else {
      // Normal external change -- update persisted content and notify editors.
      // (Echo suppression already ran above for non-tag-check events.)
      diffTrace('DocumentModel notifyFileChanged (no active tags)', {
        path: this.filePath,
        contentLen: typeof info.content === 'string' ? info.content.length : -1,
        t: performance.now(),
      });
      this.lastPersistedContent = info.content;
      // A successful external read means the file is back. Clear the deleted
      // flag so saves can resume against the fresh baseline. Also notify the
      // main process so the recentlyDeleted entry can be released.
      if (this.deleted) {
        this.deleted = false;
        this.notifyMainEditorReleasedDeletedPath();
      }
      this.notifyFileChanged(info.content);
    }
  }

  /**
   * Rebuild `diffState` from the current session's snapshot. Called after every session
   * mutation (ingest, drain, partial-resolve) so consumers reading `diffState` see a
   * value consistent with the state machine.
   */
  private refreshDiffStateFromSession(): void {
    if (!this.currentSession) {
      this.diffState = null;
      this.emit('diff-state-changed');
      return;
    }
    const snap = this.currentSession.snapshot();
    this.diffState = {
      tagId: snap.tagId,
      sessionId: snap.sessionId,
      oldContent: snap.baselineContent,
      newContent: snap.appliedContent,
      newContentHash: snap.appliedContentHash,
      createdAt: snap.createdAt,
    };
    this.emit('diff-state-changed');
  }

  /** Fire onDiffRequested callbacks on every attached editor with the current diffState. */
  private notifyDiffRequested(): void {
    if (!this.diffState) return;
    for (const att of this.attachments.values()) {
      for (const cb of att.diffRequestedCallbacks) {
        try {
          cb(this.diffState);
        } catch (err) {
          console.error('[DocumentModel] Error in diff requested callback:', err);
        }
      }
    }
  }

  /**
   * Editor reports that its current apply finished. Transition the session from
   * `applying` to `applied`, then drain any payload queued during the apply -- if a
   * fresh payload was waiting, the session re-enters `applying` and we re-fire the
   * diff-requested callbacks with the drained content.
   */
  private markDiffApplied(): void {
    if (!this.currentSession) return;
    if (this.currentSession.phase !== 'applying') return; // Defensive: no-op if not applying.
    this.currentSession.markApplied();

    const drained = this.currentSession.drainPending();
    diffTrace('DocumentModel.markDiffApplied', {
      path: this.filePath,
      tagId: this.currentSession.tagId,
      phaseAfterMark: this.currentSession.phase,
      drainedLen: drained?.length ?? -1,
      t: performance.now(),
    });
    this.refreshDiffStateFromSession();
    if (drained !== null) {
      // Session is back in 'applying' with the drained payload as appliedContent.
      this.notifyDiffRequested();
    }
  }

  /**
   * Rotate the active tag and re-baseline after a partial accept/reject. The editor has
   * already created the new incremental-approval tag and persisted the post-partial
   * content; we update the session so subsequent file-watcher events compute against the
   * new baseline. The visible diff stays on screen (un-resolved groups remain).
   */
  private applyPartialResolve(input: { newTagId: string; newBaseline: string }): void {
    if (!this.currentSession || this.currentSession.phase !== 'applied') {
      diffTrace('DocumentModel.applyPartialResolve ignored', {
        path: this.filePath,
        hasSession: !!this.currentSession,
        phase: this.currentSession?.phase,
      });
      return;
    }
    this.currentSession.beginPartialResolve();
    this.currentSession.completePartialResolve(input);
    this.refreshDiffStateFromSession();
  }

  // -- Diff resolution ------------------------------------------------------

  private async resolveDiffFromEditor(editorId: string, accepted: boolean): Promise<void> {
    if (!this.diffState) return;

    const { tagId } = this.diffState;
    // Use the state machine to compute the final content + transition to resolving-all.
    // Falls back to the flat diffState if a session somehow doesn't exist (defensive).
    let finalContent: string;
    if (this.currentSession && this.currentSession.phase === 'applied') {
      const { finalContent: sessionFinal } = this.currentSession.beginResolveAll(accepted);
      finalContent = sessionFinal;
    } else {
      finalContent = accepted ? this.diffState.newContent : this.diffState.oldContent;
    }

    // Mark the tag as reviewed
    await this.options.updateTagStatus(this.filePath, tagId, 'reviewed');

    // Save the final content
    await this.backingStore.save(finalContent);
    this.lastPersistedContent = finalContent;

    // End the session and clear diff state.
    if (this.currentSession?.phase === 'resolving-all') {
      this.currentSession.completeResolveAll();
    }
    this.currentSession = null;
    this.diffState = null;
    this.emit('diff-state-changed');

    // Clear dirty flags on all editors
    for (const att of this.attachments.values()) {
      att.isDirty = false;
    }
    this.emit('dirty-changed');

    // Notify all OTHER editors that diff was resolved
    for (const [attId, att] of this.attachments) {
      if (attId === editorId) continue;
      for (const cb of att.diffResolvedCallbacks) {
        try {
          cb(accepted);
        } catch (err) {
          console.error('[DocumentModel] Error in diff resolved callback:', err);
        }
      }
    }

    // Notify all editors of the final content
    this.notifyFileChanged(finalContent);
  }

  // -- Autosave timer -------------------------------------------------------

  private startAutosaveTimer(): void {
    const interval = this.options.autosaveInterval;
    if (interval <= 0) return;

    this.autosaveTimer = setInterval(() => {
      if (this.disposed) return;

      // Skip when the file is in the deleted state. saveFromEditor would
      // throw FileDeletedError anyway; short-circuiting here avoids firing
      // the editor's save callback for a save we know cannot succeed.
      if (this.deleted) return;

      // NOTE: We do NOT skip when in diff mode. The editor callback handles
      // diff-mode checks (e.g. checking $hasDiffNodes to auto-clear resolved diffs).
      // Skipping here would prevent the editor from detecting manually resolved diffs.

      // Skip if not dirty
      if (!this.isDirty()) return;

      // Skip if edit was too recent (debounce)
      if (Date.now() - this.lastEditTime < this.options.autosaveDebounce) return;

      // Find the first dirty editor and request a save
      for (const att of this.attachments.values()) {
        if (att.isDirty && att.saveRequestedCallbacks.size > 0) {
          for (const cb of att.saveRequestedCallbacks) {
            try {
              cb();
            } catch (err) {
              console.error('[DocumentModel] Error in autosave request:', err);
            }
          }
          // Only request save from one editor at a time
          break;
        }
      }
    }, interval);
  }

  // -- Notifications --------------------------------------------------------

  /**
   * Notify attached editors of a content change.
   * Skips editors that are dirty (have unsaved in-flight edits) to avoid
   * overwriting user work. Also optionally excludes a specific editor.
   */
  private notifyFileChanged(content: string | ArrayBuffer, excludeEditorId?: string): void {
    for (const [attId, att] of this.attachments) {
      if (attId === excludeEditorId) continue;
      // Don't overwrite dirty editors -- they have unsaved user edits.
      if (att.isDirty) continue;
      for (const cb of att.fileChangedCallbacks) {
        try {
          cb(content);
        } catch (err) {
          console.error('[DocumentModel] Error in file changed callback:', err);
        }
      }
    }
  }

  // -- Event system ---------------------------------------------------------

  on(type: DocumentModelEventType, listener: (event: DocumentModelEvent) => void): () => void {
    let listeners = this.eventListeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(type, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners!.delete(listener);
    };
  }

  private emit(type: DocumentModelEventType): void {
    const event: DocumentModelEvent = { type, filePath: this.filePath };
    const listeners = this.eventListeners.get(type);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (err) {
          console.error(`[DocumentModel] Error in ${type} listener:`, err);
        }
      }
    }
  }

  // -- Lifecycle ------------------------------------------------------------

  /**
   * Replace the backing store and update filePath in-place.
   * Called by DocumentModelRegistry.rename() when a file is renamed so the
   * existing in-memory state (dirty buffer, autosave timer, attachments) is
   * preserved rather than discarding it and reloading from disk.
   */
  migrateToNewPath(newPath: string, newStore: DocumentBackingStore): void {
    // Tear down old backing-store subscriptions held by this model
    this.externalChangeCleanup?.();
    this.externalChangeCleanup = null;
    this.fileDeletedCleanup?.();
    this.fileDeletedCleanup = null;

    // Dispose the old store's own internal subscriptions (atom watchers, etc.)
    this.backingStore.dispose?.();

    // Switch to the new store and path
    this.backingStore = newStore;
    this.filePath = newPath;

    // Re-subscribe with the new store
    this.externalChangeCleanup = newStore.onExternalChange(
      this.handleExternalChange.bind(this),
    );
    if (typeof newStore.onDeletion === 'function') {
      this.fileDeletedCleanup = newStore.onDeletion(this.markDeleted.bind(this));
    }

    // The file now exists at the new path, so clear the deleted guard
    this.deleted = false;
  }

  dispose(): void {
    this.disposed = true;

    if (this.autosaveTimer) {
      clearInterval(this.autosaveTimer);
      this.autosaveTimer = null;
    }

    this.externalChangeCleanup?.();
    this.externalChangeCleanup = null;

    this.fileDeletedCleanup?.();
    this.fileDeletedCleanup = null;

    // Clear all attachments
    for (const att of this.attachments.values()) {
      att.fileChangedCallbacks.clear();
      att.saveRequestedCallbacks.clear();
      att.diffRequestedCallbacks.clear();
      att.diffResolvedCallbacks.clear();
    }
    this.attachments.clear();

    // Clear event listeners
    this.eventListeners.clear();

    this.backingStore.dispose?.();
  }
}
