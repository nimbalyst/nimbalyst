/**
 * Keeps the Crew gutter badge current while the panel is closed. The badge
 * value comes from the same rule the panel uses (`crewGutterBadge`); this only
 * decides when to send it: coalesced after bursts of changes, and only when
 * the value or tone actually changed, so a steady crew never re-sends.
 */

export interface GutterBadge {
  value: number | null;
  tone: 'default' | 'warning';
}

export interface BadgePublisherDeps {
  compute(): Promise<GutterBadge>;
  send(badge: GutterBadge): Promise<void>;
  log(message: string, data?: unknown): void;
  /** Coalescing delay after a change request. */
  delayMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class BadgePublisher {
  private lastSent: string | null = null;
  private timer: unknown = null;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(private readonly deps: BadgePublisherDeps) {}

  /** Something the badge depends on may have changed; publish soon. */
  request(): void {
    if (this.timer !== null) return;
    const run = () => {
      this.timer = null;
      void this.publish();
    };
    this.timer = this.deps.setTimer ? this.deps.setTimer(run, this.deps.delayMs ?? 1_000) : setTimeout(run, this.deps.delayMs ?? 1_000);
  }

  /** Computes the badge and sends it if it differs from what was last sent. Never throws. */
  publish(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          const badge = await this.deps.compute();
          const key = `${badge.value}|${badge.tone}`;
          if (key === this.lastSent) continue;
          await this.deps.send(badge);
          this.lastSent = key;
        } catch (error) {
          // Not recorded as sent, so the next change or tick retries it.
          this.deps.log('Crew gutter badge update failed', { error: String(error) });
        }
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  stop(): void {
    if (this.timer === null) return;
    if (this.deps.clearTimer) this.deps.clearTimer(this.timer);
    else clearTimeout(this.timer as ReturnType<typeof setTimeout>);
    this.timer = null;
  }
}
