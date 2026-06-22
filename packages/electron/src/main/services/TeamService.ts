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
import { resolveTeamForRemoteHash } from './teamProjectResolver';
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
  getStytchUserId,
  getUserEmail,
  getPersonalOrgId,
  getPersonalUserId,
} from './StytchAuthService';
import { getDatabase } from '../database/initialize';
import {
  backfillProjection,
  applyMemberUpserted,
  applyMemberRemoved,
  applyMemberRoleChanged,
  applyProjectGrant,
  applyProjectRevoke,
  upsertProject,
  type OrgWithRoster,
  type MemberInput,
  type ProjectionDb,
  type ProjectRole,
} from './OrgProjectionService';
import { canAccess, type CanAccessInput, type AccessDatabase } from './OrgAccessResolver';
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
  /**
   * Epic H3 P0/A: the full project registry for this org. The server returns
   * every project (primary + secondary), each with its own tracker-room routing
   * key (`teamProjectId`) and `gitRemoteHash`. Used to resolve a workspace whose
   * git remote matches a SECONDARY project, not just the primary one. May be
   * absent for snapshots from worker versions predating the registry.
   */
  projects?: TeamProjectSummary[];
}

/**
 * Epic H3 P0/A: one project in an org's registry. `teamProjectId` names the
 * project's tracker room (`org:{orgId}:tracker:{teamProjectId}`); `projectId` is
 * the stable id used for grants / discovery.
 */
export interface TeamProjectSummary {
  projectId: string;
  teamProjectId: string;
  gitRemoteHash: string | null;
  slug: string | null;
  name: string | null;
}

/** Epic H3 P3: per-member row in the move wizard's pre-flight preview. */
export interface MovePreviewMember {
  email: string | null;
  projectRole: string;
  inDest: boolean;     // already a member of the destination org
  willInvite: boolean; // not in dest -> will be invited as a paid seat
}

/** Epic H3 P3: move-project pre-flight (read-only). */
export interface MovePreview {
  projectId: string;
  slug: string | null;
  slugCollision: boolean; // dest already has a project with this slug
  custodyBlocked: boolean; // either org still legacy-e2e -> route to H2 first
  members: MovePreviewMember[];
  seatDelta: number; // # of members who'll be invited (new paid seats)
}

/** Epic H3 P1/P2: move-project result. */
export interface MoveResultSummary {
  projectId: string;
  destOrgId: string;
  destTeamProjectId: string;
  movedDocuments: number;
  grantsTransferred: number;
  grantsPending: number;
  grantsDropped: number;
  grantsSkipped: number;
}

