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
  /** Get message counts for multiple sessions in a single query */
  getMessageCounts?(sessionIds: string[]): Promise<Map<string, number>>;
  /** Return the most recent raw message for a session, or null if none. */
  getLastMessage?(sessionId: string): Promise<AgentMessage | null>;
  /** Update the content of a single raw message by id. The raw log is otherwise append-only. */
  updateMessageContent?(messageId: number, content: string): Promise<void>;
}

let storeInstance: AgentMessagesStore | null = null;

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

  async getLastMessage(sessionId: string): Promise<AgentMessage | null> {
    const store = requireStore();
    if (store.getLastMessage) {
      return await store.getLastMessage(sessionId);
    }
    const messages = await store.list(sessionId, { includeHidden: true });
    return messages.length > 0 ? messages[messages.length - 1] : null;
  },

  async updateMessageContent(messageId: number, content: string): Promise<void> {
    const store = requireStore();
    if (!store.updateMessageContent) {
      throw new Error('Agent messages store does not support updateMessageContent');
    }
    await store.updateMessageContent(messageId, content);
  },
};
