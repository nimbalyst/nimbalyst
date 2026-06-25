/**
 * Reconcile a persisted personalUserId against the authoritative member id
 * returned by a personal-org session exchange (POST /api/teams/{personalOrgId}/switch).
 *
 * The exchange `sub` is the source of truth for "this account's member id in its
 * own personal org". A previously-persisted personalUserId can be stale -- e.g.
 * seeded from a generic / active-session JWT sub by the creds migration -- and
 * historically was never corrected: resolvePersonalUserId() early-returned on any
 * cached value and refreshPersonalSession() only rewrote the JWT, never the id.
 * The stale id then permanently broke the personal index room with a JWT-sub
 * mismatch (the server validates JWT.sub === room userId). See NIM-859.
 *
 * Returns the id that should be persisted/used plus whether it changed from the
 * cached value, so callers can decide whether to write it back to disk.
 */
export function reconcilePersonalUserId(
  cached: string | null | undefined,
  exchangedSub: string | null | undefined,
): { personalUserId: string | null; changed: boolean } {
  // The personal-org exchange is authoritative whenever it produced a sub.
  if (exchangedSub) {
    return { personalUserId: exchangedSub, changed: exchangedSub !== (cached ?? null) };
  }
  // No exchange result (offline / failure) -- keep whatever we had cached.
  return { personalUserId: cached ?? null, changed: false };
}
