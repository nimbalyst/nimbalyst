import type { CreateAgentMessageInput, AgentMessage } from '../../ai/server/types';

export interface AgentMessagesStore {
  create(message: CreateAgentMessageInput): Promise<void>;
  /**
   * Batch insert multiple messages in a single transaction. Used by AgentMessageWriteQueue
   * to coalesce streaming-chunk writes and relieve PGLite writer-lock contention.
   * Stores that don't implement this fall back to per-message create() calls in the queue.
   */
  createMany?(messages: CreateAgentMessageInput[]): Promise<void>;
  list(sessionId: string, options?: { limit?: number; offset?: number; includeHidden?: boolean }): Promise<AgentMessage[]>;
  /** Get the newest messages for one session, returned oldest-to-newest */
  listTail?(sessionId: string, limit: number, options?: { includeHidden?: boolean }): Promise<AgentMessage[]>;
  /** Get messages before a raw message id, returned oldest-to-newest */
  listBefore?(sessionId: string, beforeId: number | null | undefined, limit: number, options?: { includeHidden?: boolean }): Promise<AgentMessage[]>;
  /** Get message counts for multiple sessions in a single query */
  getMessageCounts?(sessionIds: string[]): Promise<Map<string, number>>;
  /** True when getMessageCounts is backed by an exact native COUNT query. */
  hasAccurateMessageCounts?: boolean;
}

let storeInstance: AgentMessagesStore | null = null;
const warnedFallbacks = new Set<string>();

function warnFallbackOnce(capability: string, detail: string): void {
  const key = `${capability}:${detail}`;
  if (warnedFallbacks.has(key)) return;
  warnedFallbacks.add(key);
  console.warn(`[AgentMessagesRepository] Store does not implement ${capability}; ${detail}`);
}

function requireStore(): AgentMessagesStore {
  if (!storeInstance) {
    throw new Error('Agent messages store adapter has not been provided to the runtime');
  }
  return storeInstance;
}

export const AgentMessagesRepository = {
  setStore(store: AgentMessagesStore): void {
    storeInstance = store;
  },

  registerStore(store: AgentMessagesStore): void {
    storeInstance = store;
  },

  clearStore(): void {
    storeInstance = null;
  },

  getStore(): AgentMessagesStore {
    return requireStore();
  },

  hasAccurateMessageCounts(): boolean {
    return requireStore().hasAccurateMessageCounts === true;
  },

  async create(message: CreateAgentMessageInput): Promise<void> {
    await requireStore().create(message);
  },

  async createMany(messages: CreateAgentMessageInput[]): Promise<void> {
    if (messages.length === 0) return;
    const store = requireStore();
    if (store.createMany) {
      await store.createMany(messages);
      return;
    }
    // Fallback for stores that don't support batch insert (e.g. test stubs):
    // serialize per-row creates so callers still get a single resolved promise.
    for (const message of messages) {
      await store.create(message);
    }
  },

  async list(sessionId: string, options?: { limit?: number; offset?: number; includeHidden?: boolean }): Promise<AgentMessage[]> {
    return await requireStore().list(sessionId, options);
  },

  async listTail(sessionId: string, limit: number, options?: { includeHidden?: boolean }): Promise<AgentMessage[]> {
    const store = requireStore();
    if (store.listTail) {
      return await store.listTail(sessionId, limit, options);
    }

    warnFallbackOnce('listTail', 'falling back to count-plus-offset pagination');
    const counts = await this.getMessageCounts([sessionId]);
    const total = counts.get(sessionId) ?? 0;
    const boundedLimit = Math.max(1, limit);
    const offset = Math.max(0, total - boundedLimit);
    return await store.list(sessionId, { limit: boundedLimit, offset, includeHidden: options?.includeHidden });
  },

  async listBefore(sessionId: string, beforeId: number | null | undefined, limit: number, options?: { includeHidden?: boolean }): Promise<AgentMessage[]> {
    const store = requireStore();
    const boundedLimit = Math.max(1, limit);
    if (store.listBefore) {
      return await store.listBefore(sessionId, beforeId, boundedLimit, options);
    }
    if (beforeId == null) {
      return await this.listTail(sessionId, boundedLimit, options);
    }

    warnFallbackOnce('listBefore', 'falling back to a capped 50000-row in-memory filter');
    const messages = await store.list(sessionId, { limit: 50000, includeHidden: options?.includeHidden });
    return messages
      .filter((message) => Number(message.id ?? 0) < beforeId)
      .slice(-boundedLimit);
  },

  async getMessageCounts(sessionIds: string[]): Promise<Map<string, number>> {
    const store = requireStore();
    if (store.getMessageCounts) {
      return await store.getMessageCounts(sessionIds);
    }
    // Fallback: query each session individually (N+1, but works for stores without batch support)
    const counts = new Map<string, number>();
    for (const sessionId of sessionIds) {
      const messages = await store.list(sessionId);
      counts.set(sessionId, messages.length);
    }
    return counts;
  },
};
