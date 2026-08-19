/**
 * Collab-enabled EditorHost factory for extension-provided editors.
 *
 * The markdown collab path uses CollabLexicalProvider to bridge between
 * DocumentSyncProvider and Lexical's CollaborationPlugin. Extension editors
 * are bridged differently: they consume the standard `host.collaboration`
 * surface defined by the extension SDK, which exposes the raw Y.Doc and a
 * y-protocols `Awareness` instance.
 *
 * This module builds:
 *   - a y-protocols `Awareness` instance whose remote states are populated
 *     from DocumentSyncProvider's awareness broadcast,
 *   - a `CollaborationContext` that the extension's `useCollaborativeEditor`
 *     hook consumes,
 *   - an `EditorHost` with `collaboration` populated (and the file-I/O
 *     methods stubbed -- persistence is the server's encrypted blob store
 *     for collaborative documents).
 */

import type { Awareness } from 'y-protocols/awareness';
import type { DocumentSyncStatus } from '@nimbalyst/runtime/sync';
import type { DocumentSyncProvider } from '@nimbalyst/runtime/sync';
import type {
  CollaborationContext,
  CollaborationStatus,
  EditorHost,
  ExtensionStorage,
  RevisionSnapshotAdapter,
} from '@nimbalyst/runtime';
import type { CollabDocumentConfig } from '../../utils/collabDocumentOpener';
import { store, editorDirtyAtom, makeEditorKey } from '@nimbalyst/runtime/store';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import {
  setEditorContext as storeSetEditorContext,
  setEditorContextItems as storeSetEditorContextItems,
} from '../../stores/editorContextStore';
import type { EditorContext, EditorContextItem } from '@nimbalyst/runtime';
import {
  createEditorAPIOwnerToken,
  registerEditorAPI,
  unregisterEditorAPI,
} from '@nimbalyst/runtime';

/**
 * The DocumentSync -> y-protocols awareness bridge now lives in the runtime so
 * the browser collaborative host shares one presence dialect with this one. It
 * is re-exported here because every renderer call site imports it from this
 * module, and a `vi.mock` of this path in their tests must keep intercepting it.
 */
export {
  createExtensionAwarenessBridge,
} from '@nimbalyst/runtime/sync';

/**
 * Build a `CollaborationContext` backed by an existing `DocumentSyncProvider`
 * and the awareness bridge above.
 *
 * `loadInitialContent` reads from `activeConfig.initialContent`. For
 * Share-to-Team, this is populated in memory by the share flow (the host
 * reads the file once at share time). When initial content is absent (a
 * recipient opening a doc that was shared by someone else), the empty
 * string is returned and the extension's `isEmpty` check should short-
 * circuit -- the Y.Doc will be populated by the server's sync response.
 */
export function createCollaborationContext(args: {
  syncProvider: DocumentSyncProvider;
  awareness: Awareness;
  activeConfig: CollabDocumentConfig;
  /**
   * Called whenever a custom editor registers (or unregisters) a revision
   * snapshot adapter. The CollaborativeTabEditor uses this to publish a
   * per-tab history controller so the shared-doc History dialog can
   * preview and restore non-markdown documents.
   */
  onRevisionAdapterChange?: (adapter: RevisionSnapshotAdapter | null) => void;
}): CollaborationContext {
  const { syncProvider, awareness, activeConfig, onRevisionAdapterChange } = args;
  let currentAdapter: RevisionSnapshotAdapter | null = null;
  const contentFlushes = new Set<() => void | Promise<void>>();

  const context: CollaborationContext = {
    yDoc: syncProvider.getYDoc(),
    awareness,
    user: {
      id: activeConfig.teamMemberId,
      name: activeConfig.userName ?? activeConfig.teamMemberId,
      color: pickCursorColor(activeConfig.teamMemberId),
    },
    getStatus: () => syncProvider.getStatus() as CollaborationStatus,
    onStatusChange: (cb) => statusFanout(syncProvider).subscribe(cb),
    loadInitialContent: async () => {
      return activeConfig.initialContent ?? '';
    },
    flushWithAck: (timeoutMs?: number) => syncProvider.flushWithAck(timeoutMs),
    hasUndecodedContent: () => syncProvider.hasUndecodedContent(),
    reportSeedOutcome: (outcome) => {
      if (outcome.ok) return;
      const detail = outcome.error instanceof Error ? outcome.error.message : String(outcome.error ?? '');
      errorNotificationService.showWarning(
        'Shared document seed not confirmed',
        'The initial shared content was not confirmed by the server. Re-upload the local source before teammates rely on this document.',
        { details: detail || undefined, duration: 10000 },
      );
    },
    flushLocalState: async () => {
      await syncProvider.flushLocalState();
    },
    registerRevisionAdapter: (adapter: RevisionSnapshotAdapter) => {
      currentAdapter = adapter;
      onRevisionAdapterChange?.(adapter);
      return () => {
        if (currentAdapter === adapter) {
          currentAdapter = null;
          onRevisionAdapterChange?.(null);
        }
      };
    },
    registerContentFlush: (flush: () => void | Promise<void>) => {
      contentFlushes.add(flush);
      return () => {
        contentFlushes.delete(flush);
      };
    },
  };

  contentFlushRegistry.set(context, contentFlushes);
  return context;
}

