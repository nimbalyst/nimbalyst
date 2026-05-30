import * as electron from 'electron';
import type { IpcMainInvokeEvent } from 'electron';

/**
 * IPC Registry - Prevents duplicate IPC handler registration
 *
 * This module provides safe wrappers around ipcMain.handle() and ipcMain.on()
 * that prevent crashes from duplicate handler registration.
 *
 * Why this is needed:
 * - Dynamic imports can cause modules to be bundled into separate chunks
 * - If a chunk is loaded multiple times (or bundled with duplicated dependencies),
 *   IPC handlers may attempt to register twice
 * - Electron throws if you try to register the same handler twice
 *
 * This is defense-in-depth alongside manualChunks in vite config.
 */

const registeredHandlers = new Set<string>();
const registeredListeners = new Map<string, Set<Function>>();
const IPC_SAMPLE_CAP = 200;

interface IpcInvocationStats {
  callCount: number;
  errorCount: number;
  slowCount: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
  inFlight: number;
  maxInFlight: number;
  samples: number[];
}

export interface IpcChannelStatsSnapshot {
  channel: string;
  callCount: number;
  errorCount: number;
  slowCount: number;
  totalMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  lastMs: number;
  inFlight: number;
  maxInFlight: number;
}

const ipcStats = new Map<string, IpcInvocationStats>();

function getIpcMain(): any {
  try {
    return (electron as any)?.ipcMain;
  } catch (error: any) {
    // Vitest's strict ESM mock throws when an export is missing.
    // Treat missing ipcMain as unavailable so unit tests can provide partial mocks.
    if (
      typeof error?.message === 'string' &&
      error.message.includes('No "ipcMain" export is defined on the "electron" mock')
    ) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Slow-IPC threshold. Any `safeHandle` invocation that takes longer than
 * this logs a `[IpcSlow]` line with the channel + duration so the main log
 * surfaces accidental long-running handlers (e.g. a session:load that
 * triggers a heavy transcript reparse, or a sessions:list that holds the
 * write lane). 500ms is well below "user notices a hang" but above
 * routine query latency.
 *
 * Configurable via `NIMBALYST_IPC_SLOW_MS` for ad-hoc tuning.
 */
const IPC_SLOW_THRESHOLD_MS = (() => {
  const v = Number(process.env.NIMBALYST_IPC_SLOW_MS);
  return Number.isFinite(v) && v > 0 ? v : 1000;
})();

function ipcSlowLog(channel: string, durationMs: number): void {
  // Avoid pulling the main logger here (would tangle this module's
  // dependency graph at import time during tests); console.warn is captured
  // by the main-log pipeline the same way every other (MAIN) warn line is.
  console.warn(
    `[IpcSlow] ${channel} took ${durationMs.toFixed(0)}ms (threshold ${IPC_SLOW_THRESHOLD_MS}ms)`,
  );
}

function getOrCreateIpcStats(channel: string): IpcInvocationStats {
  let stats = ipcStats.get(channel);
  if (!stats) {
    stats = {
      callCount: 0,
      errorCount: 0,
      slowCount: 0,
      totalMs: 0,
      maxMs: 0,
      lastMs: 0,
      inFlight: 0,
      maxInFlight: 0,
      samples: [],
    };
    ipcStats.set(channel, stats);
  }
  return stats;
}

function recordDurationSample(stats: IpcInvocationStats, durationMs: number): void {
  stats.samples.push(durationMs);
  if (stats.samples.length > IPC_SAMPLE_CAP) {
    stats.samples.shift();
  }
}

function percentile(sortedValues: number[], pct: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((pct / 100) * sortedValues.length) - 1),
  );
  return sortedValues[index] ?? 0;
}

/**
 * Safe ipcMain.handle() - prevents duplicate registration
 *
 * Use this instead of ipcMain.handle() for all invoke-style handlers.
 * If the handler is already registered, this will log a warning and skip.
 *
 * Also wraps the handler with slow-call instrumentation: any invocation
 * longer than `IPC_SLOW_THRESHOLD_MS` logs `[IpcSlow] <channel> took ...ms`.
 */
export function safeHandle(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: any[]) => any
): void {
  const ipcMain = getIpcMain();
  if (!ipcMain?.handle) {
    return;
  }

  if (registeredHandlers.has(channel)) {
    console.warn(`[IPC] Handler already registered, skipping: ${channel}`);
    return;
  }

  // Wrap so we can time every invocation. We can't observe how long the
  // promise takes from outside `ipcMain.handle`, so the wrap is the only
  // place to measure end-to-end main-side handler latency.
  const instrumented = async (event: IpcMainInvokeEvent, ...args: any[]) => {
    const stats = getOrCreateIpcStats(channel);
    const t0 = performance.now();
    stats.callCount += 1;
    stats.inFlight += 1;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    try {
      return await handler(event, ...args);
    } catch (error) {
      stats.errorCount += 1;
      throw error;
    } finally {
      const dur = performance.now() - t0;
      stats.inFlight = Math.max(0, stats.inFlight - 1);
      stats.totalMs += dur;
      stats.maxMs = Math.max(stats.maxMs, dur);
      stats.lastMs = dur;
      recordDurationSample(stats, dur);
      if (dur >= IPC_SLOW_THRESHOLD_MS) {
        stats.slowCount += 1;
        ipcSlowLog(channel, dur);
      }
    }
  };

  // Special case: electron-log registers its own '__ELECTRON_LOG__' handler
  // If we try to register after electron-log has already initialized, we'll get an error
  // This can happen during HMR or if the module is bundled multiple times
  try {
    registeredHandlers.add(channel);
    ipcMain.handle(channel, instrumented);
  } catch (error: any) {
    if (error?.message?.includes('Attempted to register a second handler')) {
      console.warn(`[IPC] Handler registration failed (already exists): ${channel}`);
      // Keep the channel in our registry even though registration failed
      // This prevents us from trying again
    } else {
      // Remove from registry if registration failed for another reason
      registeredHandlers.delete(channel);
      throw error;
    }
  }
}

