/**
 * The workspace-scoped `ai_sessions` reads the meta-agent tools run, split out
 * of `MetaAgentService` so the SQL (and the spawn ceilings it enforces) sits in
 * one small module rather than inside the orchestration flow.
 *
 * Every query here is keyed by the workspace a session is STORED under, which
 * is not always the spelling the caller arrived with — see
 * `utils/workspaceIdentity` (https://github.com/nimbalyst/nimbalyst/issues/1551).
 */

import { database as databaseWorker } from '../database/PGLiteDatabaseWorker';

/** Controllable "max parallel" limit: children currently running. */
const MAX_IN_FLIGHT = 4;
/** Non-controllable ceiling on children ever created by one parent. */
const LIFETIME_BACKSTOP = 50;

export async function getSessionStatusRow(sessionId: string, workspaceId: string): Promise<any | null> {
  const { rows } = await databaseWorker.query<any>(
    `SELECT id, title, provider, model, status, last_activity, updated_at, created_by_session_id, agent_role
       FROM ai_sessions
       WHERE id = $1 AND workspace_id = $2
       LIMIT 1`,
    [sessionId, workspaceId]
  );
  return rows[0] || null;
}

export async function getSpawnedSessionRows(metaSessionId: string, workspaceId: string, db: Pick<typeof databaseWorker, 'query'> = databaseWorker): Promise<any[]> {
  const { rows } = await db.query<any>(
    `SELECT id, title, provider, model, status, last_activity, created_at, updated_at, worktree_id, agent_role, created_by_session_id
       FROM ai_sessions
       WHERE workspace_id = $1
         AND created_by_session_id = $2
         AND (is_archived = FALSE OR is_archived IS NULL)
       ORDER BY created_at DESC`,
    [workspaceId, metaSessionId]
  );
  return rows;
}

/**
 * Two independent gates on how many children a parent can spawn.
 *
 * `MAX_IN_FLIGHT` counts children currently active (running /
 * waiting_for_input) or with a durable pending/executing prompt. Deferred
 * launches remain charged while queue-drive waits for a window or provider.
 * A finished child with no queued work frees a slot for another launch.
 *
 * `LIFETIME_BACKSTOP` bounds ALL children ever created (any status,
 * non-archived). An in-flight count alone does NOT bound SEQUENTIAL re-spawn
 * runaways: a completion-wakeup re-drives the parent, a weak model spawns
 * another child, the child settles in milliseconds, so the in-flight count
 * stays ~0 and never fires. This backstop catches that loop without imposing a
 * low lifetime cap on normal use. Mirrors the created_by_session_id query in
 * `getSpawnedSessionRows`.
 */
export async function assertChildSpawnCapacity(workspaceId: string, metaSessionId: string, db: Pick<typeof databaseWorker, 'query'> = databaseWorker, pendingIds: string[] = []): Promise<void> {
  // SUM(CASE ...) rather than COUNT(*) FILTER (...) so the aggregate is
  // portable across both PGLite and better-sqlite3 (see DATABASE.md).
  const { rows } = await db.query<{ in_flight: string; total: string }>(
    `SELECT
         SUM(CASE WHEN status IN ('running', 'waiting_for_input')
                   OR EXISTS (SELECT 1 FROM queued_prompts q WHERE q.session_id = ai_sessions.id AND q.status IN ('pending', 'executing'))
                  THEN 1 ELSE 0 END)::text AS in_flight,
         SUM(CASE WHEN CAST(metadata->>'managerReassignedByUser' AS TEXT) IN ('true', '1')
                   AND (metadata->>'originalSpawnerSessionId' IS NULL OR metadata->>'originalSpawnerSessionId' <> created_by_session_id)
                  THEN 0 ELSE 1 END)::text AS total
       FROM ai_sessions
       WHERE workspace_id = $1
         AND created_by_session_id = $2
         AND (is_archived = FALSE OR is_archived IS NULL)
         ${pendingIds.length ? `AND id NOT IN (${pendingIds.map((_, index) => `$${index + 3}`).join(', ')})` : ''}`,
    [workspaceId, metaSessionId, ...pendingIds]
  );

  const inFlightCount = Number(rows[0]?.in_flight ?? '0') + pendingIds.length;
  const totalCount = Number(rows[0]?.total ?? '0') + pendingIds.length;
  if (inFlightCount >= MAX_IN_FLIGHT) {
    throw new Error(
      `Too many child sessions running at once (${inFlightCount}/${MAX_IN_FLIGHT} in flight). ` +
      `Wait for a spawned session to finish before spawning more.`
    );
  }
  if (totalCount >= LIFETIME_BACKSTOP) {
    throw new Error(
      `Meta-agent lifetime spawn backstop reached (${LIFETIME_BACKSTOP} total children spawned by this parent); refusing to spawn more`
    );
  }
}

const pendingSpawns = new Map<string, Set<string>>();
const reservationLanes = new Map<string, Promise<unknown>>();

/** Reserve before side effects; inserted rows are excluded while their reservation counts them. */
export async function reserveChildSpawnCapacity(workspaceId: string, managerId: string, childId: string, db: Pick<typeof databaseWorker, 'query'> = databaseWorker): Promise<() => void> {
  const key = JSON.stringify([workspaceId, managerId]);
  const reserve = (reservationLanes.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const pending = pendingSpawns.get(key) ?? new Set<string>();
    await assertChildSpawnCapacity(workspaceId, managerId, db, [...pending]);
    pending.add(childId);
    pendingSpawns.set(key, pending);
    return () => { pending.delete(childId); if (!pending.size && pendingSpawns.get(key) === pending) pendingSpawns.delete(key); };
  });
  reservationLanes.set(key, reserve);
  void reserve.finally(() => { if (reservationLanes.get(key) === reserve) reservationLanes.delete(key); }).catch(() => {});
  return reserve;
}
