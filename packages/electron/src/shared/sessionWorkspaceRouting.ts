export interface SessionWorkspaceRoutingInput {
  subscribedWorkspacePath?: string | null;
  eventWorkspacePath?: string | null;
  sessionWorkspacePath?: string | null;
}

/**
 * Resolve the canonical workspace owner for a session event.
 *
 * Worktree sessions often emit lifecycle events from the worktree path while the
 * session itself belongs to the parent project's workspace_id. Prefer the
 * persisted session workspace when available so list-scoped UIs stay in sync.
 */
export function resolveOwnedWorkspacePath(
  input: Pick<SessionWorkspaceRoutingInput, 'eventWorkspacePath' | 'sessionWorkspacePath'>
): string | null {
  return input.sessionWorkspacePath || input.eventWorkspacePath || null;
}

/**
 * Determine whether a session event should be delivered to a workspace-scoped
 * subscriber.
 */
export function sessionEventMatchesWorkspace(input: SessionWorkspaceRoutingInput): boolean {
  const { subscribedWorkspacePath, eventWorkspacePath, sessionWorkspacePath } = input;
  if (!subscribedWorkspacePath) {
    return true;
  }

  return (
    subscribedWorkspacePath === eventWorkspacePath ||
    subscribedWorkspacePath === sessionWorkspacePath
  );
}
