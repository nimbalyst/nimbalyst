/**
 * DocumentSyncHandlers
 *
 * IPC handlers for collaborative document editing.
 * Resolves auth, encryption keys, and server config from main process
 * services so the renderer can open collab:// tabs.
 */

import { BrowserWindow, dialog, net } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import { getCollabSyncWsUrl, getCollabSyncHttpUrl } from '../utils/collabSyncUrl';
import { isAuthenticated, getStytchUserId, getUserEmail, getAuthState, getPersonalOrgId, getPersonalUserId, getPersonalSessionJwt, refreshPersonalSession } from '../services/StytchAuthService';
import { findTeamForWorkspace, getOrgScopedJwt } from '../services/TeamService';
import { getOrgIdFromJwt, getJwtExp } from '../services/jwtOrg';
import { getOrgKey, getOrgKeyFingerprint, getOrCreateIdentityKeyPair, uploadIdentityKeyToOrg, fetchAndUnwrapOrgKey, clearOrgKey, fetchTeamKeyStatus, getLastKnownTeamKeyStatus, getArchivedOrgKeys } from '../services/OrgKeyService';
import { getWorkspaceState, updateWorkspaceState } from '../utils/store';
import { createSingleFlight } from '../utils/asyncCache';
import { getDialogDefaultPath, rememberDialogSelection } from '../utils/dialogPaths';
import { getPersonalDocSyncConfig, isSyncEnabled } from '../services/SyncManager';
import { resolveCollabDocumentType } from './collabDocumentTypeResolver';
import { getSyncId } from '../services/DocSyncService';
import {
  registerCollabAssetDocument,
  unregisterCollabAssetDocument,
  isCollabAssetDocumentRegisteredForSender,
  clearCollabAssetSender,
} from '../protocols/collabAssetProtocol';
import { encryptAndUploadCollabAsset } from '../services/CollabAssetUploader';
import {
  scanMarkdownImageRefs,
  resolveAssetRef,
  rewriteMarkdownImageRefs,
} from '../services/markdownAssetScanner';
import {
  clearLocalOriginBinding,
  findLinkedDocumentForLocalPath,
  getLocalOriginBinding,
  recordLocalOriginShare,
  relinkLocalOriginBinding,
  reuploadFromLocalOrigin,
  seedSharedDocumentFromContent,
} from '../services/CollabLocalOriginService';
import WebSocket from 'ws';
import { getCollabDocumentReplicaStore } from '../services/CollabDocumentReplicaStore';
import { getCollabOutboxDrainCoordinator } from '../services/CollabOutboxDrainerService';
import { getCollabAssetStore } from '../services/CollabAssetStore';
import { getCollabAssetOutboxDrainCoordinator } from '../services/CollabAssetOutboxDrainCoordinator';
import type {
  AppendLocalReplicaUpdateInput,
  AppendRemoteReplicaUpdatesInput,
  LocalReplicaIdentity,
  LocalReplicaOutboxState,
  ReplaceLocalReplicaSnapshotInput,
} from '@nimbalyst/runtime/sync';

/** Max concurrent uploads in a single migrate-local-assets pass. Keeps a    */
/** multi-image share from saturating the collab worker.                    */
const MIGRATE_UPLOAD_CONCURRENCY = 3;

/** Per-asset outcome reported back to the renderer. Renderer surfaces      */
/** "failed" and "missing" entries in the share toast.                       */
export type AssetMigrationResult =
  | { ref: string; status: 'ok'; uri: string; bytes: number }
  | { ref: string; status: 'missing' }
  | { ref: string; status: 'rejected'; reason: string }
  | { ref: string; status: 'skipped'; reason: string }
  | { ref: string; status: 'failed'; error: string };

// WebSocket proxy: browser WebSocket to sync.nimbalyst.com fails due to
// Cloudflare proxy configuration. We create WebSockets in the main process
// (Node.js) and forward messages to the renderer via IPC.
const proxiedWebSockets = new Map<string, WebSocket>();
let wsIdCounter = 0;

function getCollabPendingKey(orgId: string, documentId: string): string {
  return `org:${orgId}:doc:${documentId}`;
}

function assertReplicaAccount(requestedAccountId: string): void {
  if (process.env.PLAYWRIGHT === '1') return;
  const activeAccountId = getPersonalUserId() ?? getStytchUserId();
  if (!activeAccountId || requestedAccountId !== activeAccountId) {
    throw new Error('Local replica account does not match the active account');
  }
}

function assertReplicaAccess(identity: LocalReplicaIdentity): void {
  assertReplicaAccount(identity.accountId);
}

/**
 * Track WebContents we've already attached a destroyed listener to, so
 * opening multiple docs in the same window doesn't stack N listeners
 * (and trigger Node's MaxListenersExceededWarning at 10+ docs).
 */
const senderDestroyedHooked = new Set<number>();

/**
 * Return only the legacy org-key epochs already persisted on this device.
 *
 * Server-managed collaboration must never put the retired ECDH envelope API
 * on the document-open critical path. Pre-migration rows are a best-effort
 * recovery concern: devices may contribute whatever current/archived epochs
 * they already hold, while current server-managed rows need no client key.
 */
async function getLocalLegacyOrgKeysBase64(orgId: string): Promise<string[]> {
  const keys: string[] = [];
  const seen = new Set<string>();
  const current = await getOrgKey(orgId);
  if (current) {
    const raw = Buffer.from(await crypto.subtle.exportKey('raw', current)).toString('base64');
    seen.add(raw);
    keys.push(raw);
  }
  for (const archived of getArchivedOrgKeys(orgId)) {
    if (!seen.has(archived.rawKeyBase64)) {
      seen.add(archived.rawKeyBase64);
      keys.push(archived.rawKeyBase64);
    }
  }
  return keys;
}

// Single-flight + TTL cache for the org-key-fingerprint verify call.
// The fingerprint endpoint is per-org, not per-document, so one check
// per org per short window is enough. Without this, opening N tracker
// bodies in parallel at startup fires N HTTPS calls that saturate
// Node's HTTPS agent socket pool and produce a multi-minute event-loop
// block (user report 2026-06-01: 162-second beachball on a workspace
// with ~14 restored tracker tabs + a 50-item prewarm).
type FingerprintVerifyResult = { ok: true } | { ok: false; error: string };
const fingerprintVerifyCache: Map<string, { promise: Promise<FingerprintVerifyResult>; expiresAt: number }> = new Map();
const FINGERPRINT_VERIFY_TTL_MS = 60_000;

/** Drop the verify cache for an org (or all orgs). Called by key rotation. */
export function invalidateFingerprintVerifyCache(orgId?: string): void {
  if (orgId) fingerprintVerifyCache.delete(orgId);
  else fingerprintVerifyCache.clear();
}

