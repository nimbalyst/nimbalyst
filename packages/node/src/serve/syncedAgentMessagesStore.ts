/**
 * Stream every persisted transcript row into the session room.
 *
 * `ai_agent_messages` is the sole source of truth for a transcript, and
 * `onMessageCreated` is the ONLY thing that puts a row on the wire. A write that
 * skips this decorator is a row the desktop and the phone will never see -- and
 * the failure is invisible, because the local database looks complete.
 *
 * The timestamp is passed through, never regenerated: the row, the session's
 * `updated_at` and the index entry all have to agree on one instant or the
 * mobile client's sync comparisons see a session that is perpetually newer
 * remotely than locally.
 */

import type {
  AgentMessagesStore,
} from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import type { AgentMessage, CreateAgentMessageInput } from '@nimbalyst/runtime/ai/server/types';
import type { PushChangeOutcome } from '@nimbalyst/runtime/sync/types';
import type { Logger } from './log.js';

export interface MessageSyncHandler {
  onMessageCreated(
    message: AgentMessage,
    sessionUpdatedAt?: number,
  ): Promise<PushChangeOutcome | void> | PushChangeOutcome | void;
}

function toSyncMessage(input: CreateAgentMessageInput, createdAt: Date): AgentMessage {
  return {
    // The wire format is keyed by session and timestamp; the local autoincrement
    // id is meaningless on another device.
    id: 0,
    providerMessageId: input.providerMessageId,
    sessionId: input.sessionId,
    createdAt,
    source: input.source,
    direction: input.direction,
    content: input.content,
    metadata: input.metadata,
    hidden: input.hidden ?? false,
  } as AgentMessage;
}

/** An agent-messages store whose in-flight publications can be waited on. */
export interface FlushableAgentMessagesStore extends AgentMessagesStore {
  /**
   * Wait for outstanding publications, bounded. Returns how many were still
   * in flight when the bound expired.
   */
  flushPending(timeoutMs?: number): Promise<number>;
  /**
   * Re-attempt publications that failed. Called after the index socket comes
   * back, which is when the usual cause (a send during a reconnect) has cleared.
   * Returns the number still unpublished afterwards.
   */
  retryFailed(): Promise<number>;
  /** How many rows are written locally but not published. */
  failedCount(): number;
}

const DEFAULT_FLUSH_TIMEOUT_MS = 10_000;

/**
 * Cap on rows held for retry.
 *
 * A node that has been unable to publish for a long time is not going to fix
 * itself by accumulating an unbounded array of transcript rows in a container
 * with a fixed memory limit. Past this the oldest are dropped -- they remain
 * correct in the local database, and durable replay is the deferred fix.
 */
const MAX_RETAINED_FAILURES = 500;

