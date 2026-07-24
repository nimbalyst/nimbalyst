import React, { useEffect, useState } from 'react';

// Inject api-service-error widget styles once. Color treatment matches
// the rate-limit widget's "warning" variant (not "blocked") because these
// errors are transient and clear when the upstream incident resolves.
const injectApiServiceErrorStyles = () => {
  const styleId = 'api-service-error-widget-styles';
  if (typeof document === 'undefined') return;
  if (document.getElementById(styleId)) return;

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    .api-service-error-widget {
      background-color: color-mix(in srgb, var(--nim-warning) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--nim-warning) 25%, transparent);
    }
    .api-service-error-widget code.req-id {
      background-color: var(--nim-bg-tertiary);
      color: var(--nim-text);
      padding: 0.1rem 0.35rem;
      border-radius: 0.2rem;
      font-size: 0.8em;
      font-family: var(--font-mono, monospace);
      user-select: all;
    }
    .api-service-error-widget details > summary {
      cursor: pointer;
      user-select: none;
      color: var(--nim-text-muted);
      font-size: 0.75rem;
    }
    .api-service-error-widget details[open] > summary {
      margin-bottom: 0.4rem;
    }
    .api-service-error-widget details pre {
      background-color: var(--nim-bg-tertiary);
      color: var(--nim-text-muted);
      padding: 0.5rem;
      border-radius: 0.3rem;
      font-size: 0.72rem;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 8rem;
      overflow-y: auto;
    }
  `;
  document.head.appendChild(style);
};

interface ApiServiceErrorInfo {
  /** The HTTP status the upstream API returned (500, 529, etc.). */
  status: number | null;
  /** The 'error.type' value from the API response if present. */
  errorType: string | null;
  /** The 'error.message' value from the API response if present. */
  errorMessage: string | null;
  /** The 'request_id' from the API response. The only handle Anthropic
   *  support has to look up the server-side trace. */
  requestId: string | null;
  /** The full text we were given, kept available behind a "Show details"
   *  disclosure for users escalating to support. */
  raw: string;
}

/**
 * Parse a terminal-style upstream API error of the shape:
 *
 *   API Error: 500 {"type":"error","error":{"type":"api_error",
 *   "message":"Internal server error"},"request_id":"req_..."}
 *   Claude may be experiencing issues. Check https://status.anthropic.com
 *
 * Tolerates the response being JSON-only, line-wrapped, or wrapped in
 * extra Claude-Code style framing. Returns null fields when a piece is
 * absent rather than throwing - downstream rendering handles each case.
 */
export function parseApiServiceError(content: string): ApiServiceErrorInfo {
  const statusMatch = content.match(/\b(?:API\s+Error:\s*)?(\d{3})\b/);
  const status = statusMatch && /^5\d\d$/.test(statusMatch[1])
    ? parseInt(statusMatch[1], 10)
    : null;

  // Try to find an embedded JSON object first; fall back to loose regex.
  let errorType: string | null = null;
  let errorMessage: string | null = null;
  let requestId: string | null = null;

  const jsonMatch = content.match(/\{[\s\S]*"error"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const errObj = obj && obj.error ? obj.error : obj;
      if (errObj) {
        errorType = typeof errObj.type === 'string' ? errObj.type : null;
        errorMessage = typeof errObj.message === 'string' ? errObj.message : null;
      }
      if (typeof obj.request_id === 'string') requestId = obj.request_id;
    } catch {
      // ignore parse errors, fall through to regex
    }
  }
  if (errorType == null) {
    const typeMatch = content.match(/"type"\s*:\s*"([a-z_]+)"/);
    if (typeMatch && typeMatch[1] !== 'error') errorType = typeMatch[1];
  }
  if (errorMessage == null) {
    const msgMatch = content.match(/"message"\s*:\s*"([^"]+)"/);
    if (msgMatch) errorMessage = msgMatch[1];
  }
  if (requestId == null) {
    const ridMatch = content.match(/req_[A-Za-z0-9]{8,}/);
    if (ridMatch) requestId = ridMatch[0];
  }

  return { status, errorType, errorMessage, requestId, raw: content };
}

/**
 * Returns true if `content` looks like an upstream API service error from
 * Claude (api_error, overloaded_error) where the right user action is
 * "retry / check status page / escalate with request_id", not "file a
 * Nimbalyst bug". Conservative on purpose - we'd rather miss a borderline
 * case and render the raw error than mis-classify a real client bug as
 * "just a service hiccup".
 */
export function isApiServiceError(content: string): boolean {
  if (!content) return false;
  // Signal 1: explicit Anthropic error type token.
  if (/"type"\s*:\s*"(api_error|overloaded_error)"/.test(content)) return true;
  // Signal 2: 5xx status with a request_id, which is Anthropic's correlation
  // id format. Together these distinguish upstream errors from generic
  // 500 strings that might appear elsewhere in transcript text.
  if (/\b5\d\d\b/.test(content) && /req_[A-Za-z0-9]{8,}/.test(content)) return true;
  // Signal 3: the Claude-Code framing string, which the CLI prints after
  // the JSON and which agents commonly echo back into the transcript.
  if (/status\.(anthropic|claude)\.com/.test(content) && /\b5\d\d\b/.test(content)) return true;
  return false;
}

interface ApiServiceErrorWidgetProps {
  content: string;
}

/**
 * Human-readable surface for upstream Claude API service errors that the
 * CLI / SDK forwards verbatim into the transcript. Explains what the error
 * means, points the user at the status page, surfaces the request_id for
 * support escalation, and keeps the raw payload available behind a
 * disclosure so it can still be copy-pasted into a bug report when one is
 * genuinely warranted. See the related anthropics/claude-code issue
 * cluster (40+ duplicate reports) for the user-confusion shape this
 * widget is intended to neutralise.
 */
export const ApiServiceErrorWidget: React.FC<ApiServiceErrorWidgetProps> = ({ content }) => {
  useEffect(() => { injectApiServiceErrorStyles(); }, []);
  const [copied, setCopied] = useState(false);
  const info = parseApiServiceError(content);

  const isOverloaded = info.errorType === 'overloaded_error';
  const title = isOverloaded
    ? 'The Claude API is temporarily overloaded'
    : 'The Claude API returned a temporary error';

  const copyRequestId = async () => {
    if (!info.requestId) return;
    try {
      await navigator.clipboard.writeText(info.requestId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be denied in iframes / sandboxed contexts; the
      // request id is also selectable on the inline code element.
    }
  };

  return (
    <div className="api-service-error-widget my-3 p-3 rounded-lg flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span
          className="flex items-center justify-center w-5 h-5 rounded-full text-white text-xs font-bold"
          style={{ backgroundColor: 'var(--nim-warning)' }}
        >
          !
        </span>
        <span className="text-sm font-semibold" style={{ color: 'var(--nim-warning)' }}>
          {title}
        </span>
        {info.status != null && (
          <span className="text-[0.7rem] text-[var(--nim-text-faint)]">
            HTTP {info.status}{info.errorType ? ` · ${info.errorType}` : ''}
          </span>
        )}
      </div>

      <div className="text-[var(--nim-text-muted)] text-[0.85rem] leading-relaxed">
        {isOverloaded
          ? 'This is an upstream capacity error on the API side, not a bug in Nimbalyst. The API will accept new requests once load eases. Retrying in a minute usually works; switching to a less-loaded model also helps.'
          : 'This is a transient upstream error on the API side, not a bug in Nimbalyst. Most cases clear within a few minutes.'}
      </div>

      <ul className="text-[var(--nim-text-muted)] text-[0.8rem] leading-relaxed list-disc pl-5 m-0">
        <li>
          Check the status page at{' '}
          <a
            href="https://status.claude.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--nim-primary)] hover:underline"
          >
            status.claude.com
          </a>{' '}
          for an active incident on your model.
        </li>
        <li>Retry the request. Transient {info.errorType || 'api_error'} responses usually clear on the next attempt.</li>
        <li>If your model is listed as degraded, try a different one from Settings until the incident resolves.</li>
        {info.requestId && (
          <li>
            If the error keeps firing for more than a few minutes on the same prompt and model,
            include the request id when contacting support:{' '}
            <code className="req-id">{info.requestId}</code>{' '}
            <button
              type="button"
              onClick={copyRequestId}
              className="ml-1 text-[0.7rem] text-[var(--nim-text-faint)] hover:text-[var(--nim-text-muted)] underline-offset-2 hover:underline"
            >
              {copied ? 'copied' : 'copy'}
            </button>
          </li>
        )}
      </ul>

      <details>
        <summary>Show raw error payload</summary>
        <pre>{info.raw}</pre>
      </details>
    </div>
  );
};