async function verifyOrgKeyFingerprintCached(orgId: string): Promise<FingerprintVerifyResult> {
  const now = Date.now();
  const cached = fingerprintVerifyCache.get(orgId);
  if (cached && cached.expiresAt > now) return cached.promise;

  const promise: Promise<FingerprintVerifyResult> = (async () => {
    const localFingerprint = getOrgKeyFingerprint(orgId);
    if (!localFingerprint) return { ok: true };
    try {
      const orgJwt = await getOrgScopedJwt(orgId);
      const serverUrl = getCollabSyncHttpUrl();
      const fpResp = await net.fetch(`${serverUrl}/api/teams/${orgId}/org-key-fingerprint`, {
        headers: { 'Authorization': `Bearer ${orgJwt}` },
      });
      if (!fpResp.ok) return { ok: true };
      const fpData = await fpResp.json() as { fingerprint: string | null };
      if (fpData.fingerprint && fpData.fingerprint !== localFingerprint) {
        logger.main.warn('[DocumentSyncHandlers] Stale key detected!', {
          local: localFingerprint.slice(0, 12),
          server: fpData.fingerprint.slice(0, 12),
        });
        clearOrgKey(orgId);
        const freshOrgJwt = await getOrgScopedJwt(orgId);
        const refreshed = await fetchAndUnwrapOrgKey(orgId, freshOrgJwt);
        if (!refreshed) {
          return { ok: false, error: 'Key rotation occurred. Unable to fetch new encryption key.' };
        }
      }
      return { ok: true };
    } catch (err) {
      logger.main.error('[DocumentSyncHandlers] Failed to verify key fingerprint against server:', err);
      return { ok: false, error: 'Cannot verify encryption key epoch against server. Check your network connection and try again.' };
    }
  })();

  fingerprintVerifyCache.set(orgId, { promise, expiresAt: now + FINGERPRINT_VERIFY_TTL_MS });
  // Drop cache on failure so a transient network blip doesn't pin a sad
  // result for the full TTL window.
  void promise.then((result) => {
    if (!result.ok) {
      const entry = fingerprintVerifyCache.get(orgId);
      if (entry?.promise === promise) fingerprintVerifyCache.delete(orgId);
    }
  });

  return promise;
}

/** Build a human-readable display name from Stytch user data. Falls back to email, then userId. */
function getUserDisplayName(userId: string): string {
  const auth = getAuthState();
  const parts = [auth.user?.name?.first_name, auth.user?.name?.last_name].filter(Boolean);
  if (parts.length > 0) return parts.join(' ');
  return getUserEmail() || userId;
}

