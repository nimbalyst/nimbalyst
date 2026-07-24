export function extractResultChunkErrorMessage(chunk: any): string {
  let errorMessage = chunk.result || chunk.error || chunk.message || chunk.error_message;

  if (typeof errorMessage === 'string') {
    if (errorMessage.includes('API Error:')) {
      const apiErrorMatch = errorMessage.match(/API Error: \d+ (.*?)(?:\s*·|$)/);
      if (apiErrorMatch) {
        try {
          const errorJson = JSON.parse(apiErrorMatch[1]);
          if (errorJson.error?.message) {
            errorMessage = errorJson.error.message;
          }
        } catch {
          // Keep original message on parse failure.
        }
      }
    }
    return errorMessage;
  }

  return JSON.stringify(chunk, null, 2);
}

export function detectResultChunkErrorFlags(errorMessage: string): {
  isAuthError: boolean;
  isExpiredSessionError: boolean;
  isServerError: boolean;
} {
  const lowerError = errorMessage.toLowerCase();

  const isAuthError = (
    lowerError.includes('invalid api key') ||
    lowerError.includes('authentication') ||
    lowerError.includes('unauthorized') ||
    lowerError.includes('401')
  );

  const isExpiredSessionError = (
    lowerError.includes('no conversation found') ||
    lowerError.includes('session not found') ||
    lowerError.includes('conversation not found')
  );

  const isServerError = (
    lowerError.includes('internal server error') ||
    lowerError.includes('500') ||
    errorMessage.includes('"type":"api_error"')
  );

  return {
    isAuthError,
    isExpiredSessionError,
    isServerError,
  };
}

export function buildBedrockToolErrorGuidance(errorMessage: string): string {
  const settingsShortcut = process.platform === 'darwin' ? 'Cmd+,' : 'Ctrl+,';
  return [
    `MCP Tool Error: ${errorMessage}`,
    '',
    'This error occurs because some alternative AI providers don\'t fully support deferred tool loading (tool search).',
    '',
    'To fix this:',
    `1. Open Settings (${settingsShortcut})`,
    '2. Go to "Claude Code" panel',
    '3. In the "Environment Variables" section, add:',
    '   ENABLE_TOOL_SEARCH = false',
    '4. Save and retry your request',
    '',
    'This will load all MCP tools upfront instead of deferring them.'
  ].join('\n');
}

export function isAuthenticationSummary(summary: string): boolean {
  const lowerSummary = summary.toLowerCase();
  return (
    lowerSummary.includes('invalid api key') ||
    lowerSummary.includes('please run /login') ||
    lowerSummary.includes('401 unauthorized') ||
    lowerSummary.includes('unauthorized error') ||
    lowerSummary.includes('oauth token has expired') ||
    lowerSummary.includes('token has expired') ||
    lowerSummary.includes('expired token') ||
    lowerSummary.includes('please obtain a new token') ||
    lowerSummary.includes('refresh your existing token') ||
    lowerSummary.includes('authentication_error') ||
    lowerSummary.includes('authentication required') ||
    /\b\/login\b/.test(lowerSummary)
  );
}
