/**
 * CollabLexicalProvider
 *
 * Adapter that wraps our DocumentSyncProvider to implement the @lexical/yjs
 * Provider interface. This allows Lexical's CollaborationPlugin to work with
 * our encrypted DocumentSyncProvider instead of y-websocket.
 *
 * The Provider interface expects:
 * - awareness: ProviderAwareness (getLocalState, getStates, setLocalState, on/off update)
 * - connect() / disconnect()
 * - on/off for 'sync', 'status', 'update', 'reload' events
 */

import type { Provider, ProviderAwareness, UserState } from '@lexical/yjs';
import type { Doc } from 'yjs';
import { DocumentSyncProvider } from './DocumentSync';
import type { DocumentSyncStatus } from './documentSyncTypes';

// Simple event emitter for wiring DocumentSyncProvider callbacks to Lexical's on/off API
type EventMap = {
  sync: (isSynced: boolean) => void;
  status: (arg: { status: string }) => void;
  update: (arg: unknown) => void;
  reload: (doc: Doc) => void;
};

type AwarenessEventMap = {
  update: () => void;
};

/**
 * Wraps DocumentSyncProvider to implement @lexical/yjs Provider interface.
 *
 * Usage:
 * ```ts
 * const provider = new CollabLexicalProvider(documentSyncProvider);
 * <CollaborationPlugin providerFactory={() => provider} ... />
 * ```
 */
export interface CollabLexicalProviderOptions {
  /**
   * When true, `on('sync', cb)` does NOT fire `cb(true)` immediately on
   * listener registration. `sync(true)` will only fire after the underlying
   * DocumentSyncProvider reaches the 'connected' status (i.e., after the
   * server's initial sync response has been applied).
   *
   * Use this for hosts that are authoritative on the server side and must
   * not bootstrap local content into the Y.Doc before the server state is
   * known -- otherwise CRDT merge of the local bootstrap with remote data
   * can resurrect deleted text or duplicate content.
   *
   * Default false: the offline-first behaviour (`sync(true)` fires
   * immediately so CollaborationPlugin bootstraps without waiting on the
   * WebSocket). This is correct for disk-backed markdown tabs where the
   * local file is the source of truth.
   */
  deferInitialSync?: boolean;
}

export class CollabLexicalProvider implements Provider {
  private syncProvider: DocumentSyncProvider;
  private listeners: { [K in keyof EventMap]?: Set<EventMap[K]> } = {};
  private awarenessListeners: { [K in keyof AwarenessEventMap]?: Set<AwarenessEventMap[K]> } = {};
  private localUserState: UserState | null = null;
  private clientStates: Map<number, UserState> = new Map();
  private nextClientId = 1;
  private userIdToClientId: Map<string, number> = new Map();
  private awarenessUnsubscribe: (() => void) | null = null;
  private statusUnsubscribe: (() => void) | null = null;
  private deferInitialSync: boolean;

  awareness: ProviderAwareness;

  constructor(syncProvider: DocumentSyncProvider, options: CollabLexicalProviderOptions = {}) {
    this.syncProvider = syncProvider;
    this.deferInitialSync = options.deferInitialSync ?? false;

    // Build the awareness adapter
    this.awareness = {
      getLocalState: () => this.localUserState,

      getStates: () => this.clientStates,

      on: (_type: 'update', cb: () => void) => {
        if (!this.awarenessListeners.update) {
          this.awarenessListeners.update = new Set();
        }
        this.awarenessListeners.update.add(cb);
      },

      off: (_type: 'update', cb: () => void) => {
        this.awarenessListeners.update?.delete(cb);
      },

      setLocalState: (state: UserState | null) => {
        const previousState = this.localUserState;
        this.localUserState = state;
        const awarenessState = state ?? previousState;

        // Forward to DocumentSyncProvider's awareness
        this.syncProvider.setLocalAwareness({
          cursor: state?.anchorPos && state.focusPos ? {
            anchor: JSON.stringify(state.anchorPos),
            head: JSON.stringify(state.focusPos),
          } : undefined,
          user: {
            name: awarenessState?.name ?? '',
            color: awarenessState?.color ?? '',
          },
        });
      },

      setLocalStateField: (field: string, value: unknown) => {
        if (!this.localUserState) return;
        this.localUserState = { ...this.localUserState, [field]: value };
        // Re-send full state
        this.awareness.setLocalState(this.localUserState);
      },
    };
  }

  /**
   * Get the Y.Doc managed by the underlying DocumentSyncProvider.
   * CollaborationPlugin needs this to bind to.
   */
  getYDoc(): Doc {
    return this.syncProvider.getYDoc();
  }

  // --------------------------------------------------------------------------
  // Provider interface: connect / disconnect
  // --------------------------------------------------------------------------

