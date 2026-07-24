/**
 * AgentMessageWriteQueue
 *
 * Coalesces ai_agent_messages writes from streaming providers into batched
 * multi-row INSERTs to relieve PGLite single-writer-lock contention.
 *
 * The chunk firehose from `logAgentMessageNonBlocking` previously emitted one
 * BEGIN/INSERT/COMMIT per chunk, holding the writer lock continuously. That
 * starved synchronous control-plane writes (user input, final output, and
 * permission audits in `AgentToolHooks`), which surfaced as late
 * `Tool permission request failed: Error: Stream closed` errors when the
 * `can_use_tool` callback couldn't return inside the 5s grace window.
 *
 * This queue runs as a write-back cache for AgentMessagesRepository. It holds
 * a single FIFO buffer that flushes when ANY of the following triggers fire:
 *
 * - 200ms idle window since the last enqueue
 * - 200 buffered rows
 * - Explicit `flushAll()` (called by `flushPendingWrites()` at turn-end /
 *   abort / shutdown)
 *
 * Why no priority lanes: an earlier draft used HIGH/LOW lanes to "preempt" the
 * chunk firehose for awaited writes (user prompts, final outputs, permission
 * audits). FIFO already preserves per-session order between awaited and
 * non-awaited rows, and the 200ms idle window is well inside the SDK's 5s
 * grace timer for `can_use_tool`. Forcing a flush per awaited write *increased*
 * total transaction count, defeating coalescing. See NIM-431 for the full
 * rationale.
 *
 * See plan: `nimbalyst-local/plans/agent-message-write-coalescing.md`.
 * Tracker: NIM-340 (extends), NIM-431 (architecture decision).
 */

import type { CreateAgentMessageInput } from '../../ai/server/types';
import { AgentMessagesRepository } from './AgentMessagesRepository';

export interface QueuedMessageWrite {
  message: CreateAgentMessageInput;
  /** Resolved (or rejected) when this message has been persisted. */
  done: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

/**
 * Per-flush event payload. Emitted once per affected session per flush so the
 * renderer can coalesce its UI refresh signal in the same way the existing
 * per-message `message:logged` event drives it.
 *
 * `count` is the count of *visible* rows in the session's slice. Hidden rows
 * (e.g. metadata commands like `/context`) don't drive UI refresh, so they're
 * excluded from the count. If a flush contains only hidden rows for a session,
 * no event is emitted for that session at all.
 */
export interface MessagesLoggedBatchEvent {
  sessionId: string;
  /** Count of visible (non-hidden) rows. Always >= 1; sessions with all-hidden flushes don't emit. */
  count: number;
  /**
   * Direction summary across visible rows. 'mixed' when the flush contained both
   * input and output visible rows for that session.
   */
  direction: 'input' | 'output' | 'mixed';
}

/**
 * Listener invoked with (sessionId, summary) for each session represented in a flush.
 */
export type BatchListener = (event: MessagesLoggedBatchEvent) => void;

export interface AgentMessageWriteQueueOptions {
  /** Idle window in ms before the buffer flushes itself. Default 200ms. */
  idleFlushMs?: number;
  /** Max buffer size before a forced flush. Default 200 rows. */
  rowFlushThreshold?: number;
  /** Pressure log threshold: queue depth that signals undersized batches. Default 500. */
  pressureDepthThreshold?: number;
  /**
   * Pressure log threshold: flush latency for multi-row batches that signals
   * writer-lock contention. Default 200ms. Only checked for batches >1 row so
   * isolated single-row writes contended by unrelated tables don't spam the log.
   */
  pressureFlushMsThreshold?: number;
  /**
   * Function used to persist a batch of rows. Defaults to
   * `AgentMessagesRepository.createMany`. Tests can inject a fake.
   */
  writer?: (messages: CreateAgentMessageInput[]) => Promise<void>;
  /** Logger for telemetry. Defaults to console; tests can inject a mock. */
  logger?: { warn: (...args: any[]) => void };
}

export class AgentMessageWriteQueue {
  private readonly idleFlushMs: number;
  private readonly rowFlushThreshold: number;
  private readonly pressureDepthThreshold: number;
  private readonly pressureFlushMsThreshold: number;
  private readonly writer: (messages: CreateAgentMessageInput[]) => Promise<void>;
  private readonly logger: { warn: (...args: any[]) => void };

  /** Single FIFO buffer. Per-session order is preserved by enqueue order. */
  private buffer: QueuedMessageWrite[] = [];

  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;
  private listeners: Set<BatchListener> = new Set();
  private closed = false;

  constructor(options: AgentMessageWriteQueueOptions = {}) {
    this.idleFlushMs = options.idleFlushMs ?? 200;
    this.rowFlushThreshold = options.rowFlushThreshold ?? 200;
    this.pressureDepthThreshold = options.pressureDepthThreshold ?? 500;
    this.pressureFlushMsThreshold = options.pressureFlushMsThreshold ?? 200;
    this.writer = options.writer
      ?? ((messages) => AgentMessagesRepository.createMany(messages));
    this.logger = options.logger ?? console;
  }

  /**
   * Subscribe to per-flush batch events. Returns an unsubscribe function.
   */
  onBatch(listener: BatchListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Enqueue a message write. Returns a promise that resolves once the row has
   * been persisted (in a future flush).
   */
  enqueue(message: CreateAgentMessageInput): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('AgentMessageWriteQueue is closed'));
    }

    let resolveFn!: () => void;
    let rejectFn!: (err: unknown) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    const entry: QueuedMessageWrite = {
      message,
      done,
      resolve: resolveFn,
      reject: rejectFn,
    };

