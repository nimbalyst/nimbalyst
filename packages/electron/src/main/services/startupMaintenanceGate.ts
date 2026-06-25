/**
 * StartupMaintenanceGate
 *
 * A single place to defer non-essential startup maintenance (transcript
 * backfills, transient sweeps, and any future bulk pass) until the app is
 * "first usable", so that work never competes with the queries that paint the
 * first window.
 *
 * Why this exists (NIM-899): maintenance used to be fired un-awaited during
 * `RepositoryManager.initialize()` under the assumption it was "off the
 * critical path". It is not -- it runs on the shared single-threaded SQLite
 * worker, which is strictly FIFO and synchronous, so a long maintenance query
 * head-of-line-blocks every user-facing read/write queued behind it. A 12s
 * full-scan probe stalled the entire startup behind it.
 *
 * "First usable" = the first BrowserWindow's renderer finished loading
 * (`did-finish-load`) PLUS a short idle delay so the first paint/layout
 * settles. A hard ceiling releases maintenance anyway if that signal never
 * arrives (e.g. a window that fails to load), so maintenance can't be starved
 * forever.
 *
 * Policy: maintenance MUST be scheduled through `runWhenFirstUsable` (and be
 * internally chunked so no single query monopolizes the worker). Never issue an
 * un-awaited `db.query()` loop inline in startup. See packages/electron/DATABASE.md.
 */

import { logger } from '../utils/logger';

/** Idle settle time after the first window finishes loading. */
const IDLE_DELAY_MS = 2500;
/** Release maintenance regardless after this long, in case no window loads. */
const CEILING_MS = 20_000;

interface Gate {
  promise: Promise<void>;
  resolve: () => void;
  resolved: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  ceilingTimer?: ReturnType<typeof setTimeout>;
}

let gate: Gate | null = null;

function ensureGate(): Gate {
  if (gate) return gate;
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  const g: Gate = { promise, resolve, resolved: false };
  // Ceiling starts ticking the first time anything touches the gate (which is
  // during startup). `unref` so a pending ceiling timer never keeps the process
  // alive on its own.
  g.ceilingTimer = setTimeout(() => settle(g, 'ceiling timeout'), CEILING_MS);
  g.ceilingTimer.unref?.();
  gate = g;
  return g;
}

function settle(g: Gate, reason: string): void {
  if (g.resolved) return;
  g.resolved = true;
  if (g.idleTimer) clearTimeout(g.idleTimer);
  if (g.ceilingTimer) clearTimeout(g.ceilingTimer);
  logger.main.info(
    `[StartupMaintenanceGate] first-usable reached (${reason}); releasing deferred maintenance`,
  );
  g.resolve();
}

/**
 * Signal that a BrowserWindow's renderer finished loading. Only the first call
 * matters; subsequent windows are ignored. Starts the idle countdown to
 * first-usable. Safe to call before or after maintenance is registered.
 */
export function signalFirstWindowLoaded(): void {
  const g = ensureGate();
  if (g.resolved || g.idleTimer) return; // first window only
  g.idleTimer = setTimeout(() => settle(g, 'window loaded + idle'), IDLE_DELAY_MS);
  g.idleTimer.unref?.();
}

/** Resolves once the app is first-usable. Safe to await any number of times. */
export function whenFirstUsable(): Promise<void> {
  return ensureGate().promise;
}

/**
 * Schedule deferred startup maintenance. `fn` runs after first-usable; errors
 * are caught and logged so one task can neither break startup nor poison
 * sibling tasks. The label is used in timing/diagnostic logs.
 */
export function runWhenFirstUsable(label: string, fn: () => Promise<unknown> | unknown): void {
  void whenFirstUsable().then(async () => {
    const t0 = Date.now();
    try {
      await fn();
      logger.main.info(`[StartupMaintenanceGate] maintenance '${label}' done in ${Date.now() - t0}ms`);
    } catch (err) {
      logger.main.error(`[StartupMaintenanceGate] maintenance '${label}' failed:`, err);
    }
  });
}

/** Test-only: reset the singleton so each test starts from a clean gate. */
export function __resetStartupMaintenanceGateForTests(): void {
  if (gate?.idleTimer) clearTimeout(gate.idleTimer);
  if (gate?.ceilingTimer) clearTimeout(gate.ceilingTimer);
  gate = null;
}
