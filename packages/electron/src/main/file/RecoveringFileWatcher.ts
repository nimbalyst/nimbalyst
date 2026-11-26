import type { FileWatchHealth } from "../../shared/fileWatchHealth";

export interface WatchHandle {
  close(): unknown;
}

/**
 * Reports trouble with a handle. A call is a native failure, which replaces
 * the handle. A backlog overflow loses events but keeps the handle:
 * `overflowed` reports the loss, and `resynced` that the events after it
 * have been delivered.
 */
export interface WatchFailure {
  (reason: string): void;
  overflowed(dropped: number): void;
  resynced(): void;
}

/** Events a backlog overflow lost, for the log lines that open and close it. */
export interface WatchOverflow {
  dropped: number;
  durationMs?: number;
}

// Never restart in a tight loop under sustained FSEvents/inotify pressure.
const RETRY_DELAYS = [1000, 5000, 15_000, 60_000];
// ENOSPC means the OS watch limit is exhausted. The limit does not change
// between retries, and every retry re-crawls the whole tree before failing.
const CAPACITY_RETRY_DELAYS = [60_000, 300_000, 900_000, 1_800_000];
const HEALTHY_RESET_MS = 60_000;

/** Owns a replaceable native handle, independently of its subscribers (#1499). */
export class RecoveringFileWatcher<T extends WatchHandle> {
  handle: T | null = null;
  health: FileWatchHealth = { state: "starting", generation: 0 };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> | null = null;
  private closing: Promise<void> = Promise.resolve();
  private failures = 0;
  private capacityFailures = 0;
  private healthySince = 0;
  /** A backlog overflow on the live handle, until its scan is ready and its events delivered. */
  private overflow: {
    dropped: number;
    since: number;
    scanned: boolean;
    resynced: boolean;
  } | null = null;

  constructor(
    /**
     * Creates a native handle. `ready` reports that the handle's initial scan
     * finished; until then the watcher is `starting`, and its uptime does not
     * count toward resetting backoff.
     */
    private readonly create: (
      current: () => boolean,
      fail: WatchFailure,
      ready: () => void
    ) => Promise<T> | T,
    private readonly changed: (
      health: FileWatchHealth,
      overflow?: WatchOverflow
    ) => void,
    private readonly closeFailed: (error: unknown) => void
  ) {}

  start(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.timer || this.handle || this.health.state === "stopped")
      return Promise.resolve();
    const generation = this.health.generation + 1;
    this.publish({ state: "starting", generation });
    const current = () =>
      this.health.generation === generation && this.health.state !== "stopped";
    let installed = false;
    let readyBeforeInstall = false;
    const ready = () => {
      if (!current()) return;
      if (installed) this.ready(generation);
      else readyBeforeInstall = true;
    };
    const fail: WatchFailure = Object.assign(
      (reason: string) => {
        if (current()) this.fail(reason);
      },
      {
        overflowed: (dropped: number) => {
          if (current()) this.overflowed(dropped);
        },
        resynced: () => {
          if (current()) this.resynced();
        },
      }
    );
    this.pending = Promise.resolve()
      .then(async () => {
        await this.closing;
        if (!current()) return;
        try {
          const handle = await this.create(current, fail, ready);
          if (!current()) {
            await this.close(handle);
            return;
          }
          this.handle = handle;
          installed = true;
          if (readyBeforeInstall) this.ready(generation);
        } catch (error) {
          if (current())
            this.fail(
              (error as NodeJS.ErrnoException)?.code ?? "startup_failed"
            );
        }
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  /** Consecutive ENOSPC failures since the watcher was last healthy. */
  get capacityFailureCount(): number {
    return this.capacityFailures;
  }

  /** Whether the installed handle's initial scan is still running. */
  get scanning(): boolean {
    return (
      this.health.state === "starting" ||
      (this.overflow !== null && !this.overflow.scanned)
    );
  }

  private ready(generation: number): void {
    if (this.health.generation !== generation) return;
    if (this.overflow && !this.overflow.scanned) {
      this.healthySince = Date.now();
      this.overflow.scanned = true;
      this.endOverflow();
      return;
    }
    if (this.health.state !== "starting") return;
    this.healthySince = Date.now();
    this.publish({ state: "watching", generation });
  }

  /**
   * Subscribers recover missed events from `recovering` to `watching`, so an
   * overflow publishes that pair once per episode, keeps the generation (the
   * live handle stays current), and never schedules a restart.
   */
  private overflowed(dropped: number): void {
    if (this.overflow) {
      this.overflow.dropped += dropped;
      this.overflow.resynced = false;
      return;
    }
    const { state, generation } = this.health;
    this.overflow = {
      dropped,
      since: Date.now(),
      scanned: state === "watching",
      resynced: false,
    };
    this.publish(
      { state: "recovering", generation, reason: "event_queue_overflow" },
      { dropped }
    );
  }

  private resynced(): void {
    if (!this.overflow) return;
    this.overflow.resynced = true;
    this.endOverflow();
  }

  private endOverflow(): void {
    const overflow = this.overflow;
    if (!overflow?.scanned || !overflow.resynced) return;
    this.overflow = null;
    this.publish(
      { state: "watching", generation: this.health.generation },
      { dropped: overflow.dropped, durationMs: Date.now() - overflow.since }
    );
  }

  private fail(reason: string): void {
    // An overflow episode kept the handle; a native failure still replaces it.
    if (
      this.health.state === "stopped" ||
      (this.health.state === "recovering" && !this.overflow)
    )
      return;
    const scanned =
      this.health.state === "watching" || !!this.overflow?.scanned;
    this.overflow = null;
    // Only a watcher whose first scan finished, and that then stayed up, was
    // healthy. A scan that fails late is still a failed attempt.
    if (scanned && Date.now() - this.healthySince >= HEALTHY_RESET_MS) {
      this.failures = 0;
      this.capacityFailures = 0;
    }
    const delay =
      reason === "ENOSPC"
        ? CAPACITY_RETRY_DELAYS[
            Math.min(this.capacityFailures++, CAPACITY_RETRY_DELAYS.length - 1)
          ]
        : reason === "EACCES" || reason === "EPERM"
          ? 60_000
          : RETRY_DELAYS[Math.min(this.failures++, RETRY_DELAYS.length - 1)];
    const handle = this.handle;
    this.handle = null;
    this.publish({
      state: "recovering",
      generation: this.health.generation + 1,
      reason,
      nextRetryAt: Date.now() + delay,
    });
    // Closing from inside an FSEvents delivery callback can abort Electron (#629).
    if (handle)
      this.closing = new Promise<void>((resolve) =>
        setImmediate(() => {
          void this.close(handle).then(resolve);
        })
      );
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.start();
    }, delay);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const handle = this.handle;
    this.handle = null;
    this.publish({ state: "stopped", generation: this.health.generation + 1 });
    if (handle) await this.close(handle);
    await this.closing;
    await this.pending;
  }

  private async close(handle: T): Promise<void> {
    try {
      await handle.close();
    } catch (error) {
      this.closeFailed(error);
    }
  }

  private publish(health: FileWatchHealth, overflow?: WatchOverflow): void {
    this.health = health;
    this.changed(health, overflow);
  }
}
