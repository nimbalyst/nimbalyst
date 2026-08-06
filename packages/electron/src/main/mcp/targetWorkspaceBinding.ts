import path from 'path';
import { resolveProjectPath } from '../utils/workspaceDetection';

export interface TargetWorkspaceBindingArgs {
  targetWorkspacePath?: unknown;
}

/**
 * Resolve the workspace authority for a target-session operation.
 *
 * Calls remain bound to the caller's workspace unless the caller explicitly
 * supplies a non-empty targetWorkspacePath. The service layer must still
 * verify that the named session belongs to the resolved workspace; this helper
 * never discovers or guesses a workspace from a session ID.
 */
export function resolveTargetWorkspaceBinding(
  callerWorkspacePath: string,
  args?: TargetWorkspaceBindingArgs,
): string {
  const requestedPath = args?.targetWorkspacePath;
  if (requestedPath === undefined) {
    return resolveProjectPath(callerWorkspacePath);
  }

  if (typeof requestedPath !== 'string' || requestedPath.trim().length === 0) {
    throw new Error('targetWorkspacePath must be a non-empty string when provided');
  }

  if (!path.isAbsolute(requestedPath.trim())) {
    throw new Error('targetWorkspacePath must be absolute');
  }

  const resolvedPath = resolveProjectPath(requestedPath.trim());
  if (!resolvedPath) {
    throw new Error('targetWorkspacePath could not be resolved');
  }

  return resolvedPath;
}
