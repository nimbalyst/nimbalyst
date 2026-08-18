/**
 * Promise-based ack for "flush dirty editors before closing this window".
 *
 * "Merge All Windows" (`consolidateWorkspaceWindows.ts`) closes fully-migrated
 * donor windows once their paths are confirmed registered in the target. The
 * window's own `windowState.documentEdited` guard is decorative -- nothing in
 * the codebase ever sets it `true` -- so it cannot be relied on to stop a
 * donor with unsaved buffers from being closed. This module is the real
 * guard: it asks the donor's renderer to flush every dirty editor to disk and
 * waits for a definitive ack (flushed / still dirty / no ack in time) before
 * the caller is allowed to call `.close()`.
 *
 * Same request/ack/timeout shape as `railSeeding.ts`'s `seedProjectIntoWindow`
 * -- read that file for the pattern this mirrors. A single `safeOn` listener
 * is registered once for the process lifetime and dispatches every ack by
 * `requestId`.
 */

import type { BrowserWindow, IpcMainEvent } from 'electron';
import { randomUUID } from 'crypto';
import { safeOn } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';

/** Main -> renderer request: "flush every dirty editor now". */
export const FLUSH_BEFORE_CLOSE_CHANNEL = 'window:flush-before-close';
/** Renderer -> main ack, keyed by `requestId`. */
export const FLUSH_BEFORE_CLOSE_RESULT_CHANNEL = 'window:flush-before-close-result';

/** Renderer-reported outcomes, plus `'timeout'` for "no ack landed in time"
 *  (ack timeout, or the target window was destroyed before one arrived). */
export type FlushBeforeCloseOutcome = 'flushed' | 'still-dirty' | 'timeout';

const DEFAULT_FLUSH_TIMEOUT_MS = 5000;

interface PendingFlush {
  resolve: (outcome: FlushBeforeCloseOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  onWindowClosed: () => void;
  window: BrowserWindow;
}

const pending = new Map<string, PendingFlush>();

function settle(requestId: string, outcome: FlushBeforeCloseOutcome): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);
  clearTimeout(entry.timer);
  entry.window.removeListener('closed', entry.onWindowClosed);
  entry.resolve(outcome);
}

// Registered once at module load -- the single main-process listener for
// every `flushWindowBeforeClose` ack, dispatched by `requestId`. Uses
// `safeOn` (never raw `ipcMain`) per the main-process init rules.
safeOn(
  FLUSH_BEFORE_CLOSE_RESULT_CHANNEL,
  (_event: IpcMainEvent, data: { requestId?: string; outcome?: FlushBeforeCloseOutcome }) => {
    if (!data?.requestId || !data.outcome) return;
    settle(data.requestId, data.outcome);
  },
);

export interface FlushWindowBeforeCloseOptions {
  /** How long to wait for the ack before resolving `'timeout'`. */
  timeoutMs?: number;
}

/**
 * Send `window:flush-before-close` to `window` and resolve once the
 * renderer acks on `window:flush-before-close-result`, or `'timeout'` if no
 * ack lands within `timeoutMs`, or the window is destroyed first.
 *
 * Never leaves a dangling pending entry: the timer and the window's
 * `'closed'` listener are both cleaned up on ack, on timeout, and on window
 * destruction (whichever happens first settles the promise and clears the
 * other two).
 */
export function flushWindowBeforeClose(
  window: BrowserWindow,
  options: FlushWindowBeforeCloseOptions = {},
): Promise<FlushBeforeCloseOutcome> {
  const { timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS } = options;

  if (window.isDestroyed()) {
    return Promise.resolve('timeout');
  }

  const requestId = randomUUID();

  return new Promise<FlushBeforeCloseOutcome>((resolve) => {
    const onWindowClosed = () => {
      logger.main.warn(
        '[FlushWindowBeforeClose] target window closed before flush ack landed',
      );
      settle(requestId, 'timeout');
    };

    const timer = setTimeout(() => {
      logger.main.warn(
        '[FlushWindowBeforeClose] timed out waiting for flush-before-close ack',
      );
      settle(requestId, 'timeout');
    }, timeoutMs);

    pending.set(requestId, { resolve, timer, onWindowClosed, window });
    window.once('closed', onWindowClosed);

    window.webContents.send(FLUSH_BEFORE_CLOSE_CHANNEL, { requestId });
  });
}

/** Test-only: number of acks/timeouts still awaited. Used to assert no leak. */
export function getPendingFlushCountForTests(): number {
  return pending.size;
}
