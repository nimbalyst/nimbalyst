/**
 * TeamCustodyService - server-managed team key custody.
 *
 * Team data is encrypted at rest by the sync server under a per-team DEK the
 * server holds (KMS-wrapped). The client holds NO team key: it sends and
 * receives plaintext and the server refuses every content operation for an
 * organization that is not marked server-managed.
 *
 * The retired client-managed lane (per-device ECDH identity key pairs, org
 * encryption keys, wrapped key envelopes, per-member trust verification, org
 * key rotation) is gone. What remains is the custody marker: reading it, and
 * setting it when a team is created.
 *
 * Personal sync is unaffected and stays zero-knowledge.
 */

import { net } from 'electron';
import { logger } from '../utils/logger';
import { getCollabSyncHttpUrl } from '../utils/collabSyncUrl';
import { isAuthenticated } from './StytchAuthService';
import { getOrgScopedJwt } from './TeamService';
import { safeHandle } from '../utils/ipcRegistry';
import { createTtlCache } from '../utils/asyncCache';

const getCollabServerUrl = getCollabSyncHttpUrl;

/**
 * Custody as reported by the server. `server-managed` is the only supported
 * value; `unmigrated` means the organization was never converted and the
 * server refuses its team content — it has to be set up again.
 */
export type TeamKeyCustodyMode = 'server-managed' | 'unmigrated';

export interface TeamKeyStatus {
  mode: TeamKeyCustodyMode;
  dekEpoch: number | null;
  dekFingerprint: string | null;
}

async function fetchApi(
  apiPath: string,
  method: string,
  body: unknown | undefined,
  orgScopedJwt: string,
): Promise<unknown> {
  const url = `${getCollabServerUrl()}${apiPath}`;
  const response = await net.fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${orgScopedJwt}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${method} ${apiPath} failed (${response.status}): ${text}`);
  }
  return response.json().catch(() => ({}));
}

async function fetchTeamKeyStatusUncached(orgId: string, orgScopedJwt: string): Promise<TeamKeyStatus> {
  const data = await fetchApi(`/api/teams/${orgId}/key-status`, 'GET', undefined, orgScopedJwt) as {
    mode?: string; dekEpoch?: number | null; dekFingerprint?: string | null;
  };
  // Any value other than the explicit server-managed marker means unmigrated.
  // Unknown values must NOT fall through to the permissive reading.
  const mode: TeamKeyCustodyMode = data.mode === 'server-managed' ? 'server-managed' : 'unmigrated';
  return { mode, dekEpoch: data.dekEpoch ?? null, dekFingerprint: data.dekFingerprint ?? null };
}

// Per-org TTL cache + single-flight for the key-status GET. Custody only
// changes at team creation, so a short cache is safe and keeps N concurrent
// settings reads from firing N identical GETs. A failed fetch is not cached.
const TEAM_KEY_STATUS_TTL_MS = 60_000;
const teamKeyStatusCache = createTtlCache<string, TeamKeyStatus>(TEAM_KEY_STATUS_TTL_MS);

/** Drop the key-status cache for an org (or all orgs). */
export function invalidateTeamKeyStatusCache(orgId?: string): void {
  teamKeyStatusCache.invalidate(orgId);
}

/**
 * Read a team's custody status. Informational only — the sync lane no longer
 * branches on it, and the server is the authority that refuses an unmigrated
 * organization. Rejects on failure rather than guessing a mode; callers that
 * only want to render status should surface the error.
 *
 * TEAM lane only — never call this for personal/mobile rooms (those stay
 * zero-knowledge and have no team DEK).
 */
export function fetchTeamKeyStatus(orgId: string, orgScopedJwt: string): Promise<TeamKeyStatus> {
  return teamKeyStatusCache.get(orgId, () => fetchTeamKeyStatusUncached(orgId, orgScopedJwt));
}

/**
 * Mark a team server-managed. Called once, at team creation. The server
 * accepts no other value and the marker is one-way.
 */
export async function setTeamServerManagedCustody(orgId: string, orgScopedJwt: string): Promise<void> {
  await fetchApi(`/api/teams/${orgId}/set-key-custody-mode`, 'POST', { mode: 'server-managed' }, orgScopedJwt);
  invalidateTeamKeyStatusCache(orgId);
  logger.main.info('[TeamCustodyService] Marked org server-managed:', orgId);
}

export function registerTeamCustodyHandlers(): void {
  // Drives the Security & encryption section in organization settings.
  safeHandle('team:get-key-custody-status', async (_event, orgId: string) => {
    if (!isAuthenticated()) return { success: false, error: 'Not authenticated' };
    try {
      const orgJwt = await getOrgScopedJwt(orgId);
      const status = await fetchTeamKeyStatus(orgId, orgJwt);
      return { success: true, mode: status.mode, dekFingerprint: status.dekFingerprint };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
