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
  DiffApplyCompletion,
  DiffResolutionDecision,
  DiffResolutionRequest,
  DiffResolutionSnapshot,
  DiffState,
  ExternalChangeInfo,
} from './types';
import { diffTrace } from '@nimbalyst/runtime/utils/debugFlags';
import { DiffSession } from './DiffSession';
import { SerialMutationQueue } from './SerialMutationQueue';

let nextAttachmentId = 0;

const AUTOSAVE_FAILURE_RETRY_DELAYS_MS = [5_000, 30_000] as const;
const AUTOSAVE_MAX_ATTEMPTS = AUTOSAVE_FAILURE_RETRY_DELAYS_MS.length + 1;

/**
 * How long the model waits for a presenter to report an outcome for the
 * generation it was handed before treating the acknowledgement as lost.
 *
 * Sits above TabEditor's known Lexical settle window (a 250ms reset wait plus a
 * 100ms post-dispatch wait) with room for a slow parse. This is failure
 * recovery, never normal ordering: on expiry the model re-reads disk and keeps
 * the tag pending rather than pretending the stale generation rendered.
 */
export const DEFAULT_DIFF_APPLY_WATCHDOG_MS = 5_000;

/**
 * Recoveries the model attempts before it stops republishing a generation nobody
 * can present. It parks in `awaiting-presenter` instead of re-reading disk on a
 * timer forever: the tag stays pending, newer disk content is absorbed, and a
 * presenter that re-registers gets the latest target.
 */
const MAX_CONSECUTIVE_APPLY_RECOVERIES = 3;

/**
 * Backoff for a hydration whose tag or baseline lookup failed.
 *
 * A transient history-lookup failure is not the same fact as "this file has no
 * pending tags", and treating them alike leaves the tab permanently un-hydrated
 * over an unreviewed agent write -- nothing would ask again short of a reopen.
 * Bounded, and only while an editor is still attached to care about the answer
 * (NIM-5359, defect H).
 */
const HYDRATION_RETRY_DELAYS_MS = [500, 2_000, 5_000] as const;

/**
 * Backoff for a watcher event whose tag or baseline lookup failed.
 *
 * Dropping the event is not neutral: the agent's write is on disk and no editor
 * has been told about it, so the tab keeps showing stale content and its next
 * save compares against a baseline disk no longer holds. Each retry re-reads disk
 * rather than replaying the stale payload (NIM-5359, defects E/I).
 */
const EXTERNAL_CHANGE_RETRY_DELAYS_MS = [500, 2_000, 5_000] as const;

/** A history tag as the pending-tag lookup returns it. */
type PendingTag = { id: string; sessionId: string; createdAt?: string; status?: string };

/** Tags that still describe an edit the user has not acted on. */
function activeTagsOf(tags: Array<{ id: string; sessionId: string; createdAt?: string }>): PendingTag[] {
  return (tags as PendingTag[]).filter(
    (tag) => tag.status !== 'reviewed' && tag.status !== 'rejected',
  );
}

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

/**
 * Thrown when one attachment asks for the opposite decision while another's is
 * already in flight -- Approve in Files mode, Reject in Agent mode. The loser is
 * refused *without writing*: previously the second write simply landed last, so a
 * reject arriving a millisecond late silently reverted an accepted change
 * (NIM-5359, defect I).
 */
export class DiffResolutionConflictError extends Error {
  readonly filePath: string;
  readonly inFlightDecision: DiffResolutionDecision;
  readonly refusedDecision: DiffResolutionDecision;
  constructor(filePath: string, inFlight: DiffResolutionDecision, refused: DiffResolutionDecision) {
    super(`Cannot ${refused} the diff for ${filePath}: a ${inFlight} is already in flight`);
    this.name = 'DiffResolutionConflictError';
    this.filePath = filePath;
    this.inFlightDecision = inFlight;
    this.refusedDecision = refused;
  }
}

/**
 * Thrown by every save path while a resolution has committed its bytes to disk
 * but has not yet been able to mark the tag reviewed. Writing a second revision
 * under a tag that still describes an unreviewed edit is how a reject ends up
 * looking like an invisible pending diff on reopen (NIM-5359, defect I).
 */
export class DiffResolutionIncompleteError extends Error {
  readonly filePath: string;
  constructor(filePath: string) {
    super(
      `Cannot save ${filePath}: a diff resolution wrote to disk but its history tag is still pending. ` +
        `Retry the resolution to finish it.`,
    );
    this.name = 'DiffResolutionIncompleteError';
    this.filePath = filePath;
  }
}

/**
 * Thrown when the decision names a generation the model has already moved past --
 * the agent wrote again between the user seeing the diff and the click reaching
 * the model. The editor's serialized buffer describes the older generation, so
 * writing it would drop the newer write; the review stays open instead and the
 * newer generation renders (NIM-5359, defects C/F).
 */
export class DiffResolutionSupersededError extends Error {
  readonly filePath: string;
  readonly decidedGeneration: number | null;
  readonly currentGeneration: number | null;
  constructor(filePath: string, decided: number | null, current: number | null) {
    super(
      `Cannot resolve the diff for ${filePath}: the decision was made against generation ` +
        `${decided ?? 'unknown'} and the model now holds ${current ?? 'newer content'}`,
    );
    this.name = 'DiffResolutionSupersededError';
    this.filePath = filePath;
    this.decidedGeneration = decided;
    this.currentGeneration = current;
  }
}

/**
 * One caller's request to end the review. Several callers can share a single
 * entry (same decision), and an entry can outlive its first attempt: a request
 * that arrives while newer disk content is still on its way to the screen parks
 * and is retried when the generation settles.
 */
interface ResolutionEntry {
  decision: DiffResolutionDecision;
  /** Attachment that asked; excluded from the diff-resolved fan-out. */
  editorId: string;
  /** What the caller attached to the decision (serialized buffer, generation). */
  request: DiffResolutionRequest;
  promise: Promise<void>;
  settle: () => void;
  fail: (err: unknown) => void;
  /**
   * True once this entry has parked. A first attempt covers the generation that
   * was on screen when the user clicked; a resumed one must wait for anything
   * published since, because the user has not seen it.
   */
  parked: boolean;
}

interface EditorAttachment {
  id: string;
  isDirty: boolean;
  fileChangedCallbacks: Set<(content: string | ArrayBuffer) => unknown>;
  saveRequestedCallbacks: Set<() => void | Promise<void>>;
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
  /**
   * Bound on how long a published generation may go unacknowledged before the
   * model recovers it. Defaults to `DEFAULT_DIFF_APPLY_WATCHDOG_MS`.
   */
  diffApplyWatchdogMs?: number;
}

export class DocumentModel {
  filePath: string;
  private backingStore: DocumentBackingStore;
  private options: Required<DocumentModelOptions>;

  // -- Coordination state ---------------------------------------------------

  /** Verified editor baseline used to reject a save over unseen disk content (#1499). */
  private lastPersistedContent: string | ArrayBuffer | null = null;
  /** Latest disk observation, separate from the baseline when a dirty editor refused a reload. */
  private lastSeenDiskContent: string | ArrayBuffer | null = null;

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

  /**
   * The only code path allowed to create, ingest into, drain, resolve or replace
   * `currentSession`. Watcher delivery, hydration and resolution all run here so
   * two of them can never interleave inside each other's `await`s
   * (NIM-5359, defect E).
   */
  private readonly mutations = new SerialMutationQueue();

