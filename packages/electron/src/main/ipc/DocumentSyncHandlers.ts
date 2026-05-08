/**
 * DocumentSyncHandlers
 *
 * IPC handlers for collaborative document editing.
 * Resolves auth, encryption keys, and server config from main process
 * services so the renderer can open collab:// tabs.
 */

import { net } from 'electron';
import { randomUUID } from 'crypto';
import { safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import { isAuthenticated, getStytchUserId, getUserEmail, getAuthState, getPersonalSessionJwt, refreshPersonalSession } from '../services/StytchAuthService';
import { findTeamForWorkspace, getOrgScopedJwt } from '../services/TeamService';
import { getOrgKey, getOrgKeyFingerprint, getOrCreateIdentityKeyPair, uploadIdentityKeyToOrg, fetchAndUnwrapOrgKey, clearOrgKey } from '../services/OrgKeyService';
import { getSessionSyncConfig, getWorkspaceState, updateWorkspaceState } from '../utils/store';
import { getPersonalDocSyncConfig, isSyncEnabled } from '../services/SyncManager';
import { getSyncId } from '../services/DocSyncService';
import {
  registerCollabAssetDocument,
  unregisterCollabAssetDocument,
  isCollabAssetDocumentRegisteredForSender,
  clearCollabAssetSender,
} from '../protocols/collabAssetProtocol';
import { deleteRemovedAssets } from '../services/CollabAssetGC';
import WebSocket from 'ws';

// WebSocket proxy: browser WebSocket to sync.nimbalyst.com fails due to
// Cloudflare proxy configuration. We create WebSockets in the main process
// (Node.js) and forward messages to the renderer via IPC.
const proxiedWebSockets = new Map<string, WebSocket>();
let wsIdCounter = 0;

const PRODUCTION_SYNC_URL = 'wss://sync.nimbalyst.com';
const DEVELOPMENT_SYNC_URL = 'ws://localhost:8790';

function getCollabPendingKey(orgId: string, documentId: string): string {
  return `org:${orgId}:doc:${documentId}`;
}

/**
 * Track WebContents we've already attached a destroyed listener to, so
 * opening multiple docs in the same window doesn't stack N listeners
 * (and trigger Node's MaxListenersExceededWarning at 10+ docs).
 */
const senderDestroyedHooked = new Set<number>();

function getSyncWsUrl(): string {
  const config = getSessionSyncConfig();
  const isDev = process.env.NODE_ENV !== 'production';
  const env = isDev ? config?.environment : undefined;
  return env === 'development' ? DEVELOPMENT_SYNC_URL : PRODUCTION_SYNC_URL;
}

function getSyncHttpUrl(): string {
  const wsUrl = getSyncWsUrl();
  return wsUrl.replace('wss://', 'https://').replace('ws://', 'http://');
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
  }) => {
    if (!isAuthenticated()) {
      return { success: false, error: 'Not authenticated. Sign in first.' };
    }

    const userId = getStytchUserId();
    if (!userId) {
      return { success: false, error: 'No user ID available.' };
    }

    // Find team for workspace
    const team = await findTeamForWorkspace(payload.workspacePath);
    if (!team) {
      return { success: false, error: 'No team found for this workspace. Create or join a team first.' };
    }
    const orgId = team.orgId;

    // Get org encryption key
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

    // Verify local key fingerprint against server to detect stale keys
    const localFingerprint = getOrgKeyFingerprint(orgId);
    if (localFingerprint) {
      try {
        const orgJwt = await getOrgScopedJwt(orgId);
        const { net } = await import('electron');
        const serverUrl = getSyncHttpUrl();
        const fpResp = await net.fetch(`${serverUrl}/api/teams/${orgId}/org-key-fingerprint`, {
          headers: { 'Authorization': `Bearer ${orgJwt}` },
        });
        if (fpResp.ok) {
          const fpData = await fpResp.json() as { fingerprint: string | null };
          if (fpData.fingerprint && fpData.fingerprint !== localFingerprint) {
            logger.main.warn('[DocumentSyncHandlers] Stale key detected! Local:', localFingerprint.slice(0, 12), 'Server:', fpData.fingerprint.slice(0, 12));
            // Clear stale key and re-fetch
            clearOrgKey(orgId);
            const freshOrgJwt = await getOrgScopedJwt(orgId);
            encryptionKey = await fetchAndUnwrapOrgKey(orgId, freshOrgJwt);
            if (!encryptionKey) {
              return { success: false, error: 'Key rotation occurred. Unable to fetch new encryption key.' };
            }
          }
        }
      } catch (err) {
        logger.main.error('[DocumentSyncHandlers] Failed to verify key fingerprint against server:', err);
        return { success: false, error: 'Cannot verify encryption key epoch against server. Check your network connection and try again.' };
      }
    }

    // Export key as raw base64 for renderer to reconstruct
    const rawBytes = await crypto.subtle.exportKey('raw', encryptionKey!);
    const orgKeyBase64 = Buffer.from(rawBytes).toString('base64');

    const serverUrl = getSyncWsUrl();
    const pendingKey = getCollabPendingKey(orgId, payload.documentId);
    const pendingUpdateBase64 = getWorkspaceState(payload.workspacePath)
      .collabPendingUpdates?.[pendingKey]?.mergedUpdateBase64;

    logger.main.info('[DocumentSyncHandlers] Resolved collab config', {
      orgId,
      documentId: payload.documentId,
      serverUrl,
      userId,
    });

    const orgKeyFp = getOrgKeyFingerprint(orgId) ?? undefined;

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
      });
    }

    return {
      success: true,
      config: {
        orgId,
        documentId: payload.documentId,
        title: payload.title || payload.documentId,
        orgKeyBase64,
        orgKeyFingerprint: orgKeyFp,
        serverUrl,
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

    try {
      const orgKey = await getOrgKey(payload.orgId);
      if (!orgKey) {
        return { success: false, error: 'No org encryption key cached' };
      }

      const orgJwt = await getOrgScopedJwt(payload.orgId);
      const assetId = randomUUID();

      // Encrypt body
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        orgKey,
        payload.fileBytes
      );

      // Encrypt metadata (filename only, for now)
      const metaIv = crypto.getRandomValues(new Uint8Array(12));
      const metaPlain = new TextEncoder().encode(JSON.stringify({ name: payload.fileName }));
      const metaCipher = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: metaIv },
        orgKey,
        metaPlain as BufferSource
      );

      const fingerprint = getOrgKeyFingerprint(payload.orgId);

      const httpUrl = getSyncHttpUrl();
      const url =
        `${httpUrl}/api/collab/docs/${encodeURIComponent(payload.documentId)}` +
        `/assets/${encodeURIComponent(assetId)}`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${orgJwt}`,
        'X-Collab-Asset-Iv': Buffer.from(iv).toString('base64'),
        'X-Collab-Asset-Metadata': Buffer.from(metaCipher).toString('base64'),
        'X-Collab-Asset-Metadata-Iv': Buffer.from(metaIv).toString('base64'),
        'X-Collab-Asset-Mime-Type': payload.mimeType || 'application/octet-stream',
        'X-Collab-Asset-Plaintext-Size': String(payload.fileBytes.byteLength),
      };
      if (fingerprint) {
        headers['X-Collab-Asset-Key-Fingerprint'] = fingerprint;
      }

      const resp = await net.fetch(url, {
        method: 'PUT',
        headers,
        body: ciphertext,
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        logger.main.warn('[DocumentSyncHandlers] upload-asset failed', resp.status, errText);
        return { success: false, error: errText || `Upload failed (${resp.status})` };
      }

      return {
        success: true,
        assetId,
        uri: `collab-asset://doc/${payload.documentId}/asset/${assetId}`,
      };
    } catch (err) {
      logger.main.error('[DocumentSyncHandlers] upload-asset threw', err);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /**
   * Delete the specific list of `collab-asset://` URIs reported by the
   * renderer's AssetGCPlugin as having disappeared from the live Yjs
   * state since the previous scan. Diff-only: we never delete an asset
   * the client never observed, so concurrent inserts on other peers
   * (which we may not have received yet) are safe.
   */
  safeHandle('document-sync:gc-assets', async (event, payload: {
    orgId: string;
    documentId: string;
    removedUris: string[];
  }) => {
    if (!isAuthenticated()) {
      return { success: false, error: 'Not authenticated' };
    }
    if (!payload?.orgId || !payload?.documentId) {
      return { success: false, error: 'orgId and documentId required' };
    }
    if (!isCollabAssetDocumentRegisteredForSender(event.sender.id, payload.orgId, payload.documentId)) {
      return { success: false, error: 'Document not open in this window' };
    }
    if (!payload.removedUris || payload.removedUris.length === 0) {
      return { success: true, requested: 0, deleted: 0, failed: 0, skipped: 0 };
    }

    try {
      const orgJwt = await getOrgScopedJwt(payload.orgId);
      const result = await deleteRemovedAssets(
        getSyncHttpUrl(),
        orgJwt,
        payload.documentId,
        payload.removedUris
      );
      return { success: true, ...result };
    } catch (err) {
      logger.main.error('[DocumentSyncHandlers] gc-assets threw', err);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
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

  /**
   * Get a fresh org-scoped JWT for an org.
   * Called by the renderer's getJwt() callback during WebSocket reconnects.
   */
  safeHandle('document-sync:get-jwt', async (_event, payload: { orgId: string }) => {
    try {
      const jwt = await getOrgScopedJwt(payload.orgId);
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
  safeHandle('document-sync:resolve-index-config', async (_event, payload: {
    workspacePath: string;
  }) => {
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
    const orgKeyBase64 = Buffer.from(rawBytes).toString('base64');
    const serverUrl = getSyncWsUrl();

    // logger.main.info('[DocumentSyncHandlers] Resolved doc index config', { orgId, serverUrl, userId });

    return {
      success: true,
      config: {
        orgId,
        orgKeyBase64,
        serverUrl,
        userId,
        userName: getUserDisplayName(userId),
        userEmail: getUserEmail() || undefined,
      },
    };
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
      const isDev = process.env.NODE_ENV !== 'production';
      const config = getSessionSyncConfig();
      const env = isDev ? config?.environment : undefined;
      const serverUrl = env === 'development' ? DEVELOPMENT_SYNC_URL : PRODUCTION_SYNC_URL;

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
}
