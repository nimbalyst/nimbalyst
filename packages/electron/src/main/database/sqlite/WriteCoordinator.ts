/**
 * WriteCoordinator
 *
 * Serializes writes through a single in-process lane and amortizes fsync by
 * batching pending writes within a short window into one BEGIN IMMEDIATE / COMMIT.
 *
 * Background lane: long-running writes (FTS rebuilds, vacuum, bulk imports,
 * the PGLite→SQLite migrator itself) run in chunks that await a microtask
 * between chunks so the JS event loop stays free for reads and IPC.
 *
 * Why: better-sqlite3 is synchronous and WAL gives us concurrent readers, but
 * writes still serialize through one connection. A single long write blocks
 * every other writer for as long as it runs. Centralizing the discipline in
 * one place is what made Andrew Demczuk's prototype
 * (ademczuk/nimbalyst-1#1) deliver ~2x baseline throughput and keep reads
 * sub-ms during a 644 ms FTS rewrite.
 */

import type { Database as SqliteDatabase } from 'better-sqlite3';

/** A unit of work that runs inside the hot write lane. */
export type WriteWork<T> = (db: SqliteDatabase) => T;

/** A unit of work scheduled on the background lane, run in chunks. */
export interface BackgroundWork<T> {
  /** Human-readable name (e.g. 'fts-rebuild', 'vacuum', 'migrator:tracker_items'). Used by instrumentation. */
  name: string;
  /**
   * Process a single chunk. Return `done: true` when no more chunks remain.
   * Each chunk should be a self-contained BEGIN/COMMIT-able unit of work.
   */
  chunk(db: SqliteDatabase): { done: boolean; result?: T };
  /** Optional max chunks per microtask tick before forcing a yield. Default 1. */
  chunksPerTick?: number;
}

export interface WriteCoordinatorOptions {
  /** Batching window in ms. Default 5. */
  batchWindowMs?: number;
  /** Warn if a background-lane chunk runs past this many ms without yielding. Default 50. */
  slowChunkWarnMs?: number;
  /** Hook for instrumentation. */
  onBatch?: (info: { batchSize: number; durationMs: number; fsynced: boolean }) => void;
  onChunk?: (info: { name: string; durationMs: number; chunkIndex: number }) => void;
  onSlowChunk?: (info: { name: string; durationMs: number; chunkIndex: number }) => void;
  /** Logger for diagnostics. Tests can pass a no-op. */
  log?: (level: 'info' | 'warn', msg: string) => void;
}

interface QueuedWrite<T> {
  work: WriteWork<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

export class WriteCoordinator {
  private db: SqliteDatabase;
  private batchWindowMs: number;
  private slowChunkWarnMs: number;
  private onBatch?: WriteCoordinatorOptions['onBatch'];
  private onChunk?: WriteCoordinatorOptions['onChunk'];
  private onSlowChunk?: WriteCoordinatorOptions['onSlowChunk'];
  private log: (level: 'info' | 'warn', msg: string) => void;

  private pending: QueuedWrite<unknown>[] = [];
  private flushScheduled = false;
  private flushPromise: Promise<void> = Promise.resolve();
  /** True while the hot lane is mid-flush; bg lane must yield to it. */
  private flushing = false;
  /** Chained tail so background ops run serially on their own lane. */
  private bgTail: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(db: SqliteDatabase, opts: WriteCoordinatorOptions = {}) {
    this.db = db;
    this.batchWindowMs = opts.batchWindowMs ?? 5;
    this.slowChunkWarnMs = opts.slowChunkWarnMs ?? 50;
    this.onBatch = opts.onBatch;
    this.onChunk = opts.onChunk;
    this.onSlowChunk = opts.onSlowChunk;
    this.log = opts.log ?? (() => {});
  }

