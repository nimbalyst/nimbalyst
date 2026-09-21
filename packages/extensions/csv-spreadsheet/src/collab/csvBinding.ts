/** Bridges grid snapshots to Y.Text while retaining their original CRDT baseline. */

import * as Y from 'yjs';
import type * as awarenessProtocol from 'y-protocols/awareness';
import { getYCsv } from './seed';
import { CsvPublication } from './csvPublication';
import { extractRemotePresences, type RemotePresence } from './presence';

const SYNC_DEBOUNCE_MS = 150;

export interface CsvBindingOptions {
  /** Resolves only after the full current grid application is readable. */
  isReady?: () => boolean;
  getGeneration?: () => number;
  waitUntilReady?: () => Promise<void>;
  /** Current CSV serialization from the grid. Called inside the debounce. */
  getCurrentCsv: () => Promise<string> | string;
  /** Called with the full Y.Text content when a remote change is observed. */
  onRemoteContent: (content: string) => void;
  /** Called when remote awareness changes (e.g. for "X is selecting B5" overlays). */
  onRemoteAwareness?: () => void;
}

export interface CsvAwarenessLocal {
  selectedCell?: { row: number; col: number } | null;
  editingCell?: { row: number; col: number } | null;
}

export class CsvBinding {
  private yDoc: Y.Doc;
  private yText: Y.Text;
  private awareness?: awarenessProtocol.Awareness;
  private opts: CsvBindingOptions;

  private subscriptions: Array<() => void> = [];
  private localTxnOrigin = Symbol('csv-local-txn');
  /** Last CSV content pushed by us OR last received from a remote update. */
  private lastSyncedContent: string;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  /** One serialized drain for every immediate, debounced, and host flush request. */
  private syncInFlight: Promise<void> | null = null;
  /** Set by a caller that arrived while the current grid serialization was running. */
  private syncRequested = false;
  private destroyed = false;
  private publication: CsvPublication | null = null;
  private readonly publicationWriterId: number;
  private remotePending = false;
  private mutationDepth = 0;
  private mutationsDone: Promise<void> | null = null;
  private finishMutations: (() => void) | null = null;

  constructor(
    yDoc: Y.Doc,
    initialContent: string,
    opts: CsvBindingOptions,
    awareness?: awarenessProtocol.Awareness,
  ) {
    const writer = new Y.Doc();
    this.publicationWriterId = writer.clientID;
    writer.destroy();
    this.yDoc = yDoc;
    this.yText = getYCsv(yDoc);
    this.opts = opts;
    this.awareness = awareness;
    this.lastSyncedContent = initialContent;

    const onTextChange = (
      _event: Y.YTextEvent,
      txn: Y.Transaction,
    ): void => {
      if (this.destroyed) return;
      // Ignore echoes of our own writes; the editor already has the
      // up-to-date grid content.
      if (txn.origin === this.localTxnOrigin) return;
      const content = this.yText.toString();
      if (content === this.lastSyncedContent) return;
      this.refreshFromShared();
    };
    this.yText.observe(onTextChange);
    this.subscriptions.push(() => this.yText.unobserve(onTextChange));

    if (this.awareness) {
      const onAwareness = () => this.opts.onRemoteAwareness?.();
      this.awareness.on('change', onAwareness);
      this.subscriptions.push(() => this.awareness?.off('change', onAwareness));
    }
  }

  /** Text and metadata share the same repaint barrier. */
  refreshFromShared(): void {
    if (this.destroyed) return;
    // The Y.Doc receives remote updates immediately; only repaint waits so
    // a pending grid read or mutation cannot mix two application generations.
    if (this.publication) {
      this.remotePending = true;
      return;
    }
    this.lastSyncedContent = this.yText.toString();
    this.opts.onRemoteContent(this.lastSyncedContent);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    for (const s of this.subscriptions) {
      try {
        s();
      } catch {
        /* ignore */
      }
    }
    this.subscriptions = [];
    if (!this.syncInFlight) {
      this.publication?.destroy();
      this.publication = null;
    }
  }

  /** Keep remote repaint outside asynchronous multi-cell/row operations. */
  async mutate<T>(operation: () => Promise<T>): Promise<T> {
    if (this.destroyed) throw new Error('CSV binding was destroyed');
    if (this.opts.waitUntilReady && !this.opts.isReady?.()) await this.opts.waitUntilReady();
    this.publication ??= new CsvPublication(this.yDoc, this.publicationWriterId);
    if (this.mutationDepth++ === 0) {
      this.mutationsDone = new Promise(resolve => { this.finishMutations = resolve; });
    }
    let result: T;
    try {
      result = await operation();
    } finally {
      if (--this.mutationDepth === 0) {
        this.finishMutations?.();
        this.mutationsDone = null;
        this.finishMutations = null;
      }
    }
    await this.syncNow();
    return result;
  }