export function registerDocumentSyncHandlers(): void {
  /**
   * Resolve all config needed to open a collaborative document.
   * Returns the org key as raw base64 (renderer reconstructs CryptoKey).
   *
   * Payload: { workspacePath: string; documentId: string; title?: string }
   * Returns: { success: true, config: { orgId, documentId, title, orgKeyBase64, serverUrl, userId } }
   *       | { success: false, error: string }
   */
  safeHandle('document-sync:open', async (event, payload: {
    workspacePath: string;
    documentId: string;
    title?: string;
    documentType?: string;
  }) => {
    // Phase timing. safeHandle already emits IpcSlow when the whole call
    // exceeds 1s, but doesn't say WHICH sub-step (team lookup vs envelope
    // fetch vs fingerprint check) ate the budget. The shortDocId tag lets
    // us correlate phases across the many document-sync:open calls that
    // fire at startup when restoring open tabs.
    const handlerStart = Date.now();
    const shortDocId = payload.documentId?.slice(0, 8) ?? '?';
    const logPhase = (phase: string, since: number) => {
      const ms = Date.now() - since;
      if (ms >= 200) {
        logger.main.info(`[DocumentSyncHandlers] open(${shortDocId}) ${phase}: ${ms}ms`);
      }
    };

    if (!isAuthenticated()) {
      return { success: false, error: 'Not authenticated. Sign in first.' };
    }

    const userId = getStytchUserId();
    if (!userId) {
      return { success: false, error: 'No user ID available.' };
    }

    // Find team for workspace
    const teamStart = Date.now();
    const team = await findTeamForWorkspace(payload.workspacePath);
    logPhase('findTeamForWorkspace', teamStart);
    if (!team) {
      return { success: false, error: 'No team found for this workspace. Create or join a team first.' };
    }
    const orgId = team.orgId;

    // Epic H2: decide the key-custody lane before touching the ECDH envelope
    // path. In server-managed mode the server holds the per-team DEK and the
    // doc syncs PLAINTEXT, so no org key is fetched or required.
    let serverManaged = false;
    try {
      const orgJwt = await getOrgScopedJwt(orgId);
      serverManaged = (await fetchTeamKeyStatus(orgId, orgJwt)).mode === 'server-managed';
    } catch (err) {
      // Offline JWT mint failure (NIM-1778): fall back to the last-known mode
      // instead of assuming legacy-e2e, which bricks a server-managed team.
      serverManaged = getLastKnownTeamKeyStatus(orgId)?.mode === 'server-managed';
      logger.main.warn('[DocumentSyncHandlers] key-status resolve failed; using last-known mode (serverManaged:', serverManaged, '):', err);
    }

    // Get org encryption key (legacy mode only).
    const keyStart = Date.now();
    let orgKeyBase64 = '';
    let orgKeyFp: string | undefined;
    // NIM-878/959: every candidate legacy org-key epoch for reading PRE-MIGRATION
    // rows in server-managed mode (rows written before the flip are still AES-
    // ciphertext, and may span multiple epochs if the org key was rotated while
    // the team was still legacy-e2e).
    const legacyOrgKeysBase64: string[] = [];
    if (!serverManaged) {
      let encryptionKey = await getOrgKey(orgId);
      if (!encryptionKey) {
        logger.main.info('[DocumentSyncHandlers] No org key cached, attempting to fetch envelope...');
        try {
          const orgJwt = await getOrgScopedJwt(orgId);
          await getOrCreateIdentityKeyPair();
          await uploadIdentityKeyToOrg(orgJwt);
          encryptionKey = await fetchAndUnwrapOrgKey(orgId, orgJwt);
        } catch (err) {
          logger.main.warn('[DocumentSyncHandlers] Failed to fetch org key envelope:', err);
        }
        if (!encryptionKey) {
          return { success: false, error: 'No encryption key available. Team admin may need to re-share keys.' };
        }
      }
      logPhase('getOrgKey/fetchEnvelope', keyStart);

      // Verify local key fingerprint against server to detect stale keys.
      // Single-flight + 60s TTL per orgId; see verifyOrgKeyFingerprintCached.
      const fpStart = Date.now();
      const fpResult = await verifyOrgKeyFingerprintCached(orgId);
      logPhase('verifyFingerprint', fpStart);
      if (!fpResult.ok) return { success: false, error: fpResult.error };
      // Re-read the key in case the cached verify rotated it for this org.
      encryptionKey = await getOrgKey(orgId);
      if (!encryptionKey) {
        return { success: false, error: 'No encryption key available.' };
      }

      // Export key as raw base64 for renderer to reconstruct
      const rawBytes = await crypto.subtle.exportKey('raw', encryptionKey);
      orgKeyBase64 = Buffer.from(rawBytes).toString('base64');
      orgKeyFp = getOrgKeyFingerprint(orgId) ?? undefined;
    } else {
      // logger.main.info('[DocumentSyncHandlers] team', orgId, 'is server-managed; skipping ECDH org-key unwrap');
      // NIM-878/959: documents created before this team migrated to server-
      // managed still have legacy-e2e AES-ciphertext rows on the server (passed
      // through with their original iv), and those rows may span multiple org-
      // key epochs if the key was rotated while the team was still legacy-e2e.
      // Gather only epochs already stored on this device. Do not refresh the
      // retired ECDH envelope here: current server-managed rows need no client
      // key, and a recovery-only network call must not delay every doc open.
      try {
        legacyOrgKeysBase64.push(...await getLocalLegacyOrgKeysBase64(orgId));
      } catch (err) {
        logger.main.info('[DocumentSyncHandlers] no legacy org keys for server-managed migration read (pre-migration rows may not load):', err);
      }
      logPhase('getLocalLegacyKeys', keyStart);
      // logger.main.info('[DocumentSyncHandlers] doc server-managed legacy key epochs available:', legacyOrgKeysBase64.length);
    }
    logPhase('total', handlerStart);

    const serverUrl = getCollabSyncWsUrl();
    const workspaceState = getWorkspaceState(payload.workspacePath);
    const pendingKey = getCollabPendingKey(orgId, payload.documentId);
    let pendingUpdateBase64 = workspaceState
      .collabPendingUpdates?.[pendingKey]?.mergedUpdateBase64;

    // Defensive: if the caller didn't pass documentType, fall back to the
    // renderer-persisted entry list. Some restore paths only know the
    // documentId; without a resolved documentType, CollaborativeTabEditor
    // renders shared docs through the markdown branch and Excalidraw /
    // mockup Y.Docs come back blank.
    const resolvedDocumentType = resolveCollabDocumentType({
      callerDocumentType: payload.documentType,
      workspaceState: workspaceState as unknown as { openCollabDocumentEntries?: unknown },
      documentId: payload.documentId,
    });

    const accountId = getPersonalUserId() ?? userId;
    if (pendingUpdateBase64) {
      try {
        const legacyUpdateCommitted = await getCollabDocumentReplicaStore().migrateLegacyPendingUpdate(
          { accountId, orgId, documentId: payload.documentId },
          resolvedDocumentType ?? 'markdown',
          Buffer.from(pendingUpdateBase64, 'base64'),
        );
        if (legacyUpdateCommitted) {
          updateWorkspaceState(payload.workspacePath, state => {
            delete state.collabPendingUpdates?.[pendingKey];
          });
          pendingUpdateBase64 = undefined;
        }
      } catch (error) {
        logger.main.error('[DocumentSyncHandlers] Failed to migrate legacy pending update:', error);
      }
    }

    // logger.main.info('[DocumentSyncHandlers] Resolved collab config', {
    //   orgId,
    //   documentId: payload.documentId,
    //   serverUrl,
    //   userId,
    // });

    // Authorize THIS renderer (webContents) to load this doc's encrypted
    // assets via collab-asset:// and to invoke upload-asset / gc-assets
    // for this doc. Refcounted per-sender -- close-doc on tab unmount
    // decrements. The sender scoping prevents window B from operating on
    // a doc only window A has opened.
    const senderId = event.sender.id;
    registerCollabAssetDocument(orgId, payload.documentId, senderId);

    // Drop all of this sender's registrations when the WebContents goes
    // away (window close, crash, navigation away). Attach the listener
    // once per WebContents -- otherwise opening many docs in the same
    // window stacks N identical listeners.
    if (!event.sender.isDestroyed() && !senderDestroyedHooked.has(senderId)) {
      senderDestroyedHooked.add(senderId);
      event.sender.once('destroyed', () => {
        senderDestroyedHooked.delete(senderId);
        clearCollabAssetSender(senderId);
        getCollabOutboxDrainCoordinator().clearSender(senderId);
      });
    }

    return {
      success: true,
      config: {
        orgId,
        documentId: payload.documentId,
        title: payload.title || payload.documentId,
        documentType: resolvedDocumentType,
        keyCustody: serverManaged ? 'server-managed' : 'legacy-e2e',
        orgKeyBase64,
        // NIM-959: all candidate legacy epochs; keep the singular field for
        // back-compat with any caller still reading it (first epoch).
        legacyOrgKeyBase64: legacyOrgKeysBase64[0] ?? '',
        legacyOrgKeysBase64,
        orgKeyFingerprint: orgKeyFp,
        serverUrl,
        accountId,
        userId,
        userName: getUserDisplayName(userId),
        userEmail: getUserEmail() || undefined,
        pendingUpdateBase64,
      },
    };
  });

  /**
   * Renderer signals that a collab tab is unmounting. Decrement THIS
   * sender's collab-asset:// registry refcount.
   */
  safeHandle('document-sync:close-doc', async (event, payload: { documentId: string }) => {
    if (!payload?.documentId) {
      return { success: false, error: 'documentId required' };
    }
    unregisterCollabAssetDocument(payload.documentId, event.sender.id);
    return { success: true };
  });

  /**
   * Encrypt a file and PUT it to the collab worker as a new asset.
   * Routed through main because the renderer's origin is blocked by the
   * worker's CORS allowlist. Authorized per-sender: a renderer can only
   * upload for a doc that THIS WebContents has opened, even if another
   * window in the same process has it open too.
   */
  safeHandle('document-sync:upload-asset', async (event, payload: {
    orgId: string;
    documentId: string;
    fileBytes: ArrayBuffer;
    mimeType: string;
    fileName: string;
  }) => {
    if (!isAuthenticated()) {
      return { success: false, error: 'Not authenticated' };
    }
    if (!payload?.orgId || !payload?.documentId || !payload.fileBytes) {
      return { success: false, error: 'orgId, documentId, and fileBytes required' };
    }
    if (!isCollabAssetDocumentRegisteredForSender(event.sender.id, payload.orgId, payload.documentId)) {
      return { success: false, error: 'Document not open in this window' };
    }

    const accountId = getPersonalUserId();
    if (!accountId) {
      return { success: false, error: 'Local account identity unavailable' };
    }
    const assetId = randomUUID();
    await getCollabAssetStore().enqueueUpload({
      identity: {
        accountId,
        orgId: payload.orgId,
        documentId: payload.documentId,
        assetId,
      },
      bytes: new Uint8Array(payload.fileBytes),
      mimeType: payload.mimeType || 'application/octet-stream',
      fileName: payload.fileName || assetId,
    });
    // The URI is usable from the local cache immediately. Network upload is
    // deliberately detached so the body edit that references it never waits.
    getCollabAssetOutboxDrainCoordinator().trigger('asset-enqueued');
    return {
      success: true,
      assetId,
      uri: `collab-asset://doc/${encodeURIComponent(payload.documentId)}/asset/${encodeURIComponent(assetId)}`,
      queued: true,
    };
  });

  /**
   * Walk a markdown file for local image references, upload each one through
   * the encrypted collab-asset path, and return the rewritten markdown plus
   * a per-asset result list. The "pre-seed migration pass" used by Share to
   * Team so collaborators can actually see the originator's pasted images.
   *
   * Sender authorization: identical to `upload-asset` -- the requesting
   * WebContents must have called `document-sync:open` for this doc first.
   */
  safeHandle('document-sync:migrate-local-assets', async (event, payload: {
    workspacePath: string;
    orgId: string;
    documentId: string;
    sourceFilePath: string;
    markdown: string;
  }) => {
    if (!isAuthenticated()) {
      return { success: false, error: 'Not authenticated' };
    }
    if (!payload?.workspacePath || !payload?.orgId || !payload?.documentId
        || !payload?.sourceFilePath || typeof payload.markdown !== 'string') {
      return {
        success: false,
        error: 'workspacePath, orgId, documentId, sourceFilePath, and markdown required',
      };
    }
    if (!isCollabAssetDocumentRegisteredForSender(event.sender.id, payload.orgId, payload.documentId)) {
      return { success: false, error: 'Document not open in this window' };
    }

    const refs = scanMarkdownImageRefs(payload.markdown);
    if (refs.length === 0) {
      return {
        success: true,
        rewrittenMarkdown: payload.markdown,
        results: [] as AssetMigrationResult[],
      };
    }

    const syncHttpUrl = getCollabSyncHttpUrl();
    const results: AssetMigrationResult[] = new Array(refs.length);
    const substitutions = new Map<string, string>();

    async function processRef(index: number): Promise<void> {
      const ref = refs[index];
      const resolution = resolveAssetRef(ref, payload.sourceFilePath, payload.workspacePath);

      if (resolution.kind === 'skip') {
        results[index] = { ref, status: 'skipped', reason: resolution.reason };
        return;
      }
      if (resolution.kind === 'rejected') {
        results[index] = { ref, status: 'rejected', reason: resolution.reason };
        return;
      }

      let bytes: Buffer;
      try {
        bytes = await fs.readFile(resolution.absolutePath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') {
          results[index] = { ref, status: 'missing' };
        } else {
          results[index] = {
            ref,
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          };
        }
        return;
      }

      // Slice into an ArrayBuffer view so we hand the encrypt path a stable
      // backing buffer that exactly matches the file bytes (Node Buffers can
      // share a larger pool-allocated backing store).
      const arrayBuffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;

      const upload = await encryptAndUploadCollabAsset({
        orgId: payload.orgId,
        documentId: payload.documentId,
        fileBytes: arrayBuffer,
        mimeType: resolution.mimeType,
        fileName: resolution.fileName,
        syncHttpUrl,
      });

      if (!upload.success) {
        results[index] = { ref, status: 'failed', error: upload.error };
        return;
      }

      substitutions.set(ref, upload.uri);
      results[index] = {
        ref,
        status: 'ok',
        uri: upload.uri,
        bytes: bytes.byteLength,
      };
    }

    // Bounded concurrency: pull-from-queue workers so a 50-image share does
    // not fan out 50 simultaneous TLS handshakes against the collab worker.
    let cursor = 0;
    const workers: Promise<void>[] = [];
    const workerCount = Math.min(MIGRATE_UPLOAD_CONCURRENCY, refs.length);
    for (let w = 0; w < workerCount; w++) {
      workers.push((async () => {
        while (true) {
          const i = cursor++;
          if (i >= refs.length) return;
          await processRef(i);
        }
      })());
    }
    await Promise.all(workers);

    const rewrittenMarkdown = rewriteMarkdownImageRefs(payload.markdown, substitutions);
    return { success: true, rewrittenMarkdown, results };
  });

  /**
   * NIM-1683: retained as an inert no-op. This channel used to delete the R2
   * blobs for `collab-asset://` URIs that disappeared from the live editor
   * state. That is data-loss -- an image removed from the current state is
   * still referenced by document revision history and undo / cut-paste, which
   * re-insert the SAME URI. Asset lifetime is now tied to document lifetime;
   * the collab worker reclaims a doc's assets only when the document is
   * deleted. The renderer no longer calls this (see CollaborativeTabEditor),
   * but the handler stays as a safe sink for any stale caller.
   */
  safeHandle('document-sync:gc-assets', async () => {
    return { success: true, requested: 0, deleted: 0, failed: 0, skipped: 0 };
  });


  safeHandle('document-sync:set-pending-update', async (_event, payload: {
    workspacePath: string;
    orgId: string;
    documentId: string;
    pendingUpdateBase64: string | null;
  }) => {
    const pendingKey = getCollabPendingKey(payload.orgId, payload.documentId);
    updateWorkspaceState(payload.workspacePath, state => {
      state.collabPendingUpdates ??= {};
      if (!payload.pendingUpdateBase64) {
        delete state.collabPendingUpdates[pendingKey];
        return;
      }
      state.collabPendingUpdates[pendingKey] = {
        mergedUpdateBase64: payload.pendingUpdateBase64,
        updatedAt: Date.now(),
      };
    });
    return { success: true };
  });

  safeHandle('document-sync:replica-load', async (_event, payload: {
    workspacePath: string;
    identity: LocalReplicaIdentity;
  }) => {
    if (!payload?.workspacePath) throw new Error('document-sync:replica-load requires workspacePath');
    assertReplicaAccess(payload.identity);
    return getCollabDocumentReplicaStore().load(payload.identity);
  });

  safeHandle('document-sync:replica-append-local', async (event, payload: {
    workspacePath: string;
    input: AppendLocalReplicaUpdateInput;
  }) => {
    if (!payload?.workspacePath) throw new Error('document-sync:replica-append-local requires workspacePath');
    assertReplicaAccess(payload.input.identity);
    const replicaStore = getCollabDocumentReplicaStore();
    const drainCoordinator = getCollabOutboxDrainCoordinator();
    await replicaStore.prepareForAppend(
      payload.input.identity.accountId,
      replicaStore.estimateLocalAppendBytes(payload.input),
      (identity) => drainCoordinator.isProviderAttached(identity),
    );
    await replicaStore.appendLocalUpdate(payload.input);
    const siblingSenderIds = new Set(
      drainCoordinator.getAttachedSenderIds(
        payload.input.identity,
        event.sender.id,
      ),
    );
    for (const window of BrowserWindow.getAllWindows()) {
      if (
        siblingSenderIds.has(window.webContents.id) &&
        !window.webContents.isDestroyed()
      ) {
        window.webContents.send('document-sync:replica-local-update', {
          identity: payload.input.identity,
          updateId: payload.input.updateId,
          update: payload.input.update,
        });
      }
    }
  });

  safeHandle('document-sync:replica-append-remote', async (_event, payload: {
    workspacePath: string;
    input: AppendRemoteReplicaUpdatesInput;
  }) => {
    if (!payload?.workspacePath) throw new Error('document-sync:replica-append-remote requires workspacePath');
    assertReplicaAccess(payload.input.identity);
    const replicaStore = getCollabDocumentReplicaStore();
    const drainCoordinator = getCollabOutboxDrainCoordinator();
    await replicaStore.prepareForAppend(
      payload.input.identity.accountId,
      replicaStore.estimateRemoteAppendBytes(payload.input),
      (identity) => drainCoordinator.isProviderAttached(identity),
    );
    await replicaStore.appendRemoteUpdates(payload.input);
  });

  safeHandle('document-sync:replica-set-outbox-state', async (_event, payload: {
    workspacePath: string;
    identity: LocalReplicaIdentity;
    batchIds: string[];
    state: LocalReplicaOutboxState;
    lastErrorCode?: string | null;
  }) => {
    if (!payload?.workspacePath) throw new Error('document-sync:replica-set-outbox-state requires workspacePath');
    assertReplicaAccess(payload.identity);
    await getCollabDocumentReplicaStore().setOutboxState(
      payload.identity,
      payload.batchIds,
      payload.state,
      payload.lastErrorCode,
    );
  });

  safeHandle('document-sync:replica-claim-outbox', async (_event, payload: {
    workspacePath: string;
    identity: LocalReplicaIdentity;
    batchIds: string[];
  }) => {
    if (!payload?.workspacePath) throw new Error('document-sync:replica-claim-outbox requires workspacePath');
    assertReplicaAccess(payload.identity);
    return getCollabDocumentReplicaStore().claimOutboxBatch(
      payload.identity,
      payload.batchIds,
    );
  });

  safeHandle('document-sync:replica-load-outbox', async (_event, payload: {
    workspacePath: string;
    identity: LocalReplicaIdentity;
  }) => {
    if (!payload?.workspacePath) throw new Error('document-sync:replica-load-outbox requires workspacePath');
    assertReplicaAccess(payload.identity);
    return getCollabDocumentReplicaStore().loadOutbox(payload.identity);
  });

  safeHandle('document-sync:replica-record-outbox-error', async (_event, payload: {
    workspacePath: string;
    identity: LocalReplicaIdentity;
    batchIds: string[];
    errorCode: string;
  }) => {
    if (!payload?.workspacePath) throw new Error('document-sync:replica-record-outbox-error requires workspacePath');
    assertReplicaAccess(payload.identity);
    await getCollabDocumentReplicaStore().recordOutboxError(
      payload.identity,
      payload.batchIds,
      payload.errorCode,
    );
  });

  safeHandle('document-sync:replica-ack-outbox', async (_event, payload: {
    workspacePath: string;
    identity: LocalReplicaIdentity;
    batchIds: string[];
    serverSequence: number;
  }) => {
    if (!payload?.workspacePath) throw new Error('document-sync:replica-ack-outbox requires workspacePath');
    assertReplicaAccess(payload.identity);
    await getCollabDocumentReplicaStore().acknowledgeOutbox(
      payload.identity,
      payload.batchIds,
      payload.serverSequence,
    );
  });

  safeHandle('document-sync:replica-replace-snapshot', async (_event, payload: {
    workspacePath: string;
    input: ReplaceLocalReplicaSnapshotInput;
  }) => {
    if (!payload?.workspacePath) throw new Error('document-sync:replica-replace-snapshot requires workspacePath');
    assertReplicaAccess(payload.input.identity);
    return getCollabDocumentReplicaStore().replaceSnapshot(payload.input);
  });

  safeHandle('document-sync:replica-mark-incomplete', async (_event, payload: {
    workspacePath: string;
    identity: LocalReplicaIdentity;
  }) => {
    if (!payload?.workspacePath) throw new Error('document-sync:replica-mark-incomplete requires workspacePath');
    assertReplicaAccess(payload.identity);
    await getCollabDocumentReplicaStore().markIncomplete(payload.identity);
  });

  safeHandle('document-sync:replica-mark-complete', async (_event, payload: {
    workspacePath: string;
    identity: LocalReplicaIdentity;
  }) => {
    if (!payload?.workspacePath) throw new Error('document-sync:replica-mark-complete requires workspacePath');
    assertReplicaAccess(payload.identity);
    await getCollabDocumentReplicaStore().markComplete(payload.identity);
  });

  safeHandle('document-sync:replica-quarantine', async (_event, payload: {
    workspacePath: string;
    identity: LocalReplicaIdentity;
    reason: string;
  }) => {
    if (!payload?.workspacePath) throw new Error('document-sync:replica-quarantine requires workspacePath');
    assertReplicaAccess(payload.identity);
    await getCollabDocumentReplicaStore().quarantine(payload.identity, payload.reason);
  });

  safeHandle('document-sync:replica-reset-clean-hydration', async (_event, payload: {
    workspacePath: string;
    identity: LocalReplicaIdentity;
  }) => {
    if (!payload?.workspacePath) throw new Error('document-sync:replica-reset-clean-hydration requires workspacePath');
    assertReplicaAccess(payload.identity);
    await getCollabDocumentReplicaStore().resetForCleanHydration(payload.identity);
  });

  safeHandle('document-sync:replica-discard', async (_event, payload: {
    workspacePath: string;
    identity: LocalReplicaIdentity;
  }) => {
    if (!payload?.workspacePath) throw new Error('document-sync:replica-discard requires workspacePath');
    assertReplicaAccess(payload.identity);
    await getCollabDocumentReplicaStore().discard(payload.identity);
  });

  safeHandle('document-sync:replica-purge-account', async (_event, payload: {
    workspacePath: string;
    accountId: string;
  }) => {
    if (!payload?.workspacePath) throw new Error('document-sync:replica-purge-account requires workspacePath');
    assertReplicaAccount(payload.accountId);
    await getCollabDocumentReplicaStore().purgeByAccount(payload.accountId);
  });

  safeHandle('document-sync:replica-purge-org', async (_event, payload: {
    workspacePath: string;
    accountId: string;
    orgId: string;
  }) => {
    if (!payload?.workspacePath) throw new Error('document-sync:replica-purge-org requires workspacePath');
    assertReplicaAccount(payload.accountId);
    await getCollabDocumentReplicaStore().purgeByOrg(payload.accountId, payload.orgId);
  });

  safeHandle('document-sync:replica-storage-usage', async (_event, payload: {
    workspacePath: string;
    accountId: string;
  }) => {
    if (!payload?.workspacePath) throw new Error('document-sync:replica-storage-usage requires workspacePath');
    assertReplicaAccount(payload.accountId);
    return getCollabDocumentReplicaStore().getStorageUsage(payload.accountId);
  });

  safeHandle('document-sync:replica-list-pending-outboxes', async (_event, payload: {
    workspacePath: string;
    accountId?: string;
  }) => {
    if (!payload?.workspacePath) throw new Error('document-sync:replica-list-pending-outboxes requires workspacePath');
    const accountId = payload.accountId ?? getPersonalUserId() ?? getStytchUserId();
    if (!accountId) {
      throw new Error('Local replica account identity is unavailable');
    }
    assertReplicaAccount(accountId);
    return getCollabDocumentReplicaStore().listPendingOutboxes(accountId);
  });

  safeHandle('document-sync:replica-provider-attached', async (event, payload: {
    identity: LocalReplicaIdentity;
    attachmentId: string;
    attached: boolean;
  }) => {
    // Detach must remain best-effort after logout; it only removes this
    // renderer's ownership claim and must never leave the coordinator stuck.
    if (!payload.attachmentId) {
      throw new Error('document-sync:replica-provider-attached requires attachmentId');
    }
    if (payload.attached) assertReplicaAccess(payload.identity);
    await getCollabOutboxDrainCoordinator().setProviderAttached(
      event.sender.id,
      payload.identity,
      payload.attachmentId,
      payload.attached,
    );
  });

  safeHandle('document-sync:seed-shared-document', async (_event, payload: {
    workspacePath: string;
    documentId: string;
    documentType: string;
    content: string;
  }) => {
    try {
      const ok = await seedSharedDocumentFromContent(payload);
      return { success: ok };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  safeHandle('document-sync:get-local-origin', async (_event, payload: {
    workspacePath: string;
    documentId: string;
  }) => {
    try {
      const binding = await getLocalOriginBinding(payload.workspacePath, payload.documentId);
      return { success: true, binding };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  safeHandle('document-sync:save-local-origin', async (_event, payload: {
    workspacePath: string;
    documentId: string;
    documentType: string;
    sourceFilePath: string;
    lastLocalContentHash: string | null;
    lastCollabContentHash: string | null;
  }) => {
    try {
      const binding = await recordLocalOriginShare(payload);
      return { success: true, binding };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  safeHandle('document-sync:relink-local-origin', async (_event, payload: {
    workspacePath: string;
    documentId: string;
    documentType: string;
    sourceFilePath: string;
  }) => {
    try {
      const binding = await relinkLocalOriginBinding(payload);
      return { success: true, binding };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  safeHandle('document-sync:clear-local-origin', async (_event, payload: {
    workspacePath: string;
    documentId: string;
  }) => {
    try {
      await clearLocalOriginBinding(payload.workspacePath, payload.documentId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  safeHandle('document-sync:reupload-local-origin', async (_event, payload: {
    workspacePath: string;
    documentId: string;
    forceOverwriteShared?: boolean;
  }) => {
    try {
      return await reuploadFromLocalOrigin(payload);
    } catch (err) {
      return {
        success: false,
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  safeHandle('document-sync:find-local-origin-link', async (_event, payload: {
    workspacePath: string;
    sourceFilePath: string;
  }) => {
    try {
      const binding = await findLinkedDocumentForLocalPath(payload.workspacePath, payload.sourceFilePath);
      return { success: true, binding };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /**
   * Get a fresh org-scoped JWT for an org.
   * Called by the renderer's getJwt() callback during WebSocket reconnects.
   */
  safeHandle('document-sync:get-jwt', async (_event, payload: { orgId: string; forceRefresh?: boolean }) => {
    try {
      // NIM-949: forceRefresh bypasses the org-JWT cache so a reconnect after an
      // auth-style rejection re-exchanges instead of replaying a rejected token.
      const jwt = await getOrgScopedJwt(payload.orgId, undefined, payload.forceRefresh);
      return { success: true, jwt };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // --------------------------------------------------------------------------
  // WebSocket Proxy
  //
  // Cloudflare's proxy blocks WebSocket upgrades from browser/Chromium clients
  // but allows them from Node.js. Session sync works because SyncManager runs
  // in the main process; document sync runs in the renderer (Chromium).
  // We proxy WebSocket connections through the main process via IPC.
  // --------------------------------------------------------------------------

  /**
   * Create a proxied WebSocket connection in the main process.
   * Returns a unique wsId the renderer uses to send/receive on this socket.
   */
  safeHandle('document-sync:ws-connect', async (event, payload: { url: string }) => {
    const wsId = `ws-proxy-${++wsIdCounter}`;
    const webContents = event.sender;

    // logger.main.info('[DocumentSyncHandlers] WS proxy connect', { wsId, url: payload.url.replace(/token=[^&]+/, 'token=<redacted>') });

    // Safe send: guard against webContents being destroyed (e.g., window closed)
    function safeSend(data: Record<string, unknown>): void {
      try {
        if (!webContents.isDestroyed()) {
          webContents.send('document-sync:ws-event', data);
        }
      } catch {
        // Window destroyed between check and send -- ignore
      }
    }

    // NIM-949: decode the room org + the presented token so a rejected upgrade
    // (HTTP 400) reports *why* instead of just "Unexpected server response: 400".
    let roomOrgId: string | null = null;
    let tokenOrgId: string | null = null;
    let tokenExp: number | null = null;
    try {
      const parsed = new URL(payload.url);
      const roomMatch = parsed.pathname.match(/org:([^:]+):doc:/);
      roomOrgId = roomMatch ? roomMatch[1] : null;
      const token = parsed.searchParams.get('token');
      if (token) {
        tokenOrgId = getOrgIdFromJwt(token);
        tokenExp = getJwtExp(token);
      }
    } catch {
      // best-effort diagnostics only
    }

    try {
      const ws = new WebSocket(payload.url);
      proxiedWebSockets.set(wsId, ws);

      ws.on('open', () => {
        // logger.main.info('[DocumentSyncHandlers] WS proxy open', { wsId });
        safeSend({ wsId, type: 'open' });
      });

      ws.on('message', (data: WebSocket.Data) => {
        // Forward as string (our protocol is JSON text)
        const msg = typeof data === 'string' ? data : data.toString();
        safeSend({ wsId, type: 'message', data: msg });
      });

      // NIM-949: the server rejected the upgrade with a non-101 status (e.g. 400
      // for a wrong-org / expired token). The `ws` 'error' event only carries
      // "Unexpected server response: <status>"; read the body here, log the auth
      // context, and forward the status so the client can force a fresh JWT.
      ws.on('unexpected-response', (_req, res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString().slice(0, 512);
          const orgMismatch = !!roomOrgId && !!tokenOrgId && roomOrgId !== tokenOrgId;
          logger.main.warn('[DocumentSyncHandlers] WS proxy upgrade rejected', {
            wsId,
            status,
            roomOrgId,
            tokenOrgId,
            tokenExp,
            orgMismatch,
            expired: tokenExp ? tokenExp * 1000 < Date.now() : null,
            body,
          });
          safeSend({ wsId, type: 'unexpected-response', status, roomOrgId, tokenOrgId });
          // Surface as a close so the client's reconnect path runs. The reason
          // encodes the auth status so DocumentSync can force a JWT refresh.
          safeSend({ wsId, type: 'close', code: 1006, reason: `auth-rejected:${status}` });
          proxiedWebSockets.delete(wsId);
          try { ws.terminate(); } catch { /* already closed */ }
        });
      });

      ws.on('close', (code: number, reason: Buffer) => {
        // logger.main.info('[DocumentSyncHandlers] WS proxy close', { wsId, code, reason: reason.toString() });
        safeSend({ wsId, type: 'close', code, reason: reason.toString() });
        proxiedWebSockets.delete(wsId);
      });

      ws.on('error', (err: Error) => {
        logger.main.warn('[DocumentSyncHandlers] WS proxy error', { wsId, error: err.message });
        safeSend({ wsId, type: 'error', error: err.message });
      });

      return { success: true, wsId };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /**
   * Send a message through a proxied WebSocket.
   */
  safeHandle('document-sync:ws-send', async (_event, payload: { wsId: string; data: string }) => {
    const ws = proxiedWebSockets.get(payload.wsId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return { success: false, error: 'WebSocket not open' };
    }
    ws.send(payload.data);
    return { success: true };
  });

  /**
   * Close a proxied WebSocket.
   */
  safeHandle('document-sync:ws-close', async (_event, payload: { wsId: string }) => {
    const ws = proxiedWebSockets.get(payload.wsId);
    if (ws) {
      ws.close();
      proxiedWebSockets.delete(payload.wsId);
    }
    return { success: true };
  });

  /**
   * Resolve config needed to connect to the org's TeamRoom.
   * Returns orgId, orgKeyBase64, serverUrl, userId -- the renderer
   * creates and manages the TeamSyncProvider instance itself.
   *
   * Payload: { workspacePath: string }
   * Returns: { success: true, config: { orgId, orgKeyBase64, serverUrl, userId } }
   *       | { success: false, error: string }
   */
  async function resolveIndexConfig(payload: {
    workspacePath: string;
  }) {
    if (!isAuthenticated()) {
      return { success: false, error: 'Not authenticated. Sign in first.' };
    }

    const userId = getStytchUserId();
    if (!userId) {
      return { success: false, error: 'No user ID available.' };
    }

    const team = await findTeamForWorkspace(payload.workspacePath);
    if (!team) {
      return { success: false, error: 'No team found for this workspace.' };
    }
    const orgId = team.orgId;

    // Epic H2: server-managed teams sync doc-index titles as PLAINTEXT (the
    // server encrypts at rest with the team DEK), so no org key is needed.
    let serverManaged = false;
    try {
      const orgJwt = await getOrgScopedJwt(orgId);
      serverManaged = (await fetchTeamKeyStatus(orgId, orgJwt)).mode === 'server-managed';
    } catch (err) {
      // Offline JWT mint failure (NIM-1778): fall back to the last-known mode
      // instead of assuming legacy-e2e -- the wrong lane makes every doc-index
      // title fail decrypt and surface as locked until restart.
      serverManaged = getLastKnownTeamKeyStatus(orgId)?.mode === 'server-managed';
      logger.main.warn('[DocumentSyncHandlers] index key-status resolve failed; using last-known mode (serverManaged:', serverManaged, '):', err);
    }

    let orgKeyBase64 = '';
    let orgKeyFingerprint: string | null = null;
    // NIM-906/910: legacy org keys for reading PRE-MIGRATION doc-index TITLE
    // rows in server-managed mode (titles written before the flip are still AES
    // ciphertext, passed through by the server with their original iv). The org
    // key may have ROTATED while the team was legacy-e2e, so titles can be under
    // different epochs — we pass ALL candidate epochs (current + archived).
    const legacyOrgKeysBase64: string[] = [];
    if (!serverManaged) {
      let encryptionKey = await getOrgKey(orgId);
      if (!encryptionKey) {
        logger.main.info('[DocumentSyncHandlers] No org key cached for index, attempting to fetch envelope...');
        try {
          const orgJwt = await getOrgScopedJwt(orgId);
          await getOrCreateIdentityKeyPair();
          await uploadIdentityKeyToOrg(orgJwt);
          encryptionKey = await fetchAndUnwrapOrgKey(orgId, orgJwt);
        } catch (err) {
          logger.main.warn('[DocumentSyncHandlers] Failed to fetch org key envelope:', err);
        }
        if (!encryptionKey) {
          return { success: false, error: 'No encryption key available. Team admin may need to re-share keys.' };
        }
      }

      const rawBytes = await crypto.subtle.exportKey('raw', encryptionKey);
      orgKeyBase64 = Buffer.from(rawBytes).toString('base64');
      orgKeyFingerprint = (await getOrgKeyFingerprint(orgId)) ?? null;
    } else {
      // logger.main.info('[DocumentSyncHandlers] index for', orgId, 'is server-managed; skipping ECDH org-key unwrap');
      // Use only keys already persisted on this device. Resolving the current
      // server-managed index must not block on the retired envelope API.
      try {
        legacyOrgKeysBase64.push(...await getLocalLegacyOrgKeysBase64(orgId));
      } catch (err) {
        logger.main.info('[DocumentSyncHandlers] no legacy org keys for server-managed index (pre-migration titles may show as locked):', err);
      }
      // logger.main.info('[DocumentSyncHandlers] index server-managed legacy key epochs available:', legacyOrgKeysBase64.length);
    }
    const serverUrl = getCollabSyncWsUrl();

    // logger.main.info('[DocumentSyncHandlers] Resolved doc index config', { orgId, serverUrl, userId });

    return {
      success: true,
      config: {
        orgId,
        // Epic H3 P0/A: the resolved project's tracker-room routing key. For a
        // workspace matched to a SECONDARY project this is that project's id;
        // the TeamSyncProvider tags every docIndexRegister with it so the
        // server's project-partitioned doc index attributes docs correctly.
        teamProjectId: team.teamProjectId ?? null,
        keyCustody: serverManaged ? 'server-managed' : 'legacy-e2e',
        orgKeyBase64,
        // NIM-906/910: every candidate legacy org-key epoch (current + archived),
        // present only in server-managed mode; empty when none are recoverable.
        legacyOrgKeysBase64,
        orgKeyFingerprint,
        serverUrl,
        userId,
        // Personal org id (stable across team session exchanges) so the
        // TeamSyncProvider can announce it for inbox-event fanout routing.
        personalOrgId: getPersonalOrgId() || undefined,
        userName: getUserDisplayName(userId),
        userEmail: getUserEmail() || undefined,
      },
    };
  }

  // Collapses a burst of concurrent `document-sync:resolve-index-config`
  // calls for the same workspace (initSharedDocuments, tracker sync, collab
  // backup, local-origin service all fan out at startup) into one team-
  // resolve + key-status + org-key-envelope run. collab-open-latency
  // investigation (RC4).
  const resolveIndexConfigSingleFlight = createSingleFlight<string, Awaited<ReturnType<typeof resolveIndexConfig>>>();

  safeHandle('document-sync:resolve-index-config', async (_event, payload: {
    workspacePath: string;
  }) => {
    return resolveIndexConfigSingleFlight(payload.workspacePath, () => resolveIndexConfig(payload));
  });

  // --------------------------------------------------------------------------
  // Personal Document Sync (mobile markdown sync)
  //
  // Uses the same encryption key and personal org as session sync.
  // Documents are identified by syncId stored in frontmatter.
  // --------------------------------------------------------------------------

  /**
   * Check if personal document sync is available for the current user.
   * Returns true if session sync is enabled (which means QR pairing has been done).
   */
  safeHandle('document-sync:is-personal-sync-available', async () => {
    return { available: isSyncEnabled() };
  });

  /**
   * Get the deterministic syncId for a markdown file based on its relative path.
   *
   * Payload: { filePath: string, workspacePath: string }
   * Returns: { success: true, syncId: string } | { success: false, error: string }
   */
  safeHandle('document-sync:get-sync-id', async (_event, payload: { filePath: string; workspacePath: string }) => {
    try {
      const syncId = getSyncId(payload.filePath, payload.workspacePath);
      return { success: true, syncId };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /**
   * Resolve personal document sync config for the renderer.
   * The renderer uses this to create a DocumentSyncProvider for a .md file.
   *
   * Payload: { filePath: string }
   * Returns: { success: true, config: PersonalDocSyncResolvedConfig }
   *        | { success: false, error: string }
   */
  safeHandle('document-sync:resolve-personal-config', async (_event, payload: {
    filePath: string;
    workspacePath: string;
  }) => {
    const syncConfig = getPersonalDocSyncConfig();
    if (!syncConfig) {
      return { success: false, error: 'Personal sync not available. Enable mobile sync first.' };
    }

    try {
      const syncId = getSyncId(payload.filePath, payload.workspacePath);

      // Export the encryption key as raw base64 for the renderer
      const rawBytes = await crypto.subtle.exportKey('raw', syncConfig.encryptionKeyRaw);
      const encryptionKeyBase64 = Buffer.from(rawBytes).toString('base64');

      return {
        success: true,
        config: {
          serverUrl: syncConfig.serverUrl,
          orgId: syncConfig.orgId,
          userId: syncConfig.userId,
          encryptionKeyBase64,
          syncId,
          userName: getUserDisplayName(syncConfig.userId),
        },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /**
   * Get a fresh personal JWT for document sync WebSocket reconnects.
   * Personal docs use the personal JWT (not team JWT).
   */
  safeHandle('document-sync:get-personal-jwt', async () => {
    try {
      const serverUrl = getCollabSyncWsUrl();
      await refreshPersonalSession(serverUrl);
      const jwt = getPersonalSessionJwt();
      if (!jwt) {
        return { success: false, error: 'No personal JWT available' };
      }
      return { success: true, jwt };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  if (process.env.PLAYWRIGHT === '1') {
    safeHandle('document-sync:open-test', async (_event, payload: {
      serverUrl: string;
      orgId: string;
      userId: string;
      documentId: string;
      title?: string;
      encryptionKeyBase64: string;
    }) => {
      try {
        return {
          success: true,
          config: {
            orgId: payload.orgId,
            documentId: payload.documentId,
            title: payload.title || payload.documentId,
            orgKeyBase64: payload.encryptionKeyBase64,
            serverUrl: payload.serverUrl,
            accountId: payload.userId,
            userId: payload.userId,
            userName: 'Test User',
            userEmail: 'test@test.com',
          },
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  /**
   * Save a copy of a shared collab document to disk.
   *
   * The renderer projects the live Y.Doc to bytes via the registered
   * CollabContentAdapter (host knows the layout for this documentType),
   * then hands the bytes to this IPC. Main shows a save dialog and
   * writes the file. Same trust boundary as `share:revealInFinder` --
   * never persists bytes outside the user-chosen path.
   *
   * Payload: { documentType, defaultFileName, bytes }
   * Returns: { success: true, filePath } | { success: false, cancelled?: true, error?: string }
   */
  safeHandle('document-sync:export-to-file', async (event, payload: {
    documentType: string;
    defaultFileName: string;
    fileExtensions?: string[];
    bytes: ArrayBuffer | Uint8Array;
  }) => {
    if (!payload || typeof payload.documentType !== 'string' || typeof payload.defaultFileName !== 'string') {
      return { success: false, error: 'Invalid payload.' };
    }
    if (!payload.bytes) {
      return { success: false, error: 'Missing bytes to write.' };
    }

    const window = BrowserWindow.fromWebContents(event.sender);
    const filterExtensions = (payload.fileExtensions ?? [])
      .map((ext) => (ext.startsWith('.') ? ext.slice(1) : ext))
      .filter((ext) => ext.length > 0);

    const dialogOptions: Electron.SaveDialogOptions = {
      title: 'Save a copy',
      defaultPath: getDialogDefaultPath({ window, explicitPath: payload.defaultFileName }),
      filters: filterExtensions.length > 0
        ? [{ name: payload.documentType, extensions: filterExtensions }]
        : undefined,
    };

    const result = window
      ? await dialog.showSaveDialog(window, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions);

    if (result.canceled || !result.filePath) {
      return { success: false, cancelled: true };
    }

    rememberDialogSelection(result.filePath, 'file');

    try {
      const buffer = payload.bytes instanceof Uint8Array
        ? Buffer.from(payload.bytes)
        : Buffer.from(new Uint8Array(payload.bytes));
      await fs.writeFile(result.filePath, buffer);
      return { success: true, filePath: result.filePath, fileName: path.basename(result.filePath) };
    } catch (err) {
      logger.main.error('[DocumentSync] export-to-file write failed:', err);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
