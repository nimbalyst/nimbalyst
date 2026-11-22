export interface CodexPermissionProfile {
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy: 'never' | 'on-request';
  approvalsReviewer?: 'auto_review';
}

/**
 * Translate Nimbalyst's persisted project permission pair into Codex's native
 * sandbox and approval controls.
 *
 * With `userApprovals` (the app-server transport, which routes approval
 * requests to Nimbalyst's permission prompt) every mode uses `on-request`.
 * Under `never`, Codex turns any request its policy raises into a silent
 * rejection; its built-in rules reject `rm -rf` that way even with
 * `danger-full-access` (#1884). The mode then decides who answers:
 * - `ask`: read-only sandbox, so every write and edit comes to the user.
 * - `allow-all`: workspace writes run; anything else comes to the user.
 * - `bypass-all`: full access; Nimbalyst accepts every request itself.
 * - `bypass-all` + Agent-verified: Codex's automatic reviewer first, then
 *   the user for anything it passes on.
 *
 * The legacy SDK transport cannot answer approvals, so it keeps `never`.
 */
export function resolveCodexPermissionProfile(
  permissionMode: string | undefined,
  agentVerified: boolean,
  options: { userApprovals: boolean },
): CodexPermissionProfile {
  if (permissionMode === 'bypass-all' && agentVerified) {
    return {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
    };
  }

  const approvalPolicy = options.userApprovals ? 'on-request' : 'never';

  if (permissionMode === 'bypass-all') {
    return { sandboxMode: 'danger-full-access', approvalPolicy };
  }

  if (permissionMode === 'ask' && options.userApprovals) {
    return { sandboxMode: 'read-only', approvalPolicy };
  }

  return { sandboxMode: 'workspace-write', approvalPolicy };
}
