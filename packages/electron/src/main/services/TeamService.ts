/**
 * TeamService - Manages team CRUD operations via collabv3 REST API.
 *
 * Architecture: Per-workspace org context. The user's personal org (global auth)
 * is NEVER replaced. Team operations use org-scoped JWTs obtained via Stytch
 * session exchange, cached per-org with TTL. Different projects can use different
 * orgs simultaneously.
 *
 * This service handles:
 * - Creating teams (new Stytch orgs + D1 metadata)
 * - Listing team members with roles
 * - Inviting/removing members
 * - Per-org JWT caching via session exchange
 * - Git remote detection for workspace identity
 *
 * Follows the TrackerSyncManager pattern:
 * - Module-level functions (no class)
 * - safeHandle() for IPC registration
 * - REST calls with JWT auth to collabv3
 */

import { net } from 'electron';
import { createHash } from 'crypto';
import { safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import { getNormalizedGitRemote } from '../utils/gitUtils';
import { getCollabSyncHttpUrl } from '../utils/collabSyncUrl';
import {
  getAccounts,
  getSessionJwt,
  getSessionJwtForAccount,
  getSessionToken,
  getSessionTokenForAccount,
  isAuthenticated,
  refreshSession,
  refreshSessionForAccount,
  onAuthStateChange,
  updateSessionToken,
} from './StytchAuthService';
import {
  getOrCreateIdentityKeyPair,
  uploadIdentityKeyToOrg,
  generateAndStoreOrgKey,
  wrapOrgKeyForMember,
  uploadEnvelope,
  exportPublicKeyJwk,
  fetchMemberPublicKey,
  deleteEnvelope,
  deleteAllEnvelopes,
  fetchAllEnvelopes,
  hasOrgKey,
  fetchAndUnwrapOrgKey,
  fetchOwnEnvelope,
  getOrgKeyFingerprint,
  clearOrgKey,
  getMemberTrustStatus,
  markMemberVerified,
  fingerprintIdentityKey,
} from './OrgKeyService';
import { performKeyRotation, cleanupOrphanedDocuments, reEncryptTrackerFromLocal } from './KeyRotationService';
// TrackerSyncManager already imports from this module (findTeamForWorkspace).
// The cycle is safe because both sides only reference the imported symbols
// inside function bodies, never at module-init time -- by the time
// autoMatchTeamForWorkspace runs, both modules are fully loaded.
import { ensureTrackerSyncForWorkspace } from './TrackerSyncManager';

// ============================================================================
// Server URL Helper
// ============================================================================

// Team operations resolve to the same host the renderer's DocumentSync /
// TrackerSync use; the canonical helper is `getCollabSyncHttpUrl` in
// utils/collabSyncUrl.ts. Re-exported under the original name so this
// module's many callers (and any external imports) don't churn.
const getCollabServerUrl = getCollabSyncHttpUrl;

// ============================================================================
// Types
// ============================================================================

interface TeamDetails {
  orgId: string;
  name: string;
  gitRemoteHash: string | null;
  /**
   * Server-minted UUID that names this team's tracker room
   * (tracker-sync-redesign D8 / NIM-404). May be null for snapshots from
   * old worker versions that predate the field; the tracker host adapter
   * fails closed in that case rather than falling back to gitRemoteHash.
   */
  teamProjectId?: string | null;
  createdAt: string;
  role: string;
  /** Stytch membership type: active_member, pending_member, or invited_member */
  membershipType?: string;
}

interface TeamMember {
  memberId: string;
  email: string;
  name: string;
  status: string;
  role: string;
  createdAt: string;
}

// ============================================================================
// Per-Org JWT Cache
// ============================================================================

interface CachedOrgJwt {
  jwt: string;
  expiresAt: number;
}

/** Cache of org-scoped JWTs. Key is orgId. */
const orgJwtCache = new Map<string, CachedOrgJwt>();

/** Buffer before JWT exp to refresh early (60 seconds). */
const JWT_REFRESH_BUFFER_MS = 60 * 1000;

/**
 * Extract the `exp` claim from a JWT without verifying it.
 * Returns epoch seconds, or null if parsing fails.
 */
function getJwtExp(jwt: string): number | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * Get an org-scoped JWT via session exchange. Caches per-org.
 * This does NOT touch the global auth state -- the personal org session is preserved.
 *
 * Cache TTL is derived from the actual JWT `exp` claim (minus a 60s buffer)
 * so we never serve an expired token.
 */
export async function getOrgScopedJwt(orgId: string, accountOrgId?: string): Promise<string> {
  // Check cache
  const cached = orgJwtCache.get(orgId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.jwt;
  }
  // logger.main.info(`[TeamService] Org JWT cache miss for ${orgId}, exchanging session...`);

  // Need to exchange -- use the correct account's session token
  const sessionToken = accountOrgId
    ? getSessionTokenForAccount(accountOrgId)
    : getSessionToken();
  if (!sessionToken) {
    logger.main.warn('[TeamService] getOrgScopedJwt: no session token available');
    throw new Error('Not authenticated. Sign in first.');
  }

  const httpUrl = getCollabServerUrl();

  // Use the correct account's JWT to authenticate the exchange request
  const personalJwt = accountOrgId
    ? getSessionJwtForAccount(accountOrgId)
    : getSessionJwt();
  if (!personalJwt) {
    throw new Error('Not authenticated. Sign in first.');
  }

  const doExchange = async (jwt: string, token: string) =>
    net.fetch(`${httpUrl}/api/teams/${orgId}/switch`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sessionToken: token }),
    });

  let response = await doExchange(personalJwt, sessionToken);

  // On 401, refresh the personal session and retry once.
  // The personal JWT expires after ~5 minutes; reconnecting tracker sync
  // after a WebSocket drop hits this path routinely.
  if (response.status === 401) {
    logger.main.info(`[TeamService] getOrgScopedJwt: 401 for ${orgId}, refreshing session...`);
    let refreshed = false;
    try {
      if (accountOrgId) {
        const freshJwt = await refreshSessionForAccount(accountOrgId);
        refreshed = !!freshJwt;
      } else {
        refreshed = await refreshSession();
      }
    } catch {
      // Network error -- can't retry
    }
    if (refreshed) {
      const freshJwt = accountOrgId
        ? getSessionJwtForAccount(accountOrgId)
        : getSessionJwt();
      const freshToken = accountOrgId
        ? getSessionTokenForAccount(accountOrgId)
        : getSessionToken();
      if (freshJwt && freshToken) {
        response = await doExchange(freshJwt, freshToken);
      }
    }
  }

  if (!response.ok) {
    const errData = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string };
    throw new Error(errData.error || `Failed to get org-scoped JWT: ${response.status}`);
  }

  const data = await response.json() as {
    sessionJwt: string;
    sessionToken: string;
  };

  if (!data.sessionJwt) {
    throw new Error('Session exchange returned no JWT');
  }

  // Stytch session exchange replaces the session token -- the old one is now
  // invalid. We MUST persist the new token so that refreshSession() and
  // getSessionToken() continue to work.
  // BUT: only update the global token when operating under the primary account.
  // Secondary account exchanges must NOT overwrite the primary's token.
  if (data.sessionToken && !accountOrgId) {
    updateSessionToken(data.sessionToken);
  }

  // Derive cache TTL from the actual JWT exp claim (with 60s buffer).
  // Fall back to 5 minutes if we can't parse it.
  const exp = getJwtExp(data.sessionJwt);
  const expiresAt = exp
    ? (exp * 1000) - JWT_REFRESH_BUFFER_MS
    : Date.now() + 5 * 60 * 1000;

  // Cache the org-scoped JWT (do NOT update global auth state -- the global
  // session JWT stays personal-org-scoped, only the token is shared)
  orgJwtCache.set(orgId, {
    jwt: data.sessionJwt,
    expiresAt,
  });

  // logger.main.info('[TeamService] Obtained org-scoped JWT for:', orgId, 'expires in', Math.round((expiresAt - Date.now()) / 1000), 's');
  return data.sessionJwt;
}

