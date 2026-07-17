/**
 * CollabLexicalProvider
 *
 * Adapter that wraps our DocumentSyncProvider to implement the @lexical/yjs
 * Provider interface, plus a per-mount editor-doc bridge that makes remounts
 * onto long-lived Y.Docs actually render. This allows Lexical's
 * CollaborationPlugin to work with our encrypted DocumentSyncProvider instead
 * of y-websocket.
 *
 * The Provider interface expects:
 * - awareness: ProviderAwareness (getLocalState, getStates, setLocalState, on/off update)
 * - connect() / disconnect()
 * - on/off for 'sync', 'status', 'update', 'reload' events
 *
 * ============================================================================
 * READ THIS BEFORE TOUCHING ANYTHING IN THIS FILE. This adapter sits on a
 * constraint of Lexical's collab internals that has produced the same class
 * of bug repeatedly (blank editors, duplicated content, stranded offline
 * editors). The constraint, the failure history, and the invariants are
 * documented here so the next change doesn't re-learn them in production.
 * ============================================================================
 *
 * THE FUNDAMENTAL CONSTRAINT: Lexical only paints what it OBSERVES.
 *
 * Lexical's CollaborationPlugin renders collaborative content exclusively
 * from Y.Doc update events delivered AFTER its binding has attached its
 * `observeDeep` handler (a useEffect, i.e. after first render):
 *
 * - `createBinding()` does NO initial hydration. It wraps the doc's existing
 *   XmlText but leaves the Lexical EditorState empty.
 * - The bootstrap path (`initializeEditor` / `initialEditorState`) only runs
 *   when the doc is EMPTY (`root.isEmpty() && root._xmlText._length === 0`).
 *   It can never paint a non-empty doc, and it must never be forced onto a
 *   non-empty doc (see failure #2).
 * - Therefore: a Y.Doc that is already populated when the binding mounts
 *   renders a BLANK editor forever, unless something turns its state into
 *   post-mount observable events.
 *
 * A "first open" only ever worked by lucky ordering: the doc was empty at
 * bind time and server/store hydration streamed in afterwards as events.
 * Anything that hands Lexical a pre-populated doc -- warm provider caches
 * (DocumentReplicaCache, BodyDocCache), store-hydrated offline replicas,
 * HMR/StrictMode remounts onto a live doc -- hits the blank-editor bug.
 *
 * HOW THIS ADAPTER SOLVES IT: the per-mount editor-doc bridge.
 *
 * `getYDoc()` returns a FRESH, initially-empty `editorDoc` created per
 * adapter instance (one adapter per editor mount), NOT the sync provider's
 * long-lived shared doc. The two docs are bridged bidirectionally with
 * `Y.applyUpdate`, using per-direction origin markers to stop echo loops.
 * At `connect()` -- which CollaborationPlugin calls only AFTER its observers
 * are attached -- the shared doc's full state is applied to the editorDoc,
 * so hydration arrives as observable events and paints. This works uniformly
 * for cold opens, warm cache reopens, store-hydrated opens, and remounts.
 *
 * Why it is safe:
 * - Outbound edits keep flowing: the editor->shared bridge origin is NOT one
 *   of DocumentSync's internal origins (REMOTE/SNAPSHOT/replica-internal),
 *   and DocumentSync's update observer is a blocklist, so bridged edits are
 *   enqueued/sent exactly like direct edits.
 * - Cursors keep working: Yjs relative positions are client/clock-based and
 *   both docs share CRDT history, so positions are valid across the bridge.
 * - Re-hydration is idempotent: applying state a doc already has emits no
 *   events, so StrictMode double-connect and reconnects are no-ops.
 *
 * FAILURE HISTORY (do not reintroduce these):
 *
 * 1. Blank editor on close->reopen / offline open (NIM-1764, 2026-07-15).
 *    getYDoc() used to return the shared doc directly. Warm cache reopen (and
 *    any store-hydrated open) bound Lexical to an already-populated doc ->
 *    no events -> blank. Fixed by the editor-doc bridge above.
 *
 * 2. Bootstrap-over-non-empty-room content duplication / resurrection.
 *    Firing sync(true) before the server's room state was known let
 *    CollaborationPlugin bootstrap local content into a room that actually
 *    had content, CRDT-merging the two (duplicated bodies, resurrected
 *    deleted text). That is what `deferInitialSync` exists for -- hosts where
 *    the server is authoritative (team trackers, shared docs) pass true so
 *    sync(true) waits for the 'connected' status. Do NOT remove the empty-doc
 *    guard reasoning: bootstrap must only ever apply to genuinely empty docs.
 *
 * 3. sync(true) fired into zero listeners on warm providers. A warm, already-
 *    connected provider fires handleStatusChange('connected') before the new
 *    editor's CollaborationPlugin has registered its 'sync' listener; the
 *    event is lost and (with deferInitialSync) the plugin waits forever. The
 *    catch-up lives in `on()`: a 'sync' listener registering while the
 *    provider is already 'connected' is called back immediately. Keep it.
 *
 * 4. disconnect() cascading into the sync provider stranded editors offline.
 *    CollaborationPlugin calls disconnect() from useEffect cleanup during
 *    StrictMode double-mounts and HMR. Forwarding that to
 *    DocumentSyncProvider.disconnect() set suppressReconnect and blocked the
 *    post-remount reconnect. disconnect() must stay a soft unwire; the HOST
 *    owns the sync provider's lifecycle (destroy() on real unmount).
 *
 * 5. Cold-paint workarounds at the host layer. Painting a "blank" editor by
 *    converting cached markdown with editor.update() is only safe when the
 *    room/Y.Doc is genuinely empty (tracker cold-paint fallback guards on the
 *    raw Y.Doc, see useColdPaintFallback / NIM-1589). Without skip-collab it
 *    CRDT-merges duplicate content into a populated room (failure #2); with
 *    skip-collab it desyncs Lexical from the Y.Doc and corrupts later edits.
 *    The bridge makes these workarounds unnecessary for populated docs.
 *
 * INVARIANTS (a change violating any of these is wrong until proven
 * otherwise, with a test):
 *
 * - getYDoc() must return the per-mount editorDoc, never the shared doc.
 * - Initial hydration must happen at connect() time or later -- never in the
 *   constructor or providerFactory, both of which run before Lexical's
 *   observers attach.
 * - The editor->shared bridge origin must never be (or become) an origin
 *   DocumentSync treats as internal, or local edits silently stop syncing.
 * - Hosts MUST call destroy() when discarding the adapter; the shared doc
 *   outlives it inside the replica/body caches and a leaked bridge listener
 *   keeps feeding a dead editorDoc.
 * - disconnect() must not tear down the sync provider or the bridge (it runs
 *   on StrictMode/HMR remounts); destroy() is the real teardown.
 * - One adapter instance per editor mount. Reusing an adapter across mounts
 *   re-binds Lexical to an already-populated editorDoc -- failure #1 again.
 *
 * Regression tests: packages/runtime/src/sync/__tests__/CollabLexicalProvider.test.ts
 * ("per-mount editor doc bridge (NIM-1764)") cover paint-after-connect, both
 * bridge directions, origin/echo behavior, and destroy().
 */