/**
 * Safe ipcMain.on() - prevents duplicate registration of the same handler
 *
 * Use this instead of ipcMain.on() for all event-style handlers.
 * If the exact same handler function is already registered, this will skip.
 *
 * Note: This uses function identity to detect duplicates. If you pass
 * a new function each time, it won't prevent duplicates. For handlers
 * defined inline, consider using safeOnce() or defining the handler
 * as a named function.
 */
export function safeOn(
  channel: string,
  handler: (event: Electron.IpcMainEvent, ...args: any[]) => void
): void {
  const ipcMain = getIpcMain();
  if (!ipcMain?.on) {
    return;
  }

  if (!registeredListeners.has(channel)) {
    registeredListeners.set(channel, new Set());
  }
  const handlers = registeredListeners.get(channel)!;
  if (handlers.has(handler)) {
    console.warn(`[IPC] Listener already registered, skipping: ${channel}`);
    return;
  }
  handlers.add(handler);
  ipcMain.on(channel, handler);
}

/**
 * Safe version of ipcMain.once() - prevents duplicate registration
 *
 * Note: once() handlers auto-remove after first call, but during
 * initialization we might still register the same once handler twice
 * before the first event fires.
 */
export function safeOnce(
  channel: string,
  handler: (event: Electron.IpcMainEvent, ...args: any[]) => void
): void {
  const ipcMain = getIpcMain();
  if (!ipcMain?.once) {
    return;
  }

  if (!registeredListeners.has(channel)) {
    registeredListeners.set(channel, new Set());
  }
  const handlers = registeredListeners.get(channel)!;
  if (handlers.has(handler)) {
    console.warn(`[IPC] Once listener already registered, skipping: ${channel}`);
    return;
  }
  handlers.add(handler);

  // Wrap to remove from our tracking when the handler fires
  const wrappedHandler = (event: Electron.IpcMainEvent, ...args: any[]) => {
    handlers.delete(handler);
    handler(event, ...args);
  };
  ipcMain.once(channel, wrappedHandler);
}

/**
 * Remove a handler (for cleanup or replacement)
 */
export function removeHandler(channel: string): void {
  const ipcMain = getIpcMain();
  if (!ipcMain?.removeHandler) {
    return;
  }

  if (registeredHandlers.has(channel)) {
    registeredHandlers.delete(channel);
    ipcMain.removeHandler(channel);
  }
}

/**
 * Remove all listeners for a channel
 */
export function removeAllListeners(channel: string): void {
  const ipcMain = getIpcMain();
  if (!ipcMain?.removeAllListeners) {
    return;
  }

  registeredListeners.delete(channel);
  ipcMain.removeAllListeners(channel);
}

/**
 * Check if a handler is registered (for debugging)
 */
export function isHandlerRegistered(channel: string): boolean {
  return registeredHandlers.has(channel);
}

/**
 * Get count of registered handlers (for debugging)
 */
export function getRegisteredHandlerCount(): number {
  return registeredHandlers.size;
}

/**
 * Get all registered handler channels (for debugging)
 */
export function getRegisteredChannels(): string[] {
  return Array.from(registeredHandlers);
}

export function getIpcStatsSnapshot(limit?: number): IpcChannelStatsSnapshot[] {
  const rows = Array.from(ipcStats.entries()).map(([channel, stats]) => {
    const sortedSamples = [...stats.samples].sort((a, b) => a - b);
    return {
      channel,
      callCount: stats.callCount,
      errorCount: stats.errorCount,
      slowCount: stats.slowCount,
      totalMs: Number(stats.totalMs.toFixed(2)),
      avgMs: stats.callCount > 0 ? Number((stats.totalMs / stats.callCount).toFixed(2)) : 0,
      p50Ms: Number(percentile(sortedSamples, 50).toFixed(2)),
      p95Ms: Number(percentile(sortedSamples, 95).toFixed(2)),
      maxMs: Number(stats.maxMs.toFixed(2)),
      lastMs: Number(stats.lastMs.toFixed(2)),
      inFlight: stats.inFlight,
      maxInFlight: stats.maxInFlight,
    } satisfies IpcChannelStatsSnapshot;
  });

  rows.sort((a, b) =>
    b.totalMs - a.totalMs ||
    b.callCount - a.callCount ||
    b.p95Ms - a.p95Ms ||
    a.channel.localeCompare(b.channel),
  );

  return typeof limit === 'number' ? rows.slice(0, Math.max(0, limit)) : rows;
}
