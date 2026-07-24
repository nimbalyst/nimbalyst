/**
 * Mockup (`.mockup.html`) <-> Y.Doc binding.
 *
 * The editor is iframe-based: the actual HTML content lives in a `contentRef`
 * string and the iframe is re-rendered imperatively whenever the content
 * version bumps. The binding bridges between that ref and a single `Y.Text`
 * carrying the canonical HTML.
 *
 * Same shape and reasoning as `csv-spreadsheet`'s `CsvBinding`:
 *
 * Local edits -> Y.Text:
 *   The editor calls `scheduleSync()` after applying source-mode edits or
 *   any other content mutation. The binding debounces ~150ms, asks the
 *   editor for the current HTML via `getCurrentHtml`, diffs against the
 *   last-pushed snapshot, and applies a minimal `delete(...)/insert(...)`
 *   pair on Y.Text. Common-prefix and common-suffix shortcuts keep most
 *   single-character edits to a single contiguous range, which keeps the
 *   wire payload small.
 *
 * Y.Text -> editor:
 *   A change observer reads Y.Text and, when the content differs from our
 *   last-known snapshot, invokes `onRemoteContent` so the editor swaps
 *   `contentRef` and bumps the content version (which re-renders the iframe).
 *
 * Awareness:
 *   The host pre-populates `user`. The editor calls `setLocalAwareness`
 *   with the currently-selected element (its CSS selector + tag) and the
 *   currently-edited field so other clients can render presence indicators.
 */

import * as Y from 'yjs';
import type * as awarenessProtocol from 'y-protocols/awareness';
import { COLLAB_INIT_ORIGIN } from '@nimbalyst/extension-sdk';
import { getYMockupText } from './seed';

const SYNC_DEBOUNCE_MS = 150;

export interface MockupBindingOptions {
  /** Current HTML from the editor. Called inside the debounce. */
  getCurrentHtml: () => string;
  /** Called with the full Y.Text content when a remote change is observed. */
  onRemoteContent: (content: string) => void;
  /** Optional callback when remote awareness changes (presence indicators). */
  onRemoteAwareness?: () => void;
}

export interface MockupAwarenessLocal {
  /** CSS-selector + tag of the element the user has selected, if any. */
  selection?: {
    selector: string;
    tagName: string;
  } | null;
  /**
   * Free-form id of the field currently being edited. The mockup editor
   * doesn't have a single canonical input target (most editing happens
   * through the AI), so this is provided as an extension point rather than
   * an absolute requirement.
   */
  editingFieldId?: string | null;
}

export class MockupBinding {
  private yDoc: Y.Doc;
  private yText: Y.Text;
  private awareness?: awarenessProtocol.Awareness;
  private opts: MockupBindingOptions;

  private subscriptions: Array<() => void> = [];
  private localTxnOrigin: symbol = Symbol('mockup-local-txn');
  /** Last HTML pushed by us OR last received from a remote update. */
  private lastSyncedContent: string;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(
    yDoc: Y.Doc,
    initialContent: string,
    opts: MockupBindingOptions,
    awareness?: awarenessProtocol.Awareness,
  ) {
    this.yDoc = yDoc;
    this.yText = getYMockupText(yDoc);
    this.opts = opts;
    this.awareness = awareness;
    this.lastSyncedContent = initialContent;

    const onTextChange = (
      _event: Y.YTextEvent,
      txn: Y.Transaction,
    ): void => {
      if (this.destroyed) return;
      // Ignore echoes of our own writes; the editor already has the latest
      // HTML in contentRef. Also ignore the SDK's bootstrap transaction
      // (the editor's applyContent already ran on the seed input before
      // this binding was constructed).
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
   * (typical when AI streams in HTML or source-mode edits arrive) collapses
   * into a single diff+apply pass.
   */
  scheduleSync(): void {
    if (this.destroyed) return;
    if (this.syncTimer) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      this.syncNow();
    }, SYNC_DEBOUNCE_MS);
  }

  /**
   * Immediate sync. Used at unmount time so an unsynced edit doesn't get
   * dropped on close. Also called by `scheduleSync` after the debounce.
   */
  syncNow(): void {
    if (this.destroyed) return;
    const current = this.opts.getCurrentHtml();
    if (current === this.lastSyncedContent) return;

    const prev = this.lastSyncedContent;
    // Common-prefix / common-suffix shortcut: most HTML edits are local
    // (one attribute change, one CSS rule, one element insertion). Sending
    // the whole string would still merge correctly but bloats the wire and
    // worsens concurrent-edit conflict resolution.
    let prefix = 0;
    const maxPrefix = Math.min(prev.length, current.length);
    while (
      prefix < maxPrefix &&
      prev.charCodeAt(prefix) === current.charCodeAt(prefix)
    ) {
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
   * update via `onRemoteContent`. Without this, a fast follow-up edit
   * could race with the next `scheduleSync` and produce a no-op diff.
   */
  noteAppliedRemote(content: string): void {
    this.lastSyncedContent = content;
  }

  setLocalAwareness(local: MockupAwarenessLocal): void {
    if (!this.awareness) return;
    if (local.selection !== undefined) {
      this.awareness.setLocalStateField('selection', local.selection);
    }
    if (local.editingFieldId !== undefined) {
      this.awareness.setLocalStateField('editingFieldId', local.editingFieldId);
    }
  }
}