// ============================================================================
// REST API Helper
// ============================================================================

/**
 * Per-request deadline for `fetchTeamApi`. `net.fetch` has no default
 * timeout, so without this an unresponsive worker (e.g. the Stytch B2B
 * JWKS outage on 2026-05-20) can hang IPC handlers indefinitely. NIM-638
 * was a stuck tracker editor caused by `team:list-members` waiting on
 * such a hung request forever. 15s is generous for these calls -- a
 * healthy worker responds in under a second.
 */
const TEAM_API_TIMEOUT_MS = 15_000;

/**
 * Make an authenticated REST call to the collabv3 team API.
 * Uses the personal org JWT for team-listing endpoints.
 * Uses org-scoped JWT when orgId is provided (for member operations).
 * When accountOrgId is provided, uses that account's JWT instead of the primary.
 */
async function fetchTeamApi(path: string, method: string, body?: unknown, orgId?: string, accountOrgId?: string): Promise<any> {
  const httpUrl = getCollabServerUrl();

  const jwtSource = orgId ? 'org-scoped' : 'personal';
  // logger.main.info(`[TeamService] ${method} ${path} (jwt: ${jwtSource}${orgId ? `, org: ${orgId}` : ''}${accountOrgId ? `, account: ${accountOrgId}` : ''})`);

  const makeRequest = async (jwt: string) => {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${jwt}`,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEAM_API_TIMEOUT_MS);
    try {
      return await net.fetch(`${httpUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        throw new Error(`Team API timeout after ${TEAM_API_TIMEOUT_MS}ms: ${method} ${path}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  // Use org-scoped JWT if orgId provided, otherwise personal JWT
  // When accountOrgId is set, use that specific account's JWT
  let jwt = orgId
    ? await getOrgScopedJwt(orgId)
    : accountOrgId
      ? getSessionJwtForAccount(accountOrgId)
      : getSessionJwt();
  if (!jwt) {
    logger.main.warn(`[TeamService] No JWT available (source: ${jwtSource})`);
    throw new Error('Not authenticated. Sign in first.');
  }

  let response = await makeRequest(jwt);

  // On 401, retry once: refresh personal session or re-exchange org JWT
  if (response.status === 401) {
    if (accountOrgId && !orgId) {
      // Non-primary account JWT rejected -- try refreshing the secondary account's session
      logger.main.info(`[TeamService] Got 401 on account JWT for ${accountOrgId}, attempting refresh...`);
      const freshJwt = await refreshSessionForAccount(accountOrgId);
      if (freshJwt) {
        logger.main.info(`[TeamService] Secondary account ${accountOrgId} refreshed, retrying request...`);
        response = await makeRequest(freshJwt);
      } else {
        logger.main.warn(`[TeamService] Secondary account ${accountOrgId} refresh failed`);
      }
    } else if (!orgId) {
      logger.main.info('[TeamService] Got 401 on personal JWT, refreshing session...');
      let refreshed = false;
      try {
        refreshed = await refreshSession();
      } catch {
        // Network error -- can't retry
      }
      if (refreshed) {
        const freshJwt = getSessionJwt();
        if (freshJwt) {
          logger.main.info('[TeamService] Session refreshed, retrying request...');
          response = await makeRequest(freshJwt);
        } else {
          logger.main.warn('[TeamService] Session refreshed but getSessionJwt() returned null');
        }
      } else {
        logger.main.warn('[TeamService] Session refresh failed, cannot retry');
      }
    } else {
      // Org-scoped JWT rejected -- invalidate cache and re-exchange
      logger.main.info(`[TeamService] Got 401 on org-scoped JWT for ${orgId}, invalidating cache and re-exchanging...`);
      orgJwtCache.delete(orgId);
      try {
        const freshOrgJwt = await getOrgScopedJwt(orgId);
        logger.main.info('[TeamService] Org JWT re-exchanged, retrying request...');
        response = await makeRequest(freshOrgJwt);
      } catch (exchangeErr) {
        logger.main.error('[TeamService] Org JWT re-exchange failed:', exchangeErr);
      }
    }
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    let errMsg: string;
    try {
      const errData = JSON.parse(errText) as { error?: string };
      errMsg = errData.error || `HTTP ${response.status}`;
    } catch {
      errMsg = `HTTP ${response.status}${errText ? `: ${errText.slice(0, 200)}` : ''}`;
    }
    logger.main.error(`[TeamService] ${method} ${path} failed: ${response.status} - ${errMsg}`);
    throw new Error(errMsg);
  }

  return response.json();
}

// ============================================================================
// Git Remote Detection
// ============================================================================

/**
 * Hash a git remote URL with SHA-256 for server-side lookup.
 * The server never sees the plaintext remote URL -- only the hex digest.
 */
function hashGitRemote(remote: string): string {
  return createHash('sha256').update(remote).digest('hex');
}

/**
 * Extract the member ID (sub claim) from a Stytch B2B JWT.
 * The JWT is a standard 3-part base64url-encoded token.
 */
function getMemberIdFromJwt(jwt: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
    return payload.sub || null;
  } catch {
    return null;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * List all teams the current user belongs to, across all signed-in accounts.
 * Queries each account's teams and deduplicates by orgId.
 */
// Short-TTL cache: findTeamForWorkspace is fanned out from many sites
// (workspace open, sync init, tracker init, body-doc service, etc.) and each
// listTeams call hits /api/teams once per signed-in account. Without this,
// opening a workspace can trigger a parallel HTTP storm and the same call
// repeats every few hundred ms during init.
let listTeamsCache: { promise: Promise<TeamDetails[]>; expiresAt: number } | null = null;
const LIST_TEAMS_TTL_MS = 5000;

export function invalidateListTeamsCache(): void {
  listTeamsCache = null;
}

async function listTeams(): Promise<TeamDetails[]> {
  if (!isAuthenticated()) {
    logger.main.info('[TeamService] listTeams: not authenticated, skipping');
    return [];
  }

  const now = Date.now();
  if (listTeamsCache && listTeamsCache.expiresAt > now) {
    return listTeamsCache.promise;
  }

  const promise = (async (): Promise<TeamDetails[]> => {
    const allAccounts = getAccounts();
    const seenOrgIds = new Set<string>();
    const allTeams: TeamDetails[] = [];

    // Query teams for each signed-in account in parallel
    const results = await Promise.allSettled(
      allAccounts.map(async (account) => {
        try {
          const data = await fetchTeamApi('/api/teams', 'GET', undefined, undefined, account.personalOrgId) as { teams: TeamDetails[] };
          return data.teams || [];
        } catch (err) {
          logger.main.error(`[TeamService] listTeams error for account ${account.email}:`, err);
          return [];
        }
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const team of result.value) {
          if (!seenOrgIds.has(team.orgId)) {
            seenOrgIds.add(team.orgId);
            allTeams.push(team);
          }
        }
      }
    }

    return allTeams;
  })();

  listTeamsCache = { promise, expiresAt: now + LIST_TEAMS_TTL_MS };
  // Drop the cache on rejection so the next caller retries instead of pinning
  // a failed promise for the TTL window.
  promise.catch(() => {
    if (listTeamsCache?.promise === promise) listTeamsCache = null;
  });

  return promise;
}

/**
 * Get a specific team's details by orgId.
 */
async function getTeamByOrgId(orgId: string): Promise<TeamDetails | null> {
  if (!isAuthenticated()) return null;

  try {
    const teams = await listTeams();
    return teams.find(t => t.orgId === orgId) || null;
  } catch (err) {
    logger.main.error('[TeamService] getTeamByOrgId error:', err);
    return null;
  }
}

/**
 * Find a team matching a workspace's git remote.
 * Pass precomputedRemote to skip the git spawn when the caller already has it.
 */
export async function findTeamForWorkspace(workspacePath: string, precomputedRemote?: string): Promise<TeamDetails | null> {
  if (!isAuthenticated()) {
    // logger.main.info('[TeamService] findTeamForWorkspace: not authenticated');
    return null;
  }

  const remote = precomputedRemote ?? await getNormalizedGitRemote(workspacePath);
  if (!remote) {
    // logger.main.info('[TeamService] findTeamForWorkspace: no git remote for', workspacePath);
    return null;
  }

  const remoteHash = hashGitRemote(remote);

  try {
    const teams = await listTeams();
    // Only match teams where the user is an active member -- never auto-join
    // invited or pending teams without explicit user consent.
    const activeTeams = teams.filter(t => !t.membershipType || t.membershipType === 'active_member');
    const match = activeTeams.find(t => t.gitRemoteHash === remoteHash) || null;
    if (match) {
      // logger.main.info('[TeamService] findTeamForWorkspace: matched team:', match.name, 'orgId:', match.orgId, 'for workspace:', workspacePath);
    } else if (teams.length > 0) {
      // Don't dump the full team list on every miss -- this is on a hot path
      // (called from many sites during workspace init) and the full dump was
      // burning measurable CPU on JSON.stringify alone.
      logger.main.debug('[TeamService] findTeamForWorkspace: no hash match', { remoteHash, teamCount: teams.length });
    }
    return match;
  } catch (err) {
    logger.main.error('[TeamService] findTeamForWorkspace error:', err);
    return null;
  }
}

/**
 * Find a pending invite matching a workspace's git remote.
 * Used by the UI to show "Join Team" for invites that match the current project.
 */
export async function findPendingInviteForWorkspace(workspacePath: string): Promise<TeamDetails | null> {
  if (!isAuthenticated()) return null;

  const remote = await getNormalizedGitRemote(workspacePath);
  if (!remote) return null;

  const remoteHash = hashGitRemote(remote);

  try {
    const teams = await listTeams();
    const pendingTeams = teams.filter(t => t.membershipType && t.membershipType !== 'active_member');
    const match = pendingTeams.find(t => t.gitRemoteHash === remoteHash) || null;
    if (match) {
      logger.main.info('[TeamService] findPendingInviteForWorkspace: matched pending invite:', match.name, 'orgId:', match.orgId, 'membershipType:', match.membershipType);
    }
    return match;
  } catch (err) {
    logger.main.error('[TeamService] findPendingInviteForWorkspace error:', err);
    return null;
  }
}

/**
 * Create a new team (Stytch org + D1 metadata + encryption key setup).
 * Returns the new team details. Does NOT modify global auth state.
 */
async function createTeam(name: string, workspacePath?: string, accountOrgId?: string): Promise<TeamDetails> {
  let gitRemoteHash: string | undefined;
  if (workspacePath) {
    const remote = await getNormalizedGitRemote(workspacePath);
    if (remote) {
      gitRemoteHash = hashGitRemote(remote);
    }
  }

  // Create team using the specified account's JWT (or primary if not specified)
  const result = await fetchTeamApi('/api/teams', 'POST', {
    name,
    gitRemoteHash,
  }, undefined, accountOrgId) as { orgId: string; name: string; creatorMemberId: string };

  logger.main.info('[TeamService] Team created:', result.orgId, name);

  // Set up encryption: identity key + org key + self-wrap
  try {
    const orgJwt = await getOrgScopedJwt(result.orgId, accountOrgId);

    // 1. Ensure identity key pair exists
    await getOrCreateIdentityKeyPair();

    // 2. Upload public key to the new team org
    await uploadIdentityKeyToOrg(orgJwt);

    // 3. Generate org encryption key
    await generateAndStoreOrgKey(result.orgId);

    // 4. Post initial org key fingerprint to server
    const initialFingerprint = getOrgKeyFingerprint(result.orgId);
    if (initialFingerprint) {
      await fetchTeamApi(`/api/teams/${result.orgId}/org-key-fingerprint`, 'PUT', { fingerprint: initialFingerprint }, result.orgId);
    }

    // 5. Wrap org key for self and upload envelope
    const myPublicKeyJwk = await exportPublicKeyJwk();
    const envelope = await wrapOrgKeyForMember(result.orgId, myPublicKeyJwk);
    await uploadEnvelope(result.orgId, result.creatorMemberId, envelope, orgJwt);

    logger.main.info('[TeamService] Encryption set up for team:', result.orgId);
  } catch (err) {
    // Team was created but encryption setup failed -- log but don't fail
    logger.main.error('[TeamService] Encryption setup failed for team:', result.orgId, err);
  }

  return {
    orgId: result.orgId,
    name: result.name,
    gitRemoteHash: gitRemoteHash || null,
    createdAt: new Date().toISOString(),
    role: 'admin',
  };
}

/**
 * Accept a pending team invite. Exchanges the personal session for an
 * org-scoped session (promoting the user from pending/invited to active
 * in Stytch automatically), then sets up encryption keys.
 */
async function acceptInvite(orgId: string): Promise<TeamDetails> {
  // 1. Exchange session for the team org -- Stytch promotes pending -> active_member
  const orgJwt = await getOrgScopedJwt(orgId);

  // 2. Set up encryption: identity key + fetch org key
  try {
    await getOrCreateIdentityKeyPair();
    await uploadIdentityKeyToOrg(orgJwt);

    // Try to fetch and unwrap org key (admin may not have wrapped it yet)
    await fetchAndUnwrapOrgKey(orgId, orgJwt);
    logger.main.info('[TeamService] Encryption set up after accepting invite for:', orgId);
  } catch (err) {
    // Encryption setup can fail if admin hasn't shared key yet -- that's OK
    logger.main.warn('[TeamService] Encryption setup after invite accept (non-fatal):', err);
  }

  // 3. Fetch team details now that we're an active member
  const teams = await listTeams();
  const team = teams.find(t => t.orgId === orgId);
  if (!team) {
    throw new Error('Joined team but could not find it in team list');
  }

  logger.main.info('[TeamService] Accepted invite for team:', team.name, 'orgId:', orgId);
  return team;
}

/**
 * List members of a team. Requires explicit orgId.
 */
async function listMembers(orgId: string): Promise<{ members: TeamMember[]; callerRole: string }> {
  const data = await fetchTeamApi(`/api/teams/${orgId}/members`, 'GET', undefined, orgId) as {
    members: TeamMember[];
    callerRole: string;
  };
  return data;
}

/**
 * Invite a member to a team by email. Requires explicit orgId.
 */
async function inviteMember(orgId: string, email: string): Promise<void> {
  await fetchTeamApi(`/api/teams/${orgId}/invite`, 'POST', { email }, orgId);
}

/**
 * Remove a member from a team. Requires explicit orgId.
 *
 * IMPORTANT: Rotation happens BEFORE member removal. If rotation fails,
 * the member stays in the org (fail closed). This prevents the scenario
 * where a member is removed but data is still encrypted with the old key
 * that the removed member had access to.
 */
async function removeMember(orgId: string, memberId: string): Promise<void> {
  const orgJwt = await getOrgScopedJwt(orgId);
  const serverUrl = getCollabServerUrl();

  // Step 1: Rotate key and re-encrypt all data BEFORE removing the member.
  // If this fails, the member stays -- fail closed, not fail open.
  // IMPORTANT: Exclude the member being removed from the key distribution list.
  // Otherwise they receive the new key before deletion completes.
  const { backupDir } = await performKeyRotation(
    orgId,
    `member-removal:${memberId}`,
    orgJwt,
    serverUrl,
    async () => {
      const { members } = await listMembers(orgId);
      return { members: members.filter(m => m.memberId !== memberId) };
    }
  );

  logger.main.info('[TeamService] Key rotation complete, backup:', backupDir);

  // Step 2: Only remove the member after rotation succeeds.
  // At this point all data is re-encrypted with the new key that
  // the removed member never had access to.
  await fetchTeamApi(`/api/teams/${orgId}/members/${memberId}`, 'DELETE', undefined, orgId);

  logger.main.info('[TeamService] Member removed after successful rotation:', memberId);
}

/**
 * Delete a team entirely. Admin only.
 * Deletes Stytch org, D1 metadata, and TeamRoom DO state.
 */
async function deleteTeam(orgId: string): Promise<void> {
  await fetchTeamApi(`/api/teams/${orgId}`, 'DELETE', undefined, orgId);
  // Clear cached org JWT since the org no longer exists
  orgJwtCache.delete(orgId);
  logger.main.info('[TeamService] Team deleted:', orgId);
}

/**
 * Update a member's role in a team. Requires explicit orgId.
 */
async function updateMemberRole(orgId: string, memberId: string, role: string): Promise<void> {
  await fetchTeamApi(`/api/teams/${orgId}/members/${memberId}`, 'PUT', { role }, orgId);
}

/**
 * Set the project identity (git remote hash) for a team. Admin only.
 */
async function setProjectIdentity(orgId: string, gitRemoteHash: string): Promise<void> {
  await fetchTeamApi(`/api/teams/${orgId}/project-identity`, 'PUT', { gitRemoteHash }, orgId);
}

/**
 * Clear the project identity for a team. Admin only.
 */
async function clearProjectIdentity(orgId: string): Promise<void> {
  await fetchTeamApi(`/api/teams/${orgId}/project-identity`, 'DELETE', undefined, orgId);
}

/**
 * Re-share the org encryption key with a specific member.
 * Admin-only: fetches the member's current public key and wraps the org key for them.
 * Used when a member's identity key pair was regenerated (new device, corrupted safeStorage).
 */
async function reshareKeyForMember(orgId: string, memberId: string): Promise<void> {
  const orgJwt = await getOrgScopedJwt(orgId);

  // Delete stale envelope for this member (if any)
  try {
    await deleteEnvelope(orgId, memberId, orgJwt);
  } catch {
    // May not exist -- that's fine
  }

  // Fetch the member's current public key and wrap the org key for them
  const memberPubKey = await fetchMemberPublicKey(memberId, orgJwt);
  const envelope = await wrapOrgKeyForMember(orgId, memberPubKey);
  await uploadEnvelope(orgId, memberId, envelope, orgJwt);

  logger.main.info('[TeamService] Re-shared org key for member:', memberId);
}

// ============================================================================
// Auto-Match: Org Key for Workspace
// ============================================================================

/**
 * Ensure the org encryption key is available for a workspace's team.
 * If the workspace matches a team and we don't have the key yet,
 * fetches the key envelope from the server and unwraps it.
 */
async function ensureOrgKeyForWorkspace(workspacePath: string): Promise<{
  team: TeamDetails | null;
  hasKey: boolean;
}> {
  if (!isAuthenticated()) return { team: null, hasKey: false };

  const team = await findTeamForWorkspace(workspacePath);
  if (!team) return { team: null, hasKey: false };

  // Check if we already have the org key locally
  if (hasOrgKey(team.orgId)) {
    // Verify our local key matches the server's current key fingerprint.
    // If it doesn't match, the key was rotated by another admin and ours is stale.
    let keyIsStale = false;
    try {
      const orgJwt = await getOrgScopedJwt(team.orgId);
      const localFp = getOrgKeyFingerprint(team.orgId);

      // Check server fingerprint
      try {
        const fpResp = await fetchTeamApi(`/api/teams/${team.orgId}/org-key-fingerprint`, 'GET', undefined, team.orgId) as { fingerprint: string | null };
        if (fpResp.fingerprint && localFp && fpResp.fingerprint !== localFp) {
          logger.main.warn('[TeamService] Org key is stale (local:', localFp, 'server:', fpResp.fingerprint, ')');
          clearOrgKey(team.orgId);
          keyIsStale = true;
        } else if (!fpResp.fingerprint && localFp) {
          // Server has no fingerprint yet (legacy team) -- seed it if we're an admin
          logger.main.info('[TeamService] Server has no org key fingerprint, seeding:', localFp);
          try {
            await fetchTeamApi(`/api/teams/${team.orgId}/org-key-fingerprint`, 'PUT', { fingerprint: localFp }, team.orgId);
          } catch {
            // Non-fatal -- admin-only, may fail if we're not admin
          }
        }
      } catch {
        // Network error checking fingerprint -- proceed with local key
      }

      if (!keyIsStale) {
        // Key is current. Ensure our envelope exists on the server.
        // After a DO wipe, the local key cache survives but server envelopes are gone.
        await getOrCreateIdentityKeyPair();
        await uploadIdentityKeyToOrg(orgJwt);

        const existingEnvelope = await fetchOwnEnvelope(team.orgId, orgJwt);
        if (!existingEnvelope) {
          logger.main.info('[TeamService] Has local key but no server envelope, re-uploading for:', team.orgId);
          const myPublicKeyJwk = await exportPublicKeyJwk();
          const envelope = await wrapOrgKeyForMember(team.orgId, myPublicKeyJwk);
          const myMemberId = getMemberIdFromJwt(orgJwt);
          if (myMemberId) {
            await uploadEnvelope(team.orgId, myMemberId, envelope, orgJwt);
            logger.main.info('[TeamService] Re-uploaded envelope for:', team.orgId);
          }
        }
        return { team, hasKey: true };
      }
      // If key was stale, fall through to re-fetch from server
    } catch (err) {
      if (!keyIsStale) {
        // Non-fatal -- we still have the key locally
        logger.main.warn('[TeamService] Failed to verify/re-upload envelope:', err);
        return { team, hasKey: true };
      }
    }
  }

  // Try to fetch and unwrap from server
  try {
    const orgJwt = await getOrgScopedJwt(team.orgId);

    // Ensure identity key pair exists and public key is uploaded
    await getOrCreateIdentityKeyPair();
    await uploadIdentityKeyToOrg(orgJwt);

    let key: CryptoKey | null = null;
    let unwrapFailed = false;
    try {
      key = await fetchAndUnwrapOrgKey(team.orgId, orgJwt);
    } catch (unwrapErr) {
      // Envelope exists but can't be unwrapped (identity key was regenerated).
      // Recovery strategy:
      // 1. Delete the stale envelope (wrapped for old identity key)
      // 2. Re-upload identity key to trigger `identityKeyUploaded` broadcast
      //    to all connected TeamRoom clients
      // 3. Connected admins who have the org key will auto-wrap a fresh
      //    envelope for our new identity key via `autoWrapNewMembers`
      // 4. We poll for the new envelope below
      logger.main.warn(
        '[TeamService] Failed to unwrap own envelope for:',
        team.orgId,
        '-- identity key may have changed. Triggering key recovery from other admins.',
        unwrapErr,
      );
      unwrapFailed = true;
      const myMemberId = getMemberIdFromJwt(orgJwt);
      if (myMemberId) {
        try {
          // Step 1: Delete stale envelope first (so we appear "unwrapped")
          await deleteEnvelope(team.orgId, myMemberId, orgJwt);
          logger.main.info('[TeamService] Deleted stale envelope for self');

          // Step 2: Re-upload identity key to broadcast `identityKeyUploaded`
          // to connected admins. They see us as "unwrapped" and auto-wrap.
          await uploadIdentityKeyToOrg(orgJwt);
          logger.main.info('[TeamService] Re-uploaded identity key to trigger auto-wrap from other admins');
        } catch (recoveryErr) {
          logger.main.warn('[TeamService] Key recovery setup failed:', recoveryErr);
        }
      }
    }

    if (key !== null) {
      return { team, hasKey: true };
    }

    // No usable org key yet. If we just signaled other admins, poll briefly
    // to see if one of them wraps a fresh envelope for us in realtime.
    if (unwrapFailed) {
      logger.main.info('[TeamService] Polling for fresh envelope from other admins...');
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        try {
          const freshKey = await fetchAndUnwrapOrgKey(team.orgId, orgJwt);
          if (freshKey !== null) {
            logger.main.info('[TeamService] Recovered org key from another admin on attempt', attempt + 1);
            return { team, hasKey: true };
          }
        } catch {
          // Envelope still not available or still stale -- keep polling
        }
      }
      logger.main.warn(
        '[TeamService] Org key recovery timed out for:', team.orgId,
        '-- another admin with the org key needs to be online for recovery.',
      );
    } else {
      logger.main.warn(
        '[TeamService] No envelope found on server for:', team.orgId,
        '-- another admin with the org key must be online to share the key.',
      );
    }

    return { team, hasKey: false };

  } catch (err) {
    logger.main.warn('[TeamService] Failed to ensure org key for workspace:', workspacePath, err);
    return { team, hasKey: false };
  }
}

// Active auto-wrap polling intervals keyed by orgId
const autoWrapIntervals = new Map<string, ReturnType<typeof setInterval>>();

/**
 * Start a background polling interval that periodically checks for unwrapped
 * team members and wraps the org key for them. This handles the case where a
 * new member uploads their identity key after the admin's initial startup wrap.
 * Polls every 15s for 5 minutes, then stops.
 */
function startAutoWrapPolling(orgId: string): void {
  // Don't start duplicate intervals for the same org
  if (autoWrapIntervals.has(orgId)) return;

  let attempts = 0;
  const maxAttempts = 20; // 15s * 20 = 5 minutes
  const intervalMs = 15_000;

  const interval = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(interval);
      autoWrapIntervals.delete(orgId);
      return;
    }

    try {
      await autoWrapForNewMembers(orgId);
    } catch (err) {
      // Non-admin members will get "Only admins can manage key envelopes" --
      // stop polling since this user can't wrap keys
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Only admins') || msg.includes('403')) {
        clearInterval(interval);
        autoWrapIntervals.delete(orgId);
      }
    }
  }, intervalMs);

  autoWrapIntervals.set(orgId, interval);
}

/**
 * Auto-match a workspace to a team on open. Fire-and-forget.
 * If matched, ensures the org key is available and notifies renderer windows.
 */
export async function autoMatchTeamForWorkspace(workspacePath: string): Promise<void> {
  logger.main.info('[TeamService] autoMatchTeamForWorkspace:', workspacePath);

  // If auth isn't ready yet (common at startup -- session restore runs before Stytch init),
  // defer until auth becomes available via a one-shot listener.
  if (!isAuthenticated()) {
    logger.main.info('[TeamService] Auth not ready, deferring autoMatch for:', workspacePath);
    const unsubscribe = onAuthStateChange((authState) => {
      if (authState.isAuthenticated) {
        unsubscribe();
        logger.main.info('[TeamService] Auth now ready, retrying autoMatch for:', workspacePath);
        autoMatchTeamForWorkspace(workspacePath).catch(() => {});
      }
    });
    return;
  }

  try {
    const result = await ensureOrgKeyForWorkspace(workspacePath);
    if (result.team) {
      logger.main.info('[TeamService] Workspace matched to team:', result.team.name, 'orgId:', result.team.orgId, 'hasKey:', result.hasKey);

      // If we have the org key, auto-wrap for any members missing envelopes
      if (result.hasKey) {
        autoWrapForNewMembers(result.team.orgId).catch(err => {
          logger.main.warn(`[TeamService] Auto-wrap for new members of ${result.team?.orgId} failed:`, err);
        });
        // Start background polling to catch members who upload their key later
        startAutoWrapPolling(result.team.orgId);
      }

      // Notify all renderer windows about the team match
      const { BrowserWindow } = await import('electron');
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('team:workspace-matched', {
          orgId: result.team.orgId,
          teamName: result.team.name,
          workspacePath,
          hasKey: result.hasKey,
        });
      }

      // Why: callers run autoMatch and initializeTrackerSync in parallel
      // (WorkspaceManagerWindow, index.ts CLI open, RepositoryManager
      // auth-change reinit). The parallel init typically races ahead, finds
      // no team yet via findTeamForWorkspace, and bails at a debug-level
      // log line that never makes it to main.log. We use the race-safe
      // ensureTrackerSyncForWorkspace here: if the parallel call is still
      // inflight, we share its promise; if it already bailed silently or
      // bails when our shared promise resolves, ensure retries once more
      // with a fresh init so the engine actually starts.
      ensureTrackerSyncForWorkspace(workspacePath).catch(err => {
        logger.main.warn('[TeamService] post-match ensureTrackerSyncForWorkspace failed for', workspacePath, err);
      });
    }
  } catch (err) {
    // Fire-and-forget -- never block workspace open
    logger.main.error('[TeamService] autoMatchTeamForWorkspace error:', err);
  }
}

/**
 * Check for team members who don't have key envelopes yet and wrap for them.
 * Called by admin's client on workspace open to distribute org keys to new members.
 */
export async function autoWrapForNewMembers(orgId: string): Promise<void> {
  // Verify our local key is current before wrapping for others.
  // Wrapping a stale key for new members would spread split-brain encryption.
  const localFp = getOrgKeyFingerprint(orgId);
  if (!localFp) return; // No local key at all

  const orgJwt = await getOrgScopedJwt(orgId);

  try {
    const fpResp = await fetchTeamApi(`/api/teams/${orgId}/org-key-fingerprint`, 'GET', undefined, orgId) as { fingerprint: string | null };
    if (fpResp.fingerprint && fpResp.fingerprint !== localFp) {
      logger.main.warn('[TeamService] autoWrap skipped: local org key is stale (local:', localFp, 'server:', fpResp.fingerprint, ')');
      return;
    }
  } catch {
    // Network error -- skip wrapping to be safe (don't risk spreading a stale key)
    logger.main.warn('[TeamService] autoWrap skipped: could not verify org key fingerprint');
    return;
  }

  // Get all members and all existing envelopes
  const { members } = await listMembers(orgId);
  const envelopes = await fetchAllEnvelopes(orgId, orgJwt);
  const wrappedUserIds = new Set(envelopes.map((e: { targetUserId: string }) => e.targetUserId));

  // Find active members without envelopes
  const unwrappedMembers = members.filter(
    m => m.status !== 'pending' && !wrappedUserIds.has(m.memberId)
  );

  if (unwrappedMembers.length === 0) return;

  logger.main.info('[TeamService] Auto-wrapping org key for', unwrappedMembers.length, 'new member(s)');

  for (const member of unwrappedMembers) {
    try {
      const memberPubKey = await fetchMemberPublicKey(member.memberId, orgJwt);
      // Trust gate (security review Issue 2): only wrap if we haven't
      // recorded a different fingerprint for this member. `unverified` is
      // TOFU on first contact -- we wrap and record the fingerprint so the
      // next swap (member rotates their device key, or server lies about
      // which key belongs to them) is caught as `fingerprint-changed` and
      // skipped until the admin manually re-verifies via the trust UI.
      const memberFingerprint = await fingerprintIdentityKey(memberPubKey);
      const trustStatus = getMemberTrustStatus(orgId, member.memberId, memberFingerprint);
      if (trustStatus === 'fingerprint-changed') {
        logger.main.warn(
          '[TeamService] Skipping auto-wrap for', member.email || member.memberId,
          '-- identity key fingerprint changed; manual re-verification required',
        );
        continue;
      }

      const envelope = await wrapOrgKeyForMember(orgId, memberPubKey);
      await uploadEnvelope(orgId, member.memberId, envelope, orgJwt);
      if (trustStatus === 'unverified') {
        markMemberVerified(orgId, member.memberId, memberFingerprint);
      }
      logger.main.info('[TeamService] Wrapped org key for member:', member.email || member.memberId);
    } catch (err) {
      // Member may not have uploaded their public key yet - that's OK
      logger.main.warn('[TeamService] Could not wrap key for member:', member.memberId, err);
    }
  }
}

// ============================================================================
// IPC Handler Registration
// ============================================================================

export function registerTeamHandlers(): void {
  safeHandle('team:list', async () => {
    try {
      const teams = await listTeams();
      return { success: true, teams };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:find-for-workspace', async (_event, workspacePath: string) => {
    try {
      // Try active team match first
      const team = await findTeamForWorkspace(workspacePath);
      if (team) {
        return { success: true, team };
      }
      // Also check for pending invites matching this workspace
      const pendingInvite = await findPendingInviteForWorkspace(workspacePath);
      if (pendingInvite) {
        return { success: true, team: pendingInvite };
      }
      return { success: true, team: null };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:get', async (_event, orgId: string) => {
    try {
      const team = await getTeamByOrgId(orgId);
      return { success: true, team };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:create', async (_event, name: string, workspacePath?: string, accountOrgId?: string) => {
    try {
      const team = await createTeam(name, workspacePath, accountOrgId);
      return { success: true, team };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:accept-invite', async (_event, orgId: string) => {
    try {
      const team = await acceptInvite(orgId);
      return { success: true, team };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:list-members', async (_event, orgId: string) => {
    try {
      const data = await listMembers(orgId);
      return { success: true, ...data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:invite', async (_event, orgId: string, email: string) => {
    try {
      await inviteMember(orgId, email);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:remove-member', async (_event, orgId: string, memberId: string) => {
    try {
      await removeMember(orgId, memberId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:delete', async (_event, orgId: string) => {
    try {
      await deleteTeam(orgId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:update-role', async (_event, orgId: string, memberId: string, role: string) => {
    try {
      await updateMemberRole(orgId, memberId, role);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:get-git-remote', async (_event, workspacePath: string) => {
    try {
      const remote = await getNormalizedGitRemote(workspacePath);
      return { success: true, remote };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:set-project-identity', async (_event, orgId: string, workspacePath: string) => {
    try {
      const remote = await getNormalizedGitRemote(workspacePath);
      if (!remote) {
        return { success: false, error: 'No git remote found for this workspace' };
      }
      const hash = hashGitRemote(remote);
      await setProjectIdentity(orgId, hash);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:clear-project-identity', async (_event, orgId: string) => {
    try {
      await clearProjectIdentity(orgId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:ensure-workspace-key', async (_event, workspacePath: string) => {
    try {
      const result = await ensureOrgKeyForWorkspace(workspacePath);
      return { success: true, team: result.team, hasKey: result.hasKey };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:reshare-key', async (_event, orgId: string, memberId: string) => {
    try {
      await reshareKeyForMember(orgId, memberId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:auto-wrap-new-members', async (_event, orgId: string) => {
    try {
      await autoWrapForNewMembers(orgId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:handle-org-key-rotated', async (_event, orgId: string, serverFingerprint: string) => {
    try {
      const localFp = getOrgKeyFingerprint(orgId);
      if (localFp && localFp !== serverFingerprint) {
        logger.main.warn('[TeamService] Org key rotated! Local key is stale. Clearing and re-fetching.');
        clearOrgKey(orgId);

        // Attempt to fetch the new key from our envelope
        const orgJwt = await getOrgScopedJwt(orgId);
        const key = await fetchAndUnwrapOrgKey(orgId, orgJwt);
        if (key) {
          logger.main.info('[TeamService] Successfully re-fetched org key after rotation');
          return { success: true, keyRefreshed: true };
        } else {
          logger.main.warn('[TeamService] No envelope available yet after key rotation');
          return { success: true, keyRefreshed: false };
        }
      }
      return { success: true, keyRefreshed: false };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:cleanup-orphaned-documents', async (_event, orgId: string) => {
    try {
      const orgJwt = await getOrgScopedJwt(orgId);
      const serverUrl = getCollabServerUrl();
      const result = await cleanupOrphanedDocuments(orgId, orgJwt, serverUrl);
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:recover-tracker-from-local', async (_event, orgId: string, workspacePath: string) => {
    try {
      const orgJwt = await getOrgScopedJwt(orgId);
      const serverUrl = getCollabServerUrl();
      const remote = await getNormalizedGitRemote(workspacePath);
      if (!remote) {
        return { success: false, error: 'No git remote found for workspace' };
      }
      const { database } = await import('../database/PGLiteDatabaseWorker');
      const result = await reEncryptTrackerFromLocal(orgId, remote, orgJwt, serverUrl, workspacePath, database);
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
