import { app, net, safeStorage } from 'electron';
import { randomBytes, createCipheriv, createHash } from 'crypto';
import { existsSync, promises as fs, readFileSync, unlinkSync, writeFileSync } from 'fs';
import * as path from 'path';
import { safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import { AnalyticsService } from '../services/analytics/AnalyticsService';
import { AISessionsRepository } from '@nimbalyst/runtime';
import type { SessionData } from '@nimbalyst/runtime/ai/server/types';
import { exportSessionToHtml } from '../services/SessionHtmlExporter';
import { loadViewMessages } from '../utils/transcriptHelpers';
import { exportFileToHtml } from '../services/FileHtmlExporter';
import { getSessionJwt, refreshSession } from '../services/StytchAuthService';
import { store } from '../utils/store';

const SHARE_SERVER_URL = 'https://sync.nimbalyst.com';
const DEFAULT_SHARE_EXPIRATION_DAYS = 7;
const SHARE_METADATA_FILE = 'share-metadata.enc';

/**
 * Maps file extensions to viewer types for the web extension viewer.
 * Files with a viewer type are uploaded as raw content (the extension renders them).
 * Files without a viewer type are rendered to static HTML before upload.
 *
 * This must match the server-side EXTENSION_VIEWER_ALLOWLIST in collabv3/src/share.ts.
 */
const FILE_EXTENSION_TO_VIEWER_TYPE: Record<string, string> = {
  '.mindmap': 'mindmap',
  '.prisma': 'datamodellm',
  '.excalidraw': 'excalidraw',
  '.csv': 'csv',
  '.tsv': 'csv',
};

/** Compound file extensions that need full suffix matching (e.g. .mockup.html). */
const COMPOUND_EXTENSION_TO_VIEWER_TYPE: Record<string, string> = {
  '.mockup.html': 'mockup',
  '.calc.md': 'calc',
  '.slides.md': 'slides',
};

/** Get the viewer type for a file path, or null for the default HTML viewer. */
function getViewerTypeForFile(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  // Check compound extensions first (e.g. .mockup.html)
  for (const [suffix, viewerType] of Object.entries(COMPOUND_EXTENSION_TO_VIEWER_TYPE)) {
    if (lower.endsWith(suffix)) return viewerType;
  }
  const ext = path.extname(lower);
  return FILE_EXTENSION_TO_VIEWER_TYPE[ext] ?? null;
}

// --- Encryption utilities ---

/** Generate a random 256-bit AES key, returned as standard base64. */
function generateShareKey(): string {
  return randomBytes(32).toString('base64');
}

/** Convert standard base64 to URL-safe base64 (no padding). */
function keyToUrlSafe(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Encrypt HTML content with AES-256-GCM.
 * Returns Buffer of: IV (12 bytes) || ciphertext || auth tag (16 bytes)
 */
function encryptContent(html: string, keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(html, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]);
}

/** Get a previously stored encryption key for a share target, if one exists. */
function getStoredShareKey(sessionId: string): string | null {
  const keys = store.get('shareKeys') ?? {};
  if (keys[sessionId]) {
    return keys[sessionId];
  }
  return null;
}

/** Persist the encryption key for a share target after a successful upload. */
function storeShareKey(sessionId: string, key: string): void {
  const keys = store.get('shareKeys') ?? {};
  if (keys[sessionId] === key) {
    return;
  }
  const newKey = key ?? generateShareKey();
  store.set('shareKeys', { ...keys, [sessionId]: newKey });
}

/** Remove a stored share key when a share is deleted. */
function removeShareKey(sessionId: string): void {
  const keys = store.get('shareKeys') ?? {};
  if (keys[sessionId]) {
    const { [sessionId]: _, ...rest } = keys;
    store.set('shareKeys', rest);
  }
}

interface ShareDisplayMetadata {
  contentType: 'session' | 'file';
  title: string;
}

let shareMetadataCache: Record<string, ShareDisplayMetadata> | null = null;

function getShareMetadataPath(): string {
  return path.join(app.getPath('userData'), SHARE_METADATA_FILE);
}

function isSafeStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function loadShareMetadata(): Record<string, ShareDisplayMetadata> {
  if (shareMetadataCache) {
    return shareMetadataCache;
  }

  const filePath = getShareMetadataPath();
  if (!existsSync(filePath)) {
    shareMetadataCache = {};
    return shareMetadataCache;
  }

  try {
    const fileData = readFileSync(filePath);
    const jsonData = isSafeStorageAvailable()
      ? safeStorage.decryptString(fileData)
      : fileData.toString('utf8');

    const parsed = JSON.parse(jsonData) as Record<string, ShareDisplayMetadata>;
    shareMetadataCache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    logger.main.error('[ShareHandlers] Failed to load share metadata:', error);
    shareMetadataCache = {};
  }

  return shareMetadataCache;
}

function saveShareMetadata(metadata: Record<string, ShareDisplayMetadata>): void {
  shareMetadataCache = metadata;

  const filePath = getShareMetadataPath();
  if (Object.keys(metadata).length === 0) {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    return;
  }

  const jsonData = JSON.stringify(metadata);
  if (isSafeStorageAvailable()) {
    writeFileSync(filePath, safeStorage.encryptString(jsonData));
  } else {
    logger.main.warn('[ShareHandlers] safeStorage unavailable, saving share metadata without encryption');
    writeFileSync(filePath, jsonData, 'utf8');
  }
}

function setShareMetadata(sessionId: string, metadata: ShareDisplayMetadata): void {
  const current = loadShareMetadata();
  saveShareMetadata({
    ...current,
    [sessionId]: metadata,
  });
}

function removeShareMetadata(sessionId: string): void {
  const current = loadShareMetadata();
  if (!current[sessionId]) {
    return;
  }

  const { [sessionId]: _, ...rest } = current;
  saveShareMetadata(rest);
}

/**
 * Normalize expiration preference values.
 * Accepts days (number) or undefined (fallback). Max 30 days.
 * Legacy null values (no expiration) are converted to the default.
 */
function normalizeShareExpirationDays(
  value: unknown,
  fallback: number = DEFAULT_SHARE_EXPIRATION_DAYS
): number {
  const candidate = value === undefined ? fallback : value;

  // Legacy: null meant "no expiration" - convert to default
  if (candidate === null) {
    return fallback;
  }

  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
    return fallback;
  }

  const days = Math.trunc(candidate);
  if (days <= 0) {
    return fallback;
  }

  return Math.min(Math.max(days, 1), 30);
}