export function createSyncedAgentMessagesStore(
  baseStore: AgentMessagesStore,
  messageSync: MessageSyncHandler,
  log: Logger,
): FlushableAgentMessagesStore {
  /**
   * Publications that have not settled.
   *
   * Publishing is asynchronous and can block on a reconnect, so without this a
   * turn's last rows are still in flight when the drain reports itself idle and
   * shutdown closes the socket underneath them. The rows survive locally -- on
   * a machine the user cannot open.
   */
  const pending = new Set<Promise<void>>();
  /**
   * Rows written locally whose publication threw.
   *
   * Kept so a reconnect can try again: the usual cause is a send that raced the
   * twelve-minute socket rotation, and the row is otherwise invisible on every
   * device the user owns. In memory only -- a row that is still here when the
   * process exits is lost to sync, and durable replay is deferred (README).
   */
  const failed: Array<{ message: AgentMessage; updatedAt: number }> = [];

  /**
   * Hand one row to the sync handler and find out what actually happened.
   *
   * Two things this has to get right, both of which were wrong before:
   *
   *  - The promise covers the WHOLE publication, because `onMessageCreated`
   *    awaits the provider's `pushChange` -- encryption and transport included.
   *    Resolving on the decision to publish made every flush here a no-op that
   *    looked like it worked.
   *  - Not publishing is not the same as throwing. The handler reports a failed
   *    connect or a withheld write by RETURNING `{ published: false }`, and a
   *    node that had never connected therefore looked perfectly healthy while
   *    sending nothing. A rejection is a failure; so is a falsey `published`.
   */
  async function attempt(message: AgentMessage, updatedAt: number): Promise<void> {
    const outcome = await messageSync.onMessageCreated(message, updatedAt);
    if (!outcome || outcome.published) return;
    if (outcome.retryable === false) {
      // Deliberately not sent -- filtered content, or sync disabled for this
      // session. Retaining it would mean retrying forever.
      log('transcript-not-published', {
        sessionId: message.sessionId,
        reason: outcome.reason,
        note: 'deliberate; not retried',
      });
      return;
    }
    throw new Error(outcome.reason ?? 'the change was not published');
  }

  function publish(input: CreateAgentMessageInput): void {
    const createdAt = input.createdAt instanceof Date
      ? input.createdAt
      : new Date(input.createdAt!);
    const message = toSyncMessage(input, createdAt);
    const updatedAt = createdAt.getTime();

    // Never unhandled: a sync failure must not fail the local write that has
    // already succeeded.
    const publication = attempt(message, updatedAt).catch((error: unknown) => {
      if (failed.length >= MAX_RETAINED_FAILURES) failed.shift();
      failed.push({ message, updatedAt });
      log('transcript-sync-failed', {
        sessionId: input.sessionId,
        error: error instanceof Error ? error.message : String(error),
        retained: failed.length,
      });
    }).finally(() => {
      pending.delete(publication);
    });

    pending.add(publication);
  }

  return {
    async flushPending(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<number> {
      if (pending.size === 0) return 0;

      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
        // A pending flush must not by itself keep the process alive.
        timer.unref?.();
      });

      try {
        // Re-read `pending` each round: a publication can be added while an
        // earlier one is still settling.
        while (pending.size > 0) {
          const outcome = await Promise.race([
            Promise.allSettled([...pending]).then(() => 'drained' as const),
            expired,
          ]);
          if (outcome === 'timeout') break;
        }
      } finally {
        if (timer) clearTimeout(timer);
      }

      return pending.size;
    },

    failedCount: () => failed.length,

    async retryFailed(): Promise<number> {
      if (failed.length === 0) return 0;
      // Drained first: a retry that fails again re-enters through `publish`'s
      // catch, so the list must not be iterated while it is being appended to.
      const retrying = failed.splice(0, failed.length);
      log('transcript-retry', { rows: retrying.length });

      // The batch is registered in `pending` BEFORE any of it is awaited, so the
      // shutdown flush covers a retry the same way it covers a first attempt.
      // Without this a reconnect-triggered retry was invisible to
      // `flushPending()`, which reported zero while rows were still on their way
      // out -- and shutdown then disconnected the socket underneath them.
      const batch = (async () => {
        for (const row of retrying) {
          try {
            await attempt(row.message, row.updatedAt);
          } catch (error) {
            if (failed.length >= MAX_RETAINED_FAILURES) failed.shift();
            failed.push(row);
            log('transcript-sync-failed', {
              sessionId: row.message.sessionId,
              error: error instanceof Error ? error.message : String(error),
              retained: failed.length,
            });
          }
        }
      })().finally(() => {
        pending.delete(batch);
      });

      pending.add(batch);
      await batch;
      return failed.length;
    },

    async create(message: CreateAgentMessageInput): Promise<void> {
      await baseStore.create(message);
      publish(message);
    },

    async createMany(messages: CreateAgentMessageInput[]): Promise<void> {
      if (messages.length === 0) return;
      if (baseStore.createMany) {
        await baseStore.createMany(messages);
      } else {
        for (const message of messages) await baseStore.create(message);
      }
      for (const message of messages) publish(message);
    },

    list: (sessionId, options) => baseStore.list(sessionId, options),
    listTail: baseStore.listTail
      ? (sessionId, limit, options) => baseStore.listTail!(sessionId, limit, options)
      : undefined,
    getMessageCounts: baseStore.getMessageCounts
      ? (sessionIds) => baseStore.getMessageCounts!(sessionIds)
      : undefined,
  };
}