import type { Provider, ProviderAwareness, UserState } from '@lexical/yjs';
import * as Y from 'yjs';
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

  // Per-mount editor doc, bridged to the (potentially long-lived, shared)
  // sync-provider doc. Lexical's CollaborationPlugin can only render content
  // it observes as Y.Doc events AFTER its binding mounts -- a doc that is
  // already populated at binding time renders blank (NIM-1764: warm
  // replica-cache reopen, store-hydrated offline open). Binding Lexical to a
  // fresh doc and replaying the shared state at connect() (the plugin calls
  // connect() after attaching its observers) turns hydration into observable
  // events. Relative cursor positions survive the doc split because Yjs
  // relative positions are client/clock-based and both docs share history.
  private editorDoc: Y.Doc = new Y.Doc();
  private bridgeAttached = false;
  // Distinct origin markers so each bridge direction can ignore its own
  // echoes. The editor->shared origin is intentionally NOT one of
  // DocumentSync's internal origins, so bridged local edits are still
  // enqueued and sent like direct edits.
  private readonly fromSharedOrigin = { bridge: 'shared->editor' };
  private readonly fromEditorOrigin = { bridge: 'editor->shared' };
  private readonly onSharedDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this.fromEditorOrigin) return;
    Y.applyUpdate(this.editorDoc, update, this.fromSharedOrigin);
  };
  private readonly onEditorDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this.fromSharedOrigin) return;
    Y.applyUpdate(this.syncProvider.getYDoc(), update, this.fromEditorOrigin);
  };

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
   * Get the per-mount editor Y.Doc that CollaborationPlugin binds to. This is
   * NOT the sync provider's doc -- it is a bridged replica that starts empty
   * and is hydrated with the shared state at connect(), after Lexical's
   * observers are attached (see the editorDoc field comment / NIM-1764).
   */
  getYDoc(): Doc {
    return this.editorDoc;
  }

  // --------------------------------------------------------------------------
  // Provider interface: connect / disconnect
  // --------------------------------------------------------------------------

  async connect(): Promise<void> {
    // console.log('[CollabLexicalProvider] connect() called, sync listeners:', this.listeners.sync?.size ?? 0);
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

    // Attach the doc bridge and hydrate the editor doc from the shared doc.
    // This runs here -- not in the constructor -- because CollaborationPlugin
    // calls connect() only after its Y.Doc observers are attached, so the
    // replayed state arrives as observable events and actually paints.
    // Reconnects (StrictMode double-mounts, HMR) are safe: applying state a
    // doc already has is a no-op that emits no events.
    if (!this.bridgeAttached) {
      this.bridgeAttached = true;
      this.syncProvider.getYDoc().on('update', this.onSharedDocUpdate);
      this.editorDoc.on('update', this.onEditorDocUpdate);
    }
    const sharedDoc = this.syncProvider.getYDoc();
    Y.applyUpdate(this.editorDoc, Y.encodeStateAsUpdate(sharedDoc), this.fromSharedOrigin);
    // Flush any pre-connect editor-side edits (typed into the still-empty
    // editor before hydration) back to the shared doc as local edits.
    Y.applyUpdate(sharedDoc, Y.encodeStateAsUpdate(this.editorDoc), this.fromEditorOrigin);

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
    // console.log('[CollabLexicalProvider] on() registered listener:', type);
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
    if (type === 'sync') {
      const currentStatus = this.syncProvider.getStatus();
      if (!this.deferInitialSync || currentStatus === 'connected') {
        (cb as (isSynced: boolean) => void)(true);
      }
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
    // console.log('[CollabLexicalProvider] handleStatusChange:', status, '-> lexical:', lexicalStatus,
    //   'sync listeners:', this.listeners.sync?.size ?? 0,
    //   'status listeners:', this.listeners.status?.size ?? 0);
    this.listeners.status?.forEach(cb => cb({ status: lexicalStatus }));

    // When connected (synced), fire the sync event
    if (status === 'connected') {
      // console.log('[CollabLexicalProvider] Firing sync(true)');
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

  /**
   * Tear down the doc bridge and the per-mount editor doc. Hosts must call
   * this when they discard the adapter (editor unmount, doc/key change) --
   * the shared doc outlives this adapter in the replica/body caches, and a
   * leaked bridge listener would keep feeding a dead editor doc.
   */
  destroy(): void {
    if (this.bridgeAttached) {
      this.bridgeAttached = false;
      this.syncProvider.getYDoc().off('update', this.onSharedDocUpdate);
      this.editorDoc.off('update', this.onEditorDocUpdate);
    }
    this.awarenessUnsubscribe?.();
    this.awarenessUnsubscribe = null;
    this.editorDoc.destroy();
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private notifyAwareness(): void {
    this.awarenessListeners.update?.forEach(cb => cb());
  }
}
