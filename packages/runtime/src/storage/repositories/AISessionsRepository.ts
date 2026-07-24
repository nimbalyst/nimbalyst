import type { SessionData } from '../../ai/server/types';
import {
  type CreateSessionPayload,
  type SessionMeta,
  type SessionListOptions,
  type SessionStore,
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

export const AISessionsRepository = {
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
    await requireStore().create(payload);
  },

  async updateMetadata(sessionId: string, metadata: UpdateSessionMetadataPayload): Promise<void> {
    await requireStore().updateMetadata(sessionId, metadata);
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
    await requireStore().delete(sessionId);
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
