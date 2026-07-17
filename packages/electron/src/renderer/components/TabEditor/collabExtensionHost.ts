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

import { Awareness } from 'y-protocols/awareness';
import type {
  DocumentSyncStatus,
  AwarenessState as WireAwarenessState,
} from '@nimbalyst/runtime/sync';
import type { DocumentSyncProvider } from '@nimbalyst/runtime/sync';
import type {
  CollaborationContext,
  CollaborationStatus,
  EditorHost,
  ExtensionStorage,
  RevisionSnapshotAdapter,
  StandardAwarenessState,
} from '@nimbalyst/runtime';
import type { CollabDocumentConfig } from '../../utils/collabDocumentOpener';
import { store, editorDirtyAtom, makeEditorKey } from '@nimbalyst/runtime/store';
import { errorNotificationService } from '../../services/ErrorNotificationService';

/** Origin tag for awareness updates we inject from remote broadcasts. */
const REMOTE_AWARENESS_ORIGIN = Symbol('nimbalyst:collab-remote-awareness');

/**
 * Bridges DocumentSyncProvider's awareness (string userId keys + custom JSON)
 * to a y-protocols `Awareness` instance (numeric clientID keys + standard
 * awareness event shape). Returns the Awareness instance plus a cleanup fn.
 *
 * Wire-format choice: the extension awareness path puts the full y-protocols
 * local state on the wire as-is. DocumentSync's `AwarenessState` was widened
 * to `Record<string, unknown> & { user: { name, color, id? } }` precisely so
 * this works without translation.
 */
export function createExtensionAwarenessBridge(args: {
  syncProvider: DocumentSyncProvider;
  /** The Y.Doc owned by the sync provider; Awareness clientID derives from it. */
  yDoc: import('yjs').Doc;
  /** Local user identity to set on the Awareness instance immediately. */
  user: { id: string; name: string; color: string };
}): { awareness: Awareness; destroy: () => void } {
  const { syncProvider, yDoc, user } = args;

  const awareness = new Awareness(yDoc);
  // Seed the local state with the standard user block so other clients can
  // dedupe and render avatars before the extension publishes anything.
  awareness.setLocalState({ user } satisfies StandardAwarenessState);

  // Forward local awareness changes -> DocumentSync wire.
  // We listen to the 'update' event so we catch every state change (including
  // field changes via setLocalStateField). The origin guard prevents the echo
  // when we inject remote state below.
  const localUpdateHandler = (
    _changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ) => {
    if (origin === REMOTE_AWARENESS_ORIGIN) return;
    const state = awareness.getLocalState();
    if (state) {
      syncProvider.setLocalAwareness(state as WireAwarenessState);
    }
  };
  awareness.on('update', localUpdateHandler);

  // Map remote userIds (string) to stable numeric clientIDs in our Awareness.
  // Never reuse our own awareness.clientID for a remote user.
  const userIdToClientId = new Map<string, number>();
  let nextRemoteClientId = awareness.clientID + 1;
  const allocateClientId = (userId: string): number => {
    const existing = userIdToClientId.get(userId);
    if (existing !== undefined) return existing;
    // Skip past our own clientID if we collide.
    while (nextRemoteClientId === awareness.clientID) nextRemoteClientId++;
    const id = nextRemoteClientId++;
    userIdToClientId.set(userId, id);
    return id;
  };

  // Receive remote awareness from DocumentSync -> inject into Awareness.
  const awarenessUnsub = syncProvider.onAwarenessChange((states) => {
    const presentClientIds = new Set<number>();
    const added: number[] = [];
    const updated: number[] = [];

    for (const [userId, state] of states) {
      const clientId = allocateClientId(userId);
      presentClientIds.add(clientId);
      const wasPresent = awareness.states.has(clientId);
      // Ensure remote state carries `user.id` so SDK consumers can use it
      // for deduping; the DocumentSync wrapper provides userId out-of-band.
      const stateWithId: StandardAwarenessState = {
        ...(state as Record<string, unknown>),
        user: {
          ...(state.user as { name: string; color: string }),
          id: (state.user as { id?: string }).id ?? userId,
        },
      };
      awareness.states.set(clientId, stateWithId);
      const prevMeta = awareness.meta.get(clientId);
      awareness.meta.set(clientId, {
        clock: (prevMeta?.clock ?? 0) + 1,
        lastUpdated: Date.now(),
      });
      if (wasPresent) updated.push(clientId);
      else added.push(clientId);
    }

    // Anyone in our remote map but missing from the broadcast has gone away.
    const removed: number[] = [];
    for (const clientId of awareness.states.keys()) {
      if (clientId === awareness.clientID) continue;
      if (presentClientIds.has(clientId)) continue;
      awareness.states.delete(clientId);
      removed.push(clientId);
    }

    if (added.length === 0 && updated.length === 0 && removed.length === 0) {
      return;
    }
    const event = { added, updated, removed };
    awareness.emit('change', [event, REMOTE_AWARENESS_ORIGIN]);
    awareness.emit('update', [event, REMOTE_AWARENESS_ORIGIN]);
  });

  return {
    awareness,
    destroy: () => {
      awarenessUnsub();
      awareness.off('update', localUpdateHandler);
      awareness.destroy();
    },
  };
}

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

  return {
    yDoc: syncProvider.getYDoc(),
    awareness,
    user: {
      id: activeConfig.userId,
      name: activeConfig.userName ?? activeConfig.userId,
      color: pickCursorColor(activeConfig.userId),
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
  };
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
  } = args;

  const editorKey = makeEditorKey(filePath);

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
    get theme() { return getTheme ? getTheme() : 'auto'; },
    get isActive() { return isActive; },
    workspaceId,

    onThemeChanged(callback: (theme: string) => void): () => void {
      return subscribeToThemeChanges ? subscribeToThemeChanges(callback) : () => {};
    },

    async loadContent(): Promise<string> {
      return activeConfig.initialContent ?? '';
    },
    async loadBinaryContent(): Promise<ArrayBuffer> {
      return new ArrayBuffer(0);
    },

    onFileChanged: () => () => {},

    setDirty(isDirty: boolean): void {
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

    setEditorContext(): void {},
    registerEditorAPI(): void {},
    registerMenuItems(): void {},

    collaboration,
  };
}
