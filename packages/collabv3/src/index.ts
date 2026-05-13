/**
 * CollabV3 Worker Entry Point
 *
 * Routes WebSocket connections to appropriate Durable Objects based on room ID.
 * Room ID format: user:{userId}:session:{sessionId} or user:{userId}:index
 *
 * Authentication:
 * - All authentication is done via Stytch session JWTs
 * - JWT 'sub' claim contains the user ID used for room authorization
 */

// Injected at build time by wrangler define
declare const COLLABV3_VERSION: string;

import type { Env } from './types';
import { PersonalSessionRoom } from './SessionRoom';
import { PersonalIndexRoom } from './IndexRoom';
import { TeamDocumentRoom } from './DocumentRoom';
import { TeamTrackerRoom } from './TrackerRoom';
import { TeamRoom } from './TeamRoom';
import { PersonalProjectSyncRoom } from './ProjectSyncRoom';
import { parseAuth as parseAuthJWT, type AuthConfig, type AuthResult } from './auth';
import { handleShareUpload, handleShareView, handleShareContent, handleShareList, handleShareDelete } from './share';
import { handleAccountDeletion } from './accountDeletion';
import { handleAdminCleanup } from './adminCleanup';
import {
  handleDeleteDocumentAsset,
  handleGetDocumentAsset,
  handleUploadDocumentAsset,
} from './documentAssets';
import {
  handleCreateTeam,
  handleListTeams,
  handleListMembers,
  handleInviteMember,
  handleRemoveMember,
  handleUpdateMemberRole,
  handleDeleteTeam,
  handleOrgSwitch,
  handleSetProjectIdentity,
  handleClearProjectIdentity,
} from './teams';
import {
  handleUploadKeyEnvelope,
  handleGetOwnKeyEnvelope,
  handleListKeyEnvelopes,
  handleDeleteKeyEnvelope,
  handleDeleteAllKeyEnvelopes,
  handleSetOrgKeyFingerprint,
  handleGetOrgKeyFingerprint,
  handleRotationLock,
  handlePropagateFingerprint,
  handleTruncateTrackerChangelog,
  handleRotationCompactDoc,
  handleRotationBatchUpsertTracker,
} from './teamKeyEnvelopes';
import { teamRoomPost, teamRoomGet } from './teamRoomHelpers';
import { NIMBALYST_ORG_TYPE_KEY, getExplicitOrgType, resolveDiscoveredOrgType, selectPreferredPersonalOrg } from './personalOrg';
import { setLogEnvironment, createLogger } from './logger';
import { track } from './analytics';

const log = createLogger('sync');

// Re-export Durable Object classes (new names)
export { PersonalSessionRoom, PersonalIndexRoom, TeamDocumentRoom, TeamTrackerRoom, TeamRoom, PersonalProjectSyncRoom };

// Backward-compatible aliases (old names -> new names)
// Cloudflare wrangler uses renamed_classes migration to handle DO identity;
// these aliases ensure any external TypeScript imports still resolve.
export {
  PersonalSessionRoom as SessionRoom,
  PersonalIndexRoom as IndexRoom,
  TeamDocumentRoom as DocumentRoom,
  TeamTrackerRoom as TrackerRoom,
  PersonalProjectSyncRoom as ProjectSyncRoom,
};

// ============================================================================
// CORS Configuration
// ============================================================================

/**
 * Get allowed origins based on environment.
 *
 * Production: Uses ALLOWED_ORIGINS env var or defaults to secure origins
 * Development: Includes localhost and local IP addresses for testing
 */
function getAllowedOrigins(env: Env): string[] {
  // If ALLOWED_ORIGINS is set, use it
  if (env.ALLOWED_ORIGINS) {
    return env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean);
  }

  // Development mode: allow localhost and common local IPs
  if (env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'local') {
    return [
      'http://localhost:5173',      // Vite dev server
      'http://localhost:5174',      // Vite dev server (alt port)
      'http://localhost:4102',      // Capacitor web dev server
      'http://localhost:8787',      // Wrangler dev server
      'http://127.0.0.1:5173',
      'http://127.0.0.1:5174',
      'http://127.0.0.1:4102',
      'http://127.0.0.1:8787',
      'capacitor://localhost',      // Capacitor iOS/Android
      'http://localhost',           // Generic localhost
      // Common local network IPs (192.168.x.x)
      // These are dynamically checked in getCorsHeaders
    ];
  }

  // Production defaults
  return [
    'https://app.nimbalyst.com',
    'https://nimbalyst.com',
    'capacitor://localhost',
  ];
}

/**
 * Check if origin is allowed.
 * Also allows local network IPs for Capacitor dev testing.
 */
function isOriginAllowed(origin: string | null, env: Env): boolean {
  if (!origin) return false;

  const allowedOrigins = getAllowedOrigins(env);

  // Direct match
  if (allowedOrigins.includes(origin)) {
    return true;
  }

  // Allow local network IPs for Capacitor dev testing (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
  // Only in development/local environments - never in production
  if (env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'local') {
    try {
      const url = new URL(origin);
      const host = url.hostname;
      if (
        host.startsWith('192.168.') ||
        host.startsWith('10.') ||
        /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)
      ) {
        return true;
      }
    } catch {
      // Invalid URL, not allowed
    }
  }

  return false;
}

/**
 * Get CORS headers for a request.
 * Returns appropriate Access-Control-Allow-Origin based on request origin.
 */
function getCorsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');
  const allowedHeaders = [
    'Content-Type',
    'Authorization',
    'X-Collab-Asset-Iv',
    'X-Collab-Asset-Metadata',
    'X-Collab-Asset-Metadata-Iv',
    'X-Collab-Asset-Mime-Type',
    'X-Collab-Asset-Plaintext-Size',
  ].join(', ');
  const exposedHeaders = [
    'Content-Type',
    'Content-Length',
    'X-Collab-Asset-Iv',
    'X-Collab-Asset-Metadata',
    'X-Collab-Asset-Metadata-Iv',
    'X-Collab-Asset-Mime-Type',
    'X-Collab-Asset-Plaintext-Size',
  ].join(', ');

  if (isOriginAllowed(origin, env)) {
    return {
      'Access-Control-Allow-Origin': origin!,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': allowedHeaders,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Expose-Headers': exposedHeaders,
    };
  }

  // Origin not allowed - return empty CORS headers (browser will block)
  // We still include the methods/headers for preflight, but no Allow-Origin
  return {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': allowedHeaders,
    'Access-Control-Expose-Headers': exposedHeaders,
  };
}

