import { warnIfUnpublished } from './pushOutcome';
import { isSessionConnectionRefused } from './sessionConnectionAdmission';
export { isSessionConnectionRefused };
import { createSessionWriteOutbox, type SessionWriteOutboxOptions } from './sessionWriteOutbox';
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
import type {
  PushChangeOutcome,
  SyncProvider,
  SessionChange,
  SyncedSessionMetadata,
} from './types';
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
// Exported for the regression lock in __tests__/syncPayloadFields.test.ts, which
// pins that the create() / updateMetadata() push payload carries the
// SYNC_RELEVANT_FIELDS columns (incl. the meta-agent grouping fields).
export function buildSyncPayload(
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
  const hierarchyPublications = new Map<string, object>();

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

  // Await publication so asynchronous failures cannot escape the warning path.
  // metadata_updated changes can flow via the index channel even without a session room connection,
  // so we allow them through regardless of connectedSessions state.
  async function pushToSync(sessionId: string, change: SessionChange, isCurrent?: () => boolean): Promise<void> {
    if (!connectedSessions.has(sessionId) && change.type !== 'metadata_updated') return;

    try {
      if (isCurrent && !isCurrent()) return;
      const outcome = isCurrent
        ? await syncProvider.pushChange(sessionId, change, { isCurrent })
        : await syncProvider.pushChange(sessionId, change);
      warnIfUnpublished(message => console.warn(message), sessionId, '[SyncedSessionStore] Failed to publish change', outcome);
    } catch (error) {
      console.warn(`[SyncedSessionStore] Failed to push change for ${sessionId}:`, error);
    }
  }

  return {
    findByProviderSessionId: baseStore.findByProviderSessionId?.bind(baseStore),
    getMany: baseStore.getMany?.bind(baseStore),
    listPendingHierarchyIntents: baseStore.listPendingHierarchyIntents?.bind(baseStore),
    acknowledgeHierarchyIntent: baseStore.acknowledgeHierarchyIntent?.bind(baseStore),
    applyRemoteHierarchySnapshot: baseStore.applyRemoteHierarchySnapshot ? async (rows, isCurrent) => {
      const result = await baseStore.applyRemoteHierarchySnapshot!(rows, isCurrent);
      for (const row of result) if (row.accepted) hierarchyPublications.set(row.sessionId, {});
      return result;
    } : undefined,

    async ensureReady(): Promise<void> {
      return baseStore.ensureReady();
    },

    async create(payload: CreateSessionPayload): Promise<void> {
      // Create in base store first
      await baseStore.create(payload);

      // Push initial metadata immediately, but do not wait for the session-room
      // WebSocket. metadata_updated can travel through the index channel, and
      // first render for a new empty session should only depend on local persistence.
      if (shouldSync(payload.id, payload.workspaceId)) {
        const metadata = buildSyncPayload(payload as unknown as Record<string, unknown>, {
          forceUpdatedAt: true,
        });
        // Workspace ID isn't on SYNC_RELEVANT_FIELDS.columns (it's set at create
        // time and never changes), but iOS needs it to route the session into
        // the right project on first sight.
        if (payload.workspaceId !== undefined) {
          metadata.workspaceId = payload.workspaceId;
        }
        // First render must not wait for index publication; pushToSync catches internally.
        void pushToSync(payload.id, {
          type: 'metadata_updated',
          metadata: metadata as unknown as SyncedSessionMetadata,
        });

        // Keep the original per-session auto-connect behavior in the background
        // so later room-scoped changes such as message_added can reuse it.
        void ensureSyncConnected(payload.id);
      }
    },

    async updateMetadata(
      sessionId: string,
      metadata: UpdateSessionMetadataPayload
    ): Promise<void> {
      const changesHierarchy = metadata.parentSessionId !== undefined || metadata.createdBySessionId !== undefined;
      const generation = changesHierarchy ? {} : undefined;
      if (generation) hierarchyPublications.set(sessionId, generation);
      const isCurrent = generation ? () => hierarchyPublications.get(sessionId) === generation : undefined;
      // Update base store
      await baseStore.updateMetadata(sessionId, metadata);
      // Remote reconciliation owns its guarded canonical publication.
      if (metadata.hierarchySync?.source === 'remote') return;

      // Build the sync payload from SYNC_RELEVANT_FIELDS. The store is the
      // single source of truth for what reaches other devices -- callers do
      // not (and should not) need to remember to follow updateMetadata with
      // an explicit pushChange.
      const syncMetadata = buildSyncPayload(metadata as unknown as Record<string, unknown>);
      if (changesHierarchy) {
        const canonical = await baseStore.get(sessionId);
        if (canonical) {
          syncMetadata.parentSessionId = canonical.parentSessionId ?? null;
          syncMetadata.createdBySessionId = canonical.createdBySessionId ?? null;
        }
      }

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
      // Draft writes must not queue behind index publication; pushToSync catches internally.
      void pushToSync(sessionId, {
        type: 'metadata_updated',
        metadata: syncMetadata as unknown as SyncedSessionMetadata,
      }, isCurrent);
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
        await pushToSync(sessionId, { type: 'session_deleted' });
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
        // Naming must not wait for index publication; pushToSync catches internally.
        void pushToSync(sessionId, {
          type: 'metadata_updated',
          metadata: { title, updatedAt: Date.now() },
        });
      }

      return result;
    },
  };
}

