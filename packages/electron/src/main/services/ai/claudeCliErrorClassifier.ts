/**
 * Classify a non-2xx upstream response from the Claude CLI API proxy into a
 * failure the rich transcript can surface (NIM-808, Phase 4 — failed-turn state).
 *
 * The `claude-code-cli` (B3) path drives the genuine CLI through a loopback
 * proxy. When a turn fails, the CLI prints to its own TUI but the rich Nimbalyst
 * transcript shows nothing. The proxy already intercepts the upstream status
 * code; this module turns `{statusCode, body}` into a typed `ClaudeCliFailure`
 * so `claudeCliErrorLog` can persist a synthetic row the existing widgets render
 * (ContextLimitWidget / RateLimitWidget / ApiServiceErrorWidget).
 *
 * Pure + dependency-free so it is trivially unit-testable.
 */

export type ClaudeCliFailureKind =
  | 'context_limit' // 400 "prompt is too long" — context window exceeded
  | 'rate_limit' // 429 — subscription / usage rate limit
  | 'overloaded' // 529 — Anthropic temporarily overloaded
  | 'auth' // 401 / 403 — credentials rejected
  | 'api_error' // other 5xx — upstream server error
  | 'generic'; // anything else (4xx we don't special-case)

export interface ClaudeCliFailure {
  kind: ClaudeCliFailureKind;
  statusCode: number;
  /** Human-readable message — the API error body's `message` when available. */
  message: string;
  /** Anthropic error `type` (e.g. `rate_limit_error`, `overloaded_error`) if parsed. */
  errorType?: string;
  /** `retry-after` header value for rate-limit / overload, when present. */
  retryAfter?: string;
}

interface ParsedErrorBody {
  errorType?: string;
  message?: string;
}

/** Best-effort parse of the Anthropic error envelope `{type:'error',error:{type,message}}`. */
function parseErrorBody(body?: string): ParsedErrorBody {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body) as { error?: { type?: unknown; message?: unknown } };
    const err = parsed?.error;
    if (err && typeof err === 'object') {
      return {
        errorType: typeof err.type === 'string' ? err.type : undefined,
        message: typeof err.message === 'string' ? err.message : undefined,
      };
    }
  } catch {
    // Non-JSON body (proxy passthrough, truncated stream, HTML error page) — fall through.
  }
  return {};
}

const DEFAULT_MESSAGES: Record<ClaudeCliFailureKind, string> = {
  context_limit: 'The conversation is too long for the model context window.',
  rate_limit: 'Rate limit reached. Claude paused this turn; it will retry shortly.',
  overloaded: 'Claude is temporarily overloaded. The turn will retry shortly.',
  auth: 'Authentication failed. Check your Claude login / credentials.',
  api_error: 'Claude API error. The turn did not complete.',
  generic: 'The Claude CLI turn failed.',
};

/**
 * Returns a typed failure for any status >= 400, or null for a success status
 * (defensive — callers only invoke this for non-2xx responses).
 */
export function classifyClaudeCliUpstreamError(input: {
  statusCode: number;
  body?: string;
  retryAfter?: string;
}): ClaudeCliFailure | null {
  const { statusCode, body, retryAfter } = input;
  if (statusCode < 400) return null;

  const parsed = parseErrorBody(body);

  let kind: ClaudeCliFailureKind;
  if (statusCode === 400 && (parsed.message ?? '').toLowerCase().includes('prompt is too long')) {
    kind = 'context_limit';
  } else if (statusCode === 429) {
    kind = 'rate_limit';
  } else if (statusCode === 529) {
    kind = 'overloaded';
  } else if (statusCode === 401 || statusCode === 403) {
    kind = 'auth';
  } else if (statusCode >= 500) {
    kind = 'api_error';
  } else {
    kind = 'generic';
  }

  return {
    kind,
    statusCode,
    message: parsed.message ?? DEFAULT_MESSAGES[kind],
    errorType: parsed.errorType,
    retryAfter,
  };
}
