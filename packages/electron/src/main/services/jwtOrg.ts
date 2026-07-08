/**
 * Pure JWT claim helpers for org-scoped (Stytch B2B) tokens.
 *
 * Kept dependency-free (no electron / no service imports) so it is trivially
 * unit-testable and safe to reuse from both the auth path (TeamService) and the
 * WebSocket proxy diagnostics (DocumentSyncHandlers).
 *
 * NIM-949: a session-exchange can return a token scoped to the WRONG org (e.g.
 * a personal-org token after a session refresh demotes a team session). If that
 * token is cached and served for a team document room, the room rejects the ws
 * upgrade (HTTP 400) and the doc never hydrates -- showing a blank "Offline
 * unsynced changes" editor. `assertJwtMatchesOrg` makes that mismatch a hard,
 * typed error instead of a silent wrong-org token.
 */

/** Raised when a JWT's organization_id does not match the org it was requested for. */
export class AuthContextMismatchError extends Error {
  override readonly name = 'AuthContextMismatchError';
  constructor(
    public readonly requestedOrgId: string,
    public readonly tokenOrgId: string | null,
  ) {
    super(
      `Auth context mismatch: token is scoped to org ` +
        `${tokenOrgId ?? '(none)'} but ${requestedOrgId} was requested`,
    );
  }
}

/**
 * Decode a JWT payload without verifying the signature (the server verifies).
 * Returns null on any malformed input.
 */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return typeof payload === 'object' && payload !== null ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Extract the Stytch B2B `organization_id`, or null.
 *
 * Stytch B2B session JWTs nest the org under the namespaced claim
 * `https://stytch.com/organization` (`{ organization_id, slug }`), NOT a
 * top-level `organization_id`. Reading only the top-level claim returns null
 * for every real Stytch token, which made `assertJwtMatchesOrg` reject all
 * valid org-scoped tokens as "no-org" (NIM-949 regression: team sync broke
 * with "wrong-org token (token org: (none))" for tokens that were actually
 * correctly scoped). Check the namespaced claim first; fall back to a
 * top-level `organization_id` for any non-Stytch/test tokens.
 */
export function getOrgIdFromJwt(jwt: string): string | null {
  const payload = decodeJwtPayload(jwt);
  if (!payload) return null;
  const namespaced = payload['https://stytch.com/organization'];
  if (namespaced && typeof namespaced === 'object') {
    const orgId = (namespaced as Record<string, unknown>).organization_id;
    if (typeof orgId === 'string') return orgId;
  }
  const top = payload.organization_id;
  return typeof top === 'string' ? top : null;
}

/** Extract the `exp` claim (epoch seconds), or null. */
export function getJwtExp(jwt: string): number | null {
  const payload = decodeJwtPayload(jwt);
  return typeof payload?.exp === 'number' ? (payload.exp as number) : null;
}

/** Extract the `sub` (member id) claim, or null. */
export function getSubFromJwt(jwt: string): string | null {
  const payload = decodeJwtPayload(jwt);
  return typeof payload?.sub === 'string' ? (payload.sub as string) : null;
}

/**
 * Throw AuthContextMismatchError unless the token's organization_id equals the
 * requested orgId. A missing org claim is treated as a mismatch.
 */
export function assertJwtMatchesOrg(jwt: string, requestedOrgId: string): void {
  const tokenOrgId = getOrgIdFromJwt(jwt);
  if (tokenOrgId !== requestedOrgId) {
    throw new AuthContextMismatchError(requestedOrgId, tokenOrgId);
  }
}
