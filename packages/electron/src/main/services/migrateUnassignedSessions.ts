/**
 * Utility to assign unassigned sessions (workspace_id = NULL or 'default')
 * to a specific workspace.
 *
 * This is useful for migrating old sessions that were created before
 * workspace tracking was implemented.
 */

type PGliteLike = {
  query: <T = any>(sql: string, params?: any[]) => Promise<{ rows: T[] }>;
};

export async function migrateUnassignedSessions(
  db: PGliteLike,
  targetWorkspacePath: string
): Promise<{ migrated: number }> {
  // Update all sessions with NULL or 'default' workspace_id to the target workspace
  const result = await db.query(
    `UPDATE ai_sessions
     SET workspace_id = $1
     WHERE workspace_id IS NULL OR workspace_id = 'default'
     RETURNING id`,
    [targetWorkspacePath]
  );

  return { migrated: result.rows.length };
}

/**
 * Get count of unassigned sessions
 */
export async function countUnassignedSessions(db: PGliteLike): Promise<number> {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*) as count
     FROM ai_sessions
     WHERE workspace_id IS NULL OR workspace_id = 'default'`
  );

  return parseInt(result.rows[0]?.count || '0', 10);
}