/** Epic H3 P4: merge-orgs result. */
export interface MergeResultSummary {
  survivorOrgId: string;
  drainedOrgId: string;
  movedProjects: Array<{ projectId: string; destTeamProjectId: string }>;
  rosterElevated: number;
  rosterToInvite: number;
  drainedDeleted: boolean;
  partial: boolean;
  failedProjectId?: string;
  error?: string;
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
    // logger.main.info(`[TeamService] getOrgScopedJwt: 401 for ${orgId}, refreshing session...`);
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
    const reqStart = Date.now();
    try {
      const resp = await net.fetch(`${httpUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const reqMs = Date.now() - reqStart;
      // Log slow (and any non-2xx) responses so a degraded team API surfaces
      // before it hits the 15s timeout. The happy-path 200s under 500ms stay
      // silent.
      if (reqMs >= 500 || !resp.ok) {
        logger.main.info(`[TeamService] ${method} ${path} -> ${resp.status} in ${reqMs}ms (jwt: ${jwtSource})`);
      }
      return resp;
    } catch (err) {
      const reqMs = Date.now() - reqStart;
      if ((err as { name?: string })?.name === 'AbortError') {
        logger.main.warn(`[TeamService] ${method} ${path} timed out after ${reqMs}ms (jwt: ${jwtSource})`);
        throw new Error(`Team API timeout after ${TEAM_API_TIMEOUT_MS}ms: ${method} ${path}`);
      }
      logger.main.warn(`[TeamService] ${method} ${path} threw after ${reqMs}ms (jwt: ${jwtSource}):`, err);
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
    // Epic H3 P0/A: resolve across ALL projects in each org (primary + secondary),
    // so a workspace whose remote matches a SECONDARY project routes to that
    // project's tracker room. The project registry rides along on listTeams
    // (cached), so this adds no extra fetch. See teamProjectResolver.ts.
    const match = resolveTeamForRemoteHash(teams, remoteHash);
    if (match) {
      // logger.main.info('[TeamService] findTeamForWorkspace: matched', match.orgId, match.teamProjectId);
      return match;
    }

    if (teams.length > 0) {
      // Don't dump the full team list on every miss -- this is on a hot path
      // (called from many sites during workspace init) and the full dump was
      // burning measurable CPU on JSON.stringify alone.
      logger.main.debug('[TeamService] findTeamForWorkspace: no hash match', { remoteHash, teamCount: teams.length });
    }
    return null;
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
 * Add a project to an EXISTING org (Epic H3 P0) — distinct from createTeam,
 * which mints a brand-new Stytch org + primary project. This adds a second
 * (third, …) project under an org the caller already administers, with no
 * Stytch round trip: the server DO mints a fresh tracker-room routing key and
 * the org's existing DEK already covers the new project's data.
 *
 * Returns the new project's ids; also mirrors a local `projects` row so the
 * client projection (migration 0013 tables) reflects the new project.
 */
async function addProjectToOrg(
  orgId: string,
  workspacePath?: string,
  name?: string,
): Promise<{ projectId: string; teamProjectId: string }> {
  let gitRemoteHash: string | undefined;
  if (workspacePath) {
    const remote = await getNormalizedGitRemote(workspacePath);
    if (remote) {
      gitRemoteHash = hashGitRemote(remote);
    }
  }

  const result = await fetchTeamApi(`/api/teams/${orgId}/projects`, 'POST', {
    name: name ?? null,
    gitRemoteHash,
  }, orgId) as { projectId: string; teamProjectId: string };

  logger.main.info('[TeamService] Project added to org:', orgId, 'project:', result.projectId);

  // Mirror into the local projection so canAccess + UI see the new project
  // without waiting for a full re-sync. Best-effort (server is authoritative).
  try {
    const db = getDatabase() as ProjectionDb | null;
    if (db) {
      await upsertProject(db, {
        projectId: result.teamProjectId,
        orgId,
        slug: name,
        gitOriginHash: gitRemoteHash ?? null,
      });
    }
  } catch (err) {
    logger.main.warn('[TeamService] Local projection upsert for new project failed (non-fatal):', err);
  }

  return result;
}

/**
 * List every project in an org (Epic H3 P0/A). Member-gated on the server; any
 * member can read the registry. Used by the UI to enumerate projects in an org
 * (e.g. an Organization → Projects management surface).
 */
async function listProjectsForOrg(orgId: string): Promise<TeamProjectSummary[]> {
  const result = await fetchTeamApi(`/api/teams/${orgId}/projects`, 'GET', undefined, orgId) as {
    projects: TeamProjectSummary[];
  };
  return result.projects || [];
}

/** Epic H3 P3: read-only pre-flight for the "Move to another org" wizard.
 *  Admin on BOTH orgs (server-enforced). */
async function previewMoveProject(
  srcOrgId: string, projectId: string, destOrgId: string,
): Promise<MovePreview> {
  return await fetchTeamApi(
    `/api/teams/${srcOrgId}/move-project/preview?projectId=${encodeURIComponent(projectId)}&destOrgId=${encodeURIComponent(destOrgId)}`,
    'GET', undefined, srcOrgId,
  ) as MovePreview;
}

/**
 * Epic H3 P1/P2: move a project (its trackers + docs + grants) into another org.
 * Admin on BOTH orgs (server-enforced). `dropMemberEmails` opts individual
 * members out of the grant transfer (§12 #3). On success the server has flipped
 * D1 routing; we drop the listTeams cache so the project re-resolves into the
 * destination org on the next workspace open / sync re-init.
 */
async function moveProjectToOrg(
  srcOrgId: string, projectId: string, destOrgId: string, dropMemberEmails?: string[],
): Promise<MoveResultSummary> {
  const result = await fetchTeamApi(`/api/teams/${srcOrgId}/move-project`, 'POST', {
    projectId, destOrgId, dropMemberEmails,
  }, srcOrgId) as MoveResultSummary;
  logger.main.info('[TeamService] Project moved:', projectId, srcOrgId, '->', destOrgId, result);
  invalidateListTeamsCache();
  return result;
}

/**
 * Epic H3 P4: merge one org into another — move ALL of the drained org's
 * projects into the survivor, union the rosters, optionally delete the drained
 * org. Admin on BOTH (server-enforced). Composes the move engine server-side.
 */
async function mergeOrg(
  drainedOrgId: string, survivorOrgId: string, deleteDrained: boolean, dropMemberEmails?: string[],
): Promise<MergeResultSummary> {
  const result = await fetchTeamApi(`/api/teams/${drainedOrgId}/merge-into`, 'POST', {
    survivorOrgId, deleteDrained, dropMemberEmails,
  }, drainedOrgId) as MergeResultSummary;
  logger.main.info('[TeamService] Org merged:', drainedOrgId, '->', survivorOrgId, result);
  invalidateListTeamsCache();
  return result;
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

// ============================================================================
// Epic H1: project-access grant management (admin only). These call the new
// collab REST endpoints, which forward to the TeamRoom DO project_access table.
// ============================================================================

/** Grant a member a project-scoped role. Admin only. */
async function grantProjectAccess(
  orgId: string, projectId: string, userId: string, projectRole: string,
): Promise<void> {
  await fetchTeamApi(
    `/api/teams/${orgId}/project-access`, 'POST',
    { projectId, userId, projectRole }, orgId,
  );
}

/** Revoke a member's access to a project. Admin only. */
async function revokeProjectAccess(orgId: string, projectId: string, userId: string): Promise<void> {
  const qp = `projectId=${encodeURIComponent(projectId)}&userId=${encodeURIComponent(userId)}`;
  await fetchTeamApi(`/api/teams/${orgId}/project-access?${qp}`, 'DELETE', undefined, orgId);
}

/** List the grants for a project. Admin only. */
async function listProjectAccess(
  orgId: string, projectId: string,
): Promise<Array<{ userId: string; projectRole: string }>> {
  const qp = `projectId=${encodeURIComponent(projectId)}`;
  const data = await fetchTeamApi(
    `/api/teams/${orgId}/project-access?${qp}`, 'GET', undefined, orgId,
  ) as { grants?: Array<{ userId: string; projectRole: string }> };
  return data.grants || [];
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

      // Epic H1: refresh the local org/project/membership projection so the
      // canAccess resolver has this team's roster + grants. Best-effort.
      syncOrgProjectionFromServer().catch(err => {
        logger.main.warn('[TeamService] post-match org projection sync failed:', err);
      });

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

/**
 * Epic H1: refresh the LOCAL org/project/membership projection from the
 * server-authoritative roster. Mints/updates `orgs`/`projects`/`org_members`/
 * `project_access` so the `canAccess` resolver can gate UX locally.
 *
 * Idempotent (upserts + DO NOTHING grant seeding) — safe to call on workspace
 * team match, after team mutations, or periodically. Best-effort: a roster
 * fetch failure for one team seeds that team with an empty roster rather than
 * aborting the whole sync.
 */
export async function syncOrgProjectionFromServer(): Promise<{
  success: boolean;
  counts?: { orgs: number; projects: number; members: number; grants: number };
  error?: string;
}> {
  if (!isAuthenticated()) return { success: false, error: 'not-authenticated' };
  const db = getDatabase() as AccessDatabase | null;
  if (!db) return { success: false, error: 'db-unavailable' };

  try {
    const orgs: OrgWithRoster[] = [];

    // Personal org (solo owner) so personal-context access resolves locally.
    const personalOrgId = getPersonalOrgId();
    const personalUserId = getPersonalUserId();
    if (personalOrgId && personalUserId) {
      orgs.push({
        org: { orgId: personalOrgId, name: 'Personal', flavor: 'personal' },
        members: [{ userId: personalUserId, email: getUserEmail(), role: 'owner' }],
      });
    }

    const teams = await listTeams();
    for (const team of teams) {
      let members: MemberInput[] = [];
      try {
        const data = await listMembers(team.orgId);
        members = (data.members || []).map((m) => ({
          userId: m.memberId,
          email: m.email,
          role: m.role,
        }));
      } catch (err) {
        // Pending/invited teams (or transient failures) can't list members --
        // seed the org row with an empty roster; a later sync fills it in.
        logger.main.debug('[TeamService] projection sync: listMembers failed for', team.orgId, err);
      }
      orgs.push({
        org: {
          orgId: team.orgId,
          name: team.name,
          flavor: 'team',
          teamProjectId: team.teamProjectId ?? null,
          gitOriginHash: team.gitRemoteHash,
        },
        members,
      });
    }

    const counts = await backfillProjection(db, orgs);
    logger.main.info('[TeamService] org projection synced:', counts);
    return { success: true, counts };
  } catch (err) {
    logger.main.error('[TeamService] syncOrgProjectionFromServer error:', err);
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Resolve the viewer's per-org member id (Stytch member ids are org-scoped) by
 * matching the current user's email against the local roster, then run the
 * `canAccess` resolver. Falls back to the current session's user id.
 */
async function canAccessForCurrentUser(input: CanAccessInput): Promise<{
  allowed: boolean; orgRole: string | null; projectRole: string | null; reason: string;
}> {
  const db = getDatabase() as AccessDatabase | null;
  if (!db) return { allowed: false, orgRole: null, projectRole: null, reason: 'db-unavailable' };

  let viewerUserId = getStytchUserId() ?? getPersonalUserId() ?? '';
  const email = getUserEmail();

  // Resolve the org first (from projectId if needed), then map email -> member id.
  let orgId = input.orgId ?? null;
  if (!orgId && input.projectId) {
    const pr = await db.query<{ org_id: string }>(`SELECT org_id FROM projects WHERE id = $1`, [input.projectId]);
    orgId = pr.rows[0]?.org_id ?? null;
  }
  if (orgId && email) {
    const r = await db.query<{ user_id: string }>(
      `SELECT user_id FROM org_members WHERE org_id = $1 AND lower(email) = lower($2)`,
      [orgId, email],
    );
    if (r.rows[0]?.user_id) viewerUserId = r.rows[0].user_id;
  }

  return canAccess(db, viewerUserId, input);
}

export function registerTeamHandlers(): void {
  safeHandle('org:sync-projection', async () => {
    return syncOrgProjectionFromServer();
  });

  safeHandle('org:can-access', async (_event, input: CanAccessInput) => {
    try {
      return await canAccessForCurrentUser(input);
    } catch (error) {
      return {
        allowed: false, orgRole: null, projectRole: null,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });

  safeHandle('org:grant-project-access', async (_event, orgId: string, projectId: string, userId: string, projectRole: string) => {
    try {
      await grantProjectAccess(orgId, projectId, userId, projectRole);
      // Reflect the grant in the local projection immediately.
      await syncOrgProjectionFromServer();
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('org:revoke-project-access', async (_event, orgId: string, projectId: string, userId: string) => {
    try {
      await revokeProjectAccess(orgId, projectId, userId);
      await syncOrgProjectionFromServer();
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('org:list-project-access', async (_event, orgId: string, projectId: string) => {
    try {
      const grants = await listProjectAccess(orgId, projectId);
      return { success: true, grants };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Epic H1 live write-through: the renderer's TeamSync config forwards DO
  // broadcasts here so the local projection (org_members / project_access)
  // stays current without a full re-sync. Each is targeted + idempotent.
  safeHandle('org:apply-project-access', async (_event, projectId: string, userId: string, projectRole: string | null) => {
    try {
      const db = getDatabase() as ProjectionDb | null;
      if (!db) return { success: false, error: 'db-unavailable' };
      if (projectRole) {
        await applyProjectGrant(db, projectId, userId, projectRole as ProjectRole);
      } else {
        await applyProjectRevoke(db, projectId, userId);
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('org:apply-member-upserted', async (_event, orgId: string, userId: string, email: string | null, role: string) => {
    try {
      const db = getDatabase() as ProjectionDb | null;
      if (!db) return { success: false, error: 'db-unavailable' };
      await applyMemberUpserted(db, orgId, { userId, email, role });
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('org:apply-member-role-changed', async (_event, orgId: string, userId: string, role: string) => {
    try {
      const db = getDatabase() as ProjectionDb | null;
      if (!db) return { success: false, error: 'db-unavailable' };
      await applyMemberRoleChanged(db, orgId, userId, role);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('org:apply-member-removed', async (_event, orgId: string, userId: string) => {
    try {
      const db = getDatabase() as ProjectionDb | null;
      if (!db) return { success: false, error: 'db-unavailable' };
      await applyMemberRemoved(db, orgId, userId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

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

  safeHandle('team:add-project', async (_event, orgId: string, workspacePath?: string, name?: string) => {
    try {
      const project = await addProjectToOrg(orgId, workspacePath, name);
      // The new project changes the org's registry; drop the listTeams cache so
      // findTeamForWorkspace can resolve the new project's room on the next open.
      invalidateListTeamsCache();
      return { success: true, project };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:list-projects', async (_event, orgId: string) => {
    try {
      const projects = await listProjectsForOrg(orgId);
      return { success: true, projects };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:move-project-preview', async (_event, srcOrgId: string, projectId: string, destOrgId: string) => {
    try {
      const preview = await previewMoveProject(srcOrgId, projectId, destOrgId);
      return { success: true, preview };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:move-project', async (_event, srcOrgId: string, projectId: string, destOrgId: string, dropMemberEmails?: string[]) => {
    try {
      const result = await moveProjectToOrg(srcOrgId, projectId, destOrgId, dropMemberEmails);
      return { success: true, result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:merge-org', async (_event, drainedOrgId: string, survivorOrgId: string, deleteDrained: boolean, dropMemberEmails?: string[]) => {
    try {
      const result = await mergeOrg(drainedOrgId, survivorOrgId, deleteDrained, dropMemberEmails);
      return { success: true, result };
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

  // Epic H1: populate the local org/project/membership projection independently
  // of a workspace team match, so `canAccess` resolves correctly even before (or
  // without) opening a matched workspace. Runs once now (no-op until auth + db
  // are ready) and again whenever auth becomes available (login / token refresh
  // on launch). Idempotent + best-effort.
  syncOrgProjectionFromServer().catch(err =>
    logger.main.warn('[TeamService] launch org projection sync failed:', err));
  onAuthStateChange((authState) => {
    if (authState.isAuthenticated) {
      syncOrgProjectionFromServer().catch(err =>
        logger.main.warn('[TeamService] auth-change org projection sync failed:', err));
    }
  });
}
