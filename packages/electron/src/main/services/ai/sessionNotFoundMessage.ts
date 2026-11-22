/**
 * SessionManager.loadSession returns null both for a missing session and for
 * one that belongs to another workspace. GitHub #1887: tell the user which
 * workspace owns it instead of saying it does not exist.
 */
export function sessionNotFoundMessage(
  sessionId: string,
  requestedWorkspace: string,
  row: { workspacePath?: string | null } | null | undefined,
): string {
  const owner = row?.workspacePath;
  if (owner && owner !== requestedWorkspace) {
    return `Session ${sessionId} belongs to the workspace ${owner}, not ${requestedWorkspace}. Open ${owner} to continue it.`;
  }
  return `Session ${sessionId} not found`;
}
