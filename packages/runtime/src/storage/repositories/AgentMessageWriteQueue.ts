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

/**
 * Transport outcome codes set on `err.code` by the Electron database proxy
 * (`SQLiteDatabaseProxy.ts` exports the same strings; keep them in sync).
 *
 * NOT_SUBMITTED: the request never reached a database worker, so the batch
 * cannot have been written. Safe to keep and retry.
 * OUTCOME_UNKNOWN: the request was sent and its reply was lost. It may have
 * committed; retrying could duplicate rows, so it is never replayed.
 */
export const DB_REQUEST_NOT_SUBMITTED = 'DB_REQUEST_NOT_SUBMITTED';
export const DB_REQUEST_OUTCOME_UNKNOWN = 'DB_REQUEST_OUTCOME_UNKNOWN';

type FailureOutcome = 'not-submitted' | 'unknown' | 'other';

/** Read the transport outcome from `err.code`, following the `cause` chain. */
export function classifyWriteFailure(err: unknown): FailureOutcome {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const code = (current as { code?: unknown }).code;
    if (code === DB_REQUEST_NOT_SUBMITTED) return 'not-submitted';
    if (code === DB_REQUEST_OUTCOME_UNKNOWN) return 'unknown';
    current = (current as { cause?: unknown }).cause;
  }
  return 'other';
}

export interface QueuedMessageWrite {
  message: CreateAgentMessageInput;
  /** When this entry first failed with NOT_SUBMITTED; drives the retention deadline. */
  retainedSince?: number;
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
  /**
   * Consecutive whole-batch failures after which the per-row fallback is
   * suspended. Default 2. See `runFlush` for why the fallback is dangerous
   * when the database itself is down rather than one row being bad.
   */
  perRowFallbackFailureLimit?: number;
  /**
   * Retention limits for batches that failed because the database worker was
   * unavailable (NOT_SUBMITTED). Defaults: 5,000 rows, 32 Mi characters of
   * content, 10 minutes. Over a limit, the oldest entries are rejected.
   */
  maxRetainedRows?: number;
  maxRetainedChars?: number;
  maxRetainedMs?: number;
  /** Retry backoff for retained batches: base doubling up to max. Default 500ms..10s. */
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export class AgentMessageWriteQueue {
  private readonly idleFlushMs: number;
  private readonly rowFlushThreshold: number;
  private readonly pressureDepthThreshold: number;
  private readonly pressureFlushMsThreshold: number;
  private readonly writer: (messages: CreateAgentMessageInput[]) => Promise<void>;
  private readonly logger: { warn: (...args: any[]) => void };
  private readonly perRowFallbackFailureLimit: number;
  private readonly maxRetainedRows: number;
  private readonly maxRetainedChars: number;
  private readonly maxRetainedMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  /** Set while retained rows wait for the next retry; suppresses normal flush triggers. */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive NOT_SUBMITTED flushes; 0 when the database is accepting writes. */
  private retainedFlushes = 0;
  private stallWaiters = new Set<() => void>();

  /**
   * Whole-batch failures since the last success. Drives the per-row fallback
   * circuit breaker in `runFlush`.
   */
  private consecutiveBatchFailures = 0;

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
    this.perRowFallbackFailureLimit = options.perRowFallbackFailureLimit ?? 2;
    this.maxRetainedRows = options.maxRetainedRows ?? 5_000;
    this.maxRetainedChars = options.maxRetainedChars ?? 32 * 1024 * 1024;
    this.maxRetainedMs = options.maxRetainedMs ?? 10 * 60_000;
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.retryMaxMs = options.retryMaxMs ?? 10_000;
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

    if (this.retryTimer) {
      // The database is down and a retry is scheduled. Hold the row with the
      // retained ones (bounded) instead of flushing into the outage.
      entry.retainedSince = Date.now();
      this.enforceRetentionLimits();
      return done;
    }

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
    //
    // When rows are retained because the database is unavailable, retry them
    // once now and then return rather than block turn end / shutdown for the
    // whole retention window. They keep retrying on the backoff timer.
    let forcedRetry = false;
    while (this.buffer.length > 0 || this.flushPromise) {
      if (this.flushPromise) {
        await this.flushPromise.catch(() => {});
      }
      // Closed queues schedule no retry timer, so "held rows" is the signal.
      if (this.retryTimer || this.closedDuringOutage()) {
        if (forcedRetry) return;
        forcedRetry = true;
        this.clearRetryTimer();
      }
      if (this.buffer.length > 0) {
        this.scheduleImmediateFlush();
        await this.flushPromise!.catch(() => {});
      }
    }
  }

