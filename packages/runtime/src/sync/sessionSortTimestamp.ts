/**
 * Resolves the `updatedAt` value emitted on a wire `SessionIndexEntry`, which
 * is the sort key for the mobile session list.
 *
 * Why this exists (NIM-2167): `ai_sessions.updated_at` is bumped per message
 * (`PGLiteAgentMessagesStore.create`), and the 10s incremental sync re-pushes
 * any session whose local `updatedAt` drifted ahead of the server's. iOS sorts
 * directly off `Session.updatedAt` (`SessionListView.swift`) with no
 * turn-boundary indirection and no throttle, inside a `ValueObservation`
 * applied under `withAnimation` -- so an advancing sort key mid-turn makes the
 * list visibly reshuffle while sessions stream.
 *
 * Desktop already avoids this: `getLiveSessionOrderTimestamp`
 * (`SessionHistory.tsx`) prefers a turn-boundary timestamp over `updatedAt` in
 * agent mode and throttles reorder commits. This helper gives the mobile index
 * the same property by holding the sort key steady while a session executes.
 *
 * Turn boundaries still move it: `pushExecutionStateToMobile`
 * (`SessionStateHandlers.ts`) pushes `{ isExecuting, updatedAt }` on
 * `session:started` / `completed` / `interrupted`. Because `isExecuting` is not
 * in `INDEX_CLIENT_METADATA_PATCH_SAFE_KEYS`, that push takes the full
 * `indexUpdate` path, so its `updatedAt` reaches iOS and the server converges
 * at the end of each turn.
 *
 * Note this deliberately governs ordering ONLY. `lastMessageAt` continues to
 * advance per message so unread state (`Session.hasUnread`, which compares
 * `lastMessageAt > lastReadAt`) keeps working mid-turn.
 */
export interface IndexSortTimestampInput {
  /** `updated_at` from the local session row; bumped per message. */
  localUpdatedAt: number;
  /** Last server-known `updatedAt` for this session, if it has been pushed before. */
  cachedUpdatedAt: number | undefined;
  /** Whether the session is currently mid-turn. */
  isExecuting: boolean | undefined;
}

export function resolveIndexSortTimestamp({
  localUpdatedAt,
  cachedUpdatedAt,
  isExecuting,
}: IndexSortTimestampInput): number {
  // Idle sessions sort by real content activity, as before.
  if (!isExecuting) return localUpdatedAt;

  // Mid-turn: hold the last value the server (and therefore mobile) already
  // has, so per-message drift never reorders the list. A session the server has
  // never seen has nothing to hold, so seed it from local.
  if (cachedUpdatedAt === undefined) return localUpdatedAt;

  // Holding the server's value also means a row never rewinds when the server
  // is ahead (e.g. another device pushed a turn boundary for this session).
  return cachedUpdatedAt;
}
