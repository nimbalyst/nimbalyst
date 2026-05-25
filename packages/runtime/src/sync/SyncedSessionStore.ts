/**
 * SyncedSessionStore - Decorator that adds sync capabilities to any SessionStore.
 *
 * This wraps an existing SessionStore and transparently syncs changes to other
 * devices via the SyncProvider. The underlying store handles all persistence;
 * this layer just adds sync on top.
 *
 * Usage:
 *   const baseStore = createPGLiteSessionStore(...);
 *   const syncProvider = createYjsSessionSync(config);
 *   const syncedStore = createSyncedSessionStore(baseStore, syncProvider);
 *   AISessionsRepository.setStore(syncedStore);
 */

import type {
  SessionStore,
  CreateSessionPayload,
  UpdateSessionMetadataPayload,
  SessionMeta,
  SessionListOptions,
  ChatSession,
} from '../ai/adapters/sessionStore';
import type { AgentMessage } from '../ai/server/types';
import type { SyncProvider, SessionChange, SyncedSessionMetadata } from './types';
import { SYNC_RELEVANT_FIELDS, hasSortRelevantChange } from './syncableMetadata';

export interface SyncedSessionStoreOptions {
  /** Auto-connect to sync when session is accessed */
  autoConnect?: boolean;

  /** Sessions to sync (if undefined, syncs all) */
  syncFilter?: (sessionId: string, workspaceId: string) => boolean;
}

const DEFAULT_OPTIONS: SyncedSessionStoreOptions = {
  autoConnect: true,
};

/**
 * Build the metadata payload for a `metadata_updated` sync event from a
 * raw update / create payload. Only fields listed in SYNC_RELEVANT_FIELDS
 * cross the wire; everything else (local-only caches, provider-internal
 * columns, etc.) stays on the originating device.
 *
 * `forceUpdatedAt` is used by create() -- new sessions always carry a
 * fresh updatedAt so iOS sorts them correctly even before any further
 * activity. updateMetadata() only sets updatedAt when a sort-relevant
 * column actually changed.
 */
function buildSyncPayload(
  payload: Record<string, unknown>,
  options: { forceUpdatedAt?: boolean } = {}
): Record<string, unknown> {
  const syncMetadata: Record<string, unknown> = {};

  for (const field of SYNC_RELEVANT_FIELDS.columns) {
    if (payload[field] !== undefined) {
      syncMetadata[field] = payload[field];
    }
  }

  const metadataBlob = payload.metadata as Record<string, unknown> | undefined;
  if (metadataBlob) {
    for (const key of SYNC_RELEVANT_FIELDS.metadataKeys) {
      if (metadataBlob[key] !== undefined) {
        syncMetadata[key] = metadataBlob[key];
      }
    }
  }

  if (Object.keys(syncMetadata).length === 0) {
    return syncMetadata;
  }

  if (options.forceUpdatedAt || hasSortRelevantChange(payload)) {
    syncMetadata.updatedAt = Date.now();
  }

  return syncMetadata;
}

/**
 * Creates a SessionStore wrapper that adds sync capabilities.
 */
