export interface CodexPermissionProfile {
  sandboxMode: 'workspace-write' | 'danger-full-access';
  approvalPolicy: 'never' | 'on-request';
  approvalsReviewer?: 'auto_review';
}

/**
 * Translate Nimbalyst's persisted project permission pair into Codex's native
 * sandbox and approval controls.
 *
 * `bypass-all` remains literal unrestricted access unless the project opted
 * into Agent-verified checks. In that case Codex uses its low-friction local
 * automation preset and routes eligible approval requests through its
 * automatic reviewer.
 */
export function resolveCodexPermissionProfile(
  permissionMode: string | undefined,
  agentVerified: boolean,
): CodexPermissionProfile {
  if (permissionMode === 'bypass-all' && agentVerified) {
    return {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
    };
  }

  if (permissionMode === 'bypass-all') {
    return {
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
    };
  }

  return {
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
  };
}
