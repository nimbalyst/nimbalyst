import type { SessionData } from '../../ai/server/types';
import {
  type CreateSessionPayload,
  type SessionMeta,
  type SessionListOptions,
  type SessionStore,
  type SessionVisibilityStoreMutation,
  type UpdateSessionMetadataPayload,
  getSessionStore,
  hasSessionStore,
  setSessionStore,
} from '../../ai/adapters/sessionStore';

function requireStore(): SessionStore {
  if (!hasSessionStore()) {
    throw new Error('Session store adapter has not been provided to the runtime');
  }
  return getSessionStore();
}

const sessionWriteTails = new Map<string, Promise<void>>();
const VISIBILITY_STORAGE_FENCE = Symbol.for('nimbalyst.visibility-storage-fence');
export interface VisibilityStorageFenceBinding {
  /** Stable physical-root identity; never included in public session metadata. */
  rootIdentity: string;
  /** Opaque owner nonce installed in the database by the Electron host. */
  ownerId: string;
}
let visibilityStorageFence: VisibilityStorageFenceBinding | null = null;

async function withSessionWriteLocks<T>(sessionIds: string[], fn: () => Promise<T>): Promise<T> {
  const ids = [...new Set(sessionIds)].sort();
  const releases: Array<() => void> = [];
  const ownedTails: Array<{ id: string; tail: Promise<void> }> = [];
  for (const id of ids) {
    const previous = sessionWriteTails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    sessionWriteTails.set(id, tail);
    await previous;
    releases.push(release);
    ownedTails.push({ id, tail });
  }
  try {
    return await fn();
  } finally {
    for (let index = releases.length - 1; index >= 0; index -= 1) releases[index]();
    for (const { id, tail } of ownedTails) {
      if (sessionWriteTails.get(id) === tail) sessionWriteTails.delete(id);
    }
  }
}

async function applyVisibilityMutation(
  sessionId: string,
  mutation: SessionVisibilityStoreMutation,
): Promise<void> {
  await withSessionWriteLocks(
    [sessionId, ...(mutation.destinationSessionId ? [mutation.destinationSessionId] : [])],
    async () => {
      const store = requireStore();
      if (!store.applyVisibilityMutation) throw new Error('SESSION_VISIBILITY_STORE_UNAVAILABLE');
      const fencedMutation = { ...mutation };
      Object.defineProperty(fencedMutation, VISIBILITY_STORAGE_FENCE, {
        enumerable: false,
        value: visibilityStorageFence ?? undefined,
      });
      const applied = await store.applyVisibilityMutation(sessionId, fencedMutation);
      if (!applied) throw new Error('SESSION_VISIBILITY_CAS_CONFLICT');
    },
  );
}