// ---------------------------------------------------------------------------
// Pending-content flush registry
//
// `registerContentFlush` is part of the public CollaborationContext, but the
// drain is host-internal: only the host decides when a write must be complete.
// Keyed off the context object rather than returned alongside it so the factory
// keeps its single-value contract, the same shape as `statusFanouts` below.
// ---------------------------------------------------------------------------

const contentFlushRegistry = new WeakMap<
  CollaborationContext,
  Set<() => void | Promise<void>>
>();

/**
 * Drain every binding's pending local content into the Y.Doc, then wait for the
 * server to persist it. Resolves `false` if the server did not confirm.
 *
 * A binding that never registers a flush contributes nothing here, so this
 * still closes the provider-to-server half for every collaborative document.
 */
export async function flushCollaborativeContent(
  collaboration: CollaborationContext,
): Promise<boolean> {
  let drained = true;
  for (const flush of contentFlushRegistry.get(collaboration) ?? []) {
    try {
      await flush();
    } catch (error) {
      // Every binding still gets its turn, and the ack still runs -- one
      // binding's failure must not strand the others' pending content. What it
      // must do is fail the result: a binding that could not push its newest
      // edit leaves a document the server ack says nothing about, and reporting
      // that as a completed write is how an edit goes missing in silence.
      console.error('[collabExtensionHost] Pending content flush failed:', error);
      drained = false;
    }
  }
  const acked = await collaboration.flushWithAck();
  return drained && acked;
}

// ---------------------------------------------------------------------------
// Status fan-out
//
// DocumentSyncProvider's status is delivered via a single `onStatusChange`
// callback configured at construction time. The host (CollaborativeTabEditor)
// already uses that callback to write into a Jotai atom and forward to
// CollabLexicalProvider. For extensions we need a second subscriber path
// (the SDK hook subscribes via `onStatusChange`), so we maintain a per-
// provider fan-out registry that the host opts into.
// ---------------------------------------------------------------------------

const statusFanouts = new WeakMap<DocumentSyncProvider, StatusFanout>();

