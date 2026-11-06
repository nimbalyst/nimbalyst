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
