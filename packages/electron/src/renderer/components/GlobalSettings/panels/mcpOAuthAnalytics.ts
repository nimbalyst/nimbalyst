export const MCP_OAUTH_OUTCOMES = [
  'authorized',
  'rejected',
  'timed_out',
  'failed',
] as const;

export type MCPOAuthAnalyticsOutcome = typeof MCP_OAUTH_OUTCOMES[number];

// Superset of the main-process MCPRemoteOAuthErrorType union (MCPRemoteOAuth.ts):
// every category that service can emit, plus `ipc_error` for failures at the
// renderer/IPC boundary before a categorized result comes back. Keep in sync.
export const MCP_OAUTH_ERROR_TYPES = [
  'invalid_config',
  'timeout',
  'browser_launch',
  'stale_pending_auth',
  'port_conflict',
  'command_unavailable',
  'provider_rejected',
  'dynamic_registration_unsupported',
  'callback_validation',
  'token_exchange',
  'network',
  'process_error',
  'process_exit',
  'ipc_error',
  'unknown',
] as const;

export type MCPOAuthAnalyticsErrorType = typeof MCP_OAUTH_ERROR_TYPES[number];

export interface MCPOAuthTriggerResult {
  success: boolean;
  outcome?: string;
  errorType?: string;
  error?: string;
  isStalePortError?: boolean;
  canRetryAfterCacheClear?: boolean;
}

interface BuildMCPOAuthAnalyticsPropertiesOptions {
  templateId: string | null;
  retryAfterCacheClear?: boolean;
}

export function buildMCPOAuthAnalyticsProperties(
  result: MCPOAuthTriggerResult,
  options: BuildMCPOAuthAnalyticsPropertiesOptions
): {
  templateId: string | null;
  success: boolean;
  outcome: MCPOAuthAnalyticsOutcome;
  errorType?: MCPOAuthAnalyticsErrorType;
  retryAfterCacheClear?: boolean;
} {
  const success = result.success === true;
  const outcome = success
    ? 'authorized'
    : isMCPOAuthFailureOutcome(result.outcome) ? result.outcome : 'failed';
  const errorType = success
    ? undefined
    : isMCPOAuthErrorType(result.errorType)
      ? result.errorType
      : result.isStalePortError ? 'port_conflict' : 'unknown';

  return {
    templateId: options.templateId,
    success,
    outcome,
    ...(errorType ? { errorType } : {}),
    ...(options.retryAfterCacheClear ? { retryAfterCacheClear: true } : {}),
  };
}

function isMCPOAuthFailureOutcome(
  value: string | undefined
): value is Exclude<MCPOAuthAnalyticsOutcome, 'authorized'> {
  return value === 'rejected' || value === 'timed_out' || value === 'failed';
}

function isMCPOAuthErrorType(value: string | undefined): value is MCPOAuthAnalyticsErrorType {
  return MCP_OAUTH_ERROR_TYPES.includes(value as MCPOAuthAnalyticsErrorType);
}
