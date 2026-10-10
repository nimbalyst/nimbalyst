/**
 * The editor's saves. The bundle is the only place a save starts: the 500ms
 * debounce after typing, and `flush` (native's Save button and its
 * background flush) both emit through here, so every save carries a revision
 * and native answers each one with `ack(revision, ok)`.
 *
 * - `confirmed` is the last body native acknowledged as persisted (initially
 *   the loaded body). Nothing is assumed saved before its ack.
 * - At most one save is in flight; content typed meanwhile waits for the ack.
 * - Dirty means the current body differs from `confirmed`, or a save is in flight.
 * - After an ack, a body that still differs from `confirmed` is saved again,
 *   except right after a failure of that same body: it stays dirty and is
 *   retried on the next edit or flush, never in a loop.
 * - An undo back to `confirmed` with nothing in flight is clean and cancels
 *   the pending save; with a save in flight it waits for the ack.
 *
 * A remote version that arrives while there are unsaved edits is deferred,
 * not loaded over them. A persisted local save still wins over it (last write
 * wins). But if the user's edits come to nothing (back to `confirmed`, or
 * typing the remote text itself) the editor is clean again without a publish,
 * and the deferred remote body becomes `confirmed`: it is loaded if the editor
 * does not already show it.
 *
 * Shared spec with packages/ios/src/editor-mobile/pendingSave.ts (the bundles
 * do not import across packages); keep the two behaviorally identical.
 */
export interface PendingSaveCallbacks {
  /** Called when the dirty state changes. */
  onDirty(dirty: boolean): void;
  /** Persist `body`; native answers with `ack(revision, ok)`. */
  onSave(revision: number, body: string): void;
  /**
   * The edits came to nothing while a remote body was deferred: load `body`
   * (as a load, so it calls `loaded`); the editor is clean afterwards.
   */
  onReload(body: string): void;
}

interface InFlight {
  revision: number;
  body: string;
}

export class PendingSave {
  /** Last body native acknowledged as persisted; null until the first load. */
  confirmed: string | null = null;
  private current: string | null = null;
  /** Latest remote body that arrived while the editor was dirty. */
  private deferred: string | null = null;
  private inFlight: InFlight | null = null;
  private nextRevision = 1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** A flush arrived while a save was in flight: save again as soon as it is acked. */
  private flushWanted = false;
  private lastDirty = false;

  constructor(private readonly callbacks: PendingSaveCallbacks, private readonly delayMs = 500) {}

  get dirty(): boolean {
    return this.confirmed !== null && (this.current !== this.confirmed || this.inFlight !== null);
  }

  /** Content loaded from native: it is what is on disk. Acks for earlier saves are ignored. */
  loaded(body: string): void {
    this.cancelTimer();
    this.confirmed = body;
    this.current = body;
    this.deferred = null;
    this.inFlight = null;
    this.flushWanted = false;
    this.updateDirty();
  }

  /** A remote body arrived while the user has unsaved edits. */
  deferRemote(body: string): void {
    this.deferred = body;
    // Already clean (native's dirty flag lagged): take it now.
    if (this.inFlight === null && this.current === this.confirmed) this.settle(null);
  }

  /** A user update produced `body`. */
  edited(body: string): void {
    if (this.confirmed === null) return;
    this.current = body;
    this.settle(null);
  }

  /** Save now rather than after the debounce (native Save, background flush). */
  flush(): void {
    if (this.confirmed === null) return;
    this.flushWanted = true;
    this.settle(null);
  }

  /** Native's answer for a save. Only the in-flight revision counts. */
  ack(revision: number, ok: boolean): void {
    if (this.inFlight === null || this.inFlight.revision !== revision) return;
    const { body } = this.inFlight;
    this.inFlight = null;
    if (ok) {
      this.confirmed = body;
      // The local edit is persisted; it supersedes the deferred remote body.
      this.deferred = null;
    }
    this.settle(ok ? null : body);
  }

  /** The body to save when the editor is going away and cannot wait for an ack; null when clean. */
  finalBody(): string | null {
    return this.dirty ? this.current : null;
  }

  private settle(failedBody: string | null): void {
    if (this.inFlight !== null) {
      // Newer content waits for the ack.
      this.cancelTimer();
      this.updateDirty();
      return;
    }
    if (this.deferred !== null && (this.current === this.deferred || this.current === this.confirmed)) {
      const remote = this.deferred;
      this.deferred = null;
      this.cancelTimer();
      this.flushWanted = false;
      this.confirmed = remote;
      if (this.current !== remote) {
        this.current = remote;
        this.callbacks.onReload(remote);
      }
      this.updateDirty();
      return;
    }
    if (this.current === this.confirmed) {
      this.cancelTimer();
      this.flushWanted = false;
      this.updateDirty();
      return;
    }
    if (this.flushWanted) {
      this.emit();
      return;
    }
    if (failedBody !== null && this.current === failedBody) {
      // Retried on the next edit or flush, not in a loop.
      this.cancelTimer();
      this.updateDirty();
      return;
    }
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.inFlight === null && this.current !== this.confirmed) this.emit();
    }, this.delayMs);
    this.updateDirty();
  }

  private emit(): void {
    this.cancelTimer();
    this.flushWanted = false;
    const body = this.current as string;
    const revision = this.nextRevision++;
    this.inFlight = { revision, body };
    this.updateDirty();
    this.callbacks.onSave(revision, body);
  }

  private cancelTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private updateDirty(): void {
    const dirty = this.dirty;
    if (dirty === this.lastDirty) return;
    this.lastDirty = dirty;
    this.callbacks.onDirty(dirty);
  }
}