  /**
   * Resolves once the database has refused retained rows twice in a row (the
   * original failure plus one retry), or immediately if that is already the
   * case. Lets turn-end callers stop waiting on rows that are parked for
   * retry. Never resolves while the queue is healthy; call `cancel()` when
   * done waiting.
   */
  whenStalled(): { promise: Promise<void>; cancel: () => void } {
    if (this.retainedFlushes >= 2) return { promise: Promise.resolve(), cancel: () => {} };
    let waiter!: () => void;
    const promise = new Promise<void>((resolve) => { waiter = resolve; });
    this.stallWaiters.add(waiter);
    // Callers cancel when their own writes settle first; otherwise a healthy
    // queue would accumulate one waiter per turn forever.
    return { promise, cancel: () => { this.stallWaiters.delete(waiter); } };
  }

  /** Rows currently held for retry after a NOT_SUBMITTED failure. */
  retainedCount(): number {
    return this.retainedFlushes > 0 ? this.buffer.length : 0;
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
    this.clearRetryTimer();
    this.cancelIdleTimer();
    // A flush may still be in flight; once it settles nothing reschedules
    // (closedDuringOutage), so the buffer below is final.
    while (this.flushPromise) {
      await this.flushPromise.catch(() => {});
    }
    // Whatever is still retained cannot be written now; fail it explicitly
    // rather than leave its promises pending forever.
    const leftover = this.buffer;
    this.buffer = [];
    if (leftover.length > 0) {
      const err = new Error(
        `AgentMessageWriteQueue closed with ${leftover.length} row(s) not persisted: database unavailable`,
      );
      for (const entry of leftover) entry.reject(err);
      this.logger.warn(`[AgentMessageWriteQueue] ${err.message}`);
    }
    this.releaseStallWaiters();
    this.listeners.clear();
  }

