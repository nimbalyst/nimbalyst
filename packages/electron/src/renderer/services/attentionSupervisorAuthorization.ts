export interface AttentionSupervisorAuthorizationRequest {
  workspacePath: string;
  targetSessionId: string;
  targetTitle: string;
  authorized: boolean;
}

export interface AttentionSupervisorAuthorizationResult {
  cancelled?: boolean;
  success?: boolean;
  changed?: boolean;
  error?: string;
  authorizedSupervisorSessionIds?: string[];
}

export interface AttentionSupervisorAuthorizationDeps {
  promptForSupervisorId: (message: string) => string | null;
  invoke: (channel: string, payload: Record<string, unknown>) => Promise<any>;
}

const defaultDeps = (): AttentionSupervisorAuthorizationDeps => ({
  promptForSupervisorId: (message) => window.prompt(message),
  invoke: (channel, payload) => window.electronAPI.invoke(channel, payload),
});

/**
 * Human-reachable renderer bridge for the exact target selected in the session
 * context menu. Main-process window/workspace validation and the fresh native
 * confirmation dialog remain the authority boundary.
 */
export async function requestAttentionSupervisorAuthorization(
  request: AttentionSupervisorAuthorizationRequest,
  deps: AttentionSupervisorAuthorizationDeps = defaultDeps(),
): Promise<AttentionSupervisorAuthorizationResult> {
  const action = request.authorized ? 'authorize' : 'revoke';
  const supervisorSessionId = deps.promptForSupervisorId(
    `${request.authorized ? 'Authorize' : 'Revoke'} an attention supervisor for ` +
      `“${request.targetTitle}” (${request.targetSessionId}).\n\n` +
      `Enter the exact supervisor session ID to ${action}:`,
  )?.trim();
  if (!supervisorSessionId) return { cancelled: true };

  return deps.invoke('sessions:set-attention-supervisor-authorization', {
    workspacePath: request.workspacePath,
    targetSessionId: request.targetSessionId,
    supervisorSessionId,
    authorized: request.authorized,
  });
}