export const AISessionsRepository = {
  /** Host-only commit predicate; never becomes caller metadata or sync payload. */
  configureVisibilityStorageFence(binding: VisibilityStorageFenceBinding | null): void {
    visibilityStorageFence = binding;
  },

  setStore(store: SessionStore): void {
    setSessionStore(store);
  },

  registerStore(store: SessionStore): void {
    setSessionStore(store);
  },

  clearStore(): void {
    setSessionStore(null);
  },

  getStore(): SessionStore {
    return requireStore();
  },

  async ensureReady(): Promise<void> {
    await requireStore().ensureReady();
  },

  async create(payload: CreateSessionPayload): Promise<void> {
    await withSessionWriteLocks([payload.id], () => requireStore().create(payload));
  },

  async updateMetadata(sessionId: string, metadata: UpdateSessionMetadataPayload): Promise<void> {
    await withSessionWriteLocks([sessionId], () =>
      requireStore().updateMetadata(sessionId, metadata));
  },

  /**
   * Dedicated visibility-control primitive. Keeping the payload construction in
   * the repository prevents callers from widening pin writes into generic
   * metadata mutations.
   */
  async setPinnedVisibility(
    sessionId: string,
    isPinned: boolean,
    mutationId: string,
    expectedPinned: boolean,
    workspacePath: string,
    workspaceComparisonPath: string,
  ): Promise<void> {
    await applyVisibilityMutation(sessionId, {
      mutationId,
      workspacePath,
      workspaceComparisonPath,
      operation: 'session_set_pinned',
      expected: { isPinned: expectedPinned },
      after: { isPinned },
    });
  },

  /** Dedicated one-field workstream membership primitive. */
  async setWorkstreamMembership(
    sessionId: string,
    parentSessionId: string | null,
    mutationId: string,
    expectedParentSessionId: string | null,
    workspacePath: string,
    workspaceComparisonPath: string,
  ): Promise<void> {
    await applyVisibilityMutation(sessionId, {
      mutationId,
      workspacePath,
      workspaceComparisonPath,
      operation: 'session_set_workstream',
      expected: { parentSessionId: expectedParentSessionId },
      after: { parentSessionId },
    });
  },

  /** Validate the destination and conditionally reparent in one store statement. */
  async setWorkstreamMembershipIfDestinationValid(
    sessionId: string,
    parentSessionId: string,
    mutationId: string,
    expectedParentSessionId: string | null,
    workspacePath: string,
    workspaceComparisonPath: string,
  ): Promise<void> {
    await applyVisibilityMutation(sessionId, {
      mutationId,
      workspacePath,
      workspaceComparisonPath,
      operation: 'session_set_workstream',
      expected: { parentSessionId: expectedParentSessionId },
      after: { parentSessionId },
      destinationSessionId: parentSessionId,
    });
  },

  /**
   * Rename precisely the addressed session row. This deliberately bypasses
   * display-name propagation in SessionNamingService.
   */
  async renameExactSession(
    sessionId: string,
    title: string,
    mutationId: string,
    expected: { title: string; hasBeenNamed: boolean },
    workspacePath: string,
    workspaceComparisonPath: string,
  ): Promise<void> {
    await applyVisibilityMutation(sessionId, {
      mutationId,
      workspacePath,
      workspaceComparisonPath,
      operation: 'session_rename',
      expected,
      after: { title, hasBeenNamed: true },
    });
  },

  async hasVisibilityMutation(
    sessionId: string,
    mutationId: string,
    mutationIdentity?: string,
  ): Promise<boolean> {
    const store = requireStore();
    if (!store.hasVisibilityMutation) throw new Error('SESSION_VISIBILITY_STORE_UNAVAILABLE');
    return mutationIdentity === undefined
      ? store.hasVisibilityMutation(sessionId, mutationId)
      : store.hasVisibilityMutation(sessionId, mutationId, mutationIdentity);
  },

  async get(sessionId: string): Promise<SessionData | null> {
    return await requireStore().get(sessionId);
  },

  async getMany(sessionIds: string[]): Promise<SessionData[]> {
    const store = requireStore();
    if (store.getMany) {
      return await store.getMany(sessionIds);
    }
    // Fallback for stores that don't implement batch query (less efficient)
    const results = await Promise.all(
      sessionIds.map(id => store.get(id))
    );
    return results.filter((s): s is SessionData => s !== null);
  },

  async list(workspaceId: string, options?: SessionListOptions): Promise<SessionMeta[]> {
    return await requireStore().list(workspaceId, options);
  },

  async search(workspaceId: string, query: string, options?: SessionListOptions): Promise<SessionMeta[]> {
    return await requireStore().search(workspaceId, query, options);
  },

  async delete(sessionId: string): Promise<void> {
    await withSessionWriteLocks([sessionId], () => requireStore().delete(sessionId));
  },

  async updateTitleIfNotNamed(sessionId: string, title: string): Promise<boolean> {
    const store = requireStore();
    if (store.updateTitleIfNotNamed) {
      return await store.updateTitleIfNotNamed(sessionId, title);
    }
    // Fallback for stores that don't implement atomic update
    const session = await store.get(sessionId);
    if (session?.hasBeenNamed) {
      return false;
    }
    await store.updateMetadata(sessionId, { title, hasBeenNamed: true } as any);
    return true;
  },

  async getBranches(sessionId: string): Promise<SessionMeta[]> {
    const store = requireStore();
    if (store.getBranches) {
      return await store.getBranches(sessionId);
    }
    // Fallback: return empty array if store doesn't support branching
    return [];
  },
};

export type {
  CreateSessionPayload,
  SessionMeta,
  UpdateSessionMetadataPayload,
};
