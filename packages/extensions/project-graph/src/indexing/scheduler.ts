/**
 * Adaptive paging.
 *
 * The database runs on a single worker thread that processes messages FIFO and
 * synchronously (see packages/electron/DATABASE.md): one long query
 * head-of-line-blocks every read the app needs to stay responsive. So the index
 * does two things on every page boundary — it sizes the next page from how long
 * the last one actually took, and it cedes the event loop so queued foreground
 * work can interleave.
 *
 * The target is a page duration short enough that a foreground query queued
 * behind it is not noticeably delayed. Growth is gradual and shrinkage is
 * immediate, because the cost of one over-large page is paid by the user.
 */

export interface PageSchedulerOptions {
  initialPageSize?: number;
  minPageSize?: number;
  maxPageSize?: number;
  /** Page durations above this shrink the next page. */
  slowMs?: number;
  /** Page durations below this grow the next page. */
  fastMs?: number;
  /** Pause between pages so the worker can serve foreground queries. */
  interPageDelayMs?: number;
  /** Injectable for tests; defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
  initialPageSize: 500,
  minPageSize: 50,
  maxPageSize: 4000,
  slowMs: 600,
  fastMs: 150,
  interPageDelayMs: 8,
};

export class PageScheduler {
  #pageSize: number;
  readonly #min: number;
  readonly #max: number;
  readonly #slowMs: number;
  readonly #fastMs: number;
  readonly #delayMs: number;
  readonly #sleep: (ms: number) => Promise<void>;

  #totalMs = 0;
  #pages = 0;
  #slowestMs = 0;

  constructor(options: PageSchedulerOptions = {}) {
    this.#pageSize = clamp(
      options.initialPageSize ?? DEFAULTS.initialPageSize,
      options.minPageSize ?? DEFAULTS.minPageSize,
      options.maxPageSize ?? DEFAULTS.maxPageSize,
    );
    this.#min = options.minPageSize ?? DEFAULTS.minPageSize;
    this.#max = options.maxPageSize ?? DEFAULTS.maxPageSize;
    this.#slowMs = options.slowMs ?? DEFAULTS.slowMs;
    this.#fastMs = options.fastMs ?? DEFAULTS.fastMs;
    this.#delayMs = options.interPageDelayMs ?? DEFAULTS.interPageDelayMs;
    this.#sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  }

  get pageSize(): number {
    return this.#pageSize;
  }

  get timing(): { totalMs: number; pages: number; slowestPageMs: number; averagePageMs: number } {
    return {
      totalMs: this.#totalMs,
      pages: this.#pages,
      slowestPageMs: this.#slowestMs,
      averagePageMs: this.#pages > 0 ? Math.round(this.#totalMs / this.#pages) : 0,
    };
  }

  /** Record a completed page and size the next one. */
  record(durationMs: number): void {
    this.#totalMs += durationMs;
    this.#pages += 1;
    if (durationMs > this.#slowestMs) this.#slowestMs = durationMs;

    if (durationMs > this.#slowMs) {
      // Immediate halving: an over-long page already cost the user latency, and
      // creeping down would repeat it several more times.
      this.#pageSize = clamp(Math.floor(this.#pageSize / 2), this.#min, this.#max);
    } else if (durationMs < this.#fastMs) {
      this.#pageSize = clamp(Math.floor(this.#pageSize * 1.5), this.#min, this.#max);
    }
  }

  /** Cede the event loop between pages. */
  async yield(): Promise<void> {
    if (this.#delayMs > 0) await this.#sleep(this.#delayMs);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
