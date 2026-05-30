/**
 * MigrationProgressReporter
 *
 * Throttled IPC emitter for the PGLite → SQLite migration. The migrator
 * streams progress events as fast as it can (often once per insert batch);
 * the renderer only needs them ~4x/sec to drive the progress bar. This class
 * coalesces bursts into one emit per ~250ms window and guarantees the final
 * event is flushed so the UI sees the terminal state.
 *
 * Channels (broadcast to every BrowserWindow):
 *   - `db:migration:progress` — payload = MigrationProgress
 *   - `db:migration:phase`    — payload = { phase, info? } — fires on every
 *                                phase transition, not throttled
 *   - `db:migration:complete` — payload = MigrationSummary
 *   - `db:migration:failed`   — payload = { phase, message, stack? }
 */

import type { MigrationProgress, MigrationSummary, MigrationPhase } from './PGLiteToSQLiteMigrator';

export const CHANNEL_PROGRESS = 'db:migration:progress';
export const CHANNEL_PHASE = 'db:migration:phase';
export const CHANNEL_COMPLETE = 'db:migration:complete';
export const CHANNEL_FAILED = 'db:migration:failed';

export interface ReporterOptions {
  /** Min ms between progress emits. Default 250. */
  throttleMs?: number;
  /**
   * Broadcast function override (mainly for tests). Defaults to
   * `BrowserWindow.getAllWindows().forEach(w => w.webContents.send(channel, payload))`.
   */
  broadcast?: (channel: string, payload: unknown) => void;
  /** Logger. */
  log?: (level: 'info' | 'warn', msg: string, meta?: unknown) => void;
}

function defaultBroadcast(channel: string, payload: unknown): void {
  // Lazy-require Electron so this module remains import-safe in the SQLite
  // worker thread (where `require('electron')` resolves but BrowserWindow is
  // not the right surface to use, and worker-side callers always inject a
  // custom broadcast that posts messages back to main via parentPort).
  let BrowserWindow: typeof import('electron').BrowserWindow;
  try {
    BrowserWindow = require('electron').BrowserWindow;
  } catch {
    return;
  }
  if (!BrowserWindow) return;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch {
      // Window may have closed between the isDestroyed check and the send.
    }
  }
}

export class MigrationProgressReporter {
  private throttleMs: number;
  private broadcast: (channel: string, payload: unknown) => void;
  private log: (level: 'info' | 'warn', msg: string, meta?: unknown) => void;

  private latestProgress: MigrationProgress | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastEmitAt = 0;
  private lastPhase: MigrationPhase | null = null;

  constructor(opts: ReporterOptions = {}) {
    this.throttleMs = opts.throttleMs ?? 250;
    this.broadcast = opts.broadcast ?? defaultBroadcast;
    this.log = opts.log ?? (() => {});
  }

  /** Hand this to `PGLiteToSQLiteMigrator.migrate({ onProgress })`. */
  readonly onProgress = (p: MigrationProgress): void => {
    this.latestProgress = p;

    // Phase transitions are unthrottled so the UI can move out of "copying"
    // into "verifying-counts" immediately.
    if (p.phase !== this.lastPhase) {
      this.lastPhase = p.phase;
      this.broadcast(CHANNEL_PHASE, { phase: p.phase, info: p });
    }

    const now = Date.now();
    const since = now - this.lastEmitAt;
    if (since >= this.throttleMs) {
      this.emit();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.emit();
      }, this.throttleMs - since);
    }
  };

  /** Force-flush the most recent progress event. Call at end of migration. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.latestProgress) this.emit();
  }

  emitComplete(summary: MigrationSummary): void {
    this.flush();
    this.broadcast(CHANNEL_COMPLETE, summary);
  }

  emitFailed(failure: { phase: string; message: string; stack?: string }): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.broadcast(CHANNEL_FAILED, failure);
  }

  private emit(): void {
    if (!this.latestProgress) return;
    this.lastEmitAt = Date.now();
    this.broadcast(CHANNEL_PROGRESS, this.latestProgress);
  }
}
