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

export async function getSpawnedSessionRows(metaSessionId: string, workspaceId: string): Promise<any[]> {
  const { rows } = await databaseWorker.query<any>(
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
 * `MAX_IN_FLIGHT` counts only children currently active (running /
 * waiting_for_input). A finished child frees a slot, so a parent may spawn an
 * unbounded TOTAL over its lifetime as long as it does not exceed this many at
 * once — that is the intended behavior.
 *
 * `LIFETIME_BACKSTOP` bounds ALL children ever created (any status,
 * non-archived). An in-flight count alone does NOT bound SEQUENTIAL re-spawn
 * runaways: a completion-wakeup re-drives the parent, a weak model spawns
 * another child, the child settles in milliseconds, so the in-flight count
 * stays ~0 and never fires. This backstop catches that loop without imposing a
 * low lifetime cap on normal use. Mirrors the created_by_session_id query in
 * `getSpawnedSessionRows`.
 */
export async function assertChildSpawnCapacity(workspaceId: string, metaSessionId: string): Promise<void> {
  // SUM(CASE ...) rather than COUNT(*) FILTER (...) so the aggregate is
  // portable across both PGLite and better-sqlite3 (see DATABASE.md).
  const { rows } = await databaseWorker.query<{ in_flight: string; total: string }>(
    `SELECT
         SUM(CASE WHEN status IN ('running', 'waiting_for_input') THEN 1 ELSE 0 END)::text AS in_flight,
         COUNT(*)::text AS total
       FROM ai_sessions
       WHERE workspace_id = $1
         AND created_by_session_id = $2
         AND (is_archived = FALSE OR is_archived IS NULL)`,
    [workspaceId, metaSessionId]
  );

  const inFlightCount = Number(rows[0]?.in_flight ?? '0');
  const totalCount = Number(rows[0]?.total ?? '0');
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
