/**
 * Startup Timing Instrumentation
 *
 * Provides lightweight timing instrumentation for measuring main process
 * initialization performance. Enable with NIMBALYST_STARTUP_TIMING=true
 * environment variable.
 *
 * Also exports `timeStartupPhase`, an always-on wrapper that logs only when
 * a phase exceeds a slowness threshold -- so user-submitted logs reveal which
 * startup operations are responsible when the app feels frozen on launch.
 */

import { logger } from './logger';

const isEnabled = process.env.NIMBALYST_STARTUP_TIMING === 'true' ||
                  process.env.NODE_ENV === 'development';

const startupStart = Date.now();
const timings: Map<string, { start: number; end?: number }> = new Map();

/** Default slow-phase threshold. Below this we stay silent on the happy path. */
export const DEFAULT_SLOW_STARTUP_MS = 2000;

/**
 * Mark the start of a timed section.
 * @param name Identifier for this section (e.g., 'database-init')
 */
export function markStart(name: string): void {
  if (!isEnabled) return;
  timings.set(name, { start: Date.now() });
}

/**
 * Mark the end of a timed section and log the duration.
 * @param name Identifier for this section (must match markStart name)
 */
export function markEnd(name: string): void {
  if (!isEnabled) return;

  const timing = timings.get(name);
  if (!timing) {
    console.warn(`[STARTUP] No start mark found for: ${name}`);
    return;
  }

  timing.end = Date.now();
  const duration = timing.end - timing.start;
  const elapsed = timing.end - startupStart;

  console.log(`[STARTUP] ${name}: ${duration}ms (total: ${elapsed}ms)`);
}

/**
 * Log a timing checkpoint (instant mark, no duration).
 * @param name Identifier for this checkpoint
 */
export function checkpoint(name: string): void {
  if (!isEnabled) return;

  const elapsed = Date.now() - startupStart;
  console.log(`[STARTUP] ${name}: +${elapsed}ms`);
}

/**
 * Get a summary of all recorded timings.
 */
export function getSummary(): Record<string, { duration: number; total: number }> {
  const summary: Record<string, { duration: number; total: number }> = {};

  for (const [name, timing] of timings) {
    if (timing.end) {
      summary[name] = {
        duration: timing.end - timing.start,
        total: timing.end - startupStart
      };
    }
  }

  return summary;
}

/**
 * Wrap a startup-phase async operation. Always runs (independent of
 * NIMBALYST_STARTUP_TIMING). Emits a single info-level log iff the phase
 * exceeds `thresholdMs`, so the happy path stays quiet but slow startup
 * paths are visible in user-submitted logs without us asking the user
 * to enable instrumentation first.
 *
 * The `[StartupSlow]` tag is greppable.
 */
export async function timeStartupPhase<T>(
  name: string,
  fn: () => Promise<T>,
  thresholdMs: number = DEFAULT_SLOW_STARTUP_MS,
): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    const duration = Date.now() - start;
    if (duration >= thresholdMs) {
      logger.main.info(`[StartupSlow] ${name} took ${duration}ms (threshold ${thresholdMs}ms)`);
    }
  }
}

/**
 * Log the final startup summary.
 */
export function logSummary(): void {
  if (!isEnabled) return;

  const totalTime = Date.now() - startupStart;
  console.log('\n[STARTUP] === Summary ===');
  console.log(`[STARTUP] Total startup time: ${totalTime}ms`);

  const summary = getSummary();
  const entries = Object.entries(summary).sort((a, b) => b[1].duration - a[1].duration);

  console.log('[STARTUP] Top operations by duration:');
  for (const [name, { duration }] of entries.slice(0, 10)) {
    const pct = ((duration / totalTime) * 100).toFixed(1);
    console.log(`[STARTUP]   ${name}: ${duration}ms (${pct}%)`);
  }
  console.log('[STARTUP] ==================\n');
}