    this.buffer.push(entry);

    if (this.buffer.length >= this.rowFlushThreshold) {
      this.cancelIdleTimer();
      this.scheduleImmediateFlush();
    } else {
      this.armIdleTimer();
    }

    return done;
  }

  /**
   * Flush all buffered writes immediately and wait for them to complete.
   * Used by `AIProvider.flushPendingWrites()` at turn-end / abort / shutdown.
   * Idempotent: safe to call when the buffer is empty.
   */
  async flushAll(): Promise<void> {
    this.cancelIdleTimer();
    // If a flush is already in progress, wait for it to settle, then flush
    // any rows that came in while it was running. Loop until the buffer is
    // empty and no flush is in progress.
    while (this.buffer.length > 0 || this.flushPromise) {
      if (this.flushPromise) {
        await this.flushPromise.catch(() => {});
      }
      if (this.buffer.length > 0) {
        this.scheduleImmediateFlush();
        await this.flushPromise!.catch(() => {});
      }
    }
  }

  /**
   * Returns the current buffered row count. Used by tests and diagnostics.
   */
  size(): number {
    return this.buffer.length;
  }

  /**
   * Mark the queue closed and flush any remaining rows.
   */
  async close(): Promise<void> {
    this.closed = true;
    await this.flushAll();
    this.listeners.clear();
  }

  /**
   * Arm or re-arm the idle timer. Each call resets the deadline to now + idleFlushMs,
   * so the timer measures "idle since last enqueue", not "deadline since first enqueue
   * in a burst". Under steady streaming the row threshold takes over before the timer
   * ever fires; the timer only fires during a real lull.
   */
  private armIdleTimer(): void {
    this.cancelIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.scheduleImmediateFlush();
    }, this.idleFlushMs);
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleImmediateFlush(): void {
    if (this.flushPromise) {
      // A flush is already running; the next entries will be picked up by
      // the loop in flushAll() or the next idle-timer fire.
      return;
    }
    this.flushPromise = this.runFlush().finally(() => {
      this.flushPromise = null;
      // If new rows arrived during the flush, arm the idle timer so they
      // don't sit forever.
      if (this.buffer.length > 0) {
        this.armIdleTimer();
      }
    });
  }

  private async runFlush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer;
    this.buffer = [];

    const depth = batch.length;
    const messages = batch.map((entry) => entry.message);
    const startedAt = Date.now();

    try {
      await this.writer(messages);
      const flushMs = Date.now() - startedAt;
      this.maybeLogPressure(depth, flushMs, messages);
      for (const entry of batch) entry.resolve();
      this.emitBatchEvents(batch);
    } catch (err) {
      // Fall back to per-row inserts so a single bad row doesn't poison the
      // whole batch.
      const writer = (msg: CreateAgentMessageInput) => this.writer([msg]);
      for (const entry of batch) {
        try {
          await writer(entry.message);
          entry.resolve();
        } catch (rowErr) {
          entry.reject(rowErr);
        }
      }
      // Still emit batch events for the rows that resolved — the renderer's
      // refresh trigger should fire even when some rows failed. The event
      // count reflects how many were attempted, not how many succeeded; the
      // UI re-reads from the database anyway.
      this.emitBatchEvents(batch);
      // Surface the original batched-INSERT failure for diagnosis. Don't
      // re-throw; per-row results are already wired into entry promises.
      this.logger.warn('[AgentMessageWriteQueue] batched INSERT failed; fell back to per-row:', err);
    }
  }

  private emitBatchEvents(batch: QueuedMessageWrite[]): void {
    if (this.listeners.size === 0 || batch.length === 0) return;

    // Aggregate visible rows only. Hidden rows don't drive UI refresh, so they
    // shouldn't influence the per-session count or suppress the event for the
    // visible rows flushed alongside them.
    type Agg = { count: number; direction: 'input' | 'output' | 'mixed' };
    const bySession = new Map<string, Agg>();
    for (const entry of batch) {
      if (entry.message.hidden) continue;
      const sessionId = entry.message.sessionId;
      const dir = entry.message.direction;
      const existing = bySession.get(sessionId);
      if (!existing) {
        bySession.set(sessionId, { count: 1, direction: dir });
      } else {
        existing.count += 1;
        if (existing.direction !== dir) existing.direction = 'mixed';
      }
    }

    for (const [sessionId, agg] of bySession) {
      const event: MessagesLoggedBatchEvent = {
        sessionId,
        count: agg.count,
        direction: agg.direction,
      };
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          // Swallow listener errors — they shouldn't block other listeners.
        }
      }
    }
  }

  private maybeLogPressure(
    depth: number,
    flushMs: number,
    messages: CreateAgentMessageInput[],
  ): void {
    // Only log slow-flush pressure for multi-row batches. A single-row write
    // contended by unrelated table activity (tracker_items reads, session_files,
    // etc.) is normal and would otherwise spam the log without indicating a
    // real coalescing problem.
    const slowFlush = messages.length > 1 && flushMs >= this.pressureFlushMsThreshold;
    const deepBuffer = depth >= this.pressureDepthThreshold;
    if (!slowFlush && !deepBuffer) return;

    const sessions = new Set<string>();
    for (const m of messages) sessions.add(m.sessionId);
    this.logger.warn(
      `[AgentMessageWriteQueue] WRITE_QUEUE_PRESSURE: depth=${depth} flushMs=${flushMs} rows=${messages.length} sessions=${sessions.size}`
    );
  }
}
