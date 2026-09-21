import type { ChatSession } from '@nimbalyst/runtime/ai/adapters/sessionStore';
import { isPathInWorkspace, isWorktreePath, resolveProjectPath } from '../../shared/pathUtils';
import { findSessionAttributionForFile } from './sessionFilesByPath';

type Database = Parameters<typeof findSessionAttributionForFile>[0];
type Sessions = { getMany(ids: string[]): Promise<ChatSession[]> };

/** Hydrate only the linked sessions; the workspace list does not compute counts. */
export async function getSessionsForFile(db: Database, repository: Sessions, workspaceId: string, filePath: string) {
  const fileSessions = await findSessionAttributionForFile(db, {
    workspaceId,
    projectPath: resolveProjectPath(workspaceId),
    relativePath: isPathInWorkspace(filePath, workspaceId) ? filePath.slice(workspaceId.length) : null,
    filePath,
  });
  if (!fileSessions.length) return [];
  const attribution = new Map(fileSessions.map(session => [session.id, session]));
  const sessions = await repository.getMany(fileSessions.map(session => session.id));
  return sessions.map(session => ({
    id: session.id,
    title: session.title || 'Untitled Session',
    provider: session.provider,
    model: session.model,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: 0,
    worktreeId: session.worktreeId || null,
    isCurrentWorkspace: isWorktreePath(workspaceId)
      ? session.worktreePath === workspaceId
      : !session.worktreePath && session.workspacePath === workspaceId,
    ...attribution.get(session.id),
  })).sort((a, b) => {
    if (a.isCurrentWorkspace !== b.isCurrentWorkspace) return a.isCurrentWorkspace ? -1 : 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}
