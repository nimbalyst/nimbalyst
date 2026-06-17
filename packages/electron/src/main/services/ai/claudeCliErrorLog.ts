/**
 * Persist a failed `claude-code-cli` turn into the rich transcript (NIM-808,
 * Phase 4 — failed-turn state).
 *
 * The B3 CLI path drives the genuine `claude` through a loopback API proxy. When
 * an upstream request fails (rate limit, overload, auth, context limit, 5xx), the
 * CLI prints to its own TUI but the rich Nimbalyst transcript previously showed
 * NOTHING — a rate-limited or failed turn looked identical to a live hang. This
 * writer persists a synthetic `{type:'error', error}` row (the same shape the SDK
 * error path uses, parsed at `ClaudeCodeRawParser` ~L302) so the existing error
 * widgets render: ContextLimitWidget / ApiServiceErrorWidget / LoginRequiredWidget,
 * or a plain visible red block for everything else.
 *
 * Deps are injected so the row shape + broadcast are unit-testable without a DB
 * or a BrowserWindow.
 */

import { AgentMessagesRepository } from '@nimbalyst/runtime';
import { broadcastMessageLogged } from './claudeCliUserPromptLog';
import type { ClaudeCliFailure } from './claudeCliErrorClassifier';

export interface LogClaudeCliUpstreamErrorInput {
  sessionId: string;
  workspacePath: string;
  failure: ClaudeCliFailure;
}

export interface LogClaudeCliUpstreamErrorDeps {
  createMessage: (row: {
    sessionId: string;
    source: 'claude-code';
    direction: 'output';
    content: string;
    hidden: boolean;
    createdAt: Date;
  }) => Promise<unknown>;
  notifyMessageLogged: (sessionId: string, workspacePath: string) => void;
  now: () => Date;
}

/**
 * Build the `content` string for the synthetic error row. The shape is what
 * `ClaudeCodeRawParser` parses for `parsed.type === 'error'`:
 *   - `error` may be a string (rendered verbatim) or an object (JSON-stringified
 *     by the parser, so its `"type"` token survives for widget detection).
 *   - `is_auth_error: true` routes to the login widget.
 *
 * Routing intent (detection lives in `MessageSegment`):
 *   - context_limit → keep the "prompt is too long" / "context window" phrase →
 *     ContextLimitWidget.
 *   - auth → `is_auth_error` → LoginRequiredWidget.
 *   - overloaded / api_error → carry the `overloaded_error` / `api_error` type
 *     token (object form) → ApiServiceErrorWidget.
 *   - rate_limit / generic → plain human sentence → visible red error block
 *     (clear "paused, retrying" copy; no scary raw JSON).
 */
export function buildClaudeCliErrorContent(failure: ClaudeCliFailure): string {
  if (failure.kind === 'overloaded' || failure.kind === 'api_error') {
    const errorType = failure.errorType ?? (failure.kind === 'overloaded' ? 'overloaded_error' : 'api_error');
    return JSON.stringify({
      type: 'error',
      error: { type: errorType, message: failure.message, statusCode: failure.statusCode },
    });
  }

  const payload: { type: 'error'; error: string; is_auth_error?: boolean } = {
    type: 'error',
    error: failure.message,
  };
  if (failure.kind === 'auth') payload.is_auth_error = true;
  return JSON.stringify(payload);
}

const productionDeps: LogClaudeCliUpstreamErrorDeps = {
  createMessage: (row) => AgentMessagesRepository.create(row),
  notifyMessageLogged: broadcastMessageLogged,
  now: () => new Date(),
};

/**
 * Persist the failure as a visible `direction:'output'` error row, then broadcast
 * a transcript reload. Best-effort: a repository failure is swallowed (the CLI
 * turn itself is unaffected; we never want error-logging to throw into the proxy).
 */
export async function logClaudeCliUpstreamError(
  input: LogClaudeCliUpstreamErrorInput,
  deps: LogClaudeCliUpstreamErrorDeps = productionDeps,
): Promise<void> {
  try {
    await deps.createMessage({
      sessionId: input.sessionId,
      source: 'claude-code',
      direction: 'output',
      content: buildClaudeCliErrorContent(input.failure),
      hidden: false,
      createdAt: deps.now(),
    });
    deps.notifyMessageLogged(input.sessionId, input.workspacePath);
  } catch (err) {
    console.warn('[ClaudeCliErrorLog] Failed to persist upstream error row:', err);
  }
}