export function createSyncedSessionStore(
  baseStore: SessionStore,
  syncProvider: SyncProvider,
  options: SyncedSessionStoreOptions = {}
): SessionStore {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const connectedSessions = new Set<string>();

  // Track which sessions should be synced
  function shouldSync(sessionId: string, workspaceId?: string): boolean {
    if (opts.syncFilter) {
      return opts.syncFilter(sessionId, workspaceId ?? 'default');
    }
    return true;
  }

  // Connect to sync for a session if not already connected
  async function ensureSyncConnected(sessionId: string): Promise<void> {
    if (!opts.autoConnect) return;
    if (connectedSessions.has(sessionId)) return;
    if (!shouldSync(sessionId)) return;

    try {
      await syncProvider.connect(sessionId);
      connectedSessions.add(sessionId);
    } catch (error) {
      // Sync is optional - log but don't fail
      console.warn(`[SyncedSessionStore] Failed to connect sync for ${sessionId}:`, error);
    }
  }

  // Push a change to sync (fire and forget)
  // metadata_updated changes can flow via the index channel even without a session room connection,
  // so we allow them through regardless of connectedSessions state.
  function pushToSync(sessionId: string, change: SessionChange): void {
    if (!connectedSessions.has(sessionId) && change.type !== 'metadata_updated') return;

    try {
      syncProvider.pushChange(sessionId, change);
    } catch (error) {
      console.warn(`[SyncedSessionStore] Failed to push change for ${sessionId}:`, error);
    }
  }

  return {
    async ensureReady(): Promise<void> {
      return baseStore.ensureReady();
    },

    async create(payload: CreateSessionPayload): Promise<void> {
      // Create in base store first
      await baseStore.create(payload);

      // Then connect sync and push initial metadata. Build the initial payload
      // from SYNC_RELEVANT_FIELDS so a new session arrives on iOS with every
      // sync-relevant column populated -- including sessionType, parentSessionId,
      // and worktreeId, which used to require an explicit follow-up pushChange
      // from callers (and which several callers historically forgot).
      if (shouldSync(payload.id, payload.workspaceId)) {
        await ensureSyncConnected(payload.id);
        const metadata = buildSyncPayload(payload as unknown as Record<string, unknown>, {
          forceUpdatedAt: true,
        });
        // Workspace ID isn't on SYNC_RELEVANT_FIELDS.columns (it's set at create
        // time and never changes), but iOS needs it to route the session into
        // the right project on first sight.
        if (payload.workspaceId !== undefined) {
          metadata.workspaceId = payload.workspaceId;
        }
        pushToSync(payload.id, {
          type: 'metadata_updated',
          metadata: metadata as unknown as SyncedSessionMetadata,
        });
      }
    },

    async updateMetadata(
      sessionId: string,
      metadata: UpdateSessionMetadataPayload
    ): Promise<void> {
      // Update base store
      await baseStore.updateMetadata(sessionId, metadata);

      // Build the sync payload from SYNC_RELEVANT_FIELDS. The store is the
      // single source of truth for what reaches other devices -- callers do
      // not (and should not) need to remember to follow updateMetadata with
      // an explicit pushChange.
      const syncMetadata = buildSyncPayload(metadata as unknown as Record<string, unknown>);

      // Draft input gets a separate freshness timestamp; bumping updatedAt
      // here would cause the row to jump to the top on every keystroke.
      if (metadata.draftInput !== undefined) {
        syncMetadata.draftUpdatedAt = Date.now();
      }

      if (Object.keys(syncMetadata).length === 0) {
        // No sync-relevant fields changed, skip sync update
        return;
      }

      // NOTE: Do NOT call ensureSyncConnected here!
      // Metadata updates should only push to sessions that are ALREADY connected.
      // Creating a WebSocket connection for every metadata update (like draft input changes)
      // causes massive performance issues when many session tabs are open.
      // If the session isn't connected yet, the update will be synced when it is.
      pushToSync(sessionId, {
        type: 'metadata_updated',
        metadata: syncMetadata as unknown as SyncedSessionMetadata,
      });
    },

    async get(sessionId: string): Promise<ChatSession | null> {
      // NOTE: Do NOT connect to sync here - reading doesn't need a connection.
      // Connections are only needed for write operations (create, update).
      // Auto-connecting on every get() causes too many WebSocket connections
      // when loading session lists or resuming sessions.
      return baseStore.get(sessionId);
    },

    async list(
      workspaceId: string,
      options?: SessionListOptions
    ): Promise<SessionMeta[]> {
      // List is read-only, just delegate
      return baseStore.list(workspaceId, options);
    },

    async search(
      workspaceId: string,
      query: string,
      options?: SessionListOptions
    ): Promise<SessionMeta[]> {
      // Search is read-only, just delegate
      return baseStore.search(workspaceId, query, options);
    },

    async delete(sessionId: string): Promise<void> {
      // Push deletion to sync first
      if (connectedSessions.has(sessionId)) {
        pushToSync(sessionId, { type: 'session_deleted' });
        syncProvider.disconnect(sessionId);
        connectedSessions.delete(sessionId);
      }

      // Then delete from base store
      await baseStore.delete(sessionId);
    },

    async updateTitleIfNotNamed(
      sessionId: string,
      title: string
    ): Promise<boolean> {
      if (!baseStore.updateTitleIfNotNamed) {
        // Fallback implementation
        const session = await baseStore.get(sessionId);
        if (session?.hasBeenNamed) return false;
        await baseStore.updateMetadata(sessionId, { title });
        return true;
      }

      const result = await baseStore.updateTitleIfNotNamed(sessionId, title);

      // If title was updated, ensure sync connection and push update
      // This is critical for mobile sync - title changes must reach other devices
      if (result) {
        await ensureSyncConnected(sessionId);
        pushToSync(sessionId, {
          type: 'metadata_updated',
          metadata: { title, updatedAt: Date.now() },
        });
      }

      return result;
    },
  };
}

