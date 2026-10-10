import type { AgentMessage } from '../ai/server/types';
import { warnIfUnpublished } from './pushOutcome';
import type { PushChangeOutcome, SyncProvider } from './types';

/**
 * Transcript rows a session could not publish live, held in order and sent over
 * a short-lived socket.
 *
 * The desktop keeps at most `MAX_SESSION_CONNECTIONS` session-room sockets.
 * With more agents than that running, a new session is refused a socket, and
 * its rows used to be dropped with a warning while the index timestamp moved
 * past them -- so the phone never showed them, even after a restart (#1391).
 * The outbox sends them anyway and moves the index timestamp only once they
 * are on the wire.
 *
 * In memory only: rows still queued when the app quits are lost.
 */

export interface SessionWriteOutboxOptions {
  /** Wait this long after the first queued row so a streaming turn goes out in a few batches. */
  coalesceMs?: number;
  /** Short-lived sockets open at once, across all sessions. */
  maxConcurrent?: number;
  /** Rows per short-lived socket. */
  maxBatch?: number;
  /** Delay before each retry after a retryable failure; the last value repeats. */
  backoffMs?: number[];
}

type OutboxProvider = Pick<SyncProvider, 'isConnected' | 'pushChange' | 'sendSessionMessages'>;

interface OutboxEntry {
  message: AgentMessage;
  sessionUpdatedAt?: number;
}

export interface SessionWriteOutbox {
  enqueue(message: AgentMessage, sessionUpdatedAt: number | undefined, reason: string): PushChangeOutcome;
  hasPending(sessionId: string): boolean;
  dispose(): void;
}

const LOG_INTERVAL_MS = 60_000;