  /**
   * Order stamp of the newest external observation that has reached the session.
   * An operation whose stamp is not above this arrived from an older signal and
   * is dropped: applying or queuing it would move the visible diff backwards
   * onto content disk no longer holds.
   */
  private lastCommittedExternalSequence = 0;

  /** Arrival counter for backing stores that do not stamp their own signals. */
  private nextExternalSequence = 0;

  // -- Generation-scoped presentation (NIM-5359, defects F and G) ------------

  /**
   * The generation handed to presenters and still awaiting outcomes, or `null`
   * when nothing is in flight. A completion naming anything else is stale and is
   * dropped -- that is what stops one attachment's late acknowledgement from
   * settling another attachment's newer generation.
   */
  private presentedGeneration: number | null = null;

  /** Recipients of `presentedGeneration` that still owe an outcome. */
  private pendingRecipients = new Set<string>();

  /** Recipients that reported a successful outcome for `presentedGeneration`. */
  private succeededRecipients = new Set<string>();

  private applyWatchdogTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Recoveries since the last generation a presenter actually completed. A
   * presenter that fails on every republish would otherwise keep the model
   * re-reading disk indefinitely.
   */
  private consecutiveApplyRecoveries = 0;

  // -- Resolution as a two-store transaction (NIM-5359, defects C and I) -----

  /**
   * Retained state for an in-flight or half-finished resolution. Survives a
   * failure of either half so recovery can retry only what did not land.
   */
  private resolutionSnapshot: DiffResolutionSnapshot | null = null;

  /** The resolution currently owning the decision, or `null` when idle. */
  private inFlightResolution: ResolutionEntry | null = null;

  /**
   * A resolution waiting for the current generation to reach the screen. Resumed
   * from `settleCurrentGeneration`, never awaited from there: completions run on
   * the same mutation queue, so awaiting one from inside the other deadlocks.
   */
  private parkedResolution: ResolutionEntry | null = null;

  // -- Production hydration (NIM-5359, defect H) -----------------------------

  /** True once an initialization attempt has completed without a lookup failure. */
  private hydrated = false;

  /** The attempt in flight, shared by every caller that arrives while it runs. */
  private hydrationAttempt: Promise<void> | null = null;

  private hydrationRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private hydrationRetries = 0;

  /** Bounded re-read after a watcher event's history lookup failed. */
  private externalChangeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private externalChangeRetries = 0;

  /** All attached editors. */
  private attachments = new Map<string, EditorAttachment>();

  /** Event listeners on the model itself (for Jotai atoms, etc.). */
  private eventListeners = new Map<DocumentModelEventType, Set<(event: DocumentModelEvent) => void>>();

  // -- Save coordination ----------------------------------------------------

