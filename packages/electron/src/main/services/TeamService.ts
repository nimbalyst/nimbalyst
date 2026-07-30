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

import { BrowserWindow, net } from 'electron';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import { getNormalizedGitRemote } from '../utils/gitUtils';
import { resolveTeamForRemoteHash } from './teamProjectResolver';
import { getCollabSyncHttpUrl } from '../utils/collabSyncUrl';
import { assertJwtMatchesOrg, getJwtExp, AuthContextMismatchError } from './jwtOrg';
import { createSingleFlight } from '../utils/asyncCache';
import { setHasOrganizationsForMenu } from '../menu/organizationMenuState';
import {
  getAccounts,
  getPersonalSessionJwt,
  getPersonalSessionJwtForAccount,
  getSessionToken,
  getSessionTokenForAccount,
  isAuthenticated,
  refreshPersonalSession,
  refreshPersonalSessionForAccount,
  onAuthStateChange,
  updateSessionToken,
  getUserEmail,
  getPersonalOrgId,
  getPersonalUserId,
} from './StytchAuthService';
import { asTeamJwt, type PersonalJwt, type TeamJwt } from '@nimbalyst/runtime';
import type {
  ConversationDirectoryEntry,
  ConversationDirectoryMembersResult,
  ConversationMutationResult,
  CreateConversationInput,
  CreateConversationResult,
  ListConversationsOptions,
  SetConversationMembershipInput,
  SetConversationMembershipResult,
  UpdateConversationInput,
} from '../../shared/conversationDirectory';
import type { OrgSettings } from '../../shared/orgSettings';
import { normalizeOrgSettings } from '../../shared/orgSettings';
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
import { setTeamServerManagedCustody } from './TeamCustodyService';
// TrackerSyncManager already imports from this module (findTeamForWorkspace).
// The cycle is safe because both sides only reference the imported symbols
// inside function bodies, never at module-init time -- by the time
// autoMatchTeamForWorkspace runs, both modules are fully loaded.
import { ensureTrackerSyncForWorkspace } from './TrackerSyncManager';
import { getCollabBackupService } from './CollabBackupService';
import { createTeamAuthBootstrap } from './TeamAuthBootstrap';
import {
  repairAccountOrgBindingFromEmail,
  resolveTeamOrgAccountBinding,
  upsertAccountOrgBinding,
  type AccountOrgBindingSource,
} from './AccountOrgBindingService';
import { getRecentItems } from '../utils/store';
import { windowReferencesWorkspace, windowStates } from '../window/windowState';
import {
  resolveOrgProjectLocalStates,
  type OrgProjectLocalState,
  type WorkspaceRemoteState,
} from './orgProjectLocalState';

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

export interface TeamDetails {
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
  /** Personal account whose JWT discovered this membership. Public metadata only. */
  sourcePersonalOrgId?: string;
  sourceEmail?: string | null;
  /** Explicit server-side account binding projected from the org TeamRoom. */
  owningPersonalOrgId?: string | null;
  /** The Stytch member id in this team org (different from the personal member id). */
  teamMemberId?: string | null;
  /** All explicit bindings when more than one signed-in account belongs to the same org. */
  accountBindings?: Array<{ personalOrgId: string; teamMemberId: string }>;
  /** Account selected from the explicit local binding for workspace operations. */
  boundPersonalOrgId?: string | null;
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
  custodyBlocked: boolean; // either org was never converted to server-managed custody
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

export interface TeamMember {
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
  jwt: TeamJwt;
  expiresAt: number;
}

/** Cache of org-scoped JWTs. Key is orgId. */
const orgJwtCache = new Map<string, CachedOrgJwt>();
const orgJwtExchangeSingleFlight = createSingleFlight<string, TeamJwt>();
const teamAccountBindingHints = new Map<string, string>();

/** Buffer before JWT exp to refresh early (60 seconds). */
const JWT_REFRESH_BUFFER_MS = 60 * 1000;

function getProjectionDatabase(): ProjectionDb | null {
  try {
    return typeof getDatabase === 'function'
      ? getDatabase() as ProjectionDb | null
      : null;
  } catch {
    // Some isolated unit suites intentionally omit the database initializer.
    return null;
  }
}

/**
 * Get an org-scoped JWT via session exchange. Caches per-org.
 * This does NOT touch the global auth state -- the personal org session is preserved.
 *
 * Cache TTL is derived from the actual JWT `exp` claim (minus a 60s buffer)
 * so we never serve an expired token.
 *
 * NIM-949: the exchanged token is asserted to actually be scoped to `orgId`
 * (its `organization_id` claim). A session refresh can demote a team session
 * toward the personal org, in which case `/switch` may hand back a personal-org
 * token; serving that for a team document room causes the room to reject the ws
 * upgrade (400) and the doc renders blank. We throw AuthContextMismatchError
 * rather than cache/serve a wrong-org token. Pass `forceRefresh` to bypass the
 * cache and re-exchange (used by reconnect after an auth-style rejection).
 */
export async function getOrgScopedJwt(
  orgId: string,
  accountOrgId?: string,
  forceRefresh = false,
): Promise<TeamJwt> {
  let resolvedAccountOrgId = accountOrgId;
  if (!resolvedAccountOrgId) {
    const db = getProjectionDatabase();
    const signedInAccounts = getAccounts();
    const signedInAccountIds = signedInAccounts.map((account) => account.personalOrgId);
    let binding = db
      ? await resolveTeamOrgAccountBinding(db, orgId, signedInAccountIds)
      : null;
    const discoveryHint = teamAccountBindingHints.get(orgId);
    resolvedAccountOrgId = binding?.personalOrgId
      ?? (discoveryHint && signedInAccountIds.includes(discoveryHint) ? discoveryHint : undefined);

    // Upgrade safety net: background collaboration can request an org JWT
    // before listTeams has had a chance to persist or hint the A1 binding.
    // Try the same logged, once-per-pair email repair as the access resolver
    // before considering the single-account compatibility shortcut.
    if (!resolvedAccountOrgId && db) {
      for (const account of signedInAccounts) {
        if (!account.email) continue;
        await repairAccountOrgBindingFromEmail(
          db,
          account.personalOrgId,
          orgId,
          account.email,
        );
        binding = await resolveTeamOrgAccountBinding(db, orgId, signedInAccountIds);
        if (binding) {
          resolvedAccountOrgId = binding.personalOrgId;
          break;
        }
      }
    }

    if (!resolvedAccountOrgId && signedInAccounts.length === 1) {
      resolvedAccountOrgId = signedInAccounts[0].personalOrgId;
      logger.main.warn('[TeamService] getOrgScopedJwt: using sole signed-in account without a persisted team binding', {
        orgId,
        personalOrgId: resolvedAccountOrgId,
      });
    }

    if (!resolvedAccountOrgId) {
      if (signedInAccounts.length > 1) {
        logger.main.error('[TeamService] getOrgScopedJwt: ambiguous team account; refusing to use the sync account', {
          orgId,
          signedInPersonalOrgIds: signedInAccountIds,
        });
      }
      throw new Error(`No signed-in account binding exists for team org ${orgId}`);
    }
  }

  // Check cache
  const cached = orgJwtCache.get(orgId);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return cached.jwt;
  }

