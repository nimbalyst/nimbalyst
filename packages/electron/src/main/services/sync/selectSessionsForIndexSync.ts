import { isRetainedSession } from '@nimbalyst/collab-protocol';
import type { SessionIndexData, SyncProvider } from '@nimbalyst/runtime/sync/types';
import { decideMissingSession } from './missingSessionPolicy';

type ServerIndex = Awaited<ReturnType<NonNullable<SyncProvider['fetchIndex']>>>;

/** Reconcile local sessions only: foreign unreadable rows never authorize deletes. */
export function selectSessionsForIndexSync<T extends SessionIndexData>(allLocalSessions: T[], serverIndex: ServerIndex, now = Date.now()) {
  const tombstonedSessionIds = new Set(serverIndex.deletedSessionIds ?? []);
  const serverSessionMap = new Map(serverIndex.sessions.map(s => [s.sessionId, s]));
  const sessionsNeedingIndexUpdate: T[] = [];
  const sessionsNeedingMessageSync: string[] = [];

  for (const localSession of allLocalSessions) {
    if (!isRetainedSession(localSession.updatedAt, now)) continue;
    // Skip sessions without a workspace - they shouldn't exist but just in case
    if (!localSession.workspaceId) {
      continue;
    }

    const serverSession = serverSessionMap.get(localSession.id);

    if (!serverSession) {
      // Missing from the server: deleted elsewhere, never published, or
      // expired by the server TTL. See missingSessionPolicy.ts.
      const decision = decideMissingSession({
        sessionId: localSession.id,
        updatedAt: localSession.updatedAt,
        isArchived: localSession.isArchived,
        tombstonedSessionIds,
        indexProtocolVersion: serverIndex.indexProtocolVersion,
        now: now,
      });
      if (!decision.publishIndex) continue;
      sessionsNeedingIndexUpdate.push(localSession);
      if (decision.syncMessages) {
        sessionsNeedingMessageSync.push(localSession.id);
      }
    } else {
      // Compare timestamps AND message counts to detect sessions needing sync.
      // The real-time pushChange sends updatedAt=now after DB write, so
      // the server's updatedAt is often ahead of local. Message count comparison
      // catches sessions with new messages that timestamps miss.
      const serverUpdatedAt = serverSession.updatedAt || 0;
      const localUpdatedAt = localSession.updatedAt || 0;
      const serverMessageCount = serverSession.messageCount || 0;
      const localMessageCount = localSession.messageCount || 0;

      if (localUpdatedAt > serverUpdatedAt) {
        sessionsNeedingIndexUpdate.push(localSession);
        sessionsNeedingMessageSync.push(localSession.id);
      } else if (localMessageCount > serverMessageCount) {
        sessionsNeedingIndexUpdate.push(localSession);
        sessionsNeedingMessageSync.push(localSession.id);
      } else if (
        // Detect stale server metadata: desktop has fields the server doesn't.
        // This happens after server schema migrations add new columns --
        // existing rows have NULL but the desktop has the real values --
        // and also when a session was pushed before a given field was
        // wired into the publish path, leaving the server row permanently
        // missing a value the desktop has.
        (localSession.worktreeId && !serverSession.worktreeId) ||
        (localSession.sessionType && !serverSession.sessionType) ||
        (localSession.provider && !serverSession.provider) ||
        (localSession.model && !serverSession.model) ||
        (localSession.mode && !serverSession.mode) ||
        // Value-mismatch checks for fields whose changes don't bump
        // updated_at. updateMetadata intentionally keeps updated_at stable
        // for pins/reparents/archives/title-edits to avoid resorting the
        // list on iOS, so the timestamp comparison above can't catch a
        // real divergence. Heal those on the next reconnect.
        (Boolean(localSession.isArchived) !== Boolean(serverSession.isArchived)) ||
        (Boolean(localSession.isPinned) !== Boolean(serverSession.isPinned)) ||
        ((localSession.parentSessionId ?? null) !== (serverSession.parentSessionId ?? null)) ||
        (localSession.title !== serverSession.title)
      ) {
        sessionsNeedingIndexUpdate.push(localSession);
      }
    }
  }

  return { sessionsNeedingIndexUpdate, sessionsNeedingMessageSync };
}
