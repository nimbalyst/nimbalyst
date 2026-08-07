import {
  isStructuralWorkstreamContainer,
  type SessionHierarchyNode,
} from '../../shared/sessionHierarchy';

export interface ReparentValidationNode extends SessionHierarchyNode {
  workspacePath: string;
}

let sessionReparentMutationTail: Promise<void> = Promise.resolve();

/**
 * Keep hierarchy validation and its subsequent write in one critical section.
 * Without this fence, two IPC calls can both validate an old snapshot and
 * interleave their writes into a third hierarchy level.
 */
export function serializeSessionReparentMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const run = sessionReparentMutationTail.then(operation, operation);
  sessionReparentMutationTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function validateSessionReparent({
  source,
  destination,
  newParentId,
  workspacePath,
}: {
  source: ReparentValidationNode;
  destination: ReparentValidationNode | null;
  newParentId: string | null;
  workspacePath: string;
}): string | null {
  if (source.workspacePath !== workspacePath) {
    return 'Session does not belong to this workspace';
  }
  if (isStructuralWorkstreamContainer(source)) {
    return 'Cannot move a workstream container';
  }
  if (source.worktreeId) {
    return 'Cannot move a worktree-resident session into a workstream';
  }
  if (!newParentId) {
    return null;
  }
  if (source.id === newParentId) {
    return 'A session cannot be its own parent';
  }
  if (!destination) {
    return 'Parent session not found';
  }
  if (destination.workspacePath !== workspacePath) {
    return 'Parent session is in a different workspace';
  }
  if (destination.parentSessionId) {
    return 'Cannot nest workstreams: parent is already a child session';
  }
  if (destination.worktreeId) {
    return 'Cannot parent a session beneath a worktree-resident session';
  }

  return null;
}
