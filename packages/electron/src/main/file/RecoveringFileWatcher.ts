import type { FileWatchHealth } from "../../shared/fileWatchHealth";

export interface WatchHandle {
  close(): unknown;
}

/** Owns a replaceable native handle, independently of its subscribers (#1499). */
export class RecoveringFileWatcher<T extends WatchHandle> {
  handle: T | null = null;
  health: FileWatchHealth = { state: "starting", generation: 0 };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> | null = null;
  private closing: Promise<void> = Promise.resolve();
  private failures = 0;
  private healthySince = 0;

  constructor(
    private readonly create: (
      current: () => boolean,
      fail: (reason: string) => void
    ) => Promise<T> | T,
    private readonly changed: (health: FileWatchHealth) => void,
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
    this.pending = Promise.resolve()
      .then(async () => {
        await this.closing;
        if (!current()) return;
        try {
          const handle = await this.create(current, (reason) => {
            if (current()) this.fail(reason);
          });
          if (!current()) {
            await this.close(handle);
            return;
          }
          this.handle = handle;
          this.healthySince = Date.now();
          this.publish({ state: "watching", generation });
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

  private fail(reason: string): void {
    if (this.health.state === "stopped" || this.health.state === "recovering")
      return;
    if (
      this.health.state === "watching" &&
      Date.now() - this.healthySince >= 60_000
    )
      this.failures = 0;
    // Never restart in a tight loop under sustained FSEvents/inotify pressure.
    const delays = [1000, 5000, 15_000, 60_000];
    const delay =
      reason === "EACCES" || reason === "EPERM"
        ? 60_000
        : delays[Math.min(this.failures++, delays.length - 1)];
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

  private publish(health: FileWatchHealth): void {
    this.health = health;
    this.changed(health);
  }
}
