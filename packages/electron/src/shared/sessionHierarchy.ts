export interface SessionHierarchyNode {
  id: string;
  sessionType?: string | null;
  parentSessionId?: string | null;
  worktreeId?: string | null;
  childCount?: number | null;
  metadata?: Record<string, unknown> | null;
}
/**
 * Structural workstream containers never own a transcript surface. Stored type
 * is authoritative; metadata/children cover legacy rows created before typed
 * workstream roots were consistently persisted.
 */
export function isStructuralWorkstreamContainer(
  session: SessionHierarchyNode | null | undefined,
): boolean {
  return Boolean(
    session
      && (
        session.sessionType === 'workstream'
        || session.metadata?.isWorkstreamRoot === true
        || (session.childCount ?? 0) > 0
      )
  );
}

/**
 * Keep active-child state inside the current membership. Empty structural
 * containers deliberately resolve to null; only transcript-bearing singleton
 * sessions may route to their own ID.
 */
export function reconcileActiveSessionId({
  containerId,
  childSessionIds,
  activeSessionId,
  isStructuralContainer,
}: {
  containerId: string;
  childSessionIds: readonly string[];
  activeSessionId: string | null;
  isStructuralContainer: boolean;
}): string | null {
  if (childSessionIds.length > 0) {
    return activeSessionId && childSessionIds.includes(activeSessionId)
      ? activeSessionId
      : childSessionIds[0];
  }

  return isStructuralContainer ? null : containerId;
}
