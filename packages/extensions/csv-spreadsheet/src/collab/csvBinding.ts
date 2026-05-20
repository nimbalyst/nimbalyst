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
import { COLLAB_INIT_ORIGIN } from '@nimbalyst/extension-sdk';
import { getYCsv } from './seed';

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
      // up-to-date grid content. Also ignore the SDK's bootstrap
      // transaction (the editor's applyContent already ran on the seed
      // input, before this binding was constructed).
      if (txn.origin === this.localTxnOrigin) return;
      if (txn.origin === COLLAB_INIT_ORIGIN) return;
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
      void this.syncNow();
    }, SYNC_DEBOUNCE_MS);
  }

  /**
   * Immediate sync. Used at unmount time so an unsynced edit doesn't get
   * dropped on close. Also called by `scheduleSync` after the debounce.
   */
  async syncNow(): Promise<void> {
    if (this.destroyed) return;
    let current: string;
    try {
      current = await this.opts.getCurrentCsv();
    } catch (err) {
      console.error('[CsvBinding] getCurrentCsv failed:', err);
      return;
    }
    if (this.destroyed) return;
    if (current === this.lastSyncedContent) return;

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

    this.yDoc.transact(() => {
      if (removeLen > 0) this.yText.delete(prefix, removeLen);
      if (insertText.length > 0) this.yText.insert(prefix, insertText);
    }, this.localTxnOrigin);

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
   * Map of remote userId -> currently-editing cell, for "X is editing B5"
   * overlays. The selected-cell list (without editing) lives at
   * `getRemoteSelections()`.
   */
  getRemoteEditing(): Map<string, { row: number; col: number }> {
    const out = new Map<string, { row: number; col: number }>();
    if (!this.awareness) return out;
    const states = this.awareness.getStates();
    for (const [clientId, state] of states) {
      if (clientId === this.awareness.clientID) continue;
      const userId = (state.user as { id?: string } | undefined)?.id;
      if (!userId) continue;
      const cell = (state as { editingCell?: { row: number; col: number } | null }).editingCell;
      if (cell && typeof cell.row === 'number' && typeof cell.col === 'number') {
        out.set(userId, cell);
      }
    }
    return out;
  }
}