export function createSessionWriteOutbox(
  provider: OutboxProvider,
  options: SessionWriteOutboxOptions = {},
): SessionWriteOutbox {
  const coalesceMs = options.coalesceMs ?? 2_000;
  const maxConcurrent = options.maxConcurrent ?? 3;
  const maxBatch = options.maxBatch ?? 200;
  const backoffMs = options.backoffMs ?? [2_000, 5_000, 15_000, 30_000];

  const queues = new Map<string, OutboxEntry[]>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const failures = new Map<string, number>();
  const draining = new Set<string>();
  const waiting: string[] = [];
  const lastSentLogAt = new Map<string, number>();
  let active = 0;
  let disposed = false;

  function schedule(sessionId: string, delayMs: number): void {
    if (disposed || timers.has(sessionId) || draining.has(sessionId) || waiting.includes(sessionId)) return;
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      start(sessionId);
    }, delayMs);
    (timer as { unref?: () => void }).unref?.();
    timers.set(sessionId, timer);
  }

  function start(sessionId: string): void {
    if (disposed) return;
    if (active >= maxConcurrent) {
      if (!waiting.includes(sessionId)) waiting.push(sessionId);
      return;
    }
    void drain(sessionId);
  }

  /**
   * Send the head of the queue. Returns how many entries are resolved -- sent,
   * or deliberately not sent -- and the outcome that stopped it, if any.
   */
  async function send(sessionId: string, batch: OutboxEntry[]): Promise<{ resolved: number; outcome: PushChangeOutcome }> {
    if (provider.isConnected(sessionId)) {
      // The session got a permanent socket since these were queued: send through it, in order.
      for (let i = 0; i < batch.length; i++) {
        const outcome = (await provider.pushChange(sessionId, { type: 'message_added', message: batch[i].message })) ?? { published: true };
        if (!outcome.published && outcome.retryable !== false) return { resolved: i, outcome };
      }
      return { resolved: batch.length, outcome: { published: true } };
    }
    const outcome = await provider.sendSessionMessages!(sessionId, batch.map(entry => entry.message));
    return { resolved: outcome.published || outcome.retryable === false ? batch.length : 0, outcome };
  }

  async function drain(sessionId: string): Promise<void> {
    const queue = queues.get(sessionId);
    if (!queue || queue.length === 0) {
      queues.delete(sessionId);
      return;
    }
    // The session stays marked as draining until its timestamp is out, so a
    // second drain cannot take the same queue mid-publish and lose rows to it.
    active++;
    draining.add(sessionId);
    const batch = queue.slice(0, maxBatch);
    let result: { resolved: number; outcome: PushChangeOutcome };
    try {
      try {
        result = await send(sessionId, batch);
      } catch (error) {
        result = { resolved: 0, outcome: { published: false, reason: error instanceof Error ? error.message : String(error), retryable: true } };
      }
      if (disposed) return;

      const done = queue.splice(0, result.resolved);
      if (done.length > 0) {
        failures.delete(sessionId);
        if (!result.outcome.published && result.outcome.retryable === false) {
          console.warn(`[MessageOutbox] Dropped ${done.length} queued message(s) for session ${sessionId}: ${result.outcome.reason ?? 'not sendable'}`);
        } else {
          logSent(sessionId, done.length);
        }
        await publishTimestamp(sessionId, done);
      }
    } finally {
      active--;
      draining.delete(sessionId);
    }
    if (disposed) return;

    if (result.resolved < batch.length) {
      const attempt = (failures.get(sessionId) ?? 0) + 1;
      failures.set(sessionId, attempt);
      warnIfUnpublished(message => console.warn(message), sessionId, '[MessageOutbox] Failed to send queued messages', result.outcome);
      schedule(sessionId, backoffMs[Math.min(attempt, backoffMs.length) - 1]);
    } else if (queue.length > 0) {
      schedule(sessionId, coalesceMs);
    } else if (queues.get(sessionId) === queue) {
      queues.delete(sessionId);
    }

    while (active < maxConcurrent && waiting.length > 0) start(waiting.shift()!);
  }

  // The index timestamp may only move once the rows it describes are out;
  // one that runs ahead of them hides the gap from the startup reconcile.
  async function publishTimestamp(sessionId: string, entries: OutboxEntry[]): Promise<void> {
    const updatedAt = entries.reduce<number | undefined>(
      (latest, entry) => entry.sessionUpdatedAt === undefined ? latest : Math.max(latest ?? 0, entry.sessionUpdatedAt),
      undefined,
    );
    if (updatedAt === undefined || disposed) return;
    try {
      const outcome = await provider.pushChange(sessionId, { type: 'metadata_updated', metadata: { updatedAt } });
      warnIfUnpublished(message => console.warn(message), sessionId, '[MessageOutbox] Failed to publish timestamp', outcome ?? undefined);
    } catch (error) {
      console.warn(`[MessageOutbox] Failed to publish timestamp for session ${sessionId}:`, error);
    }
  }

  function logSent(sessionId: string, count: number): void {
    const now = Date.now();
    if (now - (lastSentLogAt.get(sessionId) ?? 0) < LOG_INTERVAL_MS) return;
    lastSentLogAt.set(sessionId, now);
    console.log(`[MessageOutbox] Sent ${count} queued message(s) for session ${sessionId} over a short-lived socket`);
  }

  return {
    enqueue(message, sessionUpdatedAt, reason) {
      if (disposed) return { published: false, reason: 'message outbox was disposed', retryable: true };
      const queue = queues.get(message.sessionId) ?? [];
      if (queue.length === 0) {
        queues.set(message.sessionId, queue);
        warnIfUnpublished(
          line => console.warn(line),
          message.sessionId,
          '[MessageOutbox] Queued messages for a short-lived socket',
          { published: false, reason, retryable: true },
        );
      }
      queue.push({ message, sessionUpdatedAt });
      schedule(message.sessionId, coalesceMs);
      return { published: false, reason, retryable: true, queued: true };
    },

    hasPending(sessionId) {
      return (queues.get(sessionId)?.length ?? 0) > 0;
    },

    dispose() {
      disposed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      queues.clear();
      failures.clear();
      waiting.length = 0;
    },
  };
}
