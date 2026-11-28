export type NativeFileEvent = 'change' | 'rename' | 'add' | 'unlink';

/** A dropped backlog costs its events, not the native handle that produced them. */
export interface NativeFileEventOverflow {
  /** The pending backlog was discarded; its `dropped` events are lost. */
  overflowed(dropped: number): void;
  /** Every event that arrived after the last overflow has been delivered. */
  resynced(): void;
}

/** Bound pending work, not total event volume: checkouts are ordinary traffic. */
export class NativeFileEventQueue {
  private readonly pending = new Map<string, { type: NativeFileEvent; file: string; at: number }>();
  private scheduled = false;
  private stopped = false;
  private overflowing = false;
  private delivered = 0;
  private batchStarted = performance.now();
  private waiters: Array<() => void> = [];
  constructor(
    private readonly current: () => boolean,
    private readonly deliver: (type: NativeFileEvent, file: string, at: number) => void,
    private readonly overflow: NativeFileEventOverflow,
  ) {}

  push(type: NativeFileEvent, file: string): void {
    if (this.stopped || !this.current()) return;
    if (!this.scheduled && !this.pending.size) { this.delivered = 0; this.batchStarted = performance.now(); }
    const event = { type, file, at: Date.now() };
    // Keep ordinary single notifications synchronous; expensive bursts yield.
    if (!this.pending.size && this.delivered < 128 && performance.now() - this.batchStarted < 4) {
      this.delivered++;
      this.deliver(type, file, event.at);
    } else {
      const key = type + '\0' + file;
      const previous = this.pending.get(key);
      if (previous) {
        // Keep the earliest boundary: a duplicate must not move old work into a new tool.
        event.at = previous.at;
        this.pending.delete(key);
      } else if (this.pending.size >= 16_384) {
        // Drop the backlog but keep the handle; this event starts the next one.
        const dropped = this.pending.size;
        this.pending.clear();
        this.overflowing = true;
        this.resolveWaiters();
        this.overflow.overflowed(dropped);
      }
      this.pending.set(key, event);
    }
    this.schedule();
  }
  private schedule(): void {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.delivered = 0;
      this.batchStarted = performance.now();
      if (!this.current()) this.stop();
      for (const [key, event] of this.pending) {
        if (this.delivered >= 128 || performance.now() - this.batchStarted >= 4) break;
        this.pending.delete(key);
        this.delivered++;
        this.deliver(event.type, event.file, event.at);
        if (!this.current()) { this.stop(); break; }
      }
      if (this.pending.size) { this.schedule(); return; }
      this.resolveWaiters();
      if (this.overflowing && !this.stopped) {
        this.overflowing = false;
        this.overflow.resynced();
      }
    });
  }
  drain(): Promise<void> {
    if (!this.pending.size) return Promise.resolve();
    return new Promise(resolve => this.waiters.push(resolve));
  }
  stop(): void {
    this.stopped = true;
    this.pending.clear();
    this.resolveWaiters();
  }
  private resolveWaiters(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}
