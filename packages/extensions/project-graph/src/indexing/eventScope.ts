/** Metadata covers all history; the caller separately chooses event retrieval bounds. */
import type { ResolvedIndexOptions } from './types';
import { precedingRange } from '../prototypes/range';

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Event history retained by default.
 *
 * Metadata is all-history; EVENTS are not. Walking `--name-only` across 6,117
 * commits on every load to populate a view that opens on the last week is a
 * cost nobody asked for. Ninety days covers the default and the 30/90 controls,
 * and a caller that selects an older or wider window gets that window instead —
 * the default is a floor, never a ceiling on what can be asked for.
 */
export const DEFAULT_EVENT_HORIZON_DAYS = 90;

export interface EventWindow {
  startMs: number;
  endMs: number;
}

export interface PrecedingWindow extends EventWindow {
  /**
   * True when the current period had not finished, so this window covers only
   * the matching elapsed slice of the preceding one.
   */
  partial: boolean;
  /** Elapsed duration both sides of the comparison cover. */
  elapsedMs: number;
}

export interface EventScopeConfig {
  /** `all` (default) applies no event bound. `window` bounds event retrieval. */
  mode: 'all' | 'window';
  window?: EventWindow;
  /** Supply to override the derived preceding period. */
  precedingWindow?: EventWindow;
}

export interface ResolvedEventScope {
  mode: 'all' | 'window';
  /** `null` in `all` mode — no bound, not an infinite range. */
  current: EventWindow | null;
  preceding: PrecedingWindow | null;
  /** What `SourceCoverage.window` reports. Nulls mean "no bound". */
  coverageWindow: { startMs: number | null; endMs: number | null };
}

/**
 * Turn the configured options into the windows the sources and detail fetches
 * actually use.
 *
 * `window` mode with no window falls back to `all`: stating "all history" is
 * honest, whereas inventing a default range would silently bound an answer the
 * caller never scoped.
 */
export function resolveEventWindows(
  options: ResolvedIndexOptions,
  context: { nowMs: number },
): ResolvedEventScope {
  const configured = options.eventScope;
  let current: EventWindow | null = configured.mode === 'window' ? (configured.window ?? null) : null;

  // `historyHorizonMs` predates the scope config and means "the last N ms".
  // Keeping it working as a window ending now means an existing caller does not
  // have to migrate to get the same bound.
  if (!current && options.historyHorizonMs != null) {
    current = { startMs: context.nowMs - options.historyHorizonMs, endMs: context.nowMs };
  }

  // The shell supplies its default 90-day horizon and widens it for older views.
  if (!current) {
    return { mode: 'all', current: null, preceding: null, coverageWindow: { startMs: null, endMs: null } };
  }

  const preceding: PrecedingWindow = configured.precedingWindow
    ? // A caller-supplied window is taken as given. It cannot claim the
      // elapsed-matching guarantee, so it is never reported as partial.
      { ...configured.precedingWindow, partial: false, elapsedMs: Math.max(0, configured.precedingWindow.endMs - configured.precedingWindow.startMs) }
    : (() => {
        const endMs = Math.min(current.endMs, context.nowMs);
        const elapsedMs = Math.max(0, endMs - current.startMs + 1);
        return {
          ...precedingRange({ startMs: current.startMs, endMs: Math.max(current.startMs - 1, endMs) }),
          partial: endMs < current.endMs,
          elapsedMs,
        };
      })();

  return {
    mode: 'window',
    current,
    preceding,
    coverageWindow: { startMs: current.startMs, endMs: current.endMs },
  };
}
