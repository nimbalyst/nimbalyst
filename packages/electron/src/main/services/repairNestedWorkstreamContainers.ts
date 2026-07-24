import type { UpdateSessionMetadataPayload } from '@nimbalyst/runtime/ai/adapters/sessionStore';

type PGliteLike = {
  query: <T = any>(sql: string, params?: any[]) => Promise<{ rows: T[] }>;
};

type UpdateSessionMetadata = (
  sessionId: string,
  metadata: UpdateSessionMetadataPayload,
) => Promise<void>;

/**
 * Repair the one forbidden edge only. Updates flow through the registered
 * session store so connected sync sessions receive the same metadata update as
 * an ordinary reparent; transcript rows are never queried or mutated.
 */
export async function repairNestedWorkstreamContainers(
  db: PGliteLike,
  updateSessionMetadata: UpdateSessionMetadata,
): Promise<{ repaired: number }> {
  const result = await db.query<{ id: string }>(
    `SELECT id
     FROM ai_sessions
     WHERE session_type = 'workstream'
       AND parent_session_id IS NOT NULL`,
  );

  for (const { id } of result.rows) {
    await updateSessionMetadata(id, { parentSessionId: null });
  }

  return { repaired: result.rows.length };
}