export interface MessageSyncHandlerOptions {
  /**
   * Hold rows a session could not publish live (no room socket, e.g. every
   * slot busy) and send them over a short-lived socket. The desktop enables
   * this; the headless node already retains and retries its own rows.
   */
  outbox?: SessionWriteOutboxOptions;
}

function isRetryableUnpublished(outcome: PushChangeOutcome | void): boolean {
  return !!outcome && !outcome.published && outcome.retryable !== false;
}

/**
 * Creates a message sync handler that can be attached to AgentMessagesRepository.
 *
 * This is separate from the session store because messages have their own
 * repository pattern.
 */
export function createMessageSyncHandler(syncProvider: SyncProvider, options: MessageSyncHandlerOptions = {}) {
  const outbox = options.outbox && syncProvider.sendSessionMessages
    ? createSessionWriteOutbox(syncProvider, options.outbox)
    : null;

  // Rate-limit the "Failed to connect session" log line. Without this, a
  // single hung CollabV3 connection (e.g. JWT/personal-member mismatch) produces one
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
     *
     * Returns what became of the publication rather than throwing, so the
     * fire-and-forget desktop call sites are untouched -- they ignore the value
     * and see exactly today's behaviour, including today's swallowing of a
     * connect failure. A caller that must not lose the row (the headless node,
     * which retains it and retries on the next reconnect) reads the outcome:
     * `{ published: false }` used to be indistinguishable from success, so a
     * node that had never connected reported zero failed rows while sending
     * nothing at all.
     *
     * @param message The message to sync
     * @param sessionUpdatedAt Optional timestamp (ms) for session updated_at - MUST match local DB
     */
    async onMessageCreated(
      message: AgentMessage,
      sessionUpdatedAt?: number,
    ): Promise<PushChangeOutcome> {
      // Provider-latched auth mismatch (JWT sub != configured personalMemberId) means
      // the server will reject every connection until the user re-auths or
      // settings change. Skip the connect attempt entirely; the latch
      // clears on reconnectIndex() / disconnectAll() so legitimate auth
      // refreshes still get through on the next message.
      if (syncProvider.isAuthMismatched?.()) {
        return {
          published: false,
          reason: 'the provider has latched a JWT/personal-member mismatch',
          retryable: true,
        };
      }

      // Later rows queue behind earlier unsent ones so the room keeps transcript order.
      if (outbox?.hasPending(message.sessionId)) {
        return outbox.enqueue(message, sessionUpdatedAt, 'queued behind earlier unsent messages');
      }

      // Auto-connect session if not already connected
      if (!syncProvider.isConnected(message.sessionId)) {
        // console.log(`[MessageSyncHandler] Session ${message.sessionId} not connected, auto-connecting...`);
        try {
          await syncProvider.connect(message.sessionId);
          // console.log(`[MessageSyncHandler] Successfully connected session ${message.sessionId}`);
        } catch (error) {
          if (outbox && isSessionConnectionRefused(error)) {
            return outbox.enqueue(message, sessionUpdatedAt, (error as Error).message);
          }
          logConnectFailure(message.sessionId, error);
          return {
            published: false,
            reason: error instanceof Error ? error.message : String(error),
            retryable: true,
          };
        }
      }

      // console.log(`[MessageSyncHandler] Pushing message_added for session ${message.sessionId}`);
      // Awaited, so the returned promise covers the WHOLE publication --
      // encryption and hand-off to the transport included, not just the decision
      // to publish. A caller that has to know the row is on the wire before it
      // disconnects (the headless node flushes before shutdown) otherwise sees a
      // resolved promise while the send is still pending, and the transcript is
      // stranded on a machine nobody can open. Desktop call sites ignore the
      // return value and are unaffected.
      const outcome = await syncProvider.pushChange(message.sessionId, {
        type: 'message_added',
        message,
      });
      if (outbox && isRetryableUnpublished(outcome)) {
        return outbox.enqueue(message, sessionUpdatedAt, outcome!.reason ?? 'not published');
      }
      warnIfUnpublished(message => console.warn(message), message.sessionId, '[MessageSyncHandler] Failed to publish message', outcome);

      // Also update the session index with the same timestamp used in local DB
      // This ensures updated_at matches exactly for sync comparisons. Skipped
      // while the row is unsent: a timestamp ahead of it hides the gap from the
      // startup reconcile, so the row would never reach the phone (#1391).
      if (sessionUpdatedAt !== undefined && !isRetryableUnpublished(outcome)) {
        const metadataOutcome = await syncProvider.pushChange(message.sessionId, {
          type: 'metadata_updated',
          metadata: { updatedAt: sessionUpdatedAt },
        });
        warnIfUnpublished(message => console.warn(message), message.sessionId, '[MessageSyncHandler] Failed to publish timestamp', metadataOutcome);
      }

      // A provider that reports nothing is assumed to have published: that is
      // what every caller assumed before outcomes existed.
      return outcome ?? { published: true };
    },

    /** Stop the outbox's timers and drop anything still queued. */
    dispose(): void {
      outbox?.dispose();
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
