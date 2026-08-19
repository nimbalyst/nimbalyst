/**
 * CollabTestIdentityHandlers
 *
 * Test-only identity bridge for the wrangler-backed two-client collaboration
 * specs (`packages/electron/e2e/utils/twoClientCollab.ts`). Two Electron
 * instances have to reach a local `wrangler dev` collab worker without a real
 * Stytch session, so the identity that `document-sync:open`,
 * `document-sync:get-jwt`, and `document-sync:resolve-index-config` normally
 * derive from Stytch + team discovery is supplied by the test harness instead.
 *
 * It also substitutes the team lookup that local-origin bindings use, for the
 * same reason: a `Share to Team` in the harness has no Stytch session to
 * resolve an org from.
 *
 * The bypass lives here, not inline in `DocumentSyncHandlers.ts`, so the
 * production handlers have no auth-bypass branch to reason about and so the
 * bridge is never registered outside a Playwright dev run. Gating mirrors
 * `CollabV3TestHandlers` / `document-sync:open-test`, with three extra
 * conditions:
 *
 *  - `!app.isPackaged`, so the bypass cannot exist in a shipped binary even if
 *    the environment variables are set.
 *  - all three `NIMBALYST_E2E_COLLAB_*` variables present.
 *  - the collab server URL must be loopback.
 *
 * WebSocket auth: the local worker accepts `test_user_id` / `test_org_id`
 * query parameters when `TEST_AUTH_BYPASS=true` and `ENVIRONMENT=development`.
 * Those parameters are handed to the renderer as `urlExtraQuery` on the config
 * this bridge returns, so the already-authorized URL reaches the WebSocket
 * proxy -- `document-sync:ws-connect` itself never rewrites URLs.
 */

import { app } from 'electron';
import {
  asTeamJwt,
  asTeamMemberId,
  type TeamMemberId,
} from '@nimbalyst/runtime/auth/jwtScopes';
import { removeHandler, safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import { getWorkspaceState } from '../utils/store';
import { resolveCollabDocumentType } from './collabDocumentTypeResolver';
import { setLocalOriginTeamResolverForTests } from '../services/collabLocalOriginTeam';
import {
  clearCollabAssetSender,
  registerCollabAssetDocument,
} from '../protocols/collabAssetProtocol';

interface CollabTestIdentity {
  serverUrl: string;
  orgId: string;
  teamMemberId: TeamMemberId;
  /** Pre-authorized query the renderer appends to collab WebSocket URLs. */
  urlExtraQuery: string;
}

/**
 * The renderer's `getJwt` callback must resolve to something, but the local
 * worker authorizes off `test_user_id` / `test_org_id` before it ever looks at
 * a token, so the value is opaque and never verified.
 */
const TEST_BRIDGE_JWT = asTeamJwt('collab-test-bridge-jwt');

function resolveCollabTestIdentity(): CollabTestIdentity | null {
  if (app.isPackaged) return null;
  if (process.env.PLAYWRIGHT !== '1') return null;

  const serverUrl = process.env.NIMBALYST_E2E_COLLAB_SERVER_URL;
  const orgId = process.env.NIMBALYST_E2E_COLLAB_ORG_ID;
  const rawTeamMemberId = process.env.NIMBALYST_E2E_COLLAB_USER_ID;
  if (!serverUrl || !orgId || !rawTeamMemberId) return null;
  const teamMemberId = asTeamMemberId(rawTeamMemberId);

  const parsed = new URL(serverUrl);
  const isLoopback = parsed.hostname === 'localhost'
    || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '::1';
  if (!isLoopback || (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:')) {
    throw new Error('Playwright collab test server must be a loopback WebSocket URL');
  }

  const urlExtraQuery = new URLSearchParams({
    test_user_id: teamMemberId,
    test_org_id: orgId,
  }).toString();

  return { serverUrl: parsed.origin, orgId, teamMemberId, urlExtraQuery };
}

/** Track WebContents we've already hooked so repeated opens don't stack listeners. */
const senderDestroyedHooked = new Set<number>();

/**
 * Replaces the three auth-bearing document-sync channels, and local-origin team
 * discovery, with the harness identity. No-ops unless every gate in
 * `resolveCollabTestIdentity` passes, so a normal build keeps the production
 * handlers and the real team lookup.
 *
 * Must be called AFTER `registerDocumentSyncHandlers()`.
 */
export function registerCollabTestIdentityHandlers(): void {
  const identity = resolveCollabTestIdentity();
  if (!identity) return;

  logger.main.warn(
    '[CollabTestIdentity] Playwright collab identity bridge active -- '
    + `document-sync auth replaced for ${identity.serverUrl} (org ${identity.orgId})`,
  );

  // Local-origin bindings resolve their org through the same team discovery
  // this bridge replaces, and that discovery fails closed without a Stytch
  // session. Left alone, every harness `Share to Team` records no binding and
  // raises a "No team found for this workspace" toast that outlives the step
  // that caused it -- which is how the certification matrix failed on a later
  // document type for an error the previous one produced.
  //
  // No project or git remote: the harness workspace is a temp directory with
  // neither, and `resolve-index-config` above already reports teamProjectId as
  // null for the same reason.
  setLocalOriginTeamResolverForTests(async () => ({
    orgId: identity.orgId,
    teamProjectId: null,
    gitRemoteHash: null,
  }));

  removeHandler('document-sync:open');
  safeHandle('document-sync:open', async (event, payload: {
    workspacePath: string;
    documentId: string;
    title?: string;
    documentType?: string;
  }) => {
    const workspaceState = getWorkspaceState(payload.workspacePath);
    const resolvedDocumentType = resolveCollabDocumentType({
      callerDocumentType: payload.documentType,
      workspaceState: workspaceState as unknown as { openCollabDocumentEntries?: unknown },
      documentId: payload.documentId,
    });

    const senderId = event.sender.id;
    registerCollabAssetDocument(identity.orgId, payload.documentId, senderId);
    if (!event.sender.isDestroyed() && !senderDestroyedHooked.has(senderId)) {
      senderDestroyedHooked.add(senderId);
      event.sender.once('destroyed', () => {
        senderDestroyedHooked.delete(senderId);
        clearCollabAssetSender(senderId);
      });
    }

    return {
      success: true,
      config: {
        orgId: identity.orgId,
        documentId: payload.documentId,
        title: payload.title || payload.documentId,
        documentType: resolvedDocumentType,
        serverUrl: identity.serverUrl,
        accountId: identity.teamMemberId,
        teamMemberId: identity.teamMemberId,
        userName: 'Playwright User',
        userEmail: `${identity.teamMemberId}@example.test`,
        urlExtraQuery: identity.urlExtraQuery,
      },
    };
  });

  removeHandler('document-sync:get-jwt');
  safeHandle('document-sync:get-jwt', async (_event, payload: { orgId: string }) => {
    if (payload?.orgId !== identity.orgId) {
      return { success: false, error: 'Unknown org for the collab test identity bridge' };
    }
    return { success: true, jwt: TEST_BRIDGE_JWT };
  });

  removeHandler('document-sync:resolve-index-config');
  safeHandle('document-sync:resolve-index-config', async () => ({
    success: true,
    config: {
      orgId: identity.orgId,
      teamProjectId: null,
      serverUrl: identity.serverUrl,
      teamMemberId: identity.teamMemberId,
      userName: 'Playwright User',
      userEmail: `${identity.teamMemberId}@example.test`,
      urlExtraQuery: identity.urlExtraQuery,
    },
  }));
}
