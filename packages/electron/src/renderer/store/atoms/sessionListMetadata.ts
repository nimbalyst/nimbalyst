import type { SessionMeta } from "@nimbalyst/runtime/ai/adapters/sessionStore";

/** Normalize the lightweight IPC list into the renderer registry. */
export function sessionListMetadata(
  s: Partial<SessionMeta> & Pick<SessionMeta, "id" | "createdAt" | "updatedAt">,
  workspacePath: string
): SessionMeta {
  return {
    id: s.id,
    title: s.title || "Untitled Session",
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    provider: s.provider || "claude",
    model: s.model,
    sessionType: s.sessionType || "session",
    agentRole: s.agentRole || "standard",
    createdBySessionId: s.createdBySessionId || null,
    messageCount: s.messageCount || 0,
    workspaceId: workspacePath,
    isArchived: s.isArchived || false,
    isPinned: s.isPinned || false,
    parentSessionId: s.parentSessionId || null,
    worktreeId: s.worktreeId || null,
    childCount: s.childCount || 0,
    uncommittedCount: s.uncommittedCount || 0,
    // Kanban board phase and tags from metadata JSONB
    ...(s.phase && { phase: s.phase }),
    ...(s.tags && { tags: s.tags }),
    // Linked tracker item IDs from metadata JSONB
    ...(s.linkedTrackerItemIds && {
      linkedTrackerItemIds: s.linkedTrackerItemIds,
    }),
    ...(s.agentRole && { agentRole: s.agentRole }),
    ...(s.createdBySessionId !== undefined && {
      createdBySessionId: s.createdBySessionId,
    }),
  };
}
