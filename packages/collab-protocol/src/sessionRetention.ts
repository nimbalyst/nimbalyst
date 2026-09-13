/** Personal cloud sync is a cache; these limits do not delete desktop history. */
export const SESSION_INDEX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_TRANSCRIPT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const SESSION_REPLAY_TTL_MS = SESSION_INDEX_TTL_MS;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Message activity can advance while the sidebar sort timestamp is held still. */
export function sessionActivityAt(entry: { lastMessageAt?: number | null; updatedAt?: number | null }): number | undefined {
  return typeof entry.lastMessageAt === 'number' && entry.lastMessageAt > 0
    ? entry.lastMessageAt
    : entry.updatedAt ?? undefined;
}

export function isRetainedSession(activityAt: number | null | undefined, now = Date.now(), ttl = SESSION_INDEX_TTL_MS): boolean {
  return typeof activityAt === 'number' && Number.isFinite(activityAt) && activityAt > 0
    && activityAt >= now - ttl && activityAt <= now + MAX_CLOCK_SKEW_MS;
}
