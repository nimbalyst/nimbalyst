/**
 * Decides whether an upstream failure from the Claude CLI proxy should be
 * surfaced as a failed-turn row in the rich transcript (NIM-808 / NIM-815).
 *
 * Two suppression rules, both scoped to the window BEFORE the first visible
 * assistant output:
 *
 *   1. Self-healing kinds (rate_limit / overloaded) never surface at startup —
 *      the CLI retries them; the proxy's cold connection reliably trips one on
 *      every fresh session's first request.
 *   2. (NIM-815) Other transient kinds (api_error / generic — e.g. a 400/500/502
 *      on the cold connection) get a small retry budget before surfacing.
 *      Previously these bypassed the startup guard and every new session opened
 *      with "The Claude CLI turn failed." even though the turn went on to work.
 *
 * Kinds that demand user action (auth) or are real turn-enders (context_limit)
 * always surface. After the first visible output, every new failure kind
 * surfaces, with a same-kind dedup so a retry storm collapses into one row per
 * episode (an episode ends when a turn produces output).
 */

import type { ClaudeCliFailure } from './claudeCliErrorClassifier';

export interface ClaudeCliErrorSurfacePolicy {
  /**
   * Note an observed assistant message. `visible` is false for hidden
   * sub-agent (Task) turns — they end a failure episode but don't close the
   * startup window (the parent turn hasn't produced output yet).
   */
  noteAssistantMessage(visible: boolean): void;
  /** Whether to surface this failure (mutates suppression state). */
  shouldSurface(failure: ClaudeCliFailure): boolean;
}

export function createClaudeCliErrorSurfacePolicy(options?: {
  /** Pre-first-output budget for transient api_error/generic failures. */
  startupTransientBudget?: number;
}): ClaudeCliErrorSurfacePolicy {
  let lastSurfacedKind: ClaudeCliFailure['kind'] | null = null;
  let hasProducedAssistantTurn = false;
  let startupTransientBudget = options?.startupTransientBudget ?? 2;

  return {
    noteAssistantMessage(visible: boolean): void {
      lastSurfacedKind = null;
      if (visible) hasProducedAssistantTurn = true;
    },

    shouldSurface(failure: ClaudeCliFailure): boolean {
      if (!hasProducedAssistantTurn) {
        const isSelfHealing = failure.kind === 'rate_limit' || failure.kind === 'overloaded';
        if (isSelfHealing) return false;

        const isStartupTransient = failure.kind === 'api_error' || failure.kind === 'generic';
        if (isStartupTransient && startupTransientBudget > 0) {
          startupTransientBudget -= 1;
          return false;
        }
      }

      if (failure.kind === lastSurfacedKind) return false;
      lastSurfacedKind = failure.kind;
      return true;
    },
  };
}