// Room ID parsing: org:{orgId}:user:{userId}:{suffix} or org:{orgId}:doc:{documentId} or org:{orgId}:tracker:{projectId} or org:{orgId}:team
interface ParsedRoomId {
  type: 'session' | 'index' | 'projects' | 'document' | 'tracker' | 'team' | 'projectSync';
  userId: string;
  orgId: string;
  sessionId?: string;
  documentId?: string;
  projectId?: string;
}

function parseRoomId(roomId: string): ParsedRoomId | null {
  const sessionMatch = roomId.match(/^org:([^:]+):user:([^:]+):session:([^:]+)$/);
  if (sessionMatch) {
    return { type: 'session', orgId: sessionMatch[1], userId: sessionMatch[2], sessionId: sessionMatch[3] };
  }

  const indexMatch = roomId.match(/^org:([^:]+):user:([^:]+):index$/);
  if (indexMatch) {
    return { type: 'index', orgId: indexMatch[1], userId: indexMatch[2] };
  }

  const projectsMatch = roomId.match(/^org:([^:]+):user:([^:]+):projects$/);
  if (projectsMatch) {
    return { type: 'projects', orgId: projectsMatch[1], userId: projectsMatch[2] };
  }

  // Document rooms are org-scoped (not user-scoped) - multiple users share a document room
  const documentMatch = roomId.match(/^org:([^:]+):doc:([^:]+)$/);
  if (documentMatch) {
    return { type: 'document', orgId: documentMatch[1], userId: '', documentId: documentMatch[2] };
  }

  // Tracker rooms are org-scoped (not user-scoped) - whole team shares a tracker room per project
  const trackerMatch = roomId.match(/^org:([^:]+):tracker:([^:]+)$/);
  if (trackerMatch) {
    return { type: 'tracker', orgId: trackerMatch[1], userId: '', projectId: trackerMatch[2] };
  }

  // Team rooms are org-scoped - one per org for consolidated team state
  const teamMatch = roomId.match(/^org:([^:]+):team$/);
  if (teamMatch) {
    return { type: 'team', orgId: teamMatch[1], userId: '' };
  }

  // ProjectSync rooms are user-scoped - one per (user + project) for personal file sync
  const projectSyncMatch = roomId.match(/^org:([^:]+):user:([^:]+):project:([^:]+)$/);
  if (projectSyncMatch) {
    return { type: 'projectSync', orgId: projectSyncMatch[1], userId: projectSyncMatch[2], projectId: projectSyncMatch[3] };
  }

  return null;
}

function getAuthConfig(env: Env): AuthConfig {
  return {
    stytchProjectId: env.STYTCH_PROJECT_ID,
  };
}

// Main fetch handler
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Set log environment once per request (cheap operation)
    setLogEnvironment(env.ENVIRONMENT || 'production');

    const url = new URL(request.url);

    // Health check - returns version for deploy tracking
    if (url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        version: COLLABV3_VERSION,
        environment: env.ENVIRONMENT || 'unknown',
      });
    }

    // WebSocket route: /sync/{roomId} (may have trailing path for internal DO endpoints)
    if (url.pathname.startsWith('/sync/')) {
      const fullPath = url.pathname.slice(6); // Remove '/sync/'

      if (!fullPath) {
        return new Response('Missing room ID', { status: 400 });
      }

      // Extract roomId (everything before /internal/, /status, /delete-account, /delete)
      const subPathMatch = fullPath.match(/^(.+?)(\/(?:internal|status|delete-account|delete).*)$/);
      const roomId = subPathMatch ? subPathMatch[1] : fullPath;

      const parsed = parseRoomId(roomId);
      if (!parsed) {
        return new Response(`Invalid room ID format: ${roomId}`, { status: 400 });
      }

      // Validate auth
      let auth: AuthResult | null = null;

      // Dev-only: bypass JWT auth for integration testing
      if (env.TEST_AUTH_BYPASS === 'true' && env.ENVIRONMENT === 'development') {
        const testUserId = url.searchParams.get('test_user_id');
        const testOrgId = url.searchParams.get('test_org_id');
        if (testUserId && testOrgId) {
          auth = { userId: testUserId, orgId: testOrgId };
          log.debug('TEST_AUTH_BYPASS: using test auth', testUserId, testOrgId);
        }
      }

      if (!auth) {
        const authConfig = getAuthConfig(env);
        auth = await parseAuthJWT(request, authConfig);
      }

      // Document, tracker, and team rooms are org-scoped (no userId in room ID), other rooms are user-scoped
      if (parsed.type === 'document' || parsed.type === 'tracker' || parsed.type === 'team') {
        if (!auth) {
          log.warn('Auth failed for document room');
          return new Response('Unauthorized', { status: 401 });
        }
        if (auth.orgId !== parsed.orgId) {
          log.warn('Org mismatch. Room orgId:', parsed.orgId, 'JWT orgId:', auth.orgId);
          return new Response('Unauthorized: org mismatch', { status: 401 });
        }
      } else {
        log.debug('Auth result:', auth, 'Room userId:', parsed.userId);
        if (!auth || auth.userId !== parsed.userId) {
          log.warn('Auth failed. auth:', auth, 'parsed.userId:', parsed.userId);
          return new Response('Unauthorized', { status: 401 });
        }
        // User-scoped rooms (session, index, projects) do NOT enforce orgId match.
        // The userId check above is sufficient -- these rooms hold the user's own data.
        // This allows session sync to always use the personal org's room IDs even when
        // the JWT is scoped to a team org (e.g., after a Stytch session exchange).
      }
      log.debug('Auth passed, forwarding to DO');

      // Block direct access to internal DO endpoints via /sync/ path.
      // Internal endpoints must only be reached through REST API handlers
      // (which enforce admin role checks) or through DO-to-DO calls.
      if (url.pathname.includes('/internal/')) {
        log.warn('Blocked direct /sync/ access to internal endpoint:', url.pathname);
        return new Response('Forbidden: internal endpoints not accessible via /sync', { status: 403 });
      }

      // Route to appropriate DO
      let stub: DurableObjectStub;

      if (parsed.type === 'session' && parsed.sessionId) {
        // Use session ID as DO ID for isolation
        const id = env.SESSION_ROOM.idFromName(roomId);
        stub = env.SESSION_ROOM.get(id);
      } else if (parsed.type === 'index' || parsed.type === 'projects') {
        // Use user ID as DO ID (one index per user)
        const id = env.INDEX_ROOM.idFromName(`user:${parsed.userId}:index`);
        stub = env.INDEX_ROOM.get(id);
      } else if (parsed.type === 'document' && parsed.documentId) {
        // Use full room ID as DO ID (one DO per document)
        const id = env.DOCUMENT_ROOM.idFromName(roomId);
        stub = env.DOCUMENT_ROOM.get(id);
      } else if (parsed.type === 'tracker' && parsed.projectId) {
        // Use full room ID as DO ID (one DO per project tracker)
        const id = env.TRACKER_ROOM.idFromName(roomId);
        stub = env.TRACKER_ROOM.get(id);
      } else if (parsed.type === 'team') {
        // Use full room ID as DO ID (one DO per org)
        const id = env.TEAM_ROOM.idFromName(roomId);
        stub = env.TEAM_ROOM.get(id);
      } else if (parsed.type === 'projectSync' && parsed.projectId) {
        // Use full room ID as DO ID (one DO per user+project)
        const id = env.PROJECT_SYNC_ROOM.idFromName(roomId);
        stub = env.PROJECT_SYNC_ROOM.get(id);
      } else {
        return new Response('Invalid room type', { status: 400 });
      }

      // Analytics: track WebSocket connection by room type
      if (request.headers.get('Upgrade') === 'websocket') {
        track(env, 'ws_connected', [parsed.type, auth.userId], [1]);
      }

      // Forward request to DO with user_id and org_id in query params
      const forwardUrl = new URL(request.url);
      forwardUrl.searchParams.set('user_id', auth.userId);
      forwardUrl.searchParams.set('org_id', auth.orgId);
      const forwardRequest = new Request(forwardUrl.toString(), request);
      return stub.fetch(forwardRequest);
    }

    // REST API routes
    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, env, url);
    }

    // Auth routes (OAuth callbacks, etc.)
    if (url.pathname.startsWith('/auth/')) {
      return handleAuthRoutes(request, env, url);
    }

    // Share routes
    if (url.pathname.startsWith('/share')) {
      return handleShareRoutes(request, env, url);
    }

    // Viewer static assets (extension bundles, React deps, shell)
    if (url.pathname.startsWith('/viewer/')) {
      return handleViewerAsset(url.pathname, env);
    }

    // Admin DO cleanup -- gated by Cloudflare Access (worker verifies the
    // Access JWT against CF_ACCESS_AUD). Called by scripts/cleanup-orphan-dos.mjs.
    if (url.pathname === '/admin/cleanup-do' && request.method === 'POST') {
      return handleAdminCleanup(request, env);
    }

    return new Response('Not Found', { status: 404 });
  },
};


