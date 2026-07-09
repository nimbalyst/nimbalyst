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
  /** Get a single raw message by its id, scoped to the session. Null if absent. */
  getMessageById?(sessionId: string, messageId: number): Promise<AgentMessage | null>;
  /** Id of the most recent user-input message (`message_kind = 'user'`), or null. */
  getLastUserMessageId?(sessionId: string): Promise<number | null>;
  /**
   * Edit/rewind truncation primitive: delete every raw message with `id > afterId`
   * for the session. The `ai_tool_call_file_edits.message_id` FK cascade removes
   * matching file-edit links and the FTS delete trigger clears the search mirror.
   * Returns the deleted raw ids (ascending) so callers can clean up dependents.
   */
  deleteMessagesAfter?(sessionId: string, afterId: number): Promise<{ deletedIds: number[] }>;
  /**
   * Overwrite a message's `content` and `searchable_text` in place (used when a
   * user edits a previously-sent message). The FTS update trigger reindexes the
   * row. Does NOT touch `message_kind` (an edited user message stays 'user').
   */
  updateMessageContent?(sessionId: string, messageId: number, content: string, searchableText: string | null): Promise<void>;
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

  async getMessageById(sessionId: string, messageId: number): Promise<AgentMessage | null> {
    const store = requireStore();
    if (store.getMessageById) {
      return await store.getMessageById(sessionId, messageId);
    }
    // Fallback for stores without a targeted lookup.
    const messages = await store.list(sessionId, { includeHidden: true });
    return messages.find((m) => m.id === messageId) ?? null;
  },

  async getLastUserMessageId(sessionId: string): Promise<number | null> {
    const store = requireStore();
    if (!store.getLastUserMessageId) {
      throw new Error('Agent messages store does not support getLastUserMessageId');
    }
    return await store.getLastUserMessageId(sessionId);
  },

  async deleteMessagesAfter(sessionId: string, afterId: number): Promise<{ deletedIds: number[] }> {
    const store = requireStore();
    if (!store.deleteMessagesAfter) {
      throw new Error('Agent messages store does not support deleteMessagesAfter');
    }
    return await store.deleteMessagesAfter(sessionId, afterId);
  },

  async updateMessageContent(
    sessionId: string,
    messageId: number,
    content: string,
    searchableText: string | null,
  ): Promise<void> {
    const store = requireStore();
    if (!store.updateMessageContent) {
      throw new Error('Agent messages store does not support updateMessageContent');
    }
    await store.updateMessageContent(sessionId, messageId, content, searchableText);
  },
};
