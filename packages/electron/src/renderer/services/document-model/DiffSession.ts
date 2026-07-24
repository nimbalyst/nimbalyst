/**
 * DiffSession -- the lifecycle state of a single in-progress AI-edit review for one file.
 *
 * Owned by DocumentModel. Each transition is a pure function that returns a new session
 * (or `null` when the session ends), so the state machine can be tested without Electron.
 *
 * Phases:
 *   - 'applying'           -- editor is being reset+replayed against a fresh target
 *   - 'applied'            -- diff is on screen, awaiting user
 *   - 'resolving-partial'  -- user accepted/rejected a single group; tag is being rotated
 *                              and the session is being re-baselined
 *   - 'resolving-all'      -- user accepted or rejected everything; session is about to end
 *
 * The 'idle' state is represented by `currentSession === null` on the owning model;
 * there is no DiffSession instance for that case.
 *
 * Why not just keep using the existing flat DiffState? Because the previous design conflated
 * three distinct things on a single `tagId` field:
 *   - identity of the persistent history tag
 *   - freshness key to detect duplicate IPC events
 *   - lifecycle phase (was the diff applied? being resolved? rotated?)
 *
 * Splitting them out lets us recognize a second AI edit on the same tag (HistoryManager
 * reuses the tagId for back-to-back same-session edits) as a fresh apply, and keeps
 * partial-resolve baseline rotation explicit instead of spread across TabEditor refs.
 */

import { hashContent } from './contentHash';

export type DiffPhase =
  | 'applying'
  | 'applied'
  | 'resolving-partial'
  | 'resolving-all';

export interface DiffSessionSnapshot {
  tagId: string;
  sessionId: string;
  phase: DiffPhase;
  /** Content the diff is computed against. Re-baselined on partial resolves. */
  baselineContent: string;
  /** Content currently shown as the "new" side of the diff. */
  appliedContent: string;
  /** Hash of `appliedContent`. Used as the duplicate-suppression key. */
  appliedContentHash: string;
  /**
   * Most recent payload to apply, queued because we were already in `applying`. Drains
   * automatically when the in-flight apply finishes. Last-write-wins; an earlier queued
   * payload is overwritten by a newer one.
   */
  pendingContent: string | null;
  createdAt: number;
}

export interface CreateDiffSessionInput {
  tagId: string;
  sessionId: string;
  baselineContent: string;
  /** Initial target content; the session enters 'applying' immediately. */
  initialContent: string;
  createdAt?: number;
}

/**
 * Disposition of an incoming external-change payload while a session is active.
 * The owning DocumentModel uses this to decide what to do with the editor.
 */
export type IngestResult =
  | { kind: 'apply'; session: DiffSession }
  | { kind: 'queued'; session: DiffSession }
  | { kind: 'duplicate'; session: DiffSession };

export class DiffSession {
  private _tagId: string;
  private _sessionId: string;
  private _phase: DiffPhase;
  private _baselineContent: string;
  private _appliedContent: string;
  private _appliedContentHash: string;
  private _pendingContent: string | null;
  private _createdAt: number;

  private constructor(snapshot: DiffSessionSnapshot) {
    this._tagId = snapshot.tagId;
    this._sessionId = snapshot.sessionId;
    this._phase = snapshot.phase;
    this._baselineContent = snapshot.baselineContent;
    this._appliedContent = snapshot.appliedContent;
    this._appliedContentHash = snapshot.appliedContentHash;
    this._pendingContent = snapshot.pendingContent;
    this._createdAt = snapshot.createdAt;
  }

  static create(input: CreateDiffSessionInput): DiffSession {
    return new DiffSession({
      tagId: input.tagId,
      sessionId: input.sessionId,
      phase: 'applying',
      baselineContent: input.baselineContent,
      appliedContent: input.initialContent,
      appliedContentHash: hashContent(input.initialContent),
      pendingContent: null,
      createdAt: input.createdAt ?? Date.now(),
    });
  }

  // -- Read accessors -------------------------------------------------------

  get tagId(): string { return this._tagId; }
  get sessionId(): string { return this._sessionId; }
  get phase(): DiffPhase { return this._phase; }
  get baselineContent(): string { return this._baselineContent; }
  get appliedContent(): string { return this._appliedContent; }
  get appliedContentHash(): string { return this._appliedContentHash; }
  get pendingContent(): string | null { return this._pendingContent; }
  get createdAt(): number { return this._createdAt; }

  snapshot(): DiffSessionSnapshot {
    return {
      tagId: this._tagId,
      sessionId: this._sessionId,
      phase: this._phase,
      baselineContent: this._baselineContent,
      appliedContent: this._appliedContent,
      appliedContentHash: this._appliedContentHash,
      pendingContent: this._pendingContent,
      createdAt: this._createdAt,
    };
  }