  /**
   * Enqueue a write. Resolves with the work's return value once the batched
   * transaction this write joined has committed.
   *
   * IMPORTANT: callers must not begin/commit transactions themselves; the
   * coordinator wraps the whole tick in one BEGIN IMMEDIATE / COMMIT.
   */
  write<T>(work: WriteWork<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('WriteCoordinator is closed'));
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        work: work as WriteWork<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.scheduleFlush();
    });
  }

  /**
   * Run a long-running write as a series of chunks, yielding to the JS event
   * loop between chunks. Use this for FTS rebuilds, vacuum, bulk imports, the
   * PGLite→SQLite migrator. The coordinator guarantees no hot-lane write runs
   * concurrently with a chunk; chunks are still serial with respect to writers.
   *
   * The returned promise resolves with the value from the final chunk.
   */
  runBackground<T>(work: BackgroundWork<T>): Promise<T | undefined> {
    if (this.closed) return Promise.reject(new Error('WriteCoordinator is closed'));
    const next = this.bgTail.then(() => this.executeBackground(work));
    // Keep the tail rejection-safe so a single failure doesn't poison every
    // subsequent bg op.
    this.bgTail = next.catch(() => undefined);
    return next as Promise<T | undefined>;
  }

  /**
   * Wait for any pending hot-lane writes AND background ops to settle.
   * Tests use this to assert deterministic state.
   */
  async drain(): Promise<void> {
    // Drain hot lane then bg lane; doing it in a loop covers the case where
    // a bg op enqueues a hot write or vice versa.
    for (let i = 0; i < 8; i++) {
      await this.flushPromise;
      await this.bgTail.catch(() => undefined);
      if (this.pending.length === 0 && !this.flushScheduled) return;
    }
  }

  close(): void {
    this.closed = true;
    if (this.pending.length > 0) {
      const err = new Error('WriteCoordinator closed with pending writes');
      for (const q of this.pending) q.reject(err);
      this.pending = [];
    }
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    const start = this.flushPromise;
    this.flushPromise = start.then(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            this.flushScheduled = false;
            this.flush();
            resolve();
          }, this.batchWindowMs);
        }),
    );
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    const t0 = performance.now();
    this.flushing = true;
    let fsynced = true;

    // Group all queued writes into a single transaction so we pay one fsync.
    // better-sqlite3's transaction() returns a function that runs synchronously
    // inside an IMMEDIATE/COMMIT (or ROLLBACK on throw). If one item throws,
    // we still need every OTHER queued item to succeed -- so we capture
    // per-item results inside the transaction, and if any item throws we
    // rethrow it after the transaction ends so the txn rolls back, then
    // re-run the survivors individually.
    interface ItemResult {
      ok: boolean;
      value?: unknown;
      err?: unknown;
      item: QueuedWrite<unknown>;
    }

    const tryBatch = (): { allOk: boolean; results: ItemResult[] } => {
      const results: ItemResult[] = batch.map((item) => ({ ok: false, item }));
      let anyFailed = false;
      try {
        this.db.transaction(() => {
          for (let i = 0; i < batch.length; i++) {
            try {
              results[i].value = batch[i].work(this.db);
              results[i].ok = true;
            } catch (err) {
              results[i].err = err;
              anyFailed = true;
              throw err; // roll back the txn
            }
          }
        })();
      } catch {
        fsynced = false;
        return { allOk: false, results };
      }
      return { allOk: !anyFailed, results };
    };

    const outcome = tryBatch();
    if (outcome.allOk) {
      for (const r of outcome.results) r.item.resolve(r.value);
    } else {
      // Re-run survivors individually, skipping the one that errored. We
      // could be smarter (binary-search the bad item) but the bench-supported
      // case is the all-ok path; the bad path just needs to be correct.
      for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        const prev = outcome.results[i];
        if (prev.err !== undefined) {
          item.reject(prev.err);
          continue;
        }
        try {
          let value: unknown;
          this.db.transaction(() => {
            value = item.work(this.db);
          })();
          item.resolve(value);
        } catch (err) {
          item.reject(err);
        }
      }
    }

    this.flushing = false;
    const durationMs = performance.now() - t0;
    this.onBatch?.({ batchSize: batch.length, durationMs, fsynced });

    // If new writes arrived during this synchronous flush, schedule another.
    if (this.pending.length > 0) this.scheduleFlush();
  }

  private async executeBackground<T>(work: BackgroundWork<T>): Promise<T | undefined> {
    const chunksPerTick = Math.max(1, work.chunksPerTick ?? 1);
    let chunkIndex = 0;
    let result: T | undefined;

    while (true) {
      // Yield to any pending hot-lane writes first so they don't starve.
      if (this.pending.length > 0 || this.flushScheduled) {
        await this.flushPromise;
      }

      let done = false;
      for (let i = 0; i < chunksPerTick; i++) {
        const chunkStart = performance.now();
        let outcome: { done: boolean; result?: T };
        // Each chunk runs in its own short transaction so we never hold a
        // write lock across an `await`.
        try {
          this.db.transaction(() => {
            outcome = work.chunk(this.db);
          })();
        } catch (err) {
          throw err;
        }
        const durationMs = performance.now() - chunkStart;
        this.onChunk?.({ name: work.name, durationMs, chunkIndex });
        if (durationMs > this.slowChunkWarnMs) {
          this.onSlowChunk?.({ name: work.name, durationMs, chunkIndex });
          this.log(
            'warn',
            `[WriteCoordinator] bg-lane chunk ${work.name}#${chunkIndex} ran ${durationMs.toFixed(1)}ms without yielding; consider a smaller chunkSize`,
          );
        }
        chunkIndex += 1;
        // outcome is assigned synchronously inside the transaction above.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        if (outcome!.result !== undefined) result = outcome!.result;
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        if (outcome!.done) {
          done = true;
          break;
        }
      }

      if (done) return result;

      // Yield to the macrotask queue so IPC, timers, and hot-lane writes can run.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}
