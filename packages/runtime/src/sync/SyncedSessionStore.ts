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
  SessionSyncPublicationObligation,
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

const MAX_ACTIVE_CREATE_PUBLICATIONS = 100;
const MAX_CREATE_PUBLICATION_RETRY_DELAY_MS = 30_000;
const MAX_PUBLICATION_BACKOFF_ENTRIES = 100;

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
  const publicationTails = new Map<string, Promise<void>>();
  const pendingCreatePublications = new Map<string, {
    obligationId: string;
    workspaceId: string;
    attempts: number;
    timer?: ReturnType<typeof setTimeout>;
  }>();
  let restartObligationScan: Promise<void> | null = null;
  let restartObligationScanTimer: ReturnType<typeof setTimeout> | undefined;
  let restartObligationScanFailures = 0;
  const publicationBackoffAttempts = new Map<string, number>();
  let disposed = false;
  let disposalPromise: Promise<void> | null = null;
  let activeBaseMutations = 0;
  const baseMutationDrainedWaiters = new Set<() => void>();
  let cancelGeneration!: () => void;
  const generationCancelled = new Promise<void>((resolve) => {
    cancelGeneration = resolve;
  });

  function assertActive(): void {
    if (disposed) throw new Error('SYNCED_SESSION_STORE_DISPOSED');
  }

  async function settleWhileActive<T>(operation: PromiseLike<T> | T): Promise<T> {
    const outcome = await Promise.race([
      Promise.resolve(operation).then(
        (value) => ({ kind: 'value' as const, value }),
        (error) => ({ kind: 'error' as const, error }),
      ),
      generationCancelled.then(() => ({ kind: 'cancelled' as const })),
    ]);
    if (outcome.kind === 'cancelled') {
      throw new Error('SYNCED_SESSION_STORE_DISPOSED');
    }
    if (outcome.kind === 'error') throw outcome.error;
    assertActive();
    return outcome.value;
  }

  async function runBaseMutation<T>(operation: () => Promise<T>): Promise<T> {
    assertActive();
    activeBaseMutations += 1;
    try {
      return await operation();
    } finally {
      activeBaseMutations -= 1;
      if (activeBaseMutations === 0) {
        for (const resolve of baseMutationDrainedWaiters) resolve();
        baseMutationDrainedWaiters.clear();
      }
    }
  }

  function publicationRetryDelay(attempts: number): number {
    return Math.min(
      MAX_CREATE_PUBLICATION_RETRY_DELAY_MS,
      50 * 2 ** Math.min(10, Math.max(1, attempts)),
    );
  }

  function rememberPublicationFailure(sessionId: string, attempts: number): void {
    publicationBackoffAttempts.delete(sessionId);
    while (publicationBackoffAttempts.size >= MAX_PUBLICATION_BACKOFF_ENTRIES) {
      const oldest = publicationBackoffAttempts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      publicationBackoffAttempts.delete(oldest);
    }
    publicationBackoffAttempts.set(sessionId, attempts);
  }

  function yieldDurablePublication(
    sessionId: string,
    pending: { attempts: number },
  ): void {
    const attempts = pending.attempts + 1;
    rememberPublicationFailure(sessionId, attempts);
    pendingCreatePublications.delete(sessionId);
    scheduleRestartObligationScan(publicationRetryDelay(attempts));
  }

  async function withPublicationLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = publicationTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    publicationTails.set(sessionId, tail);
    try {
      // The queue wait is generation-cancellable, so a retired waiter cannot
      // enter the base store. Once admitted, however, `fn` owns the ordering
      // tail until it settles: decisive base-store mutations cannot be
      // cancelled by racing only their returned promise. Provider/read/scan
      // awaits inside `fn` use settleWhileActive explicitly and remain safely
      // abandonable without releasing around a still-live database write.
      await settleWhileActive(previous);
      assertActive();
      return await fn();
    } finally {
      release();
      if (publicationTails.get(sessionId) === tail) publicationTails.delete(sessionId);
    }
  }

  // Track which sessions should be synced
  function shouldSync(sessionId: string, workspaceId?: string): boolean {
    if (opts.syncFilter) {
      return opts.syncFilter(sessionId, workspaceId ?? 'default');
    }
    return true;
  }

  // Connect to sync for a session if not already connected
  async function ensureSyncConnected(sessionId: string): Promise<void> {
    if (disposed) return;
    if (!opts.autoConnect) return;
    if (connectedSessions.has(sessionId)) return;
    if (!shouldSync(sessionId)) return;

    try {
      await settleWhileActive(syncProvider.connect(sessionId));
      if (disposed) return;
      connectedSessions.add(sessionId);
    } catch (error) {
      // Sync is optional - log but don't fail
      console.warn(`[SyncedSessionStore] Failed to connect sync for ${sessionId}:`, error);
    }
  }

  // Await the provider boundary so the repository's per-session writer lock
  // covers encryption, cache overlay, and peer/server publication as well as
  // local persistence. Promise.resolve intentionally observes async providers
  // whose legacy interface is still typed as returning void.
  // metadata_updated changes can flow via the index channel even without a session room connection,
  // so we allow them through regardless of connectedSessions state.
  async function pushToSync(sessionId: string, change: SessionChange): Promise<boolean> {
    if (disposed) return false;
    if (!connectedSessions.has(sessionId) && change.type !== 'metadata_updated') return true;

    try {
      if (change.type === 'metadata_updated' && syncProvider.pushMetadataChangeWithResult) {
        const result = await settleWhileActive(syncProvider.pushMetadataChangeWithResult(
          sessionId,
          change.metadata,
        ));
        if (disposed) return false;
        // `queued` is process-memory only in CollabV3 and is not an index
        // frame. The durable store obligation must remain until a frame write.
        return result.outcome === 'index_frame_written' && result.indexFrameWritten === true;
      }
      await settleWhileActive(Promise.resolve(syncProvider.pushChange(sessionId, change)));
      return !disposed;
    } catch (error) {
      console.warn(`[SyncedSessionStore] Failed to push change for ${sessionId}:`, error);
      return false;
    }
  }

  async function publishAuthoritativeCreate(
    sessionId: string,
    fallbackWorkspaceId: string,
  ): Promise<boolean> {
    if (disposed) return false;
    try {
      const authoritative = await settleWhileActive(baseStore.get(sessionId));
      if (disposed) return false;
      if (!authoritative) return false;
      const authoritativeWorkspaceId = authoritative.workspacePath ?? fallbackWorkspaceId;
      if (!shouldSync(sessionId, authoritativeWorkspaceId)) return true;
      const authoritativePayload = {
        ...authoritative,
        workspaceId: authoritativeWorkspaceId,
      } as unknown as Record<string, unknown>;
      const metadata = buildSyncPayload(authoritativePayload, { forceUpdatedAt: true });
      metadata.workspaceId = authoritativeWorkspaceId;
      return pushToSync(sessionId, {
        type: 'metadata_updated',
        metadata: metadata as unknown as SyncedSessionMetadata,
      });
    } catch (error) {
      console.warn(`[SyncedSessionStore] Authoritative create reload failed for ${sessionId}:`, error);
      return false;
    }
  }

  async function publishAndAcknowledgeCreate(
    sessionId: string,
    pending: { obligationId: string; workspaceId: string },
  ): Promise<boolean> {
    if (!await publishAuthoritativeCreate(sessionId, pending.workspaceId)) return false;
    if (disposed) return false;
    if (!baseStore.clearSyncPublicationObligation) return true;
    try {
      const cleared = await runBaseMutation(() => (
        baseStore.clearSyncPublicationObligation!(sessionId, pending.obligationId)
      ));
      return !disposed && cleared;
    } catch (error) {
      console.warn(`[SyncedSessionStore] Failed to acknowledge create publication ${sessionId}:`, error);
      return false;
    }
  }

  function schedulePendingCreatePublication(sessionId: string): void {
    if (disposed) return;
    const pending = pendingCreatePublications.get(sessionId);
    if (!pending || pending.timer) return;
    const delayMs = Math.min(
      MAX_CREATE_PUBLICATION_RETRY_DELAY_MS,
      pending.attempts === 0 ? 0 : 50 * 2 ** Math.min(10, pending.attempts),
    );
    pending.timer = setTimeout(() => {
      if (disposed) return;
      const current = pendingCreatePublications.get(sessionId);
      if (!current) return;
      current.timer = undefined;
      void withPublicationLock(sessionId, async () => {
        const latest = pendingCreatePublications.get(sessionId);
        if (!latest) return;
        if (await publishAndAcknowledgeCreate(sessionId, latest)) {
          pendingCreatePublications.delete(sessionId);
          publicationBackoffAttempts.delete(sessionId);
          scheduleRestartObligationScan(0);
          return;
        }
        if (disposed) return;
        if (baseStore.listSyncPublicationObligations) {
          // The fact remains durable in the base store. Yield this bounded
          // in-memory slot and advance the durable round-robin cursor so a
          // permanently stuck head page cannot starve later obligations.
          yieldDurablePublication(sessionId, latest);
          return;
        }
        latest.attempts += 1;
        schedulePendingCreatePublication(sessionId);
      }).catch(() => {
        if (disposed) return;
        const latest = pendingCreatePublications.get(sessionId);
        if (!latest) return;
        if (baseStore.listSyncPublicationObligations) {
          yieldDurablePublication(sessionId, latest);
          return;
        }
        latest.attempts += 1;
        schedulePendingCreatePublication(sessionId);
      });
    }, delayMs);
    pending.timer.unref?.();
  }

  function retainCreatePublication(
    sessionId: string,
    workspaceId: string,
    obligationId: string,
  ): void {
    if (disposed) return;
    const existing = pendingCreatePublications.get(sessionId);
    if (existing) {
      existing.workspaceId = workspaceId;
      existing.obligationId = obligationId;
    } else {
      if (pendingCreatePublications.size >= MAX_ACTIVE_CREATE_PUBLICATIONS) return;
      pendingCreatePublications.set(sessionId, {
        obligationId,
        workspaceId,
        attempts: publicationBackoffAttempts.get(sessionId) ?? 0,
      });
    }
    schedulePendingCreatePublication(sessionId);
  }

  async function reconcilePendingCreatePublication(sessionId: string): Promise<void> {
    if (disposed) return;
    const pending = pendingCreatePublications.get(sessionId);
    if (!pending) return;
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
    if (await publishAndAcknowledgeCreate(sessionId, pending)) {
      pendingCreatePublications.delete(sessionId);
      publicationBackoffAttempts.delete(sessionId);
      scheduleRestartObligationScan(0);
      return;
    }
    if (disposed) return;
    if (baseStore.listSyncPublicationObligations) {
      yieldDurablePublication(sessionId, pending);
      return;
    }
    pending.attempts += 1;
    schedulePendingCreatePublication(sessionId);
  }

  function scheduleRestartObligationScan(delayMs: number): void {
    if (disposed || !baseStore.listSyncPublicationObligations || restartObligationScanTimer) return;
    restartObligationScanTimer = setTimeout(() => {
      restartObligationScanTimer = undefined;
      if (disposed) return;
      void loadRestartPublicationObligations();
    }, delayMs);
    restartObligationScanTimer.unref?.();
  }

  async function loadRestartPublicationObligations(): Promise<void> {
    if (disposed || !baseStore.listSyncPublicationObligations) return;
    if (restartObligationScan) return restartObligationScan;
    if (pendingCreatePublications.size >= MAX_ACTIVE_CREATE_PUBLICATIONS) return;
    restartObligationScan = (async () => {
      try {
        const obligations = await settleWhileActive(baseStore.listSyncPublicationObligations!(
          MAX_ACTIVE_CREATE_PUBLICATIONS,
        ));
        if (disposed) return;
        restartObligationScanFailures = 0;
        for (const obligation of obligations) {
          retainCreatePublication(
            obligation.sessionId,
            obligation.workspaceId,
            obligation.obligationId,
          );
          if (pendingCreatePublications.size >= MAX_ACTIVE_CREATE_PUBLICATIONS) break;
        }
      } catch (error) {
        // Keep resource use bounded, but rescan the durable store forever with
        // capped backoff. Recovery therefore does not require another mutation
        // or process restart.
        restartObligationScanFailures += 1;
        const delay = Math.min(
          MAX_CREATE_PUBLICATION_RETRY_DELAY_MS,
          100 * 2 ** Math.min(9, restartObligationScanFailures),
        );
        scheduleRestartObligationScan(delay);
        console.warn('[SyncedSessionStore] Failed to load create publication obligations:', error);
      }
    })().finally(() => {
      restartObligationScan = null;
    });
    return restartObligationScan;
  }

  return {
    async dispose(): Promise<void> {
      if (disposalPromise) return disposalPromise;
      disposed = true;
      cancelGeneration();
      if (restartObligationScanTimer) {
        clearTimeout(restartObligationScanTimer);
        restartObligationScanTimer = undefined;
      }
      for (const pending of pendingCreatePublications.values()) {
        if (pending.timer) clearTimeout(pending.timer);
      }
      pendingCreatePublications.clear();
      publicationBackoffAttempts.clear();
      publicationTails.clear();
      connectedSessions.clear();
      // In-flight scans/provider calls retain the durable base-store fact and
      // are abandoned. An already-entered decisive base mutation is different:
      // disposal drains it before replacement, so no ordering tail is released
      // around a statement that can still commit.
      disposalPromise = activeBaseMutations === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => baseMutationDrainedWaiters.add(resolve));
      return disposalPromise;
    },

    async ensureReady(): Promise<void> {
      assertActive();
      await baseStore.ensureReady();
      assertActive();
      await loadRestartPublicationObligations();
    },

    async create(payload: CreateSessionPayload): Promise<void> {
      assertActive();
      await withPublicationLock(payload.id, async () => {
        const obligation: SessionSyncPublicationObligation = {
          obligationId: `syncpub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`,
          sessionId: payload.id,
          workspaceId: payload.workspaceId,
          createdAt: Date.now(),
        };
        if (baseStore.createWithSyncPublicationObligation) {
          await runBaseMutation(() => (
            baseStore.createWithSyncPublicationObligation!(payload, obligation)
          ));
        } else {
          await runBaseMutation(() => baseStore.create(payload));
        }
        if (!await publishAndAcknowledgeCreate(payload.id, obligation)) {
          // The local write is already durable. Retain a bounded retry fact and
          // return success; every retry reloads the latest row, so it can never
          // replay a captured pre-mutation snapshot after a newer write.
          if (!disposed) {
            retainCreatePublication(payload.id, payload.workspaceId, obligation.obligationId);
          }
        }
        if (!disposed) void ensureSyncConnected(payload.id);
      });
    },

    async updateMetadata(
      sessionId: string,
      metadata: UpdateSessionMetadataPayload
    ): Promise<void> {
      assertActive();
      await withPublicationLock(sessionId, async () => {
        await reconcilePendingCreatePublication(sessionId);
        assertActive();
        // Update base store
        await runBaseMutation(() => baseStore.updateMetadata(sessionId, metadata));

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
          return;
        }

      // NOTE: Do NOT call ensureSyncConnected here!
      // Metadata updates should only push to sessions that are ALREADY connected.
      // Creating a WebSocket connection for every metadata update (like draft input changes)
      // causes massive performance issues when many session tabs are open.
      // If the session isn't connected yet, the update will be synced when it is.
        await pushToSync(sessionId, {
          type: 'metadata_updated',
          metadata: syncMetadata as unknown as SyncedSessionMetadata,
        });
      });
    },

    async applyVisibilityMutation(sessionId, mutation): Promise<boolean> {
      assertActive();
      return withPublicationLock(sessionId, async () => {
        await reconcilePendingCreatePublication(sessionId);
        assertActive();
        if (!baseStore.applyVisibilityMutation) {
          throw new Error('SESSION_VISIBILITY_STORE_UNAVAILABLE');
        }
        const applied = await runBaseMutation(() => (
          baseStore.applyVisibilityMutation!(sessionId, mutation)
        ));
        if (!applied) return false;
        const publicUpdate: UpdateSessionMetadataPayload = {};
        if (mutation.after.isPinned !== undefined) {
          (publicUpdate as UpdateSessionMetadataPayload & { isPinned: boolean }).isPinned = mutation.after.isPinned;
        }
        if (mutation.after.parentSessionId !== undefined) {
          publicUpdate.parentSessionId = mutation.after.parentSessionId;
        }
        if (mutation.after.title !== undefined) publicUpdate.title = mutation.after.title;
        if (mutation.after.hasBeenNamed !== undefined) {
          (publicUpdate as UpdateSessionMetadataPayload & { hasBeenNamed: boolean }).hasBeenNamed = mutation.after.hasBeenNamed;
        }
        const syncMetadata = buildSyncPayload(publicUpdate as unknown as Record<string, unknown>);
        if (Object.keys(syncMetadata).length > 0) {
          await pushToSync(sessionId, {
            type: 'metadata_updated',
            metadata: syncMetadata as unknown as SyncedSessionMetadata,
          });
        }
        return true;
      });
    },

    async hasVisibilityMutation(sessionId, mutationId, mutationIdentity): Promise<boolean> {
      if (!baseStore.hasVisibilityMutation) {
        throw new Error('SESSION_VISIBILITY_STORE_UNAVAILABLE');
      }
      return mutationIdentity === undefined
        ? baseStore.hasVisibilityMutation(sessionId, mutationId)
        : baseStore.hasVisibilityMutation(sessionId, mutationId, mutationIdentity);
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
      assertActive();
      await withPublicationLock(sessionId, async () => {
        const pending = pendingCreatePublications.get(sessionId);
        if (pending?.timer) clearTimeout(pending.timer);
        pendingCreatePublications.delete(sessionId);
        if (connectedSessions.has(sessionId)) {
          await pushToSync(sessionId, { type: 'session_deleted' });
          assertActive();
          syncProvider.disconnect(sessionId);
          connectedSessions.delete(sessionId);
        }
        await runBaseMutation(() => baseStore.delete(sessionId));
      });
    },

    async updateTitleIfNotNamed(
      sessionId: string,
      title: string
    ): Promise<boolean> {
      assertActive();
      return withPublicationLock(sessionId, async () => {
        await reconcilePendingCreatePublication(sessionId);
        assertActive();
        if (!baseStore.updateTitleIfNotNamed) {
          const session = await settleWhileActive(baseStore.get(sessionId));
          assertActive();
          if (session?.hasBeenNamed) return false;
          await runBaseMutation(() => baseStore.updateMetadata(sessionId, { title }));
          return true;
        }

        const result = await runBaseMutation(() => (
          baseStore.updateTitleIfNotNamed!(sessionId, title)
        ));
        if (result) {
          await ensureSyncConnected(sessionId);
          await pushToSync(sessionId, {
            type: 'metadata_updated',
            metadata: { title, updatedAt: Date.now() },
          });
        }
        return result;
      });
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