/**
 * Creates a message sync handler that can be attached to AgentMessagesRepository.
 *
 * This is separate from the session store because messages have their own
 * repository pattern.
 */
export function createMessageSyncHandler(syncProvider: SyncProvider) {
  // Rate-limit the "Failed to connect session" log line. Without this, a
  // single hung CollabV3 connection (e.g. JWT/userId mismatch) produces one
  // error per agent message -- 1686 of 4986 main.log lines during a mobile
  // build on 2026-05-21. One log per minute per session keeps the signal
  // without the flood.
  const LOG_INTERVAL_MS = 60_000;
  const lastConnectErrorLogAt = new Map<string, number>();

  function logConnectFailure(sessionId: string, error: unknown): void {
    const now = Date.now();
    const last = lastConnectErrorLogAt.get(sessionId) ?? 0;
    if (now - last >= LOG_INTERVAL_MS) {
      lastConnectErrorLogAt.set(sessionId, now);
      console.error(
        `[MessageSyncHandler] Failed to connect session ${sessionId}:`,
        error,
      );
    }
  }

  return {
    /**
     * Call this after a message is created to sync it.
     * @param message The message to sync
     * @param sessionUpdatedAt Optional timestamp (ms) for session updated_at - MUST match local DB
     */
    async onMessageCreated(message: AgentMessage, sessionUpdatedAt?: number): Promise<void> {
      // Provider-latched auth mismatch (JWT sub != configured userId) means
      // the server will reject every connection until the user re-auths or
      // settings change. Skip the connect attempt entirely; the latch
      // clears on reconnectIndex() / disconnectAll() so legitimate auth
      // refreshes still get through on the next message.
      if (syncProvider.isAuthMismatched?.()) {
        return;
      }

      // Auto-connect session if not already connected
      if (!syncProvider.isConnected(message.sessionId)) {
        // console.log(`[MessageSyncHandler] Session ${message.sessionId} not connected, auto-connecting...`);
        try {
          await syncProvider.connect(message.sessionId);
          // console.log(`[MessageSyncHandler] Successfully connected session ${message.sessionId}`);
        } catch (error) {
          logConnectFailure(message.sessionId, error);
          return;
        }
      }

      // console.log(`[MessageSyncHandler] Pushing message_added for session ${message.sessionId}`);
      syncProvider.pushChange(message.sessionId, {
        type: 'message_added',
        message,
      });

      // Also update the session index with the same timestamp used in local DB
      // This ensures updated_at matches exactly for sync comparisons
      if (sessionUpdatedAt !== undefined) {
        syncProvider.pushChange(message.sessionId, {
          type: 'metadata_updated',
          metadata: { updatedAt: sessionUpdatedAt },
        });
      }
    },

    /**
     * Subscribe to remote message additions for a session.
     * Returns unsubscribe function.
     */
    onRemoteMessage(
      sessionId: string,
      callback: (message: AgentMessage) => void
    ): () => void {
      return syncProvider.onRemoteChange(sessionId, (change) => {
        if (change.type === 'message_added') {
          callback(change.message);
        }
      });
    },
  };
}
