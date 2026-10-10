/**
 * Dev-only: periodically clears user-timing measures.
 *
 * React DOM's development build calls `performance.measure()` for every
 * component render and scheduler update (Performance Tracks). Chromium keeps
 * those entries in the timeline until `clearMeasures()` is called, so a dev
 * renderer accumulated ~1.5M entries and hundreds of MB over a day.
 *
 * Clearing the buffer does not affect DevTools recordings: the Performance
 * panel captures user timing through tracing while it records.
 */

const TRIM_INTERVAL_MS = 30_000;

export function installUserTimingTrimmer(
  perf: Pick<Performance, 'clearMeasures'> = performance,
  intervalMs = TRIM_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => perf.clearMeasures(), intervalMs);
  return () => clearInterval(timer);
}