  async connect(): Promise<void> {
    console.log('[CollabLexicalProvider] connect() called, sync listeners:', this.listeners.sync?.size ?? 0);
    // Subscribe to status changes from DocumentSyncProvider
    this.statusUnsubscribe?.();

    // We use a custom onStatusChange approach since DocumentSyncProvider
    // fires callbacks set in config. Instead, we poll/subscribe via the
    // awareness change listener.
    // The DocumentSyncProvider was already configured with onStatusChange
    // in its config. We need to wire that to our event emitter.
    // This is handled by the creator of this adapter -- they should pass
    // onStatusChange in the DocumentSyncConfig that fires our events.

    // Subscribe to remote awareness changes
    this.awarenessUnsubscribe = this.syncProvider.onAwarenessChange((states) => {
      // Convert DocumentSyncProvider's awareness (Map<userId, AwarenessState>)
      // to Lexical's format (Map<clientId, UserState>)
      this.clientStates.clear();

      for (const [userId, state] of states) {
        let clientId = this.userIdToClientId.get(userId);
        if (clientId === undefined) {
          clientId = this.nextClientId++;
          this.userIdToClientId.set(userId, clientId);
        }

        this.clientStates.set(clientId, {
          anchorPos: state.cursor ? JSON.parse(state.cursor.anchor) : null,
          focusPos: state.cursor ? JSON.parse(state.cursor.head) : null,
          color: state.user.color,
          name: state.user.name,
          focusing: !!state.cursor,
          awarenessData: {},
        });
      }

      // Notify Lexical awareness listeners
      this.notifyAwareness();
    });

    // Connect the underlying provider
    await this.syncProvider.connect();
  }

  disconnect(): void {
    this.awarenessUnsubscribe?.();
    this.awarenessUnsubscribe = null;
    this.statusUnsubscribe?.();
    this.statusUnsubscribe = null;
    // Intentionally do NOT disconnect the underlying DocumentSyncProvider.
    // Lexical's CollaborationPlugin calls this disconnect() from its
    // useEffect cleanup, which fires during React.StrictMode double-mounts
    // and during HMR. Cascading into DocumentSyncProvider.disconnect() sets
    // `suppressReconnect = true` on the sync provider, which blocks the
    // post-remount reconnection and strands the editor offline.
    //
    // The DocumentSyncProvider's lifecycle is owned by the host hook --
    // it calls `destroy()` at the correct time (when the editor unmounts
    // permanently or the item changes). Here we only unwire this adapter.
  }

  // --------------------------------------------------------------------------
  // Provider interface: on / off event emitters
  // --------------------------------------------------------------------------

  on(type: 'sync', cb: (isSynced: boolean) => void): void;
  on(type: 'status', cb: (arg0: { status: string }) => void): void;
  on(type: 'update', cb: (arg0: unknown) => void): void;
  on(type: 'reload', cb: (doc: Doc) => void): void;
  on(type: string, cb: (...args: any[]) => void): void {
    console.log('[CollabLexicalProvider] on() registered listener:', type);
    const key = type as keyof EventMap;
    if (!this.listeners[key]) {
      (this.listeners as any)[key] = new Set();
    }
    (this.listeners[key] as Set<any>).add(cb);

    // The Y.Doc is local-first -- always usable regardless of network.
    // Fire sync(true) immediately when the listener registers so
    // CollaborationPlugin can bootstrap from initialEditorState without
    // waiting for the WebSocket. Server content merges via CRDT later.
    //
    // Hosts that cannot tolerate bootstrap-before-server-sync (e.g. team-
    // synced trackers where the server is authoritative) can pass
    // `deferInitialSync: true` to suppress this firing; sync(true) will
    // only fire via handleStatusChange('connected').
    if (type === 'sync' && !this.deferInitialSync) {
      (cb as (isSynced: boolean) => void)(true);
    }
  }

  off(type: 'sync', cb: (isSynced: boolean) => void): void;
  off(type: 'status', cb: (arg0: { status: string }) => void): void;
  off(type: 'update', cb: (arg0: unknown) => void): void;
  off(type: 'reload', cb: (doc: Doc) => void): void;
  off(type: string, cb: (...args: any[]) => void): void {
    const key = type as keyof EventMap;
    (this.listeners[key] as Set<any>)?.delete(cb);
  }

  // --------------------------------------------------------------------------
  // Event notification helpers (called by DocumentSyncProvider callbacks)
  // --------------------------------------------------------------------------

  /**
   * Called when DocumentSyncProvider's status changes.
   * Wire this to DocumentSyncConfig.onStatusChange.
   */
  handleStatusChange(status: DocumentSyncStatus): void {
    // Keep Lexical "connected" while the local Yjs document remains usable.
    // Transport-level replay/offline states are surfaced in our own UI, but
    // flipping Lexical to disconnected mid-edit causes transient editor errors.
    const lexicalStatus =
      status === 'disconnected' ||
      status === 'connecting' ||
      status === 'syncing' ||
      status === 'error'
        ? 'disconnected'
        : 'connected';
    console.log('[CollabLexicalProvider] handleStatusChange:', status, '-> lexical:', lexicalStatus,
      'sync listeners:', this.listeners.sync?.size ?? 0,
      'status listeners:', this.listeners.status?.size ?? 0);
    this.listeners.status?.forEach(cb => cb({ status: lexicalStatus }));

    // When connected (synced), fire the sync event
    if (status === 'connected') {
      console.log('[CollabLexicalProvider] Firing sync(true)');
      this.listeners.sync?.forEach(cb => cb(true));
    } else if (status === 'disconnected') {
      this.listeners.sync?.forEach(cb => cb(false));
    }
  }

  /**
   * Called when a remote Yjs update is applied.
   * Wire this to DocumentSyncConfig.onRemoteUpdate.
   */
  handleRemoteUpdate(origin: unknown): void {
    this.listeners.update?.forEach(cb => cb(origin));
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private notifyAwareness(): void {
    this.awarenessListeners.update?.forEach(cb => cb());
  }
}
