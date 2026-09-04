/**
 * CSV <-> Y.Doc binding.
 *
 * RevoGrid is the source of truth for the CSV data; useEditorLifecycle's
 * `applyContent` path is the only place that pushes data into the grid.
 * The binding bridges between the grid and a `Y.Text` carrying the
 * canonical CSV string.
 *
 * Local edits -> Y.Text:
 *   The binding exposes `scheduleSync()`. The editor calls it after every
 *   edit (or, more pragmatically, on a low-cost interval). The binding
 *   debounces ~150ms, asks the host for the current CSV via the supplied
 *   `getCurrentCsv` callback, diffs against the last-pushed snapshot, and
 *   applies a minimal `delete(...)/insert(...)` pair on Y.Text. Common-
 *   prefix and common-suffix shortcuts keep single-cell edits to a single
 *   contiguous range.
 *
 * Y.Text -> grid:
 *   A change observer reads the Y.Text content. If the resulting string
 *   differs from our last pushed snapshot, we invoke `onRemoteContent` so
 *   the editor reloads the grid via the existing applyContent flow.
 *
 * Awareness:
 *   The host pre-populates `user`. The editor calls `setLocalAwareness`
 *   with the currently-selected cell ({ row, col }) and the currently-
 *   editing cell so other clients can render presence indicators.
 *
 * Bootstrap-race safety:
 *   Two clients calling `seedCsvYDoc` concurrently produce identical
 *   Y.Text inserts; Y.Text merges character-level inserts deterministically
 *   so the merged shape equals either client's individual shape. No node
 *   identity to worry about (unlike Mindmap/Excalidraw).
 */

import * as Y from 'yjs';
import type * as awarenessProtocol from 'y-protocols/awareness';
import { getYCsv } from './seed';
import { extractRemotePresences, type RemotePresence } from './presence';

const SYNC_DEBOUNCE_MS = 150;

export interface CsvBindingOptions {
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

  constructor(
    yDoc: Y.Doc,
    initialContent: string,
    opts: CsvBindingOptions,
    awareness?: awarenessProtocol.Awareness,
  ) {
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
      this.lastSyncedContent = content;
      this.opts.onRemoteContent(content);
    };
    this.yText.observe(onTextChange);
    this.subscriptions.push(() => this.yText.unobserve(onTextChange));

    if (this.awareness) {
      const onAwareness = () => this.opts.onRemoteAwareness?.();
      this.awareness.on('change', onAwareness);
      this.subscriptions.push(() => this.awareness?.off('change', onAwareness));
    }
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
      while (this.syncRequested) {
        this.syncRequested = false;
        await this.syncOnce();
      }
    })().finally(() => {
      this.syncInFlight = null;
    });
    return this.syncInFlight;
  }

  private async syncOnce(): Promise<void> {
    let current: string;
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
    if (current === this.lastSyncedContent) return;

    // Wipe guard (NIM-1529): an empty serialization against a non-empty
    // baseline is the bootstrap race (grid polled before its data loaded),
    // not a user edit -- a real select-all-delete still serializes rows of
    // delimiters. Pushing it would delete the whole shared document for
    // every client.
    if (current.trim() === '' && this.lastSyncedContent.trim() !== '') {
      console.warn('[CsvBinding] Skipping push of empty grid state over non-empty shared doc (bootstrap race guard).');
      return;
    }

    const prev = this.lastSyncedContent;
    // Common-prefix / common-suffix shortcut: most CSV edits are local
    // (one cell, one column resize, one row insert). Sending the whole
    // string would still merge correctly but bloats the wire and
    // worsens concurrent-edit conflicts.
    let prefix = 0;
    const maxPrefix = Math.min(prev.length, current.length);
    while (prefix < maxPrefix && prev.charCodeAt(prefix) === current.charCodeAt(prefix)) {
      prefix++;
    }
    let suffix = 0;
    const maxSuffix = Math.min(prev.length - prefix, current.length - prefix);
    while (
      suffix < maxSuffix &&
      prev.charCodeAt(prev.length - 1 - suffix) ===
        current.charCodeAt(current.length - 1 - suffix)
    ) {
      suffix++;
    }
    const removeLen = prev.length - prefix - suffix;
    const insertText = current.slice(prefix, current.length - suffix);

    try {
      this.yDoc.transact(() => {
        if (removeLen > 0) this.yText.delete(prefix, removeLen);
        if (insertText.length > 0) this.yText.insert(prefix, insertText);
      }, this.localTxnOrigin);
    } catch (err) {
      // Provider teardown can win the race between the lifecycle check and
      // the transaction. That late flush is no longer actionable; other
      // failures stay visible without escaping as unhandled rejections.
      if (!this.yDoc.isDestroyed) {
        console.error('[CsvBinding] Failed to sync CSV to Y.Text:', err);
      }
      return;
    }

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