class StatusFanout {
  private listeners = new Set<(status: CollaborationStatus) => void>();
  emit(status: CollaborationStatus): void {
    for (const cb of this.listeners) cb(status);
  }
  subscribe(cb: (status: CollaborationStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

function statusFanout(provider: DocumentSyncProvider): StatusFanout {
  let f = statusFanouts.get(provider);
  if (!f) {
    f = new StatusFanout();
    statusFanouts.set(provider, f);
  }
  return f;
}

/**
 * Host-side helper -- call this from the provider's `onStatusChange`
 * config callback so the SDK-side `onStatusChange` subscribers get
 * notified. Returns the new status as a `CollaborationStatus` for
 * convenience.
 */
export function notifyCollabStatus(
  provider: DocumentSyncProvider,
  status: DocumentSyncStatus
): void {
  statusFanout(provider).emit(status as CollaborationStatus);
}

// ---------------------------------------------------------------------------
// Collab-enabled EditorHost factory
// ---------------------------------------------------------------------------

function pickCursorColor(seed: string): string {
  const colors = [
    '#E05555', '#2BA89A', '#3A8FD6', '#D97706',
    '#9B59B6', '#E06B8F', '#3B82F6', '#16A34A',
  ];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return colors[Math.abs(h) % colors.length];
}

export interface CollabExtensionHostArgs {
  filePath: string;
  fileName: string;
  isActive: boolean;
  workspaceId?: string;
  activeConfig: CollabDocumentConfig;
  collaboration: CollaborationContext;
  onDirtyChange?: (isDirty: boolean) => void;
  /** Called when the user invokes the "History" action on this tab. */
  onOpenHistory?: () => void;
  /** Read the current host theme. Called on demand so the host always
   *  returns the latest value without recreating the host. */
  getTheme?: () => string;
  /** Subscribe to host theme changes. The returned function unsubscribes. */
  subscribeToThemeChanges?: (callback: (theme: string) => void) => () => void;
  /** Inline collaborative embeds are always marked embedded + read-only. */
  embedded?: boolean;
  readOnly?: boolean;
}

/**
 * Build the `EditorHost` passed to the extension's editor component when
 * the document is opened collaboratively. The local-only host methods
 * (`saveContent`, `onSaveRequested`, `onFileChanged`) are no-ops: collab
 * persistence is via the encrypted blob store, not the local file system.
 *
 * `loadContent` returns the seed content too -- if an extension calls it
 * (e.g. via `useEditorLifecycle`) before checking `host.collaboration`, the
 * fallback path will at least show something sensible.
 */
export function createCollabExtensionHost(
  args: CollabExtensionHostArgs
): EditorHost {
  const {
    filePath,
    fileName,
    isActive,
    workspaceId,
    activeConfig,
    collaboration,
    onDirtyChange,
    onOpenHistory,
    getTheme,
    subscribeToThemeChanges,
    embedded = false,
    readOnly = false,
  } = args;

  const editorKey = makeEditorKey(filePath);
  const editorAPIOwnerToken = createEditorAPIOwnerToken(`collab:${filePath}`);

  const storage: ExtensionStorage = {
    get: () => undefined,
    set: async () => {},
    delete: async () => {},
    getGlobal: () => undefined,
    setGlobal: async () => {},
    deleteGlobal: async () => {},
    getSecret: async () => undefined,
    setSecret: async () => {},
    deleteSecret: async () => {},
  };

  return {
    filePath,
    fileName,
    embedded,
    get readOnly() { return readOnly; },
    get theme() { return getTheme ? getTheme() : 'auto'; },
    get isActive() { return isActive; },
    workspaceId,

    onThemeChanged(callback: (theme: string) => void): () => void {
      return subscribeToThemeChanges ? subscribeToThemeChanges(callback) : () => {};
    },
    onReadOnlyChanged(callback: (readOnly: boolean) => void): () => void {
      callback(readOnly);
      return () => {};
    },

    async loadContent(): Promise<string> {
      return activeConfig.initialContent ?? '';
    },
    async loadBinaryContent(): Promise<ArrayBuffer> {
      return new ArrayBuffer(0);
    },

    onFileChanged: () => () => {},

    setDirty(isDirty: boolean): void {
      if (embedded) return;
      store.set(editorDirtyAtom(editorKey), isDirty);
      onDirtyChange?.(isDirty);
    },

    async saveContent(): Promise<void> {
      // Collab docs are persisted via DocumentSyncProvider; no disk save.
    },

    onSaveRequested: () => () => {},

    openHistory(): void {
      onOpenHistory?.();
    },

    storage,

    // Route extension-provided selection context into the shared store, keyed
    // by this document's path, exactly like the non-collab host. Without this a
    // spreadsheet (or other custom editor) opened collaboratively could never
    // surface its "+ selection" cell context to the agent.
    setEditorContext(context: EditorContext | null): void {
      if (embedded) return;
      storeSetEditorContext(filePath, context);
    },
    setEditorContextItems(items: EditorContextItem[] | null): void {
      if (embedded) return;
      storeSetEditorContextItems(filePath, items);
    },
    registerEditorAPI(api: unknown | null): void {
      if (embedded) return;
      if (api) {
        // Not a no-op: `flushEditorSave` runs after every mutating extension AI
        // tool, and for a collaborative document "saved" means the edit reached
        // the Y.Doc and the server acked it. Returning early would let the tool
        // report success while the write sat in the binding's debounce, where a
        // peer update replaces it wholesale.
        registerEditorAPI(
          filePath,
          api,
          () => flushCollaborativeContent(collaboration).then(() => undefined),
          {
            ownerToken: editorAPIOwnerToken,
            priority: 'visible',
          },
        );
      } else {
        unregisterEditorAPI(filePath, editorAPIOwnerToken);
      }
    },
    registerMenuItems(): void {},

    collaboration,
  };
}