/**
 * Handle REST API requests
 */
async function handleApiRequest(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  // Get CORS headers based on request origin
  const origin = request.headers.get('Origin');
  log.debug('API request to', url.pathname, 'from origin:', origin);
  const corsHeaders = getCorsHeaders(request, env);

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Auth endpoints (no auth required)
  if (url.pathname === '/api/auth/magic-link' && request.method === 'POST') {
    return handleMagicLinkRequest(request, env, corsHeaders);
  }

  // All other API routes require authentication
  let auth: AuthResult | null = null;

  // Dev-only: bypass JWT auth for integration testing (same pattern as WebSocket routes)
  if (env.TEST_AUTH_BYPASS === 'true' && env.ENVIRONMENT === 'development') {
    const testUserId = url.searchParams.get('test_user_id');
    const testOrgId = url.searchParams.get('test_org_id');
    if (testUserId && testOrgId) {
      auth = { userId: testUserId, orgId: testOrgId };
    }
  }

  if (!auth) {
    const authConfig = getAuthConfig(env);
    auth = await parseAuthJWT(request, authConfig);
  }

  if (!auth) {
    log.warn('API auth failed for:', url.pathname, request.method);
    return new Response('Unauthorized', { status: 401, headers: corsHeaders });
  }

  // GET /api/sessions - List sessions for user
  if (url.pathname === '/api/sessions' && request.method === 'GET') {
    const indexId = env.INDEX_ROOM.idFromName(`user:${auth.userId}:index`);
    const stub = env.INDEX_ROOM.get(indexId);

    // Forward to status endpoint for now (could add dedicated list endpoint)
    return stub.fetch(new Request(`${url.origin}/status`));
  }

  // GET /api/session/{sessionId}/status - Get session status
  if (url.pathname.startsWith('/api/session/') && url.pathname.endsWith('/status')) {
    const sessionId = url.pathname.slice(13, -7); // Extract session ID
    const roomId = `user:${auth.userId}:session:${sessionId}`;
    const id = env.SESSION_ROOM.idFromName(roomId);
    const stub = env.SESSION_ROOM.get(id);

    return stub.fetch(new Request(`${url.origin}/status`));
  }

  // POST /api/bulk-index - Bulk update session index (for initial sync)
  if (url.pathname === '/api/bulk-index' && request.method === 'POST') {
    try {
      const body = await request.json() as { sessions: unknown[] };

      const indexId = env.INDEX_ROOM.idFromName(`user:${auth.userId}:index`);
      const stub = env.INDEX_ROOM.get(indexId);

      // For bulk operations, we need to call the DO method directly
      // This requires forwarding via fetch with special path
      const bulkRequest = new Request(`${url.origin}/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      return stub.fetch(bulkRequest);
    } catch (err) {
      return new Response(`Invalid request body: ${err}`, { status: 400 });
    }
  }

  // PUT /api/identity-key - Upload your ECDH public key
  if (url.pathname === '/api/identity-key' && request.method === 'PUT') {
    return handleIdentityKeyUpload(request, auth, env, corsHeaders);
  }

  // GET /api/identity-key/{userId} - Fetch a user's public key (same org only)
  if (url.pathname.startsWith('/api/identity-key/') && request.method === 'GET') {
    const targetUserId = url.pathname.slice('/api/identity-key/'.length);
    if (!targetUserId) {
      return new Response('Missing user ID', { status: 400, headers: corsHeaders });
    }
    return handleIdentityKeyFetch(targetUserId, auth, env, corsHeaders);
  }

  // POST /api/account/delete - Delete user account and all data
  if (url.pathname === '/api/account/delete' && request.method === 'POST') {
    return handleAccountDeletion(auth, env, corsHeaders);
  }

  // GET /api/collab/docs/{documentId}/assets -- List all assets (for key rotation)
  const docAssetListMatch = url.pathname.match(/^\/api\/collab\/docs\/([^/]+)\/assets$/);
  if (docAssetListMatch && request.method === 'GET') {
    const [, documentId] = docAssetListMatch;
    const roomId = `org:${auth.orgId}:doc:${documentId}`;
    const doId = env.DOCUMENT_ROOM.idFromName(roomId);
    const stub = env.DOCUMENT_ROOM.get(doId);
    const internalUrl = new URL(request.url);
    internalUrl.pathname = `/sync/${roomId}/internal/assets`;
    internalUrl.searchParams.set('user_id', auth.userId);
    internalUrl.searchParams.set('org_id', auth.orgId);
    return stub.fetch(new Request(internalUrl.toString(), { method: 'GET' }));
  }

  const docAssetMatch = url.pathname.match(/^\/api\/collab\/docs\/([^/]+)\/assets\/([^/]+)$/);
  if (docAssetMatch) {
    const [, documentId, assetId] = docAssetMatch;
    if (request.method === 'PUT') {
      return handleUploadDocumentAsset(request, env, auth, corsHeaders, documentId, assetId);
    }
    if (request.method === 'GET') {
      return handleGetDocumentAsset(request, env, auth, corsHeaders, documentId, assetId);
    }
    if (request.method === 'DELETE') {
      return handleDeleteDocumentAsset(request, env, auth, corsHeaders, documentId, assetId);
    }
    return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
  }

  // ========================================================================
  // Team Management Routes
  // ========================================================================

  // POST /api/teams - Create a new team
  if (url.pathname === '/api/teams' && request.method === 'POST') {
    const response = await handleCreateTeam(request, auth, env, corsHeaders);
    if (response.ok) {
      track(env, 'team_created', [auth.userId, auth.orgId], [1]);
    }
    return response;
  }

  // GET /api/teams - List teams the caller belongs to
  if (url.pathname === '/api/teams' && request.method === 'GET') {
    return handleListTeams(request, auth, env, corsHeaders);
  }

  // Routes under /api/teams/{orgId}/...
  const teamsMatch = url.pathname.match(/^\/api\/teams\/([^/]+)(\/.*)?$/);
  if (teamsMatch) {
    const teamOrgId = teamsMatch[1];
    const subPath = teamsMatch[2] || '';

    // DELETE /api/teams/{orgId} - Delete team (admin only)
    if (!subPath && request.method === 'DELETE') {
      return handleDeleteTeam(teamOrgId, auth, env, corsHeaders);
    }

    // GET /api/teams/{orgId}/members - List members
    if (subPath === '/members' && request.method === 'GET') {
      return handleListMembers(teamOrgId, auth, env, corsHeaders);
    }

    // POST /api/teams/{orgId}/invite - Invite member
    if (subPath === '/invite' && request.method === 'POST') {
      const response = await handleInviteMember(teamOrgId, request, auth, env, corsHeaders);
      if (response.ok) {
        track(env, 'team_member_joined', [teamOrgId, ''], [1]);
      }
      return response;
    }

    // POST /api/teams/{orgId}/switch - Switch org session
    if (subPath === '/switch' && request.method === 'POST') {
      return handleOrgSwitch(teamOrgId, request, auth, env, corsHeaders);
    }

    // PUT /api/teams/{orgId}/project-identity - Set git remote hash
    if (subPath === '/project-identity' && request.method === 'PUT') {
      return handleSetProjectIdentity(teamOrgId, request, auth, env, corsHeaders);
    }

    // DELETE /api/teams/{orgId}/project-identity - Clear project identity
    if (subPath === '/project-identity' && request.method === 'DELETE') {
      return handleClearProjectIdentity(teamOrgId, auth, env, corsHeaders);
    }

    // Org Key Fingerprint Routes
    // PUT /api/teams/{orgId}/org-key-fingerprint - Set current fingerprint (admin)
    if (subPath === '/org-key-fingerprint' && request.method === 'PUT') {
      return handleSetOrgKeyFingerprint(teamOrgId, request, auth, env, corsHeaders);
    }

    // GET /api/teams/{orgId}/org-key-fingerprint - Get current fingerprint
    if (subPath === '/org-key-fingerprint' && request.method === 'GET') {
      return handleGetOrgKeyFingerprint(teamOrgId, auth, env, corsHeaders);
    }

    // Key Envelope Routes
    // GET /api/teams/{orgId}/key-envelope - Get caller's own envelope
    if (subPath === '/key-envelope' && request.method === 'GET') {
      return handleGetOwnKeyEnvelope(teamOrgId, auth, env, corsHeaders);
    }

    // POST /api/teams/{orgId}/key-envelopes - Upload envelope for a member
    if (subPath === '/key-envelopes' && request.method === 'POST') {
      return handleUploadKeyEnvelope(teamOrgId, request, auth, env, corsHeaders);
    }

    // GET /api/teams/{orgId}/key-envelopes - List all envelopes (admin)
    if (subPath === '/key-envelopes' && request.method === 'GET') {
      return handleListKeyEnvelopes(teamOrgId, auth, env, corsHeaders);
    }

    // DELETE /api/teams/{orgId}/key-envelopes - Delete ALL envelopes (admin, rotation)
    if (subPath === '/key-envelopes' && request.method === 'DELETE') {
      return handleDeleteAllKeyEnvelopes(teamOrgId, auth, env, corsHeaders);
    }

    // DELETE /api/teams/{orgId}/key-envelopes/{userId} - Delete specific envelope
    const envelopeMatch = subPath.match(/^\/key-envelopes\/([^/]+)$/);
    if (envelopeMatch && request.method === 'DELETE') {
      return handleDeleteKeyEnvelope(teamOrgId, envelopeMatch[1], auth, env, corsHeaders);
    }

    // POST /api/teams/{orgId}/rotation-lock - Set/clear write barrier on all rooms (admin, rotation)
    if (subPath === '/rotation-lock' && request.method === 'POST') {
      return handleRotationLock(teamOrgId, request, auth, env, corsHeaders);
    }

    // POST /api/teams/{orgId}/propagate-fingerprint - Set fingerprint on doc/tracker rooms (admin, rotation)
    if (subPath === '/propagate-fingerprint' && request.method === 'POST') {
      return handlePropagateFingerprint(teamOrgId, request, auth, env, corsHeaders);
    }

    // POST /api/teams/{orgId}/truncate-tracker-changelog - Truncate changelog after rotation (admin)
    if (subPath === '/truncate-tracker-changelog' && request.method === 'POST') {
      return handleTruncateTrackerChangelog(teamOrgId, request, auth, env, corsHeaders);
    }

    // POST /api/teams/{orgId}/rotation-compact-doc - Upload re-encrypted doc snapshot (admin, rotation)
    if (subPath === '/rotation-compact-doc' && request.method === 'POST') {
      return handleRotationCompactDoc(teamOrgId, request, auth, env, corsHeaders);
    }

    // POST /api/teams/{orgId}/rotation-batch-upsert-tracker - Upload re-encrypted tracker items (admin, rotation)
    if (subPath === '/rotation-batch-upsert-tracker' && request.method === 'POST') {
      return handleRotationBatchUpsertTracker(teamOrgId, request, auth, env, corsHeaders);
    }

    // Routes under /api/teams/{orgId}/members/{memberId}
    const memberMatch = subPath.match(/^\/members\/([^/]+)$/);
    if (memberMatch) {
      const memberId = memberMatch[1];

      // DELETE /api/teams/{orgId}/members/{memberId} - Remove member
      if (request.method === 'DELETE') {
        const response = await handleRemoveMember(teamOrgId, memberId, auth, env, corsHeaders);
        if (response.ok) {
          track(env, 'team_member_left', [teamOrgId, memberId], [1]);
        }
        return response;
      }

      // PUT /api/teams/{orgId}/members/{memberId} - Update role
      if (request.method === 'PUT') {
        return handleUpdateMemberRole(teamOrgId, memberId, request, auth, env, corsHeaders);
      }
    }
  }

  return new Response('Not Found', { status: 404, headers: corsHeaders });
}

/**
 * Handle share routes for session sharing.
 * GET /share/{shareId} is public (no auth).
 * POST /share, GET /shares, DELETE /share/{shareId} require auth.
 */
async function handleShareRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const corsHeaders = getCorsHeaders(request, env);

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      },
    });
  }

  // GET /share/{shareId}/content - Public, serve raw encrypted content
  if (url.pathname.match(/^\/share\/[^/]+\/content$/) && request.method === 'GET') {
    const shareId = url.pathname.slice('/share/'.length, url.pathname.lastIndexOf('/'));
    if (shareId) {
      return handleShareContent(shareId, env);
    }
  }

  // GET /share/{shareId} - Public, serve HTML or decryption viewer
  if (url.pathname.startsWith('/share/') && !url.pathname.includes('/content') && request.method === 'GET') {
    const shareId = url.pathname.slice('/share/'.length);
    if (shareId) {
      return handleShareView(shareId, env);
    }
  }

  // POST /share - Upload HTML (authenticated)
  if (url.pathname === '/share' && request.method === 'POST') {
    const authConfig = getAuthConfig(env);
    const auth = await parseAuthJWT(request, authConfig);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    return handleShareUpload(request, env, auth, corsHeaders);
  }

  // GET /shares - List user's shares (authenticated)
  if (url.pathname === '/shares' && request.method === 'GET') {
    const authConfig = getAuthConfig(env);
    const auth = await parseAuthJWT(request, authConfig);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    return handleShareList(env, auth, corsHeaders);
  }

  // DELETE /share/{shareId} - Delete share (authenticated)
  if (url.pathname.startsWith('/share/') && request.method === 'DELETE') {
    const shareId = url.pathname.slice('/share/'.length);
    const authConfig = getAuthConfig(env);
    const auth = await parseAuthJWT(request, authConfig);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    return handleShareDelete(shareId, env, auth, corsHeaders);
  }

  return new Response('Not Found', { status: 404, headers: corsHeaders });
}

/**
 * Serve static viewer assets from R2.
 *
 * Viewer assets include React dependency bundles, extension viewer bundles,
 * and the viewer shell. These are deployed to the SESSION_SHARES R2 bucket
 * under the /viewer/ prefix.
 *
 * Assets are immutable once deployed, so we use long cache headers.
 */
async function handleViewerAsset(
  pathname: string,
  env: Env,
): Promise<Response> {
  // Sanitize: strip leading slash, ensure no path traversal
  const key = pathname.slice(1); // "viewer/deps/react.js"
  if (key.includes('..') || !key.startsWith('viewer/')) {
    return new Response('Not Found', { status: 404 });
  }

  const object = await env.SESSION_SHARES.get(key);
  if (!object) {
    return new Response('Not Found', { status: 404 });
  }

  // Determine content type from extension
  const ext = key.split('.').pop() || '';
  const contentTypes: Record<string, string> = {
    js: 'application/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    json: 'application/json; charset=utf-8',
  };

  return new Response(object.body, {
    headers: {
      'Content-Type': contentTypes[ext] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400', // 1 day
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/**
 * Handle magic link send request.
 * This uses the Stytch secret key (server-side only) to send magic link emails.
 */
async function handleMagicLinkRequest(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  // Check for required environment variables
  if (!env.STYTCH_PROJECT_ID || !env.STYTCH_SECRET_KEY) {
    return new Response(
      JSON.stringify({ error: 'Stytch not configured on server' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const body = await request.json() as { email: string; redirect_url: string };

    if (!body.email) {
      return new Response(
        JSON.stringify({ error: 'Email is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Determine magic link redirect URL
    let magicLinkUrl: string;
    const isDev = env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'local';

    if (body.redirect_url) {
      // Validate redirect URL is HTTPS in production
      if (!isDev && !body.redirect_url.startsWith('https://')) {
        return new Response(
          JSON.stringify({ error: 'redirect_url must use HTTPS' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      magicLinkUrl = body.redirect_url;
    } else if (isDev) {
      // Only allow HTTP fallback in development mode
      magicLinkUrl = 'http://localhost:8787/oauth/callback';
    } else {
      // Production requires explicit redirect_url
      return new Response(
        JSON.stringify({ error: 'redirect_url is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Call Stytch B2B Discovery magic link API
    // Discovery flow: sends a magic link that returns an intermediate session
    const magicLinkIsTest = env.STYTCH_PROJECT_ID.startsWith('project-test-');
    const b2bApiBase = magicLinkIsTest ? 'https://test.stytch.com/v1/b2b' : 'https://api.stytch.com/v1/b2b';

    const stytchResponse = await fetch(`${b2bApiBase}/magic_links/email/discovery/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${btoa(`${env.STYTCH_PROJECT_ID}:${env.STYTCH_SECRET_KEY}`)}`,
      },
      body: JSON.stringify({
        email_address: body.email,
        discovery_redirect_url: magicLinkUrl,
      }),
    });

    const stytchData = await stytchResponse.json() as { error_message?: string; email_id?: string };

    if (!stytchResponse.ok) {
      return new Response(
        JSON.stringify({ error: stytchData.error_message || 'Failed to send magic link' }),
        { status: stytchResponse.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ success: true, email_id: stytchData.email_id }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    log.error('Magic link error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Handle identity key upload (PUT /api/identity-key).
 * Stores the user's ECDH P-256 public key in the TeamRoom DO.
 */
async function handleIdentityKeyUpload(
  request: Request,
  auth: AuthResult,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const body = await request.json() as { publicKeyJwk: string };

    if (!body.publicKeyJwk) {
      return new Response(JSON.stringify({ error: 'publicKeyJwk is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Validate that the JWK is a valid ECDH P-256 public key
    try {
      const jwk = JSON.parse(body.publicKeyJwk);
      if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') {
        return new Response(JSON.stringify({ error: 'Key must be ECDH P-256 (kty: EC, crv: P-256)' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      // Ensure it's a public key (no private component)
      if (jwk.d) {
        return new Response(JSON.stringify({ error: 'Must be a public key (no private component)' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    } catch {
      return new Response(JSON.stringify({ error: 'publicKeyJwk must be valid JSON' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Upload to TeamRoom DO
    await teamRoomPost(auth.orgId, 'upload-identity-key', {
      userId: auth.userId,
      publicKeyJwk: body.publicKeyJwk,
    }, env);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    log.error('Identity key upload error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Handle identity key fetch (GET /api/identity-key/{userId}).
 * Only returns keys for users in the same org as the requester.
 * Fetches from the TeamRoom DO (org-scoped, per-org key isolation).
 */
async function handleIdentityKeyFetch(
  targetUserId: string,
  auth: AuthResult,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const resp = await teamRoomGet(auth.orgId, 'get-identity-key', env, { userId: targetUserId });

    if (!resp.ok) {
      return new Response(JSON.stringify({ error: 'Public key not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const data = await resp.json() as { userId: string; publicKeyJwk: string; updatedAt: number };

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    log.error('Identity key fetch error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Handle auth routes (OAuth callbacks, login initiation, etc.)
 */
async function handleAuthRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  // Get CORS headers based on request origin
  const corsHeaders = getCorsHeaders(request, env);

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Check for required environment variables
  if (!env.STYTCH_PROJECT_ID || !env.STYTCH_SECRET_KEY) {
    return new Response('Stytch not configured', { status: 500, headers: corsHeaders });
  }

  const b2bApiBase = env.STYTCH_PROJECT_ID.startsWith('project-test-')
    ? 'https://test.stytch.com/v1/b2b'
    : 'https://api.stytch.com/v1/b2b';

  // GET /auth/callback - OAuth/Magic Link callback from Stytch
  // Stytch redirects here with ?token=xxx&stytch_token_type=oauth|magic_links
  if (url.pathname === '/auth/callback') {
    const token = url.searchParams.get('token');
    const tokenType = url.searchParams.get('stytch_token_type');

    if (!token || !tokenType) {
      return new Response(renderErrorPage('Missing token or token type'), {
        status: 400,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    try {
      // B2B Discovery flow: OAuth returns an intermediate session token.
      // We need to: 1) authenticate via discovery, 2) list orgs, 3) exchange for org-scoped session.
      // For users with a single org, this is transparent.
      const result = await authenticateB2BToken(token, tokenType, b2bApiBase, env);

      if (!result.ok) {
        return new Response(
          renderErrorPage(result.error || 'Authentication failed'),
          { status: 401, headers: { 'Content-Type': 'text/html' } }
        );
      }

      // Analytics: track successful auth
      const method = tokenType === 'oauth' ? 'google_oauth' : 'magic_link';
      track(env, 'auth_event', [method], [1]);

      const deepLinkParams = new URLSearchParams({
        session_token: result.sessionToken,
        session_jwt: result.sessionJwt,
        user_id: result.userId,
        email: result.email,
        expires_at: result.expiresAt,
        org_id: result.orgId,
      });

      const deepLinkUrl = `nimbalyst://auth/callback?${deepLinkParams.toString()}`;

      // Mobile Safari: do a direct 302 redirect to the deep link.
      // Safari on iOS blocks automatic JS redirects to custom URL schemes,
      // but follows HTTP 302 redirects reliably.
      const ua = request.headers.get('user-agent') || '';
      const isMobile = /iPhone|iPad|iPod/i.test(ua);
      if (isMobile) {
        return new Response(null, {
          status: 302,
          headers: { 'Location': deepLinkUrl },
        });
      }

      // Desktop: return a page that redirects to the deep link
      return new Response(renderSuccessPage(deepLinkUrl), {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    } catch (err) {
      log.error('Auth callback error:', err);
      return new Response(renderErrorPage('An unexpected error occurred. Please try again.'), {
        status: 500,
        headers: { 'Content-Type': 'text/html' },
      });
    }
  }

  // POST /auth/refresh - Refresh B2B session and get new JWT
  if (url.pathname === '/auth/refresh' && request.method === 'POST') {
    try {
      const body = await request.json() as { session_token: string };
      const sessionToken = body.session_token;

      if (!sessionToken) {
        return new Response(JSON.stringify({ error: 'session_token required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const stytchResponse = await fetch(`${b2bApiBase}/sessions/authenticate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${btoa(`${env.STYTCH_PROJECT_ID}:${env.STYTCH_SECRET_KEY}`)}`,
        },
        body: JSON.stringify({
          session_token: sessionToken,
          session_duration_minutes: 60 * 24 * 7, // 1 week
        }),
      });

      const stytchData = await stytchResponse.json() as {
        member?: { member_id: string; email_address?: string; name?: string };
        member_session?: { expires_at: string };
        organization?: { organization_id: string };
        session_token?: string;
        session_jwt?: string;
        error_message?: string;
      };

      if (!stytchResponse.ok || !stytchData.session_token) {
        console.error('[auth/refresh] Stytch error:', stytchResponse.status, stytchData.error_message);
        return new Response(JSON.stringify({
          error: stytchData.error_message || 'Session refresh failed',
          expired: stytchResponse.status === 401,
        }), {
          status: stytchResponse.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({
        session_token: stytchData.session_token,
        session_jwt: stytchData.session_jwt,
        user_id: stytchData.member?.member_id || '',
        email: stytchData.member?.email_address || '',
        expires_at: stytchData.member_session?.expires_at || '',
        org_id: stytchData.organization?.organization_id || '',
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      log.error('Session refresh error:', err);
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  // GET /auth/login/google - Initiate Google OAuth via B2B Discovery
  // Desktop app opens this URL in browser
  if (url.pathname === '/auth/login/google') {
    const callbackUrl = `${url.origin}/auth/callback`;

    if (!env.STYTCH_PUBLIC_TOKEN) {
      return new Response('Stytch public token not configured', { status: 500 });
    }

    // B2B discovery OAuth - authenticate first, then select/create org
    const oauthUrl = new URL(`${b2bApiBase}/public/oauth/google/discovery/start`);
    oauthUrl.searchParams.set('public_token', env.STYTCH_PUBLIC_TOKEN);
    oauthUrl.searchParams.set('discovery_redirect_url', callbackUrl);
    // Force Google to show account picker instead of auto-selecting
    oauthUrl.searchParams.set('provider_prompt', 'select_account');

    return Response.redirect(oauthUrl.toString(), 302);
  }

  return new Response('Not Found', { status: 404 });
}

interface B2BAuthResult {
  ok: boolean;
  error?: string;
  sessionToken: string;
  sessionJwt: string;
  userId: string;
  email: string;
  expiresAt: string;
  orgId: string;
}

/**
 * Authenticate a B2B token from OAuth or magic link callback.
 *
 * Discovery flow:
 * 1. Authenticate the intermediate token
 * 2. List discovered organizations
 * 3. If user has orgs, exchange for org-scoped session (prefer personal org)
 * 4. If user has no orgs, create a personal organization first
 */
async function authenticateB2BToken(
  token: string,
  tokenType: string,
  b2bApiBase: string,
  env: Env
): Promise<B2BAuthResult> {
  const failResult = (error: string): B2BAuthResult => ({
    ok: false, error, sessionToken: '', sessionJwt: '', userId: '', email: '', expiresAt: '', orgId: '',
  });

  const b2bAuth = `Basic ${btoa(`${env.STYTCH_PROJECT_ID}:${env.STYTCH_SECRET_KEY}`)}`;

  // Step 1: Authenticate via B2B discovery
  let discoveryEndpoint: string;
  let discoveryBody: Record<string, string>;
  // Multi-tenant magic links (team invites) authenticate directly into an org,
  // bypassing the discovery flow entirely.
  if (tokenType === 'multi_tenant_magic_links') {
    log.info('Authenticating multi-tenant magic link (team invite)');
    const authResponse = await fetch(`${b2bApiBase}/magic_links/authenticate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': b2bAuth,
      },
      body: JSON.stringify({
        magic_links_token: token,
        session_duration_minutes: 60 * 24 * 7, // 1 week
      }),
    });

    if (!authResponse.ok) {
      const errData = await authResponse.json().catch(() => ({})) as { error_message?: string };
      log.error('Multi-tenant magic link auth failed:', errData.error_message);
      return failResult(errData.error_message || 'Magic link authentication failed');
    }

    const authData = await authResponse.json() as {
      member?: { member_id: string; email_address?: string };
      member_session?: { expires_at: string };
      organization?: { organization_id: string };
      session_token?: string;
      session_jwt?: string;
    };

    return {
      ok: true,
      error: '',
      sessionToken: authData.session_token || '',
      sessionJwt: authData.session_jwt || '',
      userId: authData.member?.member_id || '',
      email: authData.member?.email_address || '',
      expiresAt: authData.member_session?.expires_at || '',
      orgId: authData.organization?.organization_id || '',
    };
  }

  if (tokenType === 'discovery_oauth' || tokenType === 'oauth') {
    discoveryEndpoint = `${b2bApiBase}/oauth/discovery/authenticate`;
    discoveryBody = { discovery_oauth_token: token };
  } else if (tokenType === 'discovery' || tokenType === 'magic_links') {
    discoveryEndpoint = `${b2bApiBase}/magic_links/discovery/authenticate`;
    discoveryBody = { discovery_magic_links_token: token };
  } else {
    return failResult(`Unknown token type: ${tokenType}`);
  }

  const discoveryResponse = await fetch(discoveryEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': b2bAuth,
    },
    body: JSON.stringify(discoveryBody),
  });

  if (!discoveryResponse.ok) {
    const errData = await discoveryResponse.json().catch(() => ({})) as { error_message?: string };
    return failResult(errData.error_message || 'Discovery authentication failed');
  }

  const discoveryData = await discoveryResponse.json() as {
    intermediate_session_token?: string;
    email_address?: string;
    discovered_organizations?: Array<{
      organization?: {
        organization_id: string;
        organization_name: string;
        trusted_metadata?: Record<string, unknown>;
      };
      membership?: { type: string };
    }>;
    error_message?: string;
  };

  if (!discoveryData.intermediate_session_token) {
    return failResult(discoveryData.error_message || 'Discovery authentication failed');
  }

  const intermediateToken = discoveryData.intermediate_session_token;
  const email = discoveryData.email_address || '';
  const discoveredOrgs = discoveryData.discovered_organizations || [];

  // Step 2: Select or create organization
  let targetOrgId: string;

  if (discoveredOrgs.length > 0) {
    // Resolve org types for all discovered orgs. This backfills nimbalyst_org_type
    // metadata on orgs that don't have it yet (using TeamRoom presence as heuristic).
    // Once backfilled, future auth calls use the explicit metadata directly.
    const orgsWithTypes = await Promise.all(
      discoveredOrgs.map(async (org) => ({
        ...org,
        orgType: await resolveDiscoveredOrgType(org, env),
      }))
    );

    const preferredOrg = selectPreferredPersonalOrg(orgsWithTypes);
    targetOrgId = preferredOrg?.organization?.organization_id || '';
    log.info('Auth org selection:', discoveredOrgs.length, 'orgs,',
      'types:', orgsWithTypes.map(o => `${o.organization?.organization_id?.slice(-8)}=${o.orgType}`).join(', '),
      'selected:', targetOrgId.slice(-8));
  } else {
    // New user with no orgs - create a personal organization
    const createOrgResponse = await fetch(`${b2bApiBase}/discovery/organizations/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': b2bAuth,
      },
      body: JSON.stringify({
        intermediate_session_token: intermediateToken,
        organization_name: `${email.split('@')[0]}'s Workspace`,
        session_duration_minutes: 60 * 24 * 7, // 1 week
      }),
    });

    if (!createOrgResponse.ok) {
      const errData = await createOrgResponse.json() as { error_message?: string };
      return failResult(errData.error_message || 'Failed to create personal organization');
    }

    const createData = await createOrgResponse.json() as {
      member?: { member_id: string; email_address?: string };
      member_session?: { expires_at: string };
      organization?: { organization_id: string };
      session_token?: string;
      session_jwt?: string;
    };

    if (createData.organization?.organization_id) {
      await fetch(`${b2bApiBase}/organizations/${createData.organization.organization_id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': b2bAuth,
        },
        body: JSON.stringify({
          trusted_metadata: {
            [NIMBALYST_ORG_TYPE_KEY]: 'personal',
          },
        }),
      }).catch((error) => {
        log.warn('Failed to set personal org metadata on create:', createData.organization?.organization_id, error);
      });
    }

    return {
      ok: true,
      sessionToken: createData.session_token || '',
      sessionJwt: createData.session_jwt || '',
      userId: createData.member?.member_id || '',
      email: createData.member?.email_address || email,
      expiresAt: createData.member_session?.expires_at || '',
      orgId: createData.organization?.organization_id || '',
    };
  }

  // Step 3: Exchange intermediate session for org-scoped session
  const exchangeResponse = await fetch(`${b2bApiBase}/discovery/intermediate_sessions/exchange`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': b2bAuth,
    },
    body: JSON.stringify({
      intermediate_session_token: intermediateToken,
      organization_id: targetOrgId,
      session_duration_minutes: 60 * 24 * 7, // 1 week
    }),
  });

  if (!exchangeResponse.ok) {
    const errData = await exchangeResponse.json() as { error_message?: string };
    return failResult(errData.error_message || 'Session exchange failed');
  }

  const exchangeData = await exchangeResponse.json() as {
    member?: { member_id: string; email_address?: string };
    member_session?: { expires_at: string };
    organization?: { organization_id: string };
    session_token?: string;
    session_jwt?: string;
  };

  return {
    ok: true,
    sessionToken: exchangeData.session_token || '',
    sessionJwt: exchangeData.session_jwt || '',
    userId: exchangeData.member?.member_id || '',
    email: exchangeData.member?.email_address || email,
    expiresAt: exchangeData.member_session?.expires_at || '',
    orgId: exchangeData.organization?.organization_id || '',
  };
}

/**
 * Render success page that redirects to deep link
 * Shows session data for manual setup on devices that can't use deep links
 */
function renderSuccessPage(deepLinkUrl: string): string {
  // Escape deep link URL for HTML attribute and JS string contexts
  const safeDeepLinkHtml = escapeHtml(deepLinkUrl);
  const safeDeepLinkJs = escapeJsString(deepLinkUrl);

  return `<!DOCTYPE html>
<html>
<head>
  <title>Sign In Successful</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 20px;
      box-sizing: border-box;
    }
    .container {
      text-align: center;
      padding: 40px;
      background: rgba(255,255,255,0.1);
      border-radius: 16px;
      backdrop-filter: blur(10px);
      max-width: 500px;
      width: 100%;
    }
    h1 { margin-bottom: 16px; font-size: 24px; }
    p { opacity: 0.9; margin-bottom: 24px; }
    .button {
      display: inline-block;
      padding: 12px 24px;
      background: white;
      color: #667eea;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 600;
      transition: transform 0.2s;
      cursor: pointer;
      border: none;
      font-size: 16px;
    }
    .button:hover { transform: scale(1.05); }
    .auto-redirect { font-size: 12px; opacity: 0.7; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Successfully Signed In</h1>
    <p>Click the button below to return to Nimbalyst, or it will open automatically.</p>
    <a href="${safeDeepLinkHtml}" class="button">Open Nimbalyst</a>
    <p class="auto-redirect">Redirecting automatically...</p>
  </div>
  <script>
    // Try to open the deep link automatically
    setTimeout(() => {
      window.location.href = "${safeDeepLinkJs}";
    }, 1500);
  </script>
</body>
</html>`;
}

/**
 * Escape a string for safe embedding in HTML content.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escape a string for safe embedding in a JavaScript string literal (inside double quotes).
 */
function escapeJsString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/</g, '\\x3c')
    .replace(/>/g, '\\x3e')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/**
 * Render error page
 */
function renderErrorPage(error: string): string {
  const safeError = escapeHtml(error);
  return `<!DOCTYPE html>
<html>
<head>
  <title>Sign In Failed</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
      color: white;
    }
    .container {
      text-align: center;
      padding: 40px;
      background: rgba(255,255,255,0.1);
      border-radius: 16px;
      backdrop-filter: blur(10px);
      max-width: 400px;
    }
    h1 { margin-bottom: 16px; font-size: 24px; }
    p { opacity: 0.9; }
    .error { font-family: monospace; font-size: 12px; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Sign In Failed</h1>
    <p>Please close this window and try again.</p>
    <p class="error">${safeError}</p>
  </div>
</body>
</html>`;
}