  /**
   * Schedule a local-to-Y.Text sync. Debounced so a burst of rapid edits
   * collapses into a single diff+apply pass.
   */
  scheduleSync(): void {
    if (this.destroyed) return;
    if (this.syncTimer) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      // The debounced push has no caller to report to, so it logs. `syncNow`
      // throws now, and an unhandled rejection here would be a page error.
      void this.syncNow().catch((err) => {
        console.error('[CsvBinding] Debounced sync failed:', err);
      });
    }, SYNC_DEBOUNCE_MS);
  }

  /**
   * Immediate sync. Used at unmount time so an unsynced edit doesn't get
   * dropped on close. Also called by `scheduleSync` after the debounce.
   */
  syncNow(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    this.syncRequested = true;
    if (this.syncInFlight) return this.syncInFlight;

    // RevoGrid serialization is asynchronous. Two cell commits can therefore
    // finish out of order: without one drain, the slower first snapshot diffs
    // against and overwrites the newer second snapshot in Y.Text. Coalesce
    // callers behind the active pass, then serialize the current grid again so
    // every edit that arrived during that pass is represented by the last pass.
    this.syncInFlight = (async () => {
      if (this.opts.waitUntilReady && !this.opts.isReady?.()) await this.opts.waitUntilReady();
      if (this.yDoc.isDestroyed) return;
      this.publication ??= new CsvPublication(this.yDoc, this.publicationWriterId);
      let completed = false;
      try {
        while (this.syncRequested) {
          if (this.mutationsDone) await this.mutationsDone;
          if (this.opts.waitUntilReady && !this.opts.isReady?.()) await this.opts.waitUntilReady();
          this.syncRequested = false;
          await this.syncOnce();
        }
        if (this.remotePending && !this.destroyed && !this.yDoc.isDestroyed) {
          this.lastSyncedContent = this.yText.toString();
          this.opts.onRemoteContent(this.lastSyncedContent);
        }
        this.remotePending = false;
        completed = true;
      } finally {
        // A failed read must retain its old baseline and the still-local grid.
        // Retrying against the newer live doc would turn remote edits into deletes.
        if (completed || this.destroyed || this.yDoc.isDestroyed) {
          this.publication.destroy();
          this.publication = null;
        }
      }
    })().finally(() => {
      this.syncInFlight = null;
    });
    return this.syncInFlight;
  }

  private async syncOnce(): Promise<void> {
    let current: string;
    const generation = this.opts.getGeneration?.();
    try {
      current = await this.opts.getCurrentCsv();
    } catch (err) {
      // A flush exists to prove the newest local edit reached the Y.Doc.
      // Swallowing this reported success on a document whose latest edit was
      // never pushed, which is worse than the failure it was hiding: the host
      // tells the user "an edit was not confirmed saved" off the flush result,
      // and a resolved promise suppresses that warning. If the content cannot
      // be read, the only truthful answer is that the flush did not happen.
      throw new Error(
        `[CsvBinding] Could not read the current CSV to flush: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Once serialization has started, teardown must not cancel the write that
    // exists specifically to preserve edits made after the last polling tick.
    // destroy() still prevents any new sync from starting and removes every
    // observer immediately; this already-started write completes in the
    // background so closing a tab does not wait on a slow grid serialization.
    // The provider owns the Y.Doc, though, and may destroy it while the
    // serialization is pending. In that case there is nowhere left to flush.
    if (this.yDoc.isDestroyed) return;
    if (generation !== this.opts.getGeneration?.() || this.mutationDepth > 0) {
      this.syncRequested = true;
      return;
    }
    const publication = this.publication!;
    if (current === publication.content) return;

    // Hydration is gated by the host. Retain the empty-state backstop for
    // hosts without that contract; a partial non-empty snapshot needs the gate.
    if (current.trim() === '' && publication.content.trim() !== '' && !this.opts.isReady?.()) {
      throw new Error('[CsvBinding] Refusing an empty grid snapshot over a non-empty shared document');
    }
    publication.publish(current, this.yDoc, this.localTxnOrigin);
    this.lastSyncedContent = current;
  }

  /**
   * Called by the editor to acknowledge that it just consumed a remote
   * update via `onRemoteContent`. Without this, the next `scheduleSync`
   * would diff the freshly-applied remote content against itself and
   * emit no ops -- which is fine -- but it would also miss the case
   * where the editor mutates IMMEDIATELY after consuming a remote
   * update. Calling `noteAppliedRemote` keeps the binding's last-synced
   * baseline aligned with what the editor actually has.
   */
  noteAppliedRemote(content: string): void {
    this.lastSyncedContent = content;
  }

  setLocalAwareness(local: CsvAwarenessLocal): void {
    if (!this.awareness) return;
    if (local.selectedCell !== undefined) {
      this.awareness.setLocalStateField('selectedCell', local.selectedCell);
    }
    if (local.editingCell !== undefined) {
      this.awareness.setLocalStateField('editingCell', local.editingCell);
    }
  }

  /**
   * Render-ready list of remote collaborators' presence (selected/editing cell
   * plus name+color), for the in-grid presence overlay. The local client is
   * excluded and malformed states are dropped. See `extractRemotePresences`.
   */
  getRemotePresences(): RemotePresence[] {
    if (!this.awareness) return [];
    return extractRemotePresences(this.awareness.getStates(), this.awareness.clientID);
  }
}