  const exchangeKey = `${resolvedAccountOrgId}:${orgId}`;
  return orgJwtExchangeSingleFlight(
    exchangeKey,
    () => exchangeOrgScopedJwt(orgId, resolvedAccountOrgId),
  );
}

async function exchangeOrgScopedJwt(
  orgId: string,
  accountOrgId?: string,
): Promise<TeamJwt> {
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
    ? getPersonalSessionJwtForAccount(accountOrgId)
    : getPersonalSessionJwt();
  if (!personalJwt) {
    throw new Error('Not authenticated. Sign in first.');
  }

  const doExchange = async (jwt: PersonalJwt, token: string) =>
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
        const freshJwt = await refreshPersonalSessionForAccount(accountOrgId);
        refreshed = !!freshJwt;
      } else {
        refreshed = await refreshPersonalSession(httpUrl);
      }
    } catch {
      // Network error -- can't retry
    }
    if (refreshed) {
      const freshJwt = accountOrgId
        ? getPersonalSessionJwtForAccount(accountOrgId)
        : getPersonalSessionJwt();
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
    teamMemberId?: string;
    owningPersonalOrgId?: string;
    bindingRecorded?: boolean;
  };

  if (!data.sessionJwt) {
    throw new Error('Session exchange returned no JWT');
  }

  // NIM-949: never cache/serve a token scoped to a different org than requested.
  // A demoted (personal-org) token here is the root cause of server-only docs
  // rendering blank: the team room rejects it on the ws upgrade.
  try {
    assertJwtMatchesOrg(data.sessionJwt, orgId);
  } catch (err) {
    if (err instanceof AuthContextMismatchError) {
      orgJwtCache.delete(orgId);
      logger.main.warn(
        `[TeamService] getOrgScopedJwt: exchange returned wrong-org token for ${orgId} ` +
          `(token org: ${err.tokenOrgId ?? '(none)'}); refusing to serve it`,
      );
    }
    throw err;
  }

  const sourcePersonalOrgId = accountOrgId ?? getPersonalOrgId();
  if (data.bindingRecorded && sourcePersonalOrgId && data.teamMemberId && data.owningPersonalOrgId) {
    const db = getDatabase() as ProjectionDb | null;
    if (db) {
      await persistServerAccountOrgBinding(
        db,
        sourcePersonalOrgId,
        orgId,
        data.teamMemberId,
        data.owningPersonalOrgId,
        'server-exchange',
      );
    }
  } else {
    logger.main.warn('[TeamService] Org session exchange did not return a recorded account binding', {
      orgId,
      sourcePersonalOrgId,
      bindingRecorded: data.bindingRecorded ?? false,
    });
  }

  // Stytch session exchange replaces the session token -- the old one is now
  // invalid. We MUST persist the new token so that refreshSession() and
  // getSessionToken() continue to work.
  // Only update the singleton token when operating under the sync account.
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
  const teamJwt = asTeamJwt(data.sessionJwt);
  orgJwtCache.set(orgId, {
    jwt: teamJwt,
    expiresAt,
  });

  // logger.main.info('[TeamService] Obtained org-scoped JWT for:', orgId, 'expires in', Math.round((expiresAt - Date.now()) / 1000), 's');
  return teamJwt;
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
// Migration verification intentionally fans out across every not-yet-sealed
// document room. Large organizations can take longer than the normal
// interactive API deadline while Durable Objects wake and seal in batches.
// Keep this override scoped to the background finalizer so document opens and
// ordinary team operations still fail quickly when the API is unhealthy.
const MIGRATION_FINALIZATION_API_TIMEOUT_MS = 120_000;

