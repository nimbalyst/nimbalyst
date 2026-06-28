/**
 * Synced wrapper for AgentMessagesStore that syncs messages to remote.
 *
 * IMPORTANT: The timestamp (message.createdAt) must originate from the message source
 * (e.g., AIProvider.logAgentMessage). This wrapper just passes it through to both
 * local DB and sync - it does NOT create its own timestamp.
 */

import type { AgentMessagesStore } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import type { CreateAgentMessageInput, AgentMessage } from '@nimbalyst/runtime';
import { getMessageSyncHandler, triggerIncrementalSync } from './SyncManager';
import { logger } from '../utils/logger';

// Debounce index sync to avoid spamming on rapid message creation
let indexSyncTimeout: NodeJS.Timeout | null = null;
function scheduleIndexSync() {
  if (indexSyncTimeout) {
    clearTimeout(indexSyncTimeout);
  }
  indexSyncTimeout = setTimeout(() => {
    indexSyncTimeout = null;
    triggerIncrementalSync().catch(err => {
      logger.main.warn('[SyncedAgentMessagesStore] Failed to sync index:', err);
    });
  }, 10000); // Wait 10 seconds after last message before syncing index
}

/**
 * Wraps an AgentMessagesStore to sync messages to the SessionsIndex.
 */
export function createSyncedAgentMessagesStore(
  baseStore: AgentMessagesStore
): AgentMessagesStore {
  return {
    async create(message: CreateAgentMessageInput): Promise<void> {
      // message.createdAt MUST be set by the caller (AIProvider)
      // This ensures the same timestamp is used everywhere
      if (!message.createdAt) {
        throw new Error('message.createdAt is required for sync consistency');
      }

      const timestamp = message.createdAt instanceof Date
        ? message.createdAt
        : new Date(message.createdAt);

      // Create in base store (uses message.createdAt for both message and session updated_at)
      await baseStore.create(message);

      // Push to sync with the SAME timestamp
      const messageSyncHandler = getMessageSyncHandler();
      if (messageSyncHandler) {
        try {
          const syncMessage: AgentMessage = {
            id: 0, // ID not needed for sync
            sessionId: message.sessionId,
            createdAt: timestamp,
            source: message.source,
            direction: message.direction,
            content: message.content,
            metadata: message.metadata,
            hidden: message.hidden ?? false,
          };

          // Pass the same timestamp for session index update
          messageSyncHandler.onMessageCreated(syncMessage, timestamp.getTime());

          // Schedule index sync to update message counts (debounced)
          scheduleIndexSync();
        } catch (error) {
          logger.main.warn('[SyncedAgentMessagesStore] Failed to sync message:', error);
        }
      }
    },

    async createMany(messages: CreateAgentMessageInput[]): Promise<void> {
      if (messages.length === 0) return;

      for (const message of messages) {
        if (!message.createdAt) {
          throw new Error('message.createdAt is required for sync consistency');
        }
      }

      // Insert all rows through the base store's batched path. This is the
      // writer-lock-relief path: a single transaction holds the lock briefly,
      // not once per chunk. See AgentMessageWriteQueue.
      if (baseStore.createMany) {
        await baseStore.createMany(messages);
      } else {
        for (const message of messages) {
          await baseStore.create(message);
        }
      }

      const messageSyncHandler = getMessageSyncHandler();
      if (!messageSyncHandler) return;

      // Push each message to sync individually after the batch persists. Sync
      // already debounces its own index push (see scheduleIndexSync below).
      try {
        for (const message of messages) {
          const timestamp = message.createdAt instanceof Date
            ? message.createdAt
            : new Date(message.createdAt!);
          const syncMessage: AgentMessage = {
            id: 0,
            sessionId: message.sessionId,
            createdAt: timestamp,
            source: message.source,
            direction: message.direction,
            content: message.content,
            metadata: message.metadata,
            hidden: message.hidden ?? false,
          };
          messageSyncHandler.onMessageCreated(syncMessage, timestamp.getTime());
        }
        scheduleIndexSync();
      } catch (error) {
        logger.main.warn('[SyncedAgentMessagesStore] Failed to sync batched messages:', error);
      }
    },

    async list(sessionId: string, options?: { limit?: number; offset?: number; includeHidden?: boolean }): Promise<AgentMessage[]> {
      return baseStore.list(sessionId, options);
    },

    async getMessageCounts(sessionIds: string[]): Promise<Map<string, number>> {
      if (baseStore.getMessageCounts) {
        return baseStore.getMessageCounts(sessionIds);
      }
      // Fallback if base store doesn't support batch counts
      const counts = new Map<string, number>();
      for (const sessionId of sessionIds) {
        const messages = await baseStore.list(sessionId);
        counts.set(sessionId, messages.length);
      }
      return counts;
    },

    async getMessageById(sessionId: string, messageId: number): Promise<AgentMessage | null> {
      if (!baseStore.getMessageById) {
        const messages = await baseStore.list(sessionId, { includeHidden: true });
        return messages.find((m) => m.id === messageId) ?? null;
      }
      return baseStore.getMessageById(sessionId, messageId);
    },

    async getLastUserMessageId(sessionId: string): Promise<number | null> {
      if (!baseStore.getLastUserMessageId) {
        throw new Error('Base agent messages store does not support getLastUserMessageId');
      }
      return baseStore.getLastUserMessageId(sessionId);
    },

    async deleteMessagesAfter(sessionId: string, afterId: number): Promise<{ deletedIds: number[] }> {
      if (!baseStore.deleteMessagesAfter) {
        throw new Error('Base agent messages store does not support deleteMessagesAfter');
      }
      const result = await baseStore.deleteMessagesAfter(sessionId, afterId);
      // Best-effort: notify the cross-device propagation hook. The desktop's
      // local delete above is the source of truth and keeps this device
      // consistent immediately.
      notifyMessagesTruncated(sessionId, afterId, result.deletedIds);
      return result;
    },

    async updateMessageContent(
      sessionId: string,
      messageId: number,
      content: string,
      searchableText: string | null
    ): Promise<void> {
      if (!baseStore.updateMessageContent) {
        throw new Error('Base agent messages store does not support updateMessageContent');
      }
      await baseStore.updateMessageContent(sessionId, messageId, content, searchableText);
    },
  };
}

/**
 * Notify other devices that a session's tail was truncated by an edit/rewind.
 *
 * Deliberately a no-op in v1. The personal-sync `message_added` path has no
 * delete/truncate counterpart (`packages/collab-protocol/src/personal.ts`), so
 * propagating a truncation cross-device would require a new protocol change
 * type plus matching CollabV3-server and iOS-client handling. Until that lands,
 * the desktop truncation is local-first and authoritative; a mobile mirror that
 * had the discarded tail reconciles on its next full index/session sync. This
 * is the single, documented integration point when the protocol gains a
 * truncation message.
 */
function notifyMessagesTruncated(_sessionId: string, _afterId: number, _deletedIds: number[]): void {
  // No cross-device truncation message exists yet (see docblock). Local delete
  // is authoritative.
}
