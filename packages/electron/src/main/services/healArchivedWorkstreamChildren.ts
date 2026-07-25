/**
 * One-time startup heal for GitHub #925 / NIM-1831.
 *
 * Before the archive-cascade fix, archiving a workstream parent set
 * is_archived=TRUE on only the parent row, leaving its child sessions
 * (linked by parent_session_id) active. Those children became invisible
 * orphans that kept counting toward the active total. The write path now
 * cascades, but pre-existing orphans need a one-time cleanup.
 *
 * This runs idempotently at startup: it archives any active session whose
 * parent session is archived. After the first successful pass (and with the
 * write-path cascade in place) subsequent runs find nothing to do and issue
 * no write.
 */

type PGliteLike = {
  query: <T = any>(sql: string, params?: any[]) => Promise<{ rows: T[] }>;
};

const ORPHAN_PREDICATE = `
  (c.is_archived = FALSE OR c.is_archived IS NULL)
  AND c.parent_session_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM ai_sessions p
    WHERE p.id = c.parent_session_id AND p.is_archived = TRUE
  )
`;

export async function healArchivedWorkstreamChildren(
  db: PGliteLike
): Promise<{ healed: number }> {
  // Count first so we only write when there is something to heal. This keeps
  // the common (already-clean) startup path read-only rather than issuing a
  // no-op UPDATE on every launch.
  const countResult = await db.query<{ count: number | string }>(
    `SELECT COUNT(*) as count FROM ai_sessions c WHERE ${ORPHAN_PREDICATE}`
  );
  const orphanCount = Number(countResult.rows[0]?.count ?? 0);
  if (!orphanCount) {
    return { healed: 0 };
  }

  await db.query(
    `UPDATE ai_sessions
     SET is_archived = TRUE
     WHERE id IN (
       SELECT c.id FROM ai_sessions c WHERE ${ORPHAN_PREDICATE}
     )`
  );

  return { healed: orphanCount };
}