interface FetchTeamApiOptions {
  timeoutMs?: number;
}

/**
 * Make an authenticated REST call to the collabv3 team API.
 * Uses the personal org JWT for team-listing endpoints.
 * Uses org-scoped JWT when orgId is provided (for member operations).
 * When accountOrgId is provided, uses that account's JWT instead of the primary.
 */
async function fetchTeamApi(
  path: string,
  method: string,
  body?: unknown,
  orgId?: string,
  accountOrgId?: string,
  options?: FetchTeamApiOptions,
): Promise<any> {
  const httpUrl = getCollabServerUrl();
  const timeoutMs = options?.timeoutMs ?? TEAM_API_TIMEOUT_MS;

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
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
        throw new Error(`Team API timeout after ${timeoutMs}ms: ${method} ${path}`);
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
    ? await getOrgScopedJwt(orgId, accountOrgId)
    : accountOrgId
      ? getPersonalSessionJwtForAccount(accountOrgId)
      : getPersonalSessionJwt();
  if (!jwt) {
    logger.main.warn(`[TeamService] No JWT available (source: ${jwtSource})`);
    throw new Error('Not authenticated. Sign in first.');
  }

  // Personal JWTs are short-lived. Refresh before sending one that is already
  // inside the same 60s safety window used by the org-JWT cache, so routine
  // team discovery does not pay for an expected 401 on every expiry cycle.
  if (!orgId) {
    const exp = getJwtExp(jwt);
    if (exp && (exp * 1000) - JWT_REFRESH_BUFFER_MS <= Date.now()) {
      try {
        if (accountOrgId) {
          const freshJwt = await refreshPersonalSessionForAccount(accountOrgId);
          if (freshJwt) jwt = freshJwt;
        } else if (await refreshPersonalSession(getCollabServerUrl())) {
          const freshJwt = getPersonalSessionJwt();
          if (freshJwt) jwt = freshJwt;
        }
      } catch {
        // Keep the current token and let the existing 401 recovery path make
        // the final authentication decision.
      }
    }
  }

  let response = await makeRequest(jwt);

  // On 401, retry once: refresh personal session or re-exchange org JWT
  if (response.status === 401) {
    if (accountOrgId && !orgId) {
      // Refresh the account's PERSONAL lane. For the sync account the active
      // Stytch session may currently be team-scoped, so a generic refresh is not
      // sufficient to replace an expired personalSessionJwt.
      logger.main.info(`[TeamService] Got 401 on account JWT for ${accountOrgId}, attempting refresh...`);
      const freshJwt = await refreshPersonalSessionForAccount(accountOrgId);
      if (freshJwt) {
        logger.main.info(`[TeamService] Account ${accountOrgId} personal JWT refreshed, retrying request...`);
        response = await makeRequest(freshJwt);
      } else {
        logger.main.warn(`[TeamService] Account ${accountOrgId} personal JWT refresh failed`);
      }
    } else if (!orgId) {
      logger.main.info('[TeamService] Got 401 on personal JWT, refreshing session...');
      let refreshed = false;
      try {
        refreshed = await refreshPersonalSession(getCollabServerUrl());
      } catch {
        // Network error -- can't retry
      }
      if (refreshed) {
        const freshJwt = getPersonalSessionJwt();
        if (freshJwt) {
          logger.main.info('[TeamService] Session refreshed, retrying request...');
          response = await makeRequest(freshJwt);
        } else {
          logger.main.warn('[TeamService] Session refreshed but getPersonalSessionJwt() returned null');
        }
      } else {
        logger.main.warn('[TeamService] Session refresh failed, cannot retry');
      }
    } else {
      // Org-scoped JWT rejected -- invalidate cache and re-exchange
      logger.main.info(`[TeamService] Got 401 on org-scoped JWT for ${orgId}, invalidating cache and re-exchanging...`);
      orgJwtCache.delete(orgId);
      try {
        const freshOrgJwt = await getOrgScopedJwt(orgId, accountOrgId, true);
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

async function persistServerAccountOrgBinding(
  db: ProjectionDb,
  expectedPersonalOrgId: string,
  teamOrgId: string,
  teamMemberId: string,
  serverPersonalOrgId: string,
  source: AccountOrgBindingSource,
): Promise<boolean> {
  if (serverPersonalOrgId !== expectedPersonalOrgId) {
    logger.main.error('[TeamService] Refusing mismatched server account/org binding', {
      expectedPersonalOrgId,
      serverPersonalOrgId,
      teamOrgId,
      teamMemberId,
    });
    return false;
  }
  await upsertAccountOrgBinding(db, {
    personalOrgId: expectedPersonalOrgId,
    teamOrgId,
    teamMemberId,
    source,
  });
  return true;
}

// ============================================================================
// Public API
// ============================================================================

function requireConversationIdentifier(
  value: string,
  name: string,
): string {
  if (!value?.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

/**
 * List the caller-visible conversation directory for one organization.
 *
 * Team JWT authentication is mandatory: passing `orgId` to `fetchTeamApi`
 * selects `getOrgScopedJwt` and its org-binding checks. Direct conversations
 * are included by default because the org window renders rooms and DMs from
 * this one directory.
 */
export async function listConversations(
  orgId: string,
  options: ListConversationsOptions = {},
): Promise<ConversationDirectoryEntry[]> {
  requireConversationIdentifier(orgId, 'Organization id');
  const params = new URLSearchParams();
  if (options.includeDirect !== false) params.set('includeDirect', 'true');
  if (options.includeArchived === true) params.set('includeArchived', 'true');
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const result = await fetchTeamApi(
    `/api/teams/${encodeURIComponent(orgId)}/conversations${suffix}`,
    'GET',
    undefined,
    orgId,
  ) as { conversations?: ConversationDirectoryEntry[] };
  // A server old enough to omit capabilities must not take the directory down
  // with it: the row arrives with no grants and the renderer filters it out.
  return (result.conversations ?? []).map((conversation) => ({
    ...conversation,
    capabilities: conversation.capabilities ?? [],
  }));
}

export async function createConversation(
  orgId: string,
  input: CreateConversationInput,
): Promise<CreateConversationResult> {
  requireConversationIdentifier(orgId, 'Organization id');
  if (!input?.kind || !input.visibility) {
    throw new Error('Conversation kind and visibility are required');
  }
  return await fetchTeamApi(
    `/api/teams/${encodeURIComponent(orgId)}/conversations`,
    'POST',
    input,
    orgId,
  ) as CreateConversationResult;
}

/**
 * Rename an organization room or change its topic.
 *
 * Only the supplied fields are serialized: the server treats a present `topic`
 * key as "replace" (with `null` clearing it) and an absent one as "leave
 * alone", so sending `undefined` fields would silently wipe the topic on a
 * rename. Rooms are the only kind with editable titles — the server rejects
 * DMs and document discussions.
 */
export async function updateConversation(
  orgId: string,
  conversationId: string,
  input: UpdateConversationInput,
): Promise<ConversationMutationResult> {
  requireConversationIdentifier(orgId, 'Organization id');
  requireConversationIdentifier(conversationId, 'Conversation id');
  const body: Record<string, unknown> = {};
  if (input?.title !== undefined) {
    if (typeof input.title !== 'string' || !input.title.trim()) {
      throw new Error('Conversation title must be a non-empty string');
    }
    body.title = input.title.trim();
  }
  if (input?.topic !== undefined) {
    if (input.topic !== null && typeof input.topic !== 'string') {
      throw new Error('Conversation topic must be a string or null');
    }
    body.topic = typeof input.topic === 'string' && input.topic.trim()
      ? input.topic.trim()
      : null;
  }
  if (Object.keys(body).length === 0) {
    throw new Error('Conversation title or topic is required');
  }
  return await fetchTeamApi(
    `/api/teams/${encodeURIComponent(orgId)}/conversations/${encodeURIComponent(conversationId)}`,
    'PUT',
    body,
    orgId,
  ) as ConversationMutationResult;
}

export async function archiveConversation(
  orgId: string,
  conversationId: string,
): Promise<ConversationMutationResult> {
  requireConversationIdentifier(orgId, 'Organization id');
  requireConversationIdentifier(conversationId, 'Conversation id');
  return await fetchTeamApi(
    `/api/teams/${encodeURIComponent(orgId)}/conversations/${encodeURIComponent(conversationId)}/archive`,
    'POST',
    undefined,
    orgId,
  ) as ConversationMutationResult;
}

export async function setConversationMembership(
  orgId: string,
  conversationId: string,
  userId: string,
  input: SetConversationMembershipInput,
): Promise<SetConversationMembershipResult> {
  requireConversationIdentifier(orgId, 'Organization id');
  requireConversationIdentifier(conversationId, 'Conversation id');
  requireConversationIdentifier(userId, 'Conversation member user id');
  if (typeof input?.active !== 'boolean') {
    throw new Error('Conversation membership active state is required');
  }
  if (
    input.role !== undefined
    && input.role !== 'member'
    && input.role !== 'roomAdmin'
  ) {
    throw new Error('Conversation membership role is invalid');
  }
  return await fetchTeamApi(
    `/api/teams/${encodeURIComponent(orgId)}/conversations/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(userId)}`,
    input.active ? 'PUT' : 'DELETE',
    input.active ? { role: input.role ?? 'member' } : undefined,
    orgId,
  ) as SetConversationMembershipResult;
}

export async function listConversationMembers(
  orgId: string,
  conversationId: string,
): Promise<ConversationDirectoryMembersResult> {
  requireConversationIdentifier(orgId, 'Organization id');
  requireConversationIdentifier(conversationId, 'Conversation id');
  const result = await fetchTeamApi(
    `/api/teams/${encodeURIComponent(orgId)}/conversations/${encodeURIComponent(conversationId)}/members`,
    'GET',
    undefined,
    orgId,
  ) as ConversationDirectoryMembersResult;
  return { memberships: result.memberships ?? [] };
}

/**
 * Read one organization's settings.
 *
 * Team JWT authentication (any active member may read). Pre-settings servers
 * and never-configured orgs answer with an absent or partial object, so the
 * result is defaulted field by field rather than trusted as complete.
 */
export async function getOrgSettings(orgId: string): Promise<OrgSettings> {
  requireConversationIdentifier(orgId, 'Organization id');
  const result = await fetchTeamApi(
    `/api/teams/${encodeURIComponent(orgId)}/settings`,
    'GET',
    undefined,
    orgId,
  ) as { settings?: unknown };
  return normalizeOrgSettings(result?.settings);
}

/**
 * Replace one organization's settings (organization admins only, enforced
 * server-side).
 *
 * The server's PUT is a whole-object replace — omitted fields fall back to
 * their defaults rather than keeping their current value — so callers send the
 * complete settings they want stored, not a patch.
 */
export async function updateOrgSettings(
  orgId: string,
  settings: OrgSettings,
): Promise<OrgSettings> {
  requireConversationIdentifier(orgId, 'Organization id');
  if (!settings || typeof settings !== 'object') {
    throw new Error('Organization settings are required');
  }
  const result = await fetchTeamApi(
    `/api/teams/${encodeURIComponent(orgId)}/settings`,
    'PUT',
    normalizeOrgSettings(settings),
    orgId,
  ) as { settings?: unknown };
  return normalizeOrgSettings(result?.settings);
}

export async function renameOrganization(
  orgId: string,
  name: string,
): Promise<{ orgId: string; name: string }> {
  requireConversationIdentifier(orgId, 'Organization id');
  const normalizedName = name?.trim();
  if (!normalizedName) {
    throw new Error('Organization name is required');
  }
  await fetchTeamApi(
    `/api/teams/${encodeURIComponent(orgId)}`,
    'PUT',
    { name: normalizedName },
    orgId,
  );
  invalidateListTeamsCache();
  return { orgId, name: normalizedName };
}

export async function setAgentPosting(
  orgId: string,
  conversationId: string,
  enabled: boolean,
): Promise<ConversationMutationResult> {
  requireConversationIdentifier(orgId, 'Organization id');
  requireConversationIdentifier(conversationId, 'Conversation id');
  if (typeof enabled !== 'boolean') {
    throw new Error('Agent posting enabled state is required');
  }
  return await fetchTeamApi(
    `/api/teams/${encodeURIComponent(orgId)}/conversations/${encodeURIComponent(conversationId)}/agent-posting`,
    'PUT',
    { enabled },
    orgId,
  ) as ConversationMutationResult;
}

/**
 * List all teams the current user belongs to, across all signed-in accounts.
 * Queries each account's teams and deduplicates by orgId.
 */
// findTeamForWorkspace is fanned out from many sites (workspace open, sync
// init, tracker init, body-doc service, etc.) and each listTeams call hits
// /api/teams once per signed-in account. A short TTL just turned that into a
// steady-state poll -- org/team membership changes ~never mid-session, so the
// cache is long-lived and correctness comes from event-driven invalidation
// (auth change, team join/leave/create/delete, manual refresh -- see
// invalidateListTeamsCache() call sites) rather than a short expiry.
// collab-open-latency investigation (RC4), 2026-07-14.
let listTeamsCache: { promise: Promise<TeamDetails[]>; expiresAt: number } | null = null;
const LIST_TEAMS_TTL_MS = 5 * 60_000;

export function invalidateListTeamsCache(): void {
  listTeamsCache = null;
  teamAccountBindingHints.clear();
}

export async function listTeams(): Promise<TeamDetails[]> {
  if (!isAuthenticated()) {
    logger.main.info('[TeamService] listTeams: not authenticated, skipping');
    return [];
  }

  const now = Date.now();
  if (listTeamsCache && listTeamsCache.expiresAt > now) {
    return listTeamsCache.promise;
  }

  let allAccountLookupsSucceeded = true;
  const promise = (async (): Promise<TeamDetails[]> => {
    const allAccounts = getAccounts();
    const teamsByOrgId = new Map<string, TeamDetails>();
    const allTeams: TeamDetails[] = [];

    // Query teams for each signed-in account in parallel
    const results = await Promise.allSettled(
      allAccounts.map(async (account) => {
        const data = await fetchTeamApi('/api/teams', 'GET', undefined, undefined, account.personalOrgId) as { teams: TeamDetails[] };
        return (data.teams || []).map((team) => ({
          ...team,
          sourcePersonalOrgId: account.personalOrgId,
          sourceEmail: account.email,
        }));
      })
    );

    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        for (const team of result.value) {
          if (team.sourcePersonalOrgId && team.owningPersonalOrgId
              && team.owningPersonalOrgId !== team.sourcePersonalOrgId) {
            logger.main.error('[TeamService] Ignoring mismatched discovered account/org binding', {
              teamOrgId: team.orgId,
              sourcePersonalOrgId: team.sourcePersonalOrgId,
              owningPersonalOrgId: team.owningPersonalOrgId,
            });
          }
          const binding = team.sourcePersonalOrgId && team.teamMemberId
            && team.owningPersonalOrgId === team.sourcePersonalOrgId
            ? { personalOrgId: team.sourcePersonalOrgId, teamMemberId: team.teamMemberId }
            : null;
          if (binding) {
            const db = getProjectionDatabase();
            if (db) {
              await persistServerAccountOrgBinding(
                db,
                binding.personalOrgId,
                team.orgId,
                binding.teamMemberId,
                binding.personalOrgId,
                'server-sync',
              );
            }
          }
          const existing = teamsByOrgId.get(team.orgId);
          if (!existing) {
            if (binding) team.accountBindings = [binding];
            teamsByOrgId.set(team.orgId, team);
            allTeams.push(team);
          } else if (binding && !existing.accountBindings?.some((candidate) =>
            candidate.personalOrgId === binding.personalOrgId
            && candidate.teamMemberId === binding.teamMemberId)) {
            existing.accountBindings = [...(existing.accountBindings ?? []), binding];
          }
        }
      } else {
        allAccountLookupsSucceeded = false;
        logger.main.error(
          `[TeamService] listTeams error for account ${allAccounts[index]?.email ?? 'unknown'}:`,
          result.reason,
        );
      }
    }

    const db = getProjectionDatabase();
    const signedInAccountIds = allAccounts.map((account) => account.personalOrgId);
    for (const team of allTeams) {
      const resolved = db
        ? await resolveTeamOrgAccountBinding(db, team.orgId, signedInAccountIds)
        : null;
      team.boundPersonalOrgId = resolved?.personalOrgId
        ?? [...(team.accountBindings ?? [])]
          .sort((a, b) => a.personalOrgId.localeCompare(b.personalOrgId))[0]?.personalOrgId
        ?? team.sourcePersonalOrgId
        ?? null;
      if (team.boundPersonalOrgId) {
        teamAccountBindingHints.set(team.orgId, team.boundPersonalOrgId);
      }
    }

    return allTeams;
  })();

  listTeamsCache = { promise, expiresAt: now + LIST_TEAMS_TTL_MS };
  // A partial/failed account lookup is not authoritative. Return any teams we
  // did resolve to this caller, but evict the result immediately so a timeout
  // cannot pin "no teams" (or an incomplete list) for the full five minutes.
  void promise.then(
    (teams) => {
      if (!allAccountLookupsSucceeded && listTeamsCache?.promise === promise) {
        listTeamsCache = null;
      }
      // Drive the Organization Manager menu item's visibility. A partial lookup
      // may under-report, so only an authoritative empty result hides the item.
      if (teams.length > 0) {
        setHasOrganizationsForMenu(true);
      } else if (allAccountLookupsSucceeded) {
        setHasOrganizationsForMenu(false);
      }
    },
    () => {
      if (listTeamsCache?.promise === promise) listTeamsCache = null;
    },
  );

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

type FindForWorkspaceResult = { success: true; team: TeamDetails | null };

async function findTeamOrPendingInviteForWorkspace(workspacePath: string): Promise<FindForWorkspaceResult> {
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
}

// Collapses a burst of concurrent `team:find-for-workspace` IPC calls for the
// same workspace (e.g. many tracker rooms opening at once) into one
// findTeamForWorkspace/findPendingInviteForWorkspace run. collab-open-latency
// investigation (RC4): these calls were seen staircasing 5-deep, 2.8-6.7s.
const findForWorkspaceSingleFlight = createSingleFlight<string, FindForWorkspaceResult>();

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
  const sourcePersonalOrgId = accountOrgId ?? getPersonalOrgId();
  const result = await fetchTeamApi('/api/teams', 'POST', {
    name,
    gitRemoteHash,
  }, undefined, accountOrgId) as {
    orgId: string;
    name: string;
    creatorMemberId: string;
    teamMemberId?: string;
    owningPersonalOrgId?: string;
  };

  logger.main.info('[TeamService] Team created:', result.orgId, name);

  if (sourcePersonalOrgId && result.teamMemberId && result.owningPersonalOrgId) {
    const db = getDatabase() as ProjectionDb | null;
    if (db) {
      await persistServerAccountOrgBinding(
        db,
        sourcePersonalOrgId,
        result.orgId,
        result.teamMemberId,
        result.owningPersonalOrgId,
        'server-create',
      );
    }
  } else {
    logger.main.warn('[TeamService] Team create response omitted explicit account/org binding', {
      orgId: result.orgId,
      sourcePersonalOrgId,
    });
  }

  // Team collaboration is server-managed, and only server-managed. Mark the
  // new org before anything tries to sync into it; the server refuses content
  // for an org without this marker.
  {
    const orgJwt = await getOrgScopedJwt(result.orgId, accountOrgId);
    await setTeamServerManagedCustody(result.orgId, orgJwt);
  }
  logger.main.info('[TeamService] Server-managed encryption enabled for team:', result.orgId);

  // The new org must be visible to findTeamForWorkspace/listTeams immediately
  // (e.g. the "Create Team" flow expects to route this workspace to it right
  // away), not after the long listTeams TTL expires.
  invalidateListTeamsCache();

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

function isWorkspaceOpen(workspacePath: string): boolean {
  for (const state of windowStates.values()) {
    if (windowReferencesWorkspace(state, workspacePath)) return true;
  }
  return false;
}

async function getRecentWorkspaceRemoteStates(
  projectGitRemoteHashes: ReadonlySet<string>,
): Promise<WorkspaceRemoteState[]> {
  const states: WorkspaceRemoteState[] = [];
  for (const workspace of getRecentItems('workspaces')) {
    if (!workspace.path || !existsSync(workspace.path)) continue;
    const remote = await getNormalizedGitRemote(workspace.path);
    if (!remote) continue;
    const gitRemoteHash = hashGitRemote(remote);
    if (!projectGitRemoteHashes.has(gitRemoteHash)) continue;
    states.push({
      workspacePath: workspace.path,
      gitRemoteHash,
      open: isWorkspaceOpen(workspace.path),
    });
  }
  return states;
}

async function resolveLocalProjectStatesForOrg(
  orgId: string,
): Promise<OrgProjectLocalState[]> {
  if (!orgId || typeof orgId !== 'string') {
    throw new Error('team:resolve-org-projects-local-state requires orgId');
  }
  const projects = await listProjectsForOrg(orgId);
  const hashes = new Set(
    projects
      .map((project) => project.gitRemoteHash)
      .filter((hash): hash is string => !!hash),
  );
  const workspaces = await getRecentWorkspaceRemoteStates(hashes);
  return resolveOrgProjectLocalStates(projects, workspaces);
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
  try {
    await getCollabBackupService().markSuperseded(
      { orgId: srcOrgId, projectId },
      { orgId: destOrgId, projectId: result.destTeamProjectId },
    );
  } catch (error) {
    logger.main.warn('[TeamService] Could not mark pre-move collaboration backup as superseded', error);
  }
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
  try {
    for (const project of result.movedProjects) {
      await getCollabBackupService().markSuperseded(
        { orgId: drainedOrgId, projectId: project.projectId },
        { orgId: survivorOrgId, projectId: project.destTeamProjectId },
      );
    }
  } catch (error) {
    logger.main.warn('[TeamService] Could not mark pre-merge collaboration backups as superseded', error);
  }
  invalidateListTeamsCache();
  return result;
}

/**
 * Accept a pending team invite. Exchanges the personal session for an
 * org-scoped session (promoting the user from pending/invited to active
 * in Stytch automatically), then sets up encryption keys.
 */
async function acceptInvite(orgId: string): Promise<TeamDetails> {
  const pendingTeam = (await listTeams()).find((team) => team.orgId === orgId);
  const inviteAccountOrgId = pendingTeam?.boundPersonalOrgId
    ?? pendingTeam?.sourcePersonalOrgId;
  if (!inviteAccountOrgId) {
    throw new Error(`No signed-in account owns the pending invite for ${orgId}`);
  }
  // 1. Exchange session for the team org -- Stytch promotes pending -> active_member
  const orgJwt = await getOrgScopedJwt(orgId, inviteAccountOrgId);

  // 2. Fetch team details now that we're an active member. Invalidate first --
  // with the long listTeams TTL, a pre-join cache entry would otherwise make
  // this lookup miss the team we just joined.
  invalidateListTeamsCache();
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
export async function listMembers(orgId: string): Promise<{ members: TeamMember[]; callerRole: string }> {
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
 * The server holds the team DEK and revokes the member's access when the
 * membership row goes away; there is no client-held key to rotate.
 */
async function removeMember(orgId: string, memberId: string): Promise<void> {
  await fetchTeamApi(`/api/teams/${orgId}/members/${memberId}`, 'DELETE', undefined, orgId);
  logger.main.info('[TeamService] Member removed from organization:', memberId);
}

/**
 * Delete a team entirely. Admin only.
 * Deletes Stytch org, D1 metadata, and TeamRoom DO state.
 */
async function deleteTeam(orgId: string): Promise<void> {
  await fetchTeamApi(`/api/teams/${orgId}`, 'DELETE', undefined, orgId);
  // Clear cached org JWT since the org no longer exists
  orgJwtCache.delete(orgId);
  invalidateListTeamsCache();
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
 * Match a workspace to its team and start the collaboration services for it.
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
    const team = await findTeamForWorkspace(workspacePath);
    if (team) {
      logger.main.info('[TeamService] Workspace matched to team:', team.name, 'orgId:', team.orgId);

      // Epic H1: refresh the local org/project/membership projection so the
      // canAccess resolver has this team's roster + grants. Best-effort.
      syncOrgProjectionFromServer().catch(err => {
        logger.main.warn('[TeamService] post-match org projection sync failed:', err);
      });

      // Notify all renderer windows about the team match
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('team:workspace-matched', {
          orgId: team.orgId,
          teamName: team.name,
          workspacePath,
          hasKey: true,
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

export async function syncOrgProjectionFromServer(knownTeams?: TeamDetails[]): Promise<{
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

    const teams = knownTeams ?? await listTeams();
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
    for (const team of teams) {
      const bindings = team.accountBindings ?? (
        team.sourcePersonalOrgId && team.teamMemberId
          && team.owningPersonalOrgId === team.sourcePersonalOrgId
          ? [{ personalOrgId: team.sourcePersonalOrgId, teamMemberId: team.teamMemberId }]
          : []
      );
      for (const binding of bindings) {
        await persistServerAccountOrgBinding(
          db,
          binding.personalOrgId,
          team.orgId,
          binding.teamMemberId,
          binding.personalOrgId,
          'server-sync',
        );
      }
    }
    // logger.main.info('[TeamService] org projection synced:', counts);
    return { success: true, counts };
  } catch (err) {
    logger.main.error('[TeamService] syncOrgProjectionFromServer error:', err);
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const runAuthenticatedTeamBootstrap = createTeamAuthBootstrap(async () => {
  try {
    const teams = await listTeams();
    await Promise.all([
      syncOrgProjectionFromServer(teams),
    ]);
  } catch (err) {
    logger.main.warn('[TeamService] authenticated team bootstrap failed:', err);
  }
});

/**
 * Resolve the viewer's per-org member id from the team org's explicit account
 * binding, independently of the sync-account selection. Legacy email matching
 * remains isolated to the logged, one-time repair path.
 */
export async function canAccessForCurrentUser(input: CanAccessInput): Promise<{
  allowed: boolean; orgRole: string | null; projectRole: string | null; reason: string;
}> {
  const db = getDatabase() as AccessDatabase | null;
  if (!db) return { allowed: false, orgRole: null, projectRole: null, reason: 'db-unavailable' };

  const signedInAccounts = getAccounts();
  let viewerUserId = '';

  // Resolve the org first (from projectId if needed), then resolve its bound
  // signed-in account. The sync account is deliberately not consulted.
  let orgId = input.orgId ?? null;
  if (!orgId && input.projectId) {
    const pr = await db.query<{ org_id: string }>(`SELECT org_id FROM projects WHERE id = $1`, [input.projectId]);
    orgId = pr.rows[0]?.org_id ?? null;
  }
  if (orgId) {
    const personalAccount = signedInAccounts.find((account) => account.personalOrgId === orgId);
    if (personalAccount) {
      viewerUserId = personalAccount.personalUserId ?? '';
    } else {
      let binding = await resolveTeamOrgAccountBinding(
        db,
        orgId,
        signedInAccounts.map((account) => account.personalOrgId),
      );
      if (!binding) {
        for (const account of signedInAccounts) {
          if (!account.email) continue;
          await repairAccountOrgBindingFromEmail(
            db,
            account.personalOrgId,
            orgId,
            account.email,
          );
          binding = await resolveTeamOrgAccountBinding(
            db,
            orgId,
            signedInAccounts.map((candidate) => candidate.personalOrgId),
          );
          if (binding) break;
        }
      }
      viewerUserId = binding?.teamMemberId ?? '';
    }
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

  safeHandle('team:list', async (_event, options?: { forceRefresh?: boolean }) => {
    try {
      // The directory cache is invalidated by events (join/create/delete/auth
      // change); `forceRefresh` backs the manual Refresh affordance in Account
      // settings for the cases those events miss (e.g. invited from elsewhere).
      if (options?.forceRefresh) invalidateListTeamsCache();
      const teams = await listTeams();
      return { success: true, teams };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:find-for-workspace', async (_event, workspacePath: string) => {
    try {
      return await findForWorkspaceSingleFlight(workspacePath, () => findTeamOrPendingInviteForWorkspace(workspacePath));
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

  safeHandle('team:rename', async (_event, orgId: string, name: string) => {
    try {
      const organization = await renameOrganization(orgId, name);
      return { success: true, organization };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  safeHandle('team:create', async (_event, name: string, workspacePath?: string, accountOrgId?: string) => {
    try {
      // Org creation is disabled while Teams is invite-only alpha. The renderer
      // hides the affordances too; this is the backstop covering every caller.
      // Dev builds stay open so the create flow remains testable.
      if (process.env.NODE_ENV !== 'development') {
        return { success: false, error: 'Creating organizations is not available yet — Teams is in an invite-only alpha.' };
      }
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

  safeHandle('team:resolve-org-projects-local-state', async (_event, orgId: string) => {
    try {
      const projects = await resolveLocalProjectStatesForOrg(orgId);
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

  // Epic H1: populate the local org/project/membership projection independently
  // of a workspace team match, so `canAccess` resolves correctly even before (or
  // without) opening a matched workspace. onAuthStateChange immediately supplies
  // the current state, so this also covers launch. Keep the whole authenticated
  // bootstrap single-flight: team API requests can refresh a token, and that
  // refresh emits a re-entrant authenticated state before the request completes.
  onAuthStateChange((authState) => {
    // Any auth transition (sign-in, sign-out, account switch, token refresh)
    // can change which orgs the caller's JWTs are valid for -- drop the long-
    // lived listTeams cache so the next read reflects it instead of serving
    // a pre-transition snapshot for the rest of the TTL window.
    invalidateListTeamsCache();
    if (authState.isAuthenticated) {
      void runAuthenticatedTeamBootstrap();
    }
  });
}
