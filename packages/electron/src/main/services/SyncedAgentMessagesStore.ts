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

    async getLastMessage(sessionId: string): Promise<AgentMessage | null> {
      if (!baseStore.getLastMessage) {
        throw new Error('Base store does not support getLastMessage');
      }
      return baseStore.getLastMessage(sessionId);
    },

    async updateMessageContent(messageId: number, content: string): Promise<void> {
      if (!baseStore.updateMessageContent) {
        throw new Error('Base store does not support updateMessageContent');
      }
      // Local-only: in-place edits are intentionally not propagated over sync
      // (the edit affordance is gated off for sync-enabled projects). Delegate
      // to the base store without a sync push.
      await baseStore.updateMessageContent(messageId, content);
    },
  };
}
