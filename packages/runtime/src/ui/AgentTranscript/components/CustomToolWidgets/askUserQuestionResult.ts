/**
 * Pure result parsing for the AskUserQuestion tool. Shared by the widget and
 * the transcript's prompts menu, which lists answered questions.
 */

export function parseAnswers(args: any, result: any): Record<string, string> {
  // Check arguments first
  if (args?.answers && typeof args.answers === 'object') {
    return args.answers;
  }

  const parseFromUnknown = (value: unknown): Record<string, string> => {
    if (!value) return {};

    if (typeof value === 'string') {
      try {
        return parseFromUnknown(JSON.parse(value));
      } catch {
        // Try SDK string format: "question"="answer"
        const answers: Record<string, string> = {};
        const regex = /"([^"]+)"="([^"]+)"/g;
        let match;
        while ((match = regex.exec(value)) !== null) {
          answers[match[1]] = match[2];
        }
        return answers;
      }
    }

    // Handle MCP content arrays: [{ type: "text", text: "..." }]
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && (item as any).type === 'text' && typeof (item as any).text === 'string') {
          const nested = parseFromUnknown((item as any).text);
          if (Object.keys(nested).length > 0) return nested;
        }
      }
      return {};
    }

    if (typeof value !== 'object') {
      return {};
    }

    const record = value as Record<string, unknown>;
    if (record.answers && typeof record.answers === 'object' && !Array.isArray(record.answers)) {
      const answers: Record<string, string> = {};
      for (const [key, rawValue] of Object.entries(record.answers as Record<string, unknown>)) {
        if (typeof rawValue === 'string') {
          answers[key] = rawValue;
        }
      }
      if (Object.keys(answers).length > 0) {
        return answers;
      }
    }

    if (record.result !== undefined) {
      const nested = parseFromUnknown(record.result);
      if (Object.keys(nested).length > 0) {
        return nested;
      }
    }

    if (record.content !== undefined) {
      const nested = parseFromUnknown(record.content);
      if (Object.keys(nested).length > 0) {
        return nested;
      }
    }

    if (record.text !== undefined) {
      const nested = parseFromUnknown(record.text);
      if (Object.keys(nested).length > 0) {
        return nested;
      }
    }

    return {};
  };

  const parsed = parseFromUnknown(result);
  if (Object.keys(parsed).length > 0) {
    return parsed;
  }

  return {};
}

export interface CancelledState {
  cancelled: boolean;
  /** Why the prompt closed, e.g. `superseded` when the user sent a new message instead. */
  reason?: string;
}

const NOT_CANCELLED: CancelledState = { cancelled: false };

export function parseCancelledResult(result: unknown): CancelledState {
  if (!result) return NOT_CANCELLED;

  if (typeof result === 'string') {
    try {
      return parseCancelledResult(JSON.parse(result));
    } catch {
      const lower = result.toLowerCase();
      return { cancelled: lower.includes('cancelled') || lower.includes('canceled') };
    }
  }

  // Handle MCP content arrays: [{ type: "text", text: "..." }]
  if (Array.isArray(result)) {
    for (const item of result) {
      if (item && typeof item === 'object' && (item as any).type === 'text' && typeof (item as any).text === 'string') {
        const nested = parseCancelledResult((item as any).text);
        if (nested.cancelled) return nested;
      }
    }
    return NOT_CANCELLED;
  }

  if (typeof result !== 'object') {
    return NOT_CANCELLED;
  }

  const record = result as Record<string, unknown>;
  if (record.cancelled === true || record.canceled === true) {
    return { cancelled: true, reason: typeof record.reason === 'string' ? record.reason : undefined };
  }

  for (const nestedValue of [record.result, record.content, record.text]) {
    if (nestedValue === undefined) continue;
    const nested = parseCancelledResult(nestedValue);
    if (nested.cancelled) return nested;
  }

  return NOT_CANCELLED;
}

/**
 * Errored results that do not end the prompt: an interrupt (#1116) or an MCP
 * timeout leaves the question pending on the host, so the form stays
 * answerable. Anchored to the exact text their producers emit (the CLI's
 * interrupt and rejection messages, the MCP SDK's RequestTimeout McpError) so
 * hook text that merely mentions one of these phrases is still a denial.
 */
const ANSWERABLE_ERROR = [
  /^\[Request interrupted by user[^\]]*\]$/,
  /^The user doesn['\u2019]t want to proceed with this tool use\./,
  /^MCP error -32001: Request timed out/,
];

/** The permission layer's own refusal; it closes the question as declined. */
const PERMISSION_DENIAL = /^The user doesn['\u2019]t want to take this action/;

/** Flatten a tool result (string, MCP content array, or `{ text }`) to its text. */
export function toolResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    return result
      .map((item) => (item && typeof item === 'object' && typeof (item as any).text === 'string' ? (item as any).text : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    for (const nested of [record.text, record.content, record.result, record.error]) {
      const text = nested === undefined ? '' : toolResultText(nested);
      if (text) return text;
    }
  }
  return '';
}

/** `{ cancelled: true }` as a value, JSON text, or MCP content array. No substring matching. */
function parseStructuredCancel(value: unknown): CancelledState | null {
  if (typeof value === 'string') {
    try {
      return parseStructuredCancel(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object' && typeof (item as any).text === 'string') {
        const nested = parseStructuredCancel((item as any).text);
        if (nested) return nested;
      }
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.cancelled === true || record.canceled === true) {
    return { cancelled: true, reason: typeof record.reason === 'string' ? record.reason : undefined };
  }
  return null;
}

export type ErroredQuestionOutcome =
  | { kind: 'cancelled'; reason?: string }
  | { kind: 'open' }
  | { kind: 'blocked'; reason: string };

/**
 * How to read an errored question tool result, or null when it is not an
 * error. Every answer path in the app reports `isError: false`; errors carry
 * only a structured cancel. So an error is never parsed for answers: it is a
 * structured cancel, one of the exact open-question errors, or blocked, e.g.
 * a PreToolUse hook denied the call (#1577). A blocked call has no prompt
 * behind it and must never become answerable.
 */
export function erroredQuestionOutcome(
  toolCall: { isError?: boolean; status?: string; result?: unknown } | undefined,
): ErroredQuestionOutcome | null {
  if (!toolCall) return null;
  if (toolCall.isError !== true && toolCall.status !== 'error') return null;
  const cancel = parseStructuredCancel(toolCall.result);
  if (cancel) return { kind: 'cancelled', reason: cancel.reason };
  const text = toolResultText(toolCall.result).trim();
  if (PERMISSION_DENIAL.test(text)) return { kind: 'cancelled', reason: 'declined' };
  if (ANSWERABLE_ERROR.some((pattern) => pattern.test(text))) return { kind: 'open' };
  return { kind: 'blocked', reason: text };
}
