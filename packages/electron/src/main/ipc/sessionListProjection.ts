import type { SessionMeta } from "@nimbalyst/runtime/ai/adapters/sessionStore";

type SessionDatabase = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

/** Count launch provenance, independently of grouping and archive/view filters. */
export async function readSessionLaunchCounts(
  db: SessionDatabase,
  workspacePath: string
): Promise<Record<string, number>> {
  const { rows } = await db.query<{
    session_id: string;
    count: string | number;
  }>(
    `SELECT created_by_session_id AS session_id, COUNT(*) AS count
     FROM ai_sessions
     WHERE workspace_id = $1 AND created_by_session_id IS NOT NULL
     GROUP BY created_by_session_id`,
    [workspacePath]
  );
  return Object.fromEntries(
    rows.map((row) => [row.session_id, Number(row.count)])
  );
}

export function projectSessionList(
  entries: SessionMeta[],
  uncommittedMap: Map<string, number>
) {
  const sessions = entries.map((entry) => {
    const uncommittedCount = uncommittedMap.get(entry.id) || 0;
    return {
      id: entry.id,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      name: entry.title,
      title: entry.title,
      provider: entry.provider,
      model: entry.model,
      sessionType: entry.sessionType || "session",
      agentRole: entry.agentRole || "standard",
      createdBySessionId: entry.createdBySessionId || null,
      messageCount: entry.messageCount || 0,
      isArchived: entry.isArchived || false,
      isPinned: entry.isPinned || false, // Include isPinned from repository
      worktreeId: entry.worktreeId, // Include worktreeId from repository
      parentSessionId: entry.parentSessionId || null, // Hierarchical workstream support
      childCount: entry.childCount || 0, // Number of child sessions
      uncommittedCount, // Number of uncommitted files
      hasUnread: entry.hasUnread || false, // Unread state from metadata
      hasPendingInteractivePrompt:
        (entry as any).hasPendingInteractivePrompt || false,
      // Branch tracking - SEPARATE from hierarchical parentSessionId
      branchedFromSessionId: entry.branchedFromSessionId,
      branchPointMessageId: entry.branchPointMessageId,
      branchedAt: entry.branchedAt,
      // Kanban board phase and tags
      phase: (entry as any).phase || undefined,
      tags: (entry as any).tags || undefined,
      // Linked tracker item IDs
      linkedTrackerItemIds: (entry as any).linkedTrackerItemIds || undefined,
      metadata: {},
    };
  });
  return sessions;
}
