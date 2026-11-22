import { isRetainedSession } from '@nimbalyst/collab-protocol';
import type { PushChangeOutcome, SessionIndexData, SyncProvider } from '@nimbalyst/runtime/sync/types';
import { selectSessionsForIndexSync } from './selectSessionsForIndexSync';
import type { TranscriptBackfill } from './transcriptBackfill';

type ServerIndex = Awaited<ReturnType<NonNullable<SyncProvider['fetchIndex']>>>;
type IndexSyncOptions = NonNullable<Parameters<NonNullable<SyncProvider['syncSessionsToIndex']>>[1]>;

export interface IndexReconcileInput<T extends SessionIndexData> {
  syncSessionsToIndex: NonNullable<SyncProvider['syncSessionsToIndex']>;
  serverIndex: ServerIndex;
  /** Local sessions, without messages, for the workspaces the predicate accepts. */
  loadLocalSessions: (isProjectEnabled: (workspaceId: string) => boolean) => Promise<T[]>;
  getMessagesForSync: IndexSyncOptions['getMessagesForSync'];
  isProjectEnabled: (workspaceId: string) => boolean;
  isMidTurn: (sessionId: string) => boolean;
  /** Server rows to republish index-only even when nothing else differs (startup's stale isExecuting clear). */
  forceIndexOnlySessionIds?: ReadonlySet<string>;
  /** Durable record of withheld transcripts still owed; see transcriptBackfill.ts. */
  backfill: Pick<TranscriptBackfill, 'heldProjects' | 'pendingSessions' | 'recordReconcile' | 'settle' | 'isWithheld'>;
  warn?: (message: string, error: unknown) => void;
  now?: number;
  /** Mobile joins repair absent rows without replaying local metadata over existing server rows. */
  onlyMissing?: boolean;
}

/**
 * Server rows whose index entry this desktop should republish without
 * touching messages: rows in a project the user did not enable that do not
 * yet say `transcriptSyncDisabled` (published before the flag existed, or
 * before the project was disabled), plus any forced rows. Only rows that are
 * also local sessions are ever republished; the caller intersects.
 *
 * Cost: one billed index write per listed, retained, opted-out session, once.
 * After that the server row carries the flag and this selects nothing.
 */
export function selectIndexOnlyRepublish(
  serverIndex: ServerIndex,
  isProjectEnabled: (workspaceId: string) => boolean,
  now: number,
  forceIds: ReadonlySet<string> = new Set(),
): { sessionIds: Set<string>; optedOutProjects: Set<string> } {
  const sessionIds = new Set<string>();
  const optedOutProjects = new Set<string>();
  for (const row of serverIndex.sessions) {
    const enabled = isProjectEnabled(row.projectId);
    const needsFlag = !enabled && !row.transcriptSyncDisabled && isRetainedSession(row.updatedAt, now);
    if (!needsFlag && !forceIds.has(row.sessionId)) continue;
    sessionIds.add(row.sessionId);
    if (!enabled) optedOutProjects.add(row.projectId);
  }
  return { sessionIds, optedOutProjects };
}

/**
 * Where each session's message upload starts. A session owed its withheld
 * transcript starts from zero, whatever the server row's `lastMessageAt` says
 * (index publishes advanced it while no transcript row was uploaded).
 */
export function buildMessageSyncRequests(
  sessions: readonly SessionIndexData[],
  needingMessages: readonly string[],
  serverIndex: ServerIndex,
  fromStart: ReadonlySet<string>,
): Array<{ sessionId: string; sinceTimestamp: number }> | undefined {
  if (needingMessages.length === 0) return undefined;
  const wanted = new Set(needingMessages);
  const serverRows = new Map(serverIndex.sessions.map(row => [row.sessionId, row]));
  return sessions.filter(session => wanted.has(session.id)).map(session => ({
    sessionId: session.id,
    sinceTimestamp: fromStart.has(session.id) ? 0 : serverRows.get(session.id)?.lastMessageAt || 0,
  }));
}

/**
 * One reconciliation pass against a complete server index: publish what the
 * enabled projects are missing (index rows and transcripts), then mark listed
 * sessions of projects that are not enabled. Publication runs in the
 * background so startup and reconnect do not wait on it; the provider queues
 * what it cannot send and reports per-batch outcomes itself.
 */