  // -- Transitions ----------------------------------------------------------

  /**
   * A new external-change payload has arrived for this session's file.
   * Decides whether to apply now, queue, or treat as a duplicate.
   *
   * Same `tagId` is expected -- HistoryManager reuses it across same-session edits.
   * The freshness key is the content hash, not the tag.
   */
  ingest(content: string): IngestResult {
    const incomingHash = hashContent(content);

    // Already applied this exact payload to the editor for this tag.
    if (this._phase === 'applied' && incomingHash === this._appliedContentHash) {
      return { kind: 'duplicate', session: this };
    }

    // In-flight apply with the same payload -- the second IPC event of a doubled signal.
    if (this._phase === 'applying' && incomingHash === this._appliedContentHash) {
      return { kind: 'duplicate', session: this };
    }

    // Currently applying -- queue the latest payload (last-write-wins).
    if (this._phase === 'applying') {
      this._pendingContent = content;
      return { kind: 'queued', session: this };
    }

    // While we were resolving (partial or all), a new edit arrived. Queue and let drain
    // pick it up after the resolve settles. The owning model will trigger the actual
    // editor apply when it transitions back to 'applied' via beginApply.
    if (this._phase === 'resolving-partial' || this._phase === 'resolving-all') {
      this._pendingContent = content;
      return { kind: 'queued', session: this };
    }

    // 'applied' with a fresh hash -- apply now.
    return { kind: 'apply', session: this.beginApply(content) };
  }

  /**
   * Begin applying a new target content. Resets phase to 'applying' and updates
   * appliedContent/hash to the new target. Caller must invoke `markApplied` once the
   * editor finishes its replay (or `markApplyFailed` to roll back to the previous applied
   * payload).
   */
  beginApply(content: string): DiffSession {
    this._phase = 'applying';
    this._appliedContent = content;
    this._appliedContentHash = hashContent(content);
    return this;
  }

  /**
   * Editor finished applying the current target. If a payload was queued during apply,
   * the owning model will call `drainPending` to pick it up.
   */
  markApplied(): DiffSession {
    if (this._phase !== 'applying') {
      throw new Error(`DiffSession.markApplied: invalid phase ${this._phase}`);
    }
    this._phase = 'applied';
    return this;
  }

  /**
   * Drain a queued payload, if any. Returns the payload and transitions back to
   * 'applying'. Returns `null` if nothing was queued.
   *
   * Caller is expected to immediately apply the payload to the editor and then call
   * `markApplied` again.
   */
  drainPending(): string | null {
    if (this._pendingContent === null) return null;
    // Same hash as what's already applied -- nothing to do, drop it.
    if (hashContent(this._pendingContent) === this._appliedContentHash) {
      this._pendingContent = null;
      return null;
    }
    const next = this._pendingContent;
    this._pendingContent = null;
    this.beginApply(next);
    return next;
  }

  /**
   * User accepted or rejected a single change group. The session is being re-baselined:
   * the post-partial content becomes the new baseline, a fresh tag may be rotated in,
   * and the session returns to 'applied' with the un-resolved groups still on screen.
   *
   * Caller controls when to call this -- typically: enter via `beginPartialResolve`,
   * persist + rotate tag, then call `completePartialResolve(newBaseline, newTagId)`.
   */
  beginPartialResolve(): DiffSession {
    if (this._phase !== 'applied') {
      throw new Error(`DiffSession.beginPartialResolve: invalid phase ${this._phase}`);
    }
    this._phase = 'resolving-partial';
    return this;
  }

  completePartialResolve(input: { newBaseline: string; newTagId: string }): DiffSession {
    if (this._phase !== 'resolving-partial') {
      throw new Error(`DiffSession.completePartialResolve: invalid phase ${this._phase}`);
    }
    this._tagId = input.newTagId;
    this._baselineContent = input.newBaseline;
    this._phase = 'applied';
    return this;
  }

  /**
   * User accepted or rejected everything. The session ends after the model persists
   * the final content. Returns the final content the model should write.
   */
  beginResolveAll(accepted: boolean): { session: DiffSession; finalContent: string } {
    if (this._phase !== 'applied') {
      throw new Error(`DiffSession.beginResolveAll: invalid phase ${this._phase}`);
    }
    this._phase = 'resolving-all';
    const finalContent = accepted ? this._appliedContent : this._baselineContent;
    return { session: this, finalContent };
  }

  /** Marks resolveAll done. The owning model should drop the session reference after. */
  completeResolveAll(): void {
    if (this._phase !== 'resolving-all') {
      throw new Error(`DiffSession.completeResolveAll: invalid phase ${this._phase}`);
    }
  }
}