  /**
   * A closed queue gets one retry from close(); after that nothing may
   * schedule a flush, or the rows would be retried forever with no owner.
   */
  private closedDuringOutage(): boolean {
    return this.closed && this.retainedFlushes > 0;
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private releaseStallWaiters(): void {
    const waiters = [...this.stallWaiters];
    this.stallWaiters.clear();
    for (const w of waiters) w();
  }

  /**
   * Put a batch that never reached the database back at the head of the
   * buffer, in its original order, and schedule a backoff retry. Entry
   * promises stay pending until a later flush settles them.
   */
  private retainBatch(batch: QueuedMessageWrite[], err: unknown): void {
    const now = Date.now();
    this.buffer = batch.concat(this.buffer);
    for (const entry of this.buffer) entry.retainedSince ??= now;
    this.retainedFlushes += 1;
    this.enforceRetentionLimits();
    if (this.retainedFlushes === 1) {
      this.logger.warn(
        `[AgentMessageWriteQueue] database unavailable; holding ${this.buffer.length} row(s) for retry:`,
        err,
      );
    }
    if (this.retainedFlushes >= 2) this.releaseStallWaiters();
    if (this.buffer.length === 0 || this.closed) return;
    const delay = Math.min(this.retryBaseMs * 2 ** (this.retainedFlushes - 1), this.retryMaxMs);
    this.cancelIdleTimer();
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.scheduleImmediateFlush();
    }, delay);
  }

  /** Reject the oldest buffered entries beyond the row, size, or age limits. */
  private enforceRetentionLimits(): void {
    const now = Date.now();
    let chars = 0;
    for (const entry of this.buffer) chars += approxChars(entry.message);
    const dropped: QueuedMessageWrite[] = [];
    while (this.buffer.length > 0) {
      const head = this.buffer[0];
      const expired = head.retainedSince !== undefined && now - head.retainedSince > this.maxRetainedMs;
      if (!expired && this.buffer.length <= this.maxRetainedRows && chars <= this.maxRetainedChars) break;
      this.buffer.shift();
      chars -= approxChars(head.message);
      dropped.push(head);
    }
    if (dropped.length === 0) return;
    const err = new Error(
      `Agent message not persisted: database unavailable and retention limit reached `
      + `(${this.maxRetainedRows} rows / ${this.maxRetainedChars} chars / ${this.maxRetainedMs}ms)`,
    );
    for (const entry of dropped) entry.reject(err);
    this.logger.warn(`[AgentMessageWriteQueue] dropped ${dropped.length} retained row(s): ${err.message}`);
  }

  /**
   * Arm or re-arm the idle timer. Each call resets the deadline to now + idleFlushMs,
   * so the timer measures "idle since last enqueue", not "deadline since first enqueue
   * in a burst". Under steady streaming the row threshold takes over before the timer
   * ever fires; the timer only fires during a real lull.
   */
  private armIdleTimer(): void {
    this.cancelIdleTimer();
    // A scheduled retry owns the next flush while the database is down, and a
    // closed queue in an outage gets no further flushes at all.
    if (this.retryTimer || this.closedDuringOutage()) return;
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
      if (this.buffer.length === 0 || this.retryTimer || this.closedDuringOutage()) return;
      // A full chunk is still waiting (a backlog drained after an outage, or
      // rows that arrived during a slow flush): keep draining. Otherwise arm
      // the idle timer so new rows don't sit forever.
      if (this.buffer.length >= this.rowFlushThreshold) {
        this.scheduleImmediateFlush();
      } else {
        this.armIdleTimer();
      }
    });
  }

  private async runFlush(): Promise<void> {
    if (this.buffer.length === 0) return;

    // At most one threshold's worth per INSERT: a backlog held through an
    // outage can be thousands of rows, and one multi-row INSERT of that size
    // would exceed SQLite's bound-parameter limit.
    const batch = this.buffer.slice(0, this.rowFlushThreshold);
    this.buffer = this.buffer.slice(batch.length);

    const depth = batch.length;
    const messages = batch.map((entry) => entry.message);
    const startedAt = Date.now();

    try {
      await this.writer(messages);
      const flushMs = Date.now() - startedAt;
      this.maybeLogPressure(depth, flushMs, messages);
      this.consecutiveBatchFailures = 0;
      if (this.retainedFlushes > 0) {
        this.logger.warn(`[AgentMessageWriteQueue] database available again; persisted ${batch.length} held row(s)`);
      }
      this.retainedFlushes = 0;
      for (const entry of batch) entry.resolve();
      this.emitBatchEvents(batch);
      return;
    } catch (err) {
      const outcome = classifyWriteFailure(err);
      if (outcome === 'not-submitted') {
        // Proven never to have reached the database: nothing was written, so
        // keep the rows and retry when the worker is back (GitHub #1988).
        // No per-row fallback; every row would fail the same way.
        this.retainBatch(batch, err);
        return;
      }
      this.retainedFlushes = 0;
      this.consecutiveBatchFailures += 1;

      if (outcome === 'unknown') {
        // The batch may have committed before its reply was lost. A retry
        // (whole or per-row) could duplicate rows, so fail it as a batch.
        for (const entry of batch) entry.reject(err);
        this.logger.warn(
          `[AgentMessageWriteQueue] batch of ${batch.length} row(s) has an unknown outcome `
          + '(database worker lost the reply); not retried to avoid duplicates:',
          err,
        );
        return;
      }

      // The per-row fallback assumes ONE poisoned row spoiled an otherwise
      // healthy batch. When the database itself is unavailable that assumption
      // inverts the cost: a 200-row batch becomes 200 more immediate failures,
      // each one its own failed transaction and its own `database_error`
      // telemetry event, with no backoff. That is how a single wedged database
      // produced ~1,000 analytics events per minute from one session on
      // 2026-08-03. After repeated whole-batch failures, stop guessing that the
      // data is at fault and fail the batch as a batch.
      if (this.consecutiveBatchFailures > this.perRowFallbackFailureLimit) {
        for (const entry of batch) entry.reject(err);
        this.logger.warn(
          `[AgentMessageWriteQueue] batched INSERT failed ${this.consecutiveBatchFailures} times in a row; `
          + `skipping the per-row fallback for ${batch.length} row(s). The database is likely unavailable:`,
          err,
        );
        return;
      }

      // Fall back to per-row inserts so a single bad row doesn't poison the
      // whole batch. A one-row batch has no bad row to isolate — retrying it
      // identically just doubles the failure.
      let resolved = 0;
      if (batch.length > 1) {
        const writer = (msg: CreateAgentMessageInput) => this.writer([msg]);
        for (const entry of batch) {
          try {
            await writer(entry.message);
            entry.resolve();
            resolved += 1;
          } catch (rowErr) {
            entry.reject(rowErr);
          }
        }
      } else {
        for (const entry of batch) entry.reject(err);
      }

      // Emit for the rows that resolved — the renderer's refresh trigger should
      // fire even when some rows failed, and the UI re-reads from the database
      // anyway. Emitting when NOTHING landed is what turned a failed write into
      // a failed read: the renderer re-queried `ai_agent_messages`, that query
      // failed too, and the pair looped in lockstep.
      if (resolved > 0) this.emitBatchEvents(batch);
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

function approxChars(message: CreateAgentMessageInput): number {
  return (message.content?.length ?? 0) + (message.searchableText?.length ?? 0);
}