// --- Auth ---

/**
 * Get a valid JWT, always refreshing to ensure it's not expired.
 * Stytch JWTs have short lifetimes (~5 min), so we refresh on every
 * share operation rather than risk sending an expired token.
 */
async function getValidJwt(): Promise<string | null> {
  // Save cached JWT before refresh attempt, since refresh used to
  // call signOut() on failure which would nuke credentials.
  const cachedJwt = getSessionJwt();

  let refreshed = false;
  try {
    refreshed = await refreshSession(SHARE_SERVER_URL);
  } catch {
    // Network error -- fall through to cached JWT
  }
  if (refreshed) {
    return getSessionJwt();
  }

  // Refresh failed - try the cached JWT as a last resort.
  // The server may still accept it if it hasn't expired yet.
  if (cachedJwt) {
    logger.file.warn('[ShareHandlers] JWT refresh failed, falling back to cached JWT');
  }
  return cachedJwt;
}

export interface ShareInfo {
  shareId: string;
  sessionId: string;
  title: string;
  sizeBytes: number;
  createdAt: string;
  expiresAt: string | null;
  viewCount: number;
}

/**
 * Registers IPC handlers for session sharing functionality.
 */
export function registerShareHandlers() {
  /**
   * Share a session as a link.
   * Generates HTML, encrypts client-side, uploads ciphertext to server.
   * The decryption key is included in the URL fragment (never sent to server).
   */
  safeHandle(
    'share:sessionAsLink',
    async (
      _event,
      options: { sessionId: string; expirationDays?: number | null }
    ): Promise<{ success: boolean; url?: string; shareId?: string; isUpdate?: boolean; encryptionKey?: string; error?: string }> => {
      const { sessionId, expirationDays } = options;

      if (!sessionId) {
        return { success: false, error: 'sessionId is required' };
      }

      // Check auth
      const jwt = await getValidJwt();
      if (!jwt) {
        AnalyticsService.getInstance().sendEvent('known_error', {
          errorId: 'share_not_signed_in',
          context: 'share',
          content_type: 'session',
        });
        return { success: false, error: 'Not signed in. Sign in via Settings > Account & Sync.' };
      }

      const serverUrl = SHARE_SERVER_URL;

      try {
        // Load session and generate HTML (same pattern as ExportHandlers)
        const chatSession = await AISessionsRepository.get(sessionId);
        if (!chatSession) {
          return { success: false, error: `Session not found: ${sessionId}` };
        }

        const msgResult = await loadViewMessages(sessionId, chatSession.provider ?? 'unknown');
        if (!msgResult.success) {
          return { success: false, error: msgResult.error };
        }

        const session: SessionData = {
          id: chatSession.id,
          provider: chatSession.provider as any,
          model: chatSession.model ?? undefined,
          sessionType: chatSession.sessionType,
          mode: chatSession.mode,
          createdAt: new Date(chatSession.createdAt as any).getTime(),
          updatedAt: new Date(chatSession.updatedAt as any).getTime(),
          messages: msgResult.messages,
          workspacePath: (chatSession.metadata as any)?.workspaceId ?? chatSession.workspacePath ?? '',
          title: chatSession.title ?? 'New conversation',
        };

        const html = await exportSessionToHtml(session);

        // Encrypt the HTML content
        const shareKey = getStoredShareKey(sessionId) ?? generateShareKey();
        const encrypted = encryptContent(html, shareKey);
        const urlSafeKey = keyToUrlSafe(shareKey);

        // Build headers for upload
        const headers: Record<string, string> = {
          'Authorization': `Bearer ${jwt}`,
          'Content-Type': 'application/octet-stream',
          'X-Session-Title': 'Encrypted session',
          'X-Session-Id': sessionId,
        };

        // Resolve TTL: explicit param > stored preference > default (7 days)
        const storedPreference = normalizeShareExpirationDays(store.get('shareExpirationDays'));
        const ttlDays = normalizeShareExpirationDays(expirationDays, storedPreference);
        headers['X-TTL-Days'] = String(ttlDays);

        // Upload encrypted content to server
        const response = await net.fetch(`${serverUrl}/share`, {
          method: 'POST',
          headers,
          body: encrypted as BodyInit,
        });

        if (!response.ok) {
          const errorText = await response.text();
          logger.file.error(`[ShareHandlers] Upload failed: ${response.status} ${errorText}`);
          return { success: false, error: `Upload failed: ${errorText || response.status}` };
        }

        const data = await response.json() as { shareId: string; url: string; isUpdate?: boolean };

        // Append decryption key to URL fragment
        const fullUrl = `${data.url}#key=${urlSafeKey}`;

        logger.file.info(`[ShareHandlers] Session ${data.isUpdate ? 'updated' : 'shared'}: ${data.url}`);

        storeShareKey(sessionId, shareKey);
        setShareMetadata(sessionId, {
          contentType: 'session',
          title: chatSession.title ?? 'New conversation',
        });

        // Track successful session share
        AnalyticsService.getInstance().sendEvent('content_shared', {
          content_type: 'session',
          is_update: !!data.isUpdate,
        });

        return { success: true, url: fullUrl, shareId: data.shareId, isUpdate: data.isUpdate, encryptionKey: urlSafeKey };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.file.error(`[ShareHandlers] Share failed: ${errorMessage}`);

        // Track share upload failure
        AnalyticsService.getInstance().sendEvent('known_error', {
          errorId: 'share_upload_failed',
          context: 'share',
          content_type: 'session',
        });

        return { success: false, error: errorMessage };
      }
    }
  );

  /**
   * List the user's shared sessions.
   */
  safeHandle(
    'share:list',
    async (): Promise<{ success: boolean; shares?: ShareInfo[]; error?: string }> => {
      const jwt = await getValidJwt();
      if (!jwt) {
        return { success: false, error: 'Not signed in' };
      }

      const serverUrl = SHARE_SERVER_URL;

      try {
        const response = await net.fetch(`${serverUrl}/shares`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${jwt}`,
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          logger.file.error(`[ShareHandlers] List shares failed: ${response.status} ${errorText}`);
          if (response.status === 401 || response.status === 403) {
            return { success: false, error: 'Not signed in' };
          }
          return { success: false, error: `Failed to list shares: ${errorText || response.status}` };
        }

        const data = await response.json() as { shares: ShareInfo[] };
        const shareMetadata = loadShareMetadata();

        const shares = await Promise.all(
          data.shares.map(async (share) => {
            const shareKeyId = typeof share.sessionId === 'string' ? share.sessionId : '';
            const localMetadata = shareKeyId ? shareMetadata[shareKeyId] : undefined;
            if (localMetadata?.title) {
              return { ...share, title: localMetadata.title };
            }

            if (shareKeyId && !shareKeyId.startsWith('file:')) {
              try {
                const session = await AISessionsRepository.get(shareKeyId);
                if (session?.title) {
                  return { ...share, title: session.title };
                }
              } catch (error) {
                logger.main.warn('[ShareHandlers] Failed to resolve shared session title:', shareKeyId, error);
              }
            }

            return share;
          })
        );

        return { success: true, shares };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.file.error(`[ShareHandlers] List shares failed: ${errorMessage}`);
        return { success: false, error: errorMessage };
      }
    }
  );

  /**
   * Delete (unshare) a shared session.
   */
  safeHandle(
    'share:delete',
    async (
      _event,
      options: { shareId: string; sessionId?: string }
    ): Promise<{ success: boolean; error?: string }> => {
      const { shareId, sessionId } = options;

      if (!shareId) {
        return { success: false, error: 'shareId is required' };
      }

      const jwt = await getValidJwt();
      if (!jwt) {
        return { success: false, error: 'Not signed in' };
      }

      const serverUrl = SHARE_SERVER_URL;

      try {
        const response = await net.fetch(`${serverUrl}/share/${shareId}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${jwt}`,
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          logger.file.error(`[ShareHandlers] Delete failed: ${response.status} ${errorText}`);
          return { success: false, error: `Failed to delete share: ${errorText || response.status}` };
        }

        // Clean up local encryption key
        if (sessionId) {
          removeShareKey(sessionId);
          removeShareMetadata(sessionId);
        }

        logger.file.info(`[ShareHandlers] Share deleted: ${shareId}`);

        // Track successful share deletion
        AnalyticsService.getInstance().sendEvent('share_deleted');

        return { success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.file.error(`[ShareHandlers] Delete share failed: ${errorMessage}`);
        return { success: false, error: errorMessage };
      }
    }
  );

  /**
   * Share a file as an encrypted link.
   * Reads the file, renders to HTML, encrypts client-side, uploads ciphertext.
   * The decryption key is included in the URL fragment (never sent to server).
   */
  safeHandle(
    'share:fileAsLink',
    async (
      _event,
      options: { filePath: string; expirationDays?: number | null }
    ): Promise<{ success: boolean; url?: string; shareId?: string; isUpdate?: boolean; encryptionKey?: string; error?: string }> => {
      const { filePath, expirationDays } = options;

      if (!filePath) {
        return { success: false, error: 'filePath is required' };
      }

      const jwt = await getValidJwt();
      if (!jwt) {
        AnalyticsService.getInstance().sendEvent('known_error', {
          errorId: 'share_not_signed_in',
          context: 'share',
          content_type: 'file',
        });
        return { success: false, error: 'Not signed in. Sign in via Settings > Account & Sync.' };
      }

      const serverUrl = SHARE_SERVER_URL;

      try {
        // Read file content
        const content = await fs.readFile(filePath, 'utf-8');

        // Determine if this file type has an extension viewer on the web.
        // If so, upload raw content (extension renders it). Otherwise, render to HTML.
        const viewerType = getViewerTypeForFile(filePath);
        const contentToEncrypt = viewerType
          ? content                            // Raw content -- extension viewer renders it
          : exportFileToHtml(filePath, content); // Pre-rendered HTML -- iframe viewer

        // Use hashed file path as key identifier (avoids leaking paths in electron-store)
        const keyId = `file:${createHash('sha256').update(filePath).digest('hex').slice(0, 16)}`;

        // Encrypt the content
        const shareKey = getStoredShareKey(keyId) ?? generateShareKey();
        const encrypted = encryptContent(contentToEncrypt, shareKey);
        const urlSafeKey = keyToUrlSafe(shareKey);

        // Build headers for upload (zero-knowledge: no filename sent)
        const headers: Record<string, string> = {
          'Authorization': `Bearer ${jwt}`,
          'Content-Type': 'application/octet-stream',
          'X-Session-Title': 'Encrypted file',
          'X-Session-Id': keyId,
        };

        if (viewerType) {
          headers['X-Viewer-Type'] = viewerType;
        }

        // Resolve TTL: explicit param > stored preference > default (7 days)
        const storedPreference = normalizeShareExpirationDays(store.get('shareExpirationDays'));
        const ttlDays = normalizeShareExpirationDays(expirationDays, storedPreference);
        headers['X-TTL-Days'] = String(ttlDays);

        // Upload encrypted content to server
        const response = await net.fetch(`${serverUrl}/share`, {
          method: 'POST',
          headers,
          body: encrypted as BodyInit,
        });

        if (!response.ok) {
          const errorText = await response.text();
          logger.file.error(`[ShareHandlers] File upload failed: ${response.status} ${errorText}`);
          return { success: false, error: `Upload failed: ${errorText || response.status}` };
        }

        const data = await response.json() as { shareId: string; url: string; isUpdate?: boolean };

        // Append decryption key to URL fragment
        const fullUrl = `${data.url}#key=${urlSafeKey}`;

        logger.file.info(`[ShareHandlers] File ${data.isUpdate ? 'updated' : 'shared'}: ${data.url}`);

        storeShareKey(keyId, shareKey);
        setShareMetadata(keyId, {
          contentType: 'file',
          title: path.basename(filePath),
        });

        // Track successful file share
        AnalyticsService.getInstance().sendEvent('content_shared', {
          content_type: 'file',
          is_update: !!data.isUpdate,
        });

        return { success: true, url: fullUrl, shareId: data.shareId, isUpdate: data.isUpdate, encryptionKey: urlSafeKey };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.file.error(`[ShareHandlers] File share failed: ${errorMessage}`);

        // Track file share upload failure
        AnalyticsService.getInstance().sendEvent('known_error', {
          errorId: 'share_upload_failed',
          context: 'share',
          content_type: 'file',
        });

        return { success: false, error: errorMessage };
      }
    }
  );

  /**
   * Get locally stored share encryption keys.
   * Used by renderer to reconstruct share URLs with decryption key fragments.
   */
  safeHandle(
    'share:getKeys',
    async (): Promise<Record<string, string>> => {
      const keys = store.get('shareKeys') ?? {};
      // Convert to URL-safe format for the renderer
      const urlSafeKeys: Record<string, string> = {};
      for (const [sessionId, key] of Object.entries(keys)) {
        urlSafeKeys[sessionId] = keyToUrlSafe(key as string);
      }
      return urlSafeKeys;
    }
  );

  /**
   * Get the user's preferred share expiration (in days).
   */
  safeHandle(
    'share:getExpirationPreference',
    async (): Promise<number> => {
      return normalizeShareExpirationDays(store.get('shareExpirationDays'));
    }
  );

  /**
   * Set the user's preferred share expiration (in days).
   */
  safeHandle(
    'share:setExpirationPreference',
    async (_event, days: number | null): Promise<void> => {
      store.set('shareExpirationDays', normalizeShareExpirationDays(days));
    }
  );
}