export async function reconcileSessionIndex<T extends SessionIndexData>(input: IndexReconcileInput<T>) {
  const now = input.now ?? Date.now();
  const warn = input.warn ?? ((message: string, error: unknown) => console.warn(message, error));
  if (input.onlyMissing) {
    const present = new Set(input.serverIndex.sessions.map(row => row.sessionId));
    const local = await input.loadLocalSessions(input.isProjectEnabled);
    const missing = local.filter(row => !present.has(row.id));
    const selected = selectSessionsForIndexSync(missing, input.serverIndex, now, input.isMidTurn);
    const byId = new Map(missing.map(row => [row.id, row]));
    // This partial pass repairs list entries. Full reconciliation retains
    // ownership of held/owed transcripts and their durable settlement.
    const messageIds = selected.sessionsNeedingMessageSync.filter(id => {
      const row = byId.get(id)!;
      return !input.backfill.isWithheld(row.workspaceId!, id);
    });
    if (selected.sessionsNeedingIndexUpdate.length) {
      await input.syncSessionsToIndex(selected.sessionsNeedingIndexUpdate, {
        syncMessages: messageIds.length > 0,
        messageSyncRequests: buildMessageSyncRequests(selected.sessionsNeedingIndexUpdate, messageIds, input.serverIndex, new Set()),
        getMessagesForSync: input.getMessagesForSync,
      });
    }
    return { allLocalSessions: local, optedOutLocal: [] as T[],
      ...selected, sessionsNeedingMessageSync: messageIds, indexOnlySessions: [] as T[] };
  }
  const heldProjects = input.backfill.heldProjects();
  const owed = input.backfill.pendingSessions();
  const allLocalSessions = await input.loadLocalSessions(input.isProjectEnabled);
  const { sessionsNeedingIndexUpdate, sessionsNeedingMessageSync } =
    selectSessionsForIndexSync(allLocalSessions, input.serverIndex, now, input.isMidTurn);

  // A transcript still owed is requested again on every pass until the
  // provider confirms delivery -- the server row may no longer say anything
  // is missing (a failed upload after the flag cleared, or a restart).
  const selected = new Set(sessionsNeedingIndexUpdate.map(session => session.id));
  const requested = new Set(sessionsNeedingMessageSync);
  for (const session of allLocalSessions) {
    if (!owed.has(session.id)) continue;
    if (!selected.has(session.id)) sessionsNeedingIndexUpdate.push(session);
    if (!requested.has(session.id)) sessionsNeedingMessageSync.push(session.id);
  }
  // Newly found: rows listed while their project was not enabled, now in an
  // enabled project. Recorded durably before anything is published, with the
  // holds this pass covered released in the same write.
  const flagged = new Set(input.serverIndex.sessions.filter(row => row.transcriptSyncDisabled).map(row => row.sessionId));
  const found = sessionsNeedingMessageSync.filter(id => flagged.has(id) && !owed.has(id));
  const known = new Set([...allLocalSessions.map(session => session.id), ...input.serverIndex.sessions.map(row => row.sessionId)]);
  try {
    input.backfill.recordReconcile(found, heldProjects, id => known.has(id));
  } catch (error) {
    // Holds stay in force, so these sessions keep their flag and the next pass finds them again.
    warn('[SyncManager] Could not persist transcript backfill; retrying next reconcile', error);
  }
  const fromStart = new Set([...owed, ...found]);
  const byId = new Map(allLocalSessions.map(session => [session.id, session]));
  const onTranscriptSynced = (sessionId: string, outcome: PushChangeOutcome) => {
    if (!fromStart.has(sessionId) || (!outcome.published && outcome.retryable !== false)) return;
    let settled = false;
    try {
      settled = input.backfill.settle(sessionId);
    } catch (error) {
      warn('[SyncManager] Could not record a delivered transcript backfill; it will be sent again', error);
    }
    const session = byId.get(sessionId);
    if (settled && session) {
      // Background: republish the delivered row so its flag clears on the phone.
      void input.syncSessionsToIndex([session], { syncMessages: false });
    }
  };

  const indexOnly = selectIndexOnlyRepublish(input.serverIndex, input.isProjectEnabled, now, input.forceIndexOnlySessionIds);
  const optedOutLocal = indexOnly.optedOutProjects.size > 0
    ? await input.loadLocalSessions(workspaceId => indexOnly.optedOutProjects.has(workspaceId))
    : [];
  const queued = new Set(sessionsNeedingIndexUpdate.map(session => session.id));
  const indexOnlySessions = [...allLocalSessions, ...optedOutLocal]
    .filter(session => indexOnly.sessionIds.has(session.id) && !queued.has(session.id));

  if (sessionsNeedingIndexUpdate.length > 0) {
    // Background: the provider retains unsent rows for its reconnect drain,
    // and reports each transcript upload through onTranscriptSynced.
    void input.syncSessionsToIndex(sessionsNeedingIndexUpdate, {
      syncMessages: sessionsNeedingMessageSync.length > 0,
      messageSyncRequests: buildMessageSyncRequests(sessionsNeedingIndexUpdate, sessionsNeedingMessageSync, input.serverIndex, fromStart),
      getMessagesForSync: input.getMessagesForSync,
      onTranscriptSynced,
    });
  }
  if (indexOnlySessions.length > 0) {
    // Background, index rows only: these sessions' transcripts stay withheld.
    void input.syncSessionsToIndex(indexOnlySessions, { syncMessages: false });
  }
  return { allLocalSessions, optedOutLocal, sessionsNeedingIndexUpdate, sessionsNeedingMessageSync, indexOnlySessions };
}