  private isSaving = false;
  private pendingSave: { editorId: string; content: string | ArrayBuffer; resolve: () => void; reject: (err: unknown) => void } | null = null;
  private autosaveTimer: ReturnType<typeof setInterval> | null = null;
  private lastEditTime = 0;
  private autosaveRequestInFlight = false;
  private autosaveConsecutiveFailures = 0;
  private nextAutosaveAttemptAt = 0;
  private autosaveBlocked = false;

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
      diffApplyWatchdogMs: options.diffApplyWatchdogMs ?? DEFAULT_DIFF_APPLY_WATCHDOG_MS,
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
        const nowDirty = this.isDirty();
        if (!nowDirty) {
          this.resetAutosaveFailureState();
        }
        if (wasDirty !== nowDirty) {
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
        this.resetAutosaveFailureState();
        this.lastPersistedContent = content;
        this.lastSeenDiskContent = content;
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
        // Registering a diff callback IS the readiness signal: a parked
        // generation publishes now, and a live one gains this attachment as a
        // recipient it must wait on.
        this.mutate('presenterRegistered', () => this.onPresenterRegistered(id, callback));
        return () => {
          att.diffRequestedCallbacks.delete(callback);
          // Unsubscribing is how an attachment stops being a presenter without
          // detaching -- source mode entry is the everyday case. It has to
          // release the generation the same way detach does, or the model waits
          // on an editor that can no longer render anything until the watchdog
          // fires (NIM-5359, defects F/G).
          if (att.diffRequestedCallbacks.size > 0) return;
          const owedAnOutcome = this.pendingRecipients.delete(id);
          this.succeededRecipients.delete(id);
          if (owedAnOutcome) {
            this.mutate('presenterUnsubscribed', () => this.settleCurrentGeneration());
          }
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

      resolveDiff: async (accepted: boolean, request?: DiffResolutionRequest) => {
        await this.resolveDiffFromEditor(id, accepted, request);
      },

      markDiffApplied: () => {
        // Legacy parameterless acknowledgement: the only thing it can mean is
        // "the generation I was last handed applied". That is correct with a
        // single presenter and wrong with two, which is why it is deprecated.
        const generation = this.presentedGeneration;
        if (generation === null) return;
        this.completeDiffApply({ editorId: id, generation, outcome: 'applied' });
      },

      completeDiffApply: (input) => {
        this.completeDiffApply({ ...input, editorId: id });
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

    // A gone presenter owes the current generation nothing, and its handle must
    // no longer be able to acknowledge anything (NIM-5359, defect G).
    const owedAnOutcome = this.pendingRecipients.delete(editorId);
    this.succeededRecipients.delete(editorId);
    if (owedAnOutcome) {
      this.mutate('recipientDetached', () => this.settleCurrentGeneration());
    }

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
    this.lastSeenDiskContent = content;
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
    this.lastCommittedExternalSequence = this.nextExternalSequence;
    this.clearExternalChangeRetry();
    if (this.deleted) return;
    this.deleted = true;
    // Don't preserve a stale lastPersistedContent baseline -- if a recreated
    // file later arrives via the watcher, echo suppression must NOT compare
    // against the pre-deletion content.
    this.lastPersistedContent = null;
    this.lastSeenDiskContent = null;
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
    this.mutate('clearDiffState', () => this.runClearDiffState(excludeEditorId, accepted));
  }

  private runClearDiffState(excludeEditorId: string | undefined, accepted: boolean): void {
    if (this.diffState || this.currentSession) {
      this.diffState = null;
      this.currentSession = null;
      this.clearGenerationTracking();
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

      // The review this decision was waiting on is gone; run it so the caller's
      // promise settles rather than hanging on a session that no longer exists.
      this.maybeResumeParkedResolution();
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
   *
   * Delegates hydration to `ensureInitialized`, but is not itself the production
   * seam -- no renderer editor loads through here (NIM-5359, defect H).
   */
  async loadContent(): Promise<string | ArrayBuffer> {
    const content = await this.backingStore.load();
    this.lastPersistedContent = content;
    this.lastSeenDiskContent = content;

    // A successful load means the file is back. Reopen for saves and let
    // the main process know we've observed the recreation (for lifecycle
    // bookkeeping of recentlyDeletedFiles).
    if (this.deleted) {
      this.deleted = false;
      this.notifyMainEditorReleasedDeletedPath();
    }

    // A failed tag lookup must not fail the load: the caller asked for bytes and
    // has them. `ensureInitialized` logs and retries on its own timer.
    await this.ensureInitialized(content).catch(() => {});

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

    if (this.isSaveBlockedByPendingResolution()) {
      // Bytes are on disk under a tag that still reads as an unreviewed edit.
      // Writing again now would bury the half-finished transaction.
      throw new DiffResolutionIncompleteError(this.filePath);
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
      const persisted = this.lastPersistedContent;
      const seen = this.lastSeenDiskContent;
      const observation = this.nextExternalSequence;
      const expectedDiskContent = typeof persisted === 'string' ? persisted : undefined;
      // Only echo suppression is optimistic; the conflict baseline moves after a successful write.
      this.lastSeenDiskContent = content;
      try {
        await this.backingStore.save(content, expectedDiskContent);
      } catch (error) {
        // A later external observation owns its own baseline and must not be rewound.
        if (this.nextExternalSequence === observation) {
          if (this.lastSeenDiskContent === content) this.lastSeenDiskContent = seen;
        }
        throw error;
      }
      this.lastPersistedContent = content;
      this.resetAutosaveFailureState();

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

  /**
   * File-watcher entry point.
   *
   * Ordering is stamped here, before the tag and baseline lookups below, because
   * those lookups are the reorder point: if C1's lookup stalls while C2's
   * returns, C2 enters the session first and C1 must then be recognised as stale
   * rather than accepted as the newest payload (NIM-5359, defect E).
   * `info.timestamp` cannot serve -- DiskBackedStore assigns it after its own
   * asynchronous read.
   */
  private async handleExternalChange(info: ExternalChangeInfo): Promise<void> {
    if (this.disposed) return;
    const sequence = this.sequenceFor(info);
    try {
      await this.prepareExternalChange(sequence, info);
      this.externalChangeRetries = 0;
    } catch (err) {
      // The backing store invokes this callback without awaiting it, so a throw
      // here surfaces as an unhandled rejection and takes nothing with it. A
      // failed tag or baseline lookup is an ordinary transient (the history DB is
      // busy) -- but the agent's bytes are already on disk and nothing else will
      // ask again, so retry from a fresh read rather than waiting for the user's
      // next agent write.
      console.error(`[DocumentModel] External change handling failed for ${this.filePath}:`, err);
      this.scheduleExternalChangeRetry(err);
    }
  }

  /**
   * Re-read disk after a failed lookup, bounded, one outstanding retry at a time.
   *
   * Deliberately re-reads instead of replaying the payload that failed: by the
   * time the retry runs, disk may hold something newer, and the whole point of
   * the ordering work is that the model never presents content disk does not have.
   * The signal carries no sequence -- the failed one is spent, and a retry that
   * reused it would be dropped as stale by its own watermark.
   */
  private scheduleExternalChangeRetry(err: unknown): void {
    const delay = EXTERNAL_CHANGE_RETRY_DELAYS_MS[this.externalChangeRetries];
    if (this.disposed || delay === undefined || this.attachments.size === 0) {
      console.error(
        `[DocumentModel] External change handling for ${this.filePath} failed and will not be retried:`,
        err,
      );
      return;
    }
    this.externalChangeRetries += 1;
    if (this.externalChangeRetryTimer) return;

    this.externalChangeRetryTimer = setTimeout(() => {
      this.externalChangeRetryTimer = null;
      if (this.disposed) return;
      const source = this.backingStore;
      const observation = this.nextExternalSequence;
      void source.load().then(
        (content) => {
          if (source !== this.backingStore || this.deleted || observation !== this.nextExternalSequence) return;
          return this.handleExternalChange({
            content,
            timestamp: Date.now(),
            // Force the tag lookup: the content may be byte-identical to what we
            // last saw, and it is precisely the tag we failed to resolve.
            checkPendingTags: true,
          });
        },
        (loadErr) => {
          console.error(
            `[DocumentModel] External change retry read failed for ${this.filePath}:`,
            loadErr,
          );
          this.scheduleExternalChangeRetry(loadErr);
        },
      );
    }, delay);
  }

  private clearExternalChangeRetry(): void {
    if (this.externalChangeRetryTimer) {
      clearTimeout(this.externalChangeRetryTimer);
      this.externalChangeRetryTimer = null;
    }
  }

  private sequenceFor(info: ExternalChangeInfo): number {
    if (typeof info.sequence === 'number') {
      if (info.sequence > this.nextExternalSequence) {
        this.nextExternalSequence = info.sequence;
      }
      return info.sequence;
    }
    return ++this.nextExternalSequence;
  }

  /** Echo suppression key: have we already seen exactly these bytes on disk? */
  private isEcho(info: ExternalChangeInfo): boolean {
    const echoBaseline = this.lastSeenDiskContent ?? this.lastPersistedContent;
    return echoBaseline !== null && info.content === echoBaseline;
  }

  /**
   * True when a newer observation already reached the session, so this one is
   * older information no matter what its content says.
   */
  private isStaleObservation(sequence: number): boolean {
    return sequence <= this.lastCommittedExternalSequence;
  }

  /**
   * Lookup half of external-change handling: everything that must await runs
   * here, outside the mutation queue, so a stalled lookup cannot hold up a newer
   * event. Nothing in here may touch `currentSession` -- the commit half does
   * that, on the queue, under the ordering check.
   */
  private async prepareExternalChange(sequence: number, info: ExternalChangeInfo, source = this.backingStore): Promise<void> {
    const lastLen = typeof this.lastPersistedContent === 'string' ? this.lastPersistedContent.length : -1;
    diffTrace('DocumentModel.handleExternalChange enter', {
      path: this.filePath,
      sequence,
      checkPendingTags: info.checkPendingTags,
      contentLen: typeof info.content === 'string' ? info.content.length : -1,
      lastPersistedLen: lastLen,
      t: performance.now(),
    });

    // Echo suppression: skip if content matches last-persisted.
    // This catches our own saves echoing back through the file watcher.
    const isEcho = this.isEcho(info);
    if (isEcho && !info.checkPendingTags) {
      diffTrace('DocumentModel.handleExternalChange echo-skip', { path: this.filePath, sequence, t: performance.now() });
      return;
    }

    // Check for pending AI edit tags.
    // For echoed content: only reached when checkPendingTags is set (tag-created signal).
    // For changed content: always check.
    const pendingTags = await this.options.getPendingTags(this.filePath);
    const activeTags = activeTagsOf(pendingTags);
    diffTrace('DocumentModel.handleExternalChange tags', {
      path: this.filePath,
      sequence,
      activeTagCount: activeTags.length,
      isEcho,
      checkPendingTags: info.checkPendingTags,
      branch: activeTags.length > 0 ? 'diff' : 'fileChanged',
      t: performance.now(),
    });

    if (activeTags.length === 0) {
      await this.mutations.run(() => { if (source === this.backingStore) this.commitExternalContent(sequence, info); });
      return;
    }

    // Get the diff baseline -- this is the content BEFORE the AI edit.
    // May come from a history tag (for incremental approvals) or lastPersistedContent.
    const tag = activeTags[0];
    let baselineContent: string | null;
    try {
      const baseline = await this.options.getDiffBaseline(this.filePath);
      // A successful lookup that finds nothing recorded is a real answer, and
      // last-persisted is the right stand-in for it. A *failed* one is not.
      baselineContent =
        baseline?.content ?? (typeof this.lastPersistedContent === 'string' ? this.lastPersistedContent : '');
    } catch (err) {
      // Manufacturing a baseline out of editor state after a transport failure
      // builds a session whose "old" side is the agent's own write: the diff
      // shows C1->C2 instead of C0->C2, and rejecting it restores C1 rather than
      // the pre-edit content. Absence and failure may not share an outcome
      // (NIM-5359, defect I). A live session for this tag already owns an
      // authoritative baseline, so only a session that does not exist yet has to
      // wait for the retry.
      if (this.currentSession?.tagId !== tag.id) throw err;
      baselineContent = null;
    }

    await this.mutations.run(() => { if (source === this.backingStore) this.commitDiffPayload(sequence, info, tag, baselineContent); });
  }

  /**
   * Commit half for a change with no pending AI edit tag. Runs on the mutation
   * queue; must not await.
   */
  private commitExternalContent(sequence: number, info: ExternalChangeInfo): void {
    if (this.disposed) return;
    if (this.isStaleObservation(sequence)) {
      diffTrace('DocumentModel.commitExternalContent stale-drop', {
        path: this.filePath,
        sequence,
        committed: this.lastCommittedExternalSequence,
        t: performance.now(),
      });
      return;
    }
    // Re-check echo inside the serial section: the model may have written these
    // exact bytes itself while the tag lookup was in flight. Coalescing identical
    // disk content by comparing it against what we last saw is the same rule as
    // the pre-lookup check, applied against state that may since have moved.
    if (this.isEcho(info) && !info.checkPendingTags) return;

    this.lastCommittedExternalSequence = sequence;

    // Normal external change -- update persisted content and notify editors.
    diffTrace('DocumentModel notifyFileChanged (no active tags)', {
      path: this.filePath,
      sequence,
      contentLen: typeof info.content === 'string' ? info.content.length : -1,
      t: performance.now(),
    });
    this.lastSeenDiskContent = info.content;
    // A successful external read means the file is back. Clear the deleted
    // flag so saves can resume against the fresh baseline. Also notify the
    // main process so the recentlyDeleted entry can be released.
    if (this.deleted) {
      this.deleted = false;
      this.notifyMainEditorReleasedDeletedPath();
    }
    // The conflict baseline may only advance if every editor actually took
    // the content. A dirty editor is skipped by notifyFileChanged; advancing
    // anyway would let its next save sail through the conflict check and
    // overwrite this external write (#3684).
    if (this.notifyFileChanged(info.content)) {
      this.lastPersistedContent = info.content;
    } else {
      if (typeof info.content === 'string') this.emit('external-conflict', info.content);
    }
  }

  /**
   * Commit half for a change carrying an active AI edit tag. Runs on the
   * mutation queue; must not await.
   *
   * `baselineContent` is `null` only when the lookup failed while a session for
   * this same tag was already live -- that session's own baseline is then the
   * authoritative one.
   */
  private commitDiffPayload(
    sequence: number,
    info: ExternalChangeInfo,
    tag: { id: string; sessionId: string; createdAt?: string },
    baselineContent: string | null,
  ): void {
    if (this.disposed) return;
    if (baselineContent === null && this.currentSession?.tagId !== tag.id) {
      // The session this payload was going to lean on is gone. Creating one from
      // an unknown baseline is the defect above; let the retry re-read.
      return;
    }
    if (this.isStaleObservation(sequence)) {
      diffTrace('DocumentModel.commitDiffPayload stale-drop', {
        path: this.filePath,
        sequence,
        committed: this.lastCommittedExternalSequence,
        tagId: tag.id,
        contentLen: typeof info.content === 'string' ? info.content.length : -1,
        t: performance.now(),
      });
      return;
    }

    const newContentString = typeof info.content === 'string' ? info.content : '';
    let oldContent = baselineContent ?? this.currentSession!.baselineContent;

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
      // Still the newest thing the model has observed on disk, so it advances the
      // watermark: an older read resolving later must not create the session from
      // content this observation already superseded.
      this.lastCommittedExternalSequence = sequence;
      diffTrace('DocumentModel.handleExternalChange skip empty-diff session', {
        path: this.filePath,
        sequence,
        tagId: tag.id,
        contentLen: newContentString.length,
        checkPendingTags: info.checkPendingTags,
        t: performance.now(),
      });
      return;
    }

    this.lastCommittedExternalSequence = sequence;

    // Drive the DiffSession state machine. It owns duplicate-suppression and
    // baseline-rotation logic; only `apply` / `fresh` outcomes notify editors.
    // `queued` payloads sit in the session and are drained once every recipient
    // of the current generation reports success via `completeDiffApply`.
    let ingestKind: 'apply' | 'queued' | 'duplicate' | 'fresh';
    if (!this.currentSession || this.currentSession.tagId !== tag.id) {
      this.consecutiveApplyRecoveries = 0;
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
      sequence,
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

    // Only publish when the state machine says new work is needed.
    // 'queued' payloads wait for the in-flight generation to settle; 'duplicate' is a no-op.
    if (ingestKind === 'apply' || ingestKind === 'fresh') {
      this.publishCurrentGeneration();
    }
  }

  /**
   * Run a session mutation on the serial queue.
   *
   * The queue executes inline when idle, so a caller that expects to observe its
   * own mutation immediately (an editor reporting its apply settled, then reading
   * the drained state) still does. When another operation holds the queue, the
   * mutation waits for it instead of interleaving into its `await`s. Only
   * mutations that genuinely have to read disk (recovery) return a promise.
   */
  private mutate(label: string, op: () => void | Promise<void>): void {
    void this.mutations.run(op).catch((err) => {
      console.error(`[DocumentModel] ${label} failed for ${this.filePath}:`, err);
    });
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
      generation: snap.generation,
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
   * Attachments that can actually put a diff on screen. A registered diff
   * callback is the readiness signal; an attachment without one (source mode, a
   * custom editor whose real callback has not landed yet, a hidden editor) is not
   * a recipient and must never be waited on.
   */
  private capablePresenterIds(): string[] {
    const ids: string[] = [];
    for (const [attId, att] of this.attachments) {
      if (att.diffRequestedCallbacks.size > 0) ids.push(attId);
    }
    return ids;
  }

  /**
   * Hand the session's current target to every capable presenter and start
   * waiting on their outcomes. `diffState` must already describe that target.
   *
   * With nobody capable, the generation parks as `awaiting-presenter` instead of
   * sitting in `applying` waiting for an acknowledgement that cannot arrive --
   * that stall is what stops every later agent write from reaching the editor
   * (NIM-5359, defect G).
   */
  private publishCurrentGeneration(): void {
    const session = this.currentSession;
    if (!session || !this.diffState) return;

    const recipients = this.capablePresenterIds();
    if (recipients.length === 0) {
      if (session.phase === 'applying') session.markAwaitingPresenter();
      this.clearGenerationTracking();
      diffTrace('DocumentModel.publishCurrentGeneration awaiting-presenter', {
        path: this.filePath,
        generation: session.generation,
        newLen: session.appliedContent.length,
        t: performance.now(),
      });
      // Nobody can put this on screen, so a parked decision has nothing left to
      // wait for -- holding it would hang the caller's promise indefinitely.
      this.maybeResumeParkedResolution();
      return;
    }

    this.presentedGeneration = session.generation;
    this.pendingRecipients = new Set(recipients);
    this.succeededRecipients = new Set();
    this.armApplyWatchdog(session.generation);
    this.notifyDiffRequested();
  }

  private clearGenerationTracking(): void {
    this.presentedGeneration = null;
    this.pendingRecipients.clear();
    this.succeededRecipients.clear();
    this.clearApplyWatchdog();
  }

  /**
   * A presenter registered while a session exists. A parked target publishes
   * under a fresh generation; a live one gains this attachment as a recipient and
   * receives the current state directly.
   */
  private onPresenterRegistered(editorId: string, callback: (state: DiffState) => void): void {
    const session = this.currentSession;
    if (!session || !this.diffState) return;

    if (session.phase === 'awaiting-presenter') {
      session.beginPresenting();
      this.refreshDiffStateFromSession();
      this.publishCurrentGeneration();
      return;
    }

    if (session.phase === 'applying' && this.presentedGeneration === session.generation) {
      this.pendingRecipients.add(editorId);
    }
    try {
      callback(this.diffState);
    } catch (err) {
      console.error('[DocumentModel] Error in immediate diff callback:', err);
    }
  }

  /**
   * A presenter reports how it finished with one specific generation.
   *
   * Synchronous on the outside like the acknowledgement it replaces: an editor
   * that reports success while the queue is idle observes the resulting drain
   * before it returns. Only the failure path, which has to re-read disk, is
   * asynchronous.
   */
  completeDiffApply(input: DiffApplyCompletion): void {
    this.mutate('completeDiffApply', () => this.runApplyCompletion(input));
  }

  private runApplyCompletion(input: DiffApplyCompletion): void | Promise<void> {
    if (!this.currentSession) return;

    if (this.presentedGeneration === null || input.generation !== this.presentedGeneration) {
      // A completion for a target the model has already moved past. Acting on it
      // is exactly how one attachment's late acknowledgement settled another
      // attachment's newer in-flight generation (NIM-5359, defect F).
      diffTrace('DocumentModel.completeDiffApply stale-drop', {
        path: this.filePath,
        editorId: input.editorId,
        generation: input.generation,
        presented: this.presentedGeneration,
        outcome: input.outcome,
        t: performance.now(),
      });
      return;
    }

    // Detached, already reported, or never handed this generation at all.
    if (!this.pendingRecipients.delete(input.editorId)) return;

    if (input.outcome === 'failed') {
      return this.recoverLatestFromDisk(`failed apply from ${input.editorId}`);
    }

    if (input.outcome !== 'detached') {
      this.succeededRecipients.add(input.editorId);
    }
    this.settleCurrentGeneration();
  }

  /**
   * Advance the session once every recipient of the current generation has
   * reported. A generation nobody actually presented is parked, never applied:
   * marking it applied would advance the conflict baseline onto content no editor
   * is showing.
   */
  private settleCurrentGeneration(): void {
    const session = this.currentSession;
    if (!session || this.presentedGeneration === null) return;
    if (this.pendingRecipients.size > 0) return;

    const witnessed = this.succeededRecipients.size > 0;
    this.clearGenerationTracking();

    if (!witnessed) {
      if (session.phase === 'applying') session.markAwaitingPresenter();
      this.maybeResumeParkedResolution();
      return;
    }
    if (session.phase !== 'applying') return; // Defensive: resolution took it first.

    this.consecutiveApplyRecoveries = 0;
    session.markApplied();
    const drained = session.drainPending();
    diffTrace('DocumentModel.settleCurrentGeneration', {
      path: this.filePath,
      tagId: session.tagId,
      phaseAfterMark: session.phase,
      drainedLen: drained?.length ?? -1,
      t: performance.now(),
    });
    this.refreshDiffStateFromSession();
    if (drained !== null) {
      // Session is back in 'applying' with the drained payload as appliedContent.
      this.publishCurrentGeneration();
    }
    this.maybeResumeParkedResolution();
  }

  /**
   * Attachment ids that were handed the current generation and have not yet
   * reported an outcome for it.
   */
  getPendingDiffRecipients(): string[] {
    return [...this.pendingRecipients];
  }

  /**
   * Every published generation is watched. The recovery budget is enforced in
   * `recoverLatestFromDisk`, which *parks* when it is spent -- declining to arm
   * here instead left the last republished generation unmonitored, so a presenter
   * that never acknowledged it wedged the session in `applying` for good and every
   * later write queued behind it forever (NIM-5359, finding 6).
   */
  private armApplyWatchdog(generation: number): void {
    this.clearApplyWatchdog();
    const bound = this.options.diffApplyWatchdogMs;
    if (bound <= 0) return;
    this.applyWatchdogTimer = setTimeout(() => {
      this.applyWatchdogTimer = null;
      if (this.disposed) return;
      if (this.presentedGeneration !== generation) return;
      console.warn(
        `[DocumentModel] Diff generation ${generation} for ${this.filePath} went unacknowledged by ` +
          `${[...this.pendingRecipients].join(', ') || 'every recipient'}; recovering from disk`,
      );
      this.mutate('diffApplyWatchdog', () => this.recoverLatestFromDisk('unacknowledged generation'));
    }, bound);
  }

  private clearApplyWatchdog(): void {
    if (this.applyWatchdogTimer) {
      clearTimeout(this.applyWatchdogTimer);
      this.applyWatchdogTimer = null;
    }
  }

  /**
   * Failure recovery, never normal ordering: the generation the model handed out
   * was not presented, so it re-reads disk and republishes those bytes under a
   * fresh generation. The tag stays pending -- an edit nobody displayed has not
   * been reviewed.
   */
  private async recoverLatestFromDisk(reason: string): Promise<void> {
    const session = this.currentSession;
    if (!session) return;

    if (session.phase === 'applying') session.markApplyFailed();
    this.clearGenerationTracking();

    if (this.consecutiveApplyRecoveries >= MAX_CONSECUTIVE_APPLY_RECOVERIES) {
      console.error(
        `[DocumentModel] Diff presentation for ${this.filePath} failed ${this.consecutiveApplyRecoveries} ` +
          `times (${reason}); parking the pending tag until a presenter re-registers`,
      );
      this.maybeResumeParkedResolution();
      return;
    }
    this.consecutiveApplyRecoveries += 1;

    let diskContent: string;
    try {
      const loaded = await this.backingStore.load();
      diskContent = typeof loaded === 'string' ? loaded : session.appliedContent;
    } catch (err) {
      console.error(`[DocumentModel] Diff recovery read failed for ${this.filePath} (${reason}):`, err);
      // The session is already parked with its recipient tracking cleared, so a
      // presenter re-registering or a newer write republishes it. Two things must
      // not survive this: a payload queued behind the dead generation, which can
      // no longer drain through an acknowledgement, and a decision waiting on
      // that queue -- its caller's promise would never settle (NIM-5359).
      const queued = session.pendingContent;
      if (queued !== null) {
        session.adoptRecoveredTarget(queued);
        session.markApplyFailed();
        this.refreshDiffStateFromSession();
      }
      this.maybeResumeParkedResolution();
      return;
    }
    if (this.disposed || this.currentSession !== session) return;

    this.lastSeenDiskContent = diskContent;
    // Republish even when the bytes are unchanged: what failed is that nobody is
    // verifiably showing them, not that they went stale.
    session.adoptRecoveredTarget(diskContent);
    this.refreshDiffStateFromSession();
    this.publishCurrentGeneration();
  }

  /**
   * Retained state for an in-flight or half-finished resolution, or `null` when
   * none has been attempted. A failed write leaves `diskCommitted: false` and the
   * tag pending; a failed tag update leaves `diskCommitted: true` and every save
   * blocked until the retry lands.
   *
   * It survives a failure on purpose, so this is "the last attempt", not "a
   * resolution is running". Use `isSaveBlockedByPendingResolution()` for the save
   * gate -- a retained snapshot whose write was refused blocks nothing.
   */
  getResolutionSnapshot(): DiffResolutionSnapshot | null {
    return this.resolutionSnapshot ? { ...this.resolutionSnapshot } : null;
  }

  /**
   * True while disk already holds the resolved bytes but the history tag is still
   * pending. Every save and autosave for this file must stay blocked until the
   * idempotent tag retry lands -- TabEditor treats this the same way it treats an
   * unverified reload: the dirty buffer is preserved and nothing is written.
   */
  /**
   * True while a decision owns the resolution mutex -- including one parked
   * waiting for its generation to reach the screen.
   *
   * This, not `getResolutionSnapshot() !== null`, is what a save gate must ask.
   * The snapshot is retained after a failed attempt on purpose, so testing it
   * would block every autosave for the life of the tab.
   */
  isResolutionInFlight(): boolean {
    return this.inFlightResolution !== null;
  }

  isSaveBlockedByPendingResolution(): boolean {
    const snapshot = this.resolutionSnapshot;
    return !!snapshot && snapshot.diskCommitted && !snapshot.tagCommitted;
  }

  /**
   * Finish a resolution whose tag update failed after its bytes reached disk.
   * Retries only that half; safe to call when nothing is outstanding.
   */
  async retryPendingResolution(): Promise<void> {
    const entry = this.inFlightResolution;
    if (entry) return entry.promise;
    if (!this.isSaveBlockedByPendingResolution()) return;
    const snapshot = this.resolutionSnapshot!;
    await this.resolveDiffFromEditor('', snapshot.decision === 'accept');
  }

  /**
   * The generation an editor must name when it resolves with its own serialized
   * buffer. Reading it from the live session (rather than from the last published
   * `DiffState`) is what makes "did the agent write again since the click?" a
   * single comparison.
   */
  getCurrentDiffGeneration(): number | null {
    return this.currentSession?.generation ?? null;
  }

  /**
   * Idempotent, single-flight initialization from the bytes a real editor just
   * loaded. This is the production hydration seam: `TabEditor` calls it with
   * `initialContent`, `HiddenTabManager.host.loadContent()` calls it after its
   * disk read, and `loadContent()` delegates to it.
   *
   * Queries pending tags plus the diff baseline and creates a session only when
   * the baseline differs from the bytes the editor loaded, then publishes it. A
   * generation nobody can present yet parks as `awaiting-presenter`; a presenter
   * that registers later picks it up through `onPresenterRegistered`.
   *
   * Rejects when a lookup fails, and stays un-hydrated so the next call retries.
   * Absence ("no pending tags") and transport failure must never share an
   * outcome: memoizing the latter as the former leaves a reopened tab silently
   * un-hydrated over an unreviewed agent write.
   */
  async ensureInitialized(loadedContent: string | ArrayBuffer): Promise<void> {
    if (this.hydrated) return;
    if (this.hydrationAttempt) return this.hydrationAttempt;

    this.clearHydrationRetry();
    const attempt = this.runHydration(loadedContent).then(
      () => {
        this.hydrated = true;
        this.hydrationAttempt = null;
        this.hydrationRetries = 0;
      },
      (err) => {
        this.hydrationAttempt = null;
        this.scheduleHydrationRetry(loadedContent, err);
        throw err;
      },
    );
    this.hydrationAttempt = attempt;
    return attempt;
  }

  /**
   * Same prepare/commit split as watcher delivery: the tag and baseline lookups
   * await outside the mutation queue, and only the ordering check plus the
   * session mutation run on it. Holding the queue across an IPC round trip would
   * let one slow history read stall every live watcher event behind it.
   */
  private async runHydration(loadedContent: string | ArrayBuffer): Promise<void> {
    // Read before the lookups, for the same reason a watcher event is stamped
    // before its disk read: hydration is an observation of disk too, and a
    // stalled lookup must not let it resurrect a picture a newer write has
    // already replaced (defect E).
    //
    // It is a *watermark reading*, not a stamp. Watcher sequences come from
    // `DiskBackedStore`'s own counter, which starts at 1 for every store, so
    // spending a number out of that space here made the next real agent write
    // look like an observation the model had already committed -- it was dropped
    // as stale and only a second write got through.
    const observedWatermark = this.lastCommittedExternalSequence;

    await this.mutations.run(() => {
      // Only when nothing has established one. A live watcher event or a sibling
      // attachment's newer bytes outrank what this editor happened to load.
      if (this.lastPersistedContent === null) {
        this.setLastPersistedContent(loadedContent);
      }
    });

    if (this.disposed) return;
    // Binary content has no diff surface; seeding the baseline is the whole job.
    if (typeof loadedContent !== 'string') return;

    const activeTags = activeTagsOf(await this.options.getPendingTags(this.filePath));
    if (this.disposed) return;
    if (activeTags.length === 0) return;

    const tag = activeTags[0];
    const baseline = await this.options.getDiffBaseline(this.filePath);
    if (this.disposed) return;

    const baselineContent = baseline?.content ?? null;
    // No baseline, or one the loaded bytes already match: the tag exists but
    // there is nothing to show. A session here would be an empty `applying`
    // phase with no payload any acknowledgement could drain.
    if (baselineContent === null || baselineContent === loadedContent) {
      diffTrace('DocumentModel.runHydration nothing to present', {
        path: this.filePath,
        observedWatermark,
        tagId: tag.id,
        hasBaseline: baselineContent !== null,
        t: performance.now(),
      });
      return;
    }

    await this.mutations.run(() =>
      this.commitHydratedDiff(observedWatermark, tag, baselineContent, loadedContent),
    );
  }

  /**
   * Commit half of hydration. Runs on the mutation queue; must not await.
   *
   * A live session always wins. It was built from a watcher observation of the
   * same file, so it is at least as new as the bytes this editor loaded, and
   * replacing it would move the visible diff backwards. The same goes for a
   * watcher observation that committed while the lookups were in flight, which
   * is what `observedWatermark` (the watermark read before them) detects.
   *
   * Hydration deliberately leaves `lastCommittedExternalSequence` alone: it is
   * not a watcher observation and does not occupy a slot in the store's sequence
   * space. Advancing it here silently ate the next agent write.
   */
  private commitHydratedDiff(
    observedWatermark: number,
    tag: PendingTag,
    baselineContent: string,
    loadedContent: string,
  ): void {
    if (this.disposed) return;
    if (this.currentSession || this.lastCommittedExternalSequence !== observedWatermark) {
      diffTrace('DocumentModel.commitHydratedDiff superseded', {
        path: this.filePath,
        observedWatermark,
        committed: this.lastCommittedExternalSequence,
        hasSession: !!this.currentSession,
        tagId: tag.id,
        t: performance.now(),
      });
      return;
    }

    this.consecutiveApplyRecoveries = 0;
    // The session carries the tag it hydrated from: resolution reads
    // `currentSession.tagId` at commit time to mark the review finished.
    this.currentSession = DiffSession.create({
      tagId: tag.id,
      sessionId: tag.sessionId,
      baselineContent,
      initialContent: loadedContent,
      createdAt: tag.createdAt ? new Date(tag.createdAt).getTime() : Date.now(),
    });
    diffTrace('DocumentModel.commitHydratedDiff session created', {
      path: this.filePath,
      observedWatermark,
      tagId: tag.id,
      oldLen: baselineContent.length,
      newLen: loadedContent.length,
      attachCount: this.attachments.size,
      t: performance.now(),
    });
    this.refreshDiffStateFromSession();
    this.publishCurrentGeneration();
  }

  private scheduleHydrationRetry(loadedContent: string | ArrayBuffer, err: unknown): void {
    const delay = HYDRATION_RETRY_DELAYS_MS[this.hydrationRetries];
    if (this.disposed || delay === undefined || this.attachments.size === 0) {
      console.error(
        `[DocumentModel] Pending-diff hydration for ${this.filePath} failed and will not be retried:`,
        err,
      );
      return;
    }

    this.hydrationRetries += 1;
    console.warn(
      `[DocumentModel] Pending-diff hydration for ${this.filePath} failed; retrying in ${delay}ms:`,
      err,
    );
    this.hydrationRetryTimer = setTimeout(() => {
      this.hydrationRetryTimer = null;
      void this.ensureInitialized(loadedContent).catch(() => {
        // Logged above; the next retry, if any, is armed by this same path.
      });
    }, delay);
  }

  private clearHydrationRetry(): void {
    if (this.hydrationRetryTimer) {
      clearTimeout(this.hydrationRetryTimer);
      this.hydrationRetryTimer = null;
    }
  }

  /**
   * Rotate the active tag and re-baseline after a partial accept/reject. The editor has
   * already created the new incremental-approval tag and persisted the post-partial
   * content; we update the session so subsequent file-watcher events compute against the
   * new baseline. The visible diff stays on screen (un-resolved groups remain).
   */
  private applyPartialResolve(input: { newTagId: string; newBaseline: string }): void {
    this.mutate('applyPartialResolve', () => this.runPartialResolve(input));
  }

  private runPartialResolve(input: { newTagId: string; newBaseline: string }): void {
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

  /**
   * Single-flight entry point. The decision is claimed synchronously so a second
   * click cannot slip past the check while the first is inside an `await`:
   * callers asking for the same decision join the in-flight promise, and an
   * opposite decision is refused before anything is written.
   */
  private resolveDiffFromEditor(
    editorId: string,
    accepted: boolean,
    request: DiffResolutionRequest = {},
  ): Promise<void> {
    const decision: DiffResolutionDecision = accepted ? 'accept' : 'reject';

    const active = this.inFlightResolution;
    if (active) {
      if (active.decision !== decision) {
        return Promise.reject(
          new DiffResolutionConflictError(this.filePath, active.decision, decision),
        );
      }
      return active.promise;
    }

    let settle!: () => void;
    let fail!: (err: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      settle = res;
      fail = rej;
    });
    const entry: ResolutionEntry = {
      decision,
      editorId,
      request,
      promise,
      settle,
      fail,
      parked: false,
    };
    this.inFlightResolution = entry;
    this.startResolutionAttempt(entry);
    return promise;
  }

  /**
   * Run one attempt on the mutation queue. A parked attempt deliberately leaves
   * the caller's promise unsettled -- `maybeResumeParkedResolution` runs it again
   * once the generation it is waiting on has settled.
   */
  private startResolutionAttempt(entry: ResolutionEntry): void {
    void this.mutations.run(() => this.runDiffResolution(entry)).then(
      (outcome) => {
        if (outcome === 'parked') return;
        if (this.inFlightResolution === entry) this.inFlightResolution = null;
        entry.settle();
      },
      (err) => {
        if (this.inFlightResolution === entry) this.inFlightResolution = null;
        entry.fail(err);
      },
    );
  }

  /**
   * Resolution may only touch disk when the model holds nothing the user has not
   * been shown: the published generation must have settled and no newer payload
   * may be queued behind it. Writing against a stale target is defect C -- it
   * drops whatever the agent wrote in between and then conflicts with disk.
   */
  private canResolveNow(): boolean {
    if (this.presentedGeneration !== null) return false;
    return (this.currentSession?.pendingContent ?? null) === null;
  }

  /**
   * The user decided while the generation they were looking at was still on its
   * way to the screen. When the model holds nothing newer, that click covers it:
   * the presentation is abandoned (the diff is about to be torn down anyway) and
   * the session counts as applied. With newer content queued the decision would
   * be against bytes nobody has seen, so resolution parks instead.
   *
   * Only a first attempt may do this. Anything published *after* the click is new
   * information; a resumed attempt waits for it to reach the screen.
   */
  private supersedePresentationForResolution(): void {
    const session = this.currentSession;
    if (!session || this.presentedGeneration === null) return;
    if (session.pendingContent !== null) return;
    // Deliberately no `refreshDiffStateFromSession` -- the published state is
    // unchanged, and emitting here would announce a diff-state change for a
    // session that is one step from being torn down.
    this.clearGenerationTracking();
    if (session.phase === 'applying') session.markApplied();
  }

  private maybeResumeParkedResolution(): void {
    const parked = this.parkedResolution;
    if (!parked) return;
    // With no session left there is nothing to wait for: run so the caller's
    // promise settles instead of hanging on a review that no longer exists.
    if (this.currentSession && !this.canResolveNow()) return;
    this.parkedResolution = null;
    this.startResolutionAttempt(parked);
  }

  private async runDiffResolution(entry: ResolutionEntry): Promise<'done' | 'parked'> {
    // A previous attempt already wrote the bytes; only the idempotent tag update
    // is outstanding, and it is the only half that may be retried.
    if (this.isSaveBlockedByPendingResolution()) {
      await this.commitResolutionTag(entry.editorId, false);
      return 'done';
    }

    if (!this.diffState || !this.currentSession) return 'done';

    // The buffer the editor serialized describes one specific generation. If the
    // agent wrote again in between, writing it would drop that write and pass the
    // conflict check while doing so -- the incident this plan exists for.
    const decidedGeneration = entry.request.generation;
    if (decidedGeneration !== undefined && this.currentSession.generation !== decidedGeneration) {
      throw new DiffResolutionSupersededError(
        this.filePath,
        decidedGeneration,
        this.currentSession.generation,
      );
    }

    if (!entry.parked) this.supersedePresentationForResolution();
    if (!this.canResolveNow()) {
      // A caller-supplied buffer cannot park: it goes stale the moment the
      // generation it was serialized from is superseded, and resuming later would
      // write it over content the user has never seen. Refuse and leave the
      // review open so the newer generation renders.
      if (entry.request.finalContent !== undefined) {
        throw new DiffResolutionSupersededError(
          this.filePath,
          decidedGeneration ?? null,
          this.currentSession.generation,
        );
      }
      entry.parked = true;
      this.parkedResolution = entry;
      diffTrace('DocumentModel.runDiffResolution parked', {
        path: this.filePath,
        decision: entry.decision,
        presented: this.presentedGeneration,
        hasQueued: this.currentSession.pendingContent !== null,
        t: performance.now(),
      });
      return 'parked';
    }

    const session = this.currentSession;
    const accepted = entry.decision === 'accept';
    // Disk holds the agent's latest write, so that -- not lastPersistedContent --
    // is the honest conflict baseline. Rejecting writes the pre-edit content back
    // over it, which is exactly the path that must not clobber blind (#3684).
    const snapshot: DiffResolutionSnapshot = {
      decision: entry.decision,
      tagId: session.tagId,
      finalContent:
        entry.request.finalContent ?? (accepted ? session.appliedContent : session.baselineContent),
      expectedDiskContent: session.appliedContent,
      diskCommitted: false,
      tagCommitted: false,
    };
    this.resolutionSnapshot = snapshot;

    // Bytes first. The tag update used to run ahead of the write, so a refused
    // write left a `reviewed` tag over content the user never accepted and wedged
    // the model mid-resolution (NIM-5359, defect C).
    try {
      await this.backingStore.save(snapshot.finalContent, snapshot.expectedDiskContent);
    } catch (err) {
      // Tag untouched: an edit the user could not commit has not been reviewed.
      // Recovery re-reads disk and republishes it through the same serial queue,
      // which returns the session to a state the user can act on again.
      await this.recoverLatestFromDisk('diff resolution write refused');
      throw err;
    }

    snapshot.diskCommitted = true;
    this.lastPersistedContent = snapshot.finalContent;
    this.lastSeenDiskContent = snapshot.finalContent;

    await this.commitResolutionTag(entry.editorId, true);
    return 'done';
  }

  /**
   * Second half of the transaction. Marking an already-reviewed tag reviewed is a
   * no-op, so this is the only part a half-finished resolution retries. Until it
   * lands the session stays up and every save is blocked -- a cleared session over
   * a still-pending tag is an invisible pending diff on reopen.
   */
  private async commitResolutionTag(editorId: string, wroteThisAttempt: boolean): Promise<void> {
    const snapshot = this.resolutionSnapshot;
    if (!snapshot) return;
    // The tag captured when the decision was claimed, never the live session's:
    // a retry can run after a second agent session replaced it, and marking that
    // tag reviewed ends a review the user never saw.
    if (snapshot.tagId) {
      await this.options.updateTagStatus(this.filePath, snapshot.tagId, 'reviewed');
    }
    snapshot.tagCommitted = true;
    this.completeResolution(editorId, snapshot, wroteThisAttempt);
  }

  /**
   * Both halves confirmed: end the session and tell everyone else.
   *
   * `wroteThisAttempt` is false for a tag-only retry, where the bytes reached
   * disk on an earlier attempt. Time passed in between -- saves were blocked, but
   * typing was not -- so an editor that went dirty since then holds edits nothing
   * else has. Clearing its flag and replaying the old resolved content over it is
   * silent data loss, so those buffers are left alone (NIM-5359, finding 4).
   */
  private completeResolution(
    editorId: string,
    snapshot: DiffResolutionSnapshot,
    wroteThisAttempt: boolean,
  ): void {
    const accepted = snapshot.decision === 'accept';
    const session = this.currentSession;
    if (session?.phase === 'applied') {
      session.beginResolveAll(accepted);
      session.completeResolveAll();
    }

    this.currentSession = null;
    this.diffState = null;
    this.resolutionSnapshot = null;
    this.clearGenerationTracking();
    this.emit('diff-state-changed');

    // Clear dirty flags on all editors -- only when this attempt is the one that
    // put `finalContent` on disk, so their buffers really are what was written.
    if (wroteThisAttempt && this.isDirty()) {
      for (const att of this.attachments.values()) {
        att.isDirty = false;
      }
      this.emit('dirty-changed');
    }

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

    // Notify all editors of the final content. `notifyFileChanged` skips dirty
    // attachments, which is what preserves a buffer that was typed into while a
    // tag-only retry was outstanding.
    this.notifyFileChanged(snapshot.finalContent);
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

      // Same for a resolution that reached disk but not the history tag: no
      // autosave may land on top of the unfinished half.
      if (this.isSaveBlockedByPendingResolution()) return;

      // NOTE: We do NOT skip when in diff mode. The editor callback handles
      // diff-mode checks (e.g. checking $hasDiffNodes to auto-clear resolved diffs).
      // Skipping here would prevent the editor from detecting manually resolved diffs.

      // Skip if not dirty
      if (!this.isDirty()) return;

      // A persistent write failure is retried only a bounded number of times.
      // Once blocked, the dirty buffer remains intact and an explicit/manual
      // save (which clears dirty state on success) rearms autosave.
      if (this.autosaveBlocked || this.autosaveRequestInFlight) return;
      if (Date.now() < this.nextAutosaveAttemptAt) return;

      // Skip if edit was too recent (debounce)
      if (Date.now() - this.lastEditTime < this.options.autosaveDebounce) return;

      // Find the first dirty editor and request a save
      for (const att of this.attachments.values()) {
        if (att.isDirty && att.saveRequestedCallbacks.size > 0) {
          void this.requestAutosave(att);
          // Only request save from one editor at a time
          break;
        }
      }
    }, interval);
  }

  private async requestAutosave(att: EditorAttachment): Promise<void> {
    this.autosaveRequestInFlight = true;
    try {
      for (const cb of att.saveRequestedCallbacks) {
        await cb();
      }
      this.resetAutosaveFailureState();
    } catch (err) {
      this.autosaveConsecutiveFailures += 1;
      if (this.autosaveConsecutiveFailures >= AUTOSAVE_MAX_ATTEMPTS) {
        this.autosaveBlocked = true;
        this.nextAutosaveAttemptAt = 0;
        console.error(
          `[DocumentModel] Autosave blocked after ${AUTOSAVE_MAX_ATTEMPTS} failed attempts; explicit retry required:`,
          err,
        );
      } else {
        const retryDelay = AUTOSAVE_FAILURE_RETRY_DELAYS_MS[this.autosaveConsecutiveFailures - 1];
        this.nextAutosaveAttemptAt = Date.now() + retryDelay;
        console.error(
          `[DocumentModel] Autosave request failed; retrying in ${retryDelay}ms:`,
          err,
        );
      }
    } finally {
      this.autosaveRequestInFlight = false;
    }
  }

  private resetAutosaveFailureState(): void {
    this.autosaveConsecutiveFailures = 0;
    this.nextAutosaveAttemptAt = 0;
    this.autosaveBlocked = false;
  }

  // -- Notifications --------------------------------------------------------

  /**
   * Notify attached editors of a content change.
   * Skips editors that are dirty (have unsaved in-flight edits) to avoid
   * overwriting user work. Also optionally excludes a specific editor.
   */
  private notifyFileChanged(content: string | ArrayBuffer, excludeEditorId?: string): boolean {
    let deliveredToAll = true;
    for (const [attId, att] of this.attachments) {
      if (attId === excludeEditorId) continue;
      // Don't overwrite dirty editors -- they have unsaved user edits.
      if (att.isDirty) {
        deliveredToAll = false;
        continue;
      }
      for (const cb of att.fileChangedCallbacks) {
        try {
          if (cb(content) === false) deliveredToAll = false;
        } catch (err) {
          console.error('[DocumentModel] Error in file changed callback:', err);
          deliveredToAll = false;
        }
      }
    }
    return deliveredToAll;
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

  private emit(type: DocumentModelEventType, diskContent?: string): void {
    const event: DocumentModelEvent = { type, filePath: this.filePath, ...(diskContent !== undefined ? { diskContent } : {}) };
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

    // Signal order is the new store's own count, unrelated to the old one's, so
    // the watermark has to start over or every event from it reads as stale.
    this.lastCommittedExternalSequence = 0;
    this.nextExternalSequence = 0;
    // A retry armed against the old store would re-read the renamed-away path.
    this.clearExternalChangeRetry();
    this.externalChangeRetries = 0;

    // The file now exists at the new path, so clear the deleted guard
    this.deleted = false;
  }

  dispose(): void {
    this.disposed = true;

    if (this.autosaveTimer) {
      clearInterval(this.autosaveTimer);
      this.autosaveTimer = null;
    }

    this.clearGenerationTracking();
    this.clearHydrationRetry();
    this.clearExternalChangeRetry();

    // A decision waiting on a generation that will never arrive now: fail it
    // rather than leaving the caller's promise pending forever.
    const parked = this.parkedResolution;
    this.parkedResolution = null;
    this.inFlightResolution = null;
    parked?.fail(new Error(`DocumentModel disposed before resolving the diff for ${this.filePath}`));

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
