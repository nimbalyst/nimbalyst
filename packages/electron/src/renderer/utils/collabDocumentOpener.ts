/**
 * Collaborative Document Opener
 *
 * Entry point for opening collaborative documents as tabs.
 * Future UI (shared file tree, tracker sidebar) calls openCollabDocument()
 * which stores the connection config and adds a tab with a collab:// URI.
 *
 * The collab config registry is a module-level Map that TabContent reads
 * when creating a CollaborativeTabEditor instance.
 */

import { buildCollabUri } from './collabUri';
import { logger } from './logger';
import {
  getSharedDocumentDisplayName,
  normalizeCollabPath,
  UNRESOLVED_SHARED_DOCUMENT_NAME,
} from '../components/CollabMode/collabTree';

/**
 * Configuration for opening a collaborative document.
 * Stored in the registry and passed to CollaborativeTabEditor.
 */
export interface CollabDocumentConfig {
  workspacePath: string;
  orgId: string;
  documentId: string;
  title: string;
  /** Last-known logical path used while the shared index resolves. */
  displayPath?: string;
  /**
   * Epic H2 key custody. `legacy-e2e` (default): client encrypts/decrypts doc
   * data with `documentKey`. `server-managed`: the server holds the per-team
   * DEK and encrypts at rest, so the client syncs PLAINTEXT and `documentKey`
   * is absent.
   */
  keyCustody?: 'legacy-e2e' | 'server-managed';
  /** Org AES-256-GCM key. Present in legacy-e2e; absent in server-managed. */
  documentKey?: CryptoKey;
  /**
   * Legacy org key for reading PRE-MIGRATION rows in server-managed mode
   * (NIM-878). Rows written before the legacy-e2e -> server-managed flip are
   * still AES-ciphertext and must be decrypted with the original org key.
   */
  legacyDocumentKey?: CryptoKey;
  /**
   * NIM-959: all candidate legacy org-key epochs for server-managed reads. A
   * team that rotated its org key while still legacy-e2e can have content rows
   * spanning epochs; DocumentSync tries each. Mirrors the doc-index multi-epoch
   * fix (NIM-906/910).
   */
  legacyDocumentKeys?: CryptoKey[];
  serverUrl: string;
  getJwt: (opts?: { forceRefresh?: boolean }) => Promise<string>;
  /** Optional extra query appended to revision-history HTTP requests. */
  urlExtraQuery?: string;
  userId: string;
  /** Stable local account identity used to partition encrypted replicas. */
  accountId: string;
  /** Human-readable display name (first+last from Stytch, falls back to email). */
  userName?: string;
  /** User's email address. */
  userEmail?: string;
  /** Content to seed the Y.Doc with if the room is empty (first share). */
  initialContent?: string;
  /** Persisted local updates that still need server acknowledgement. */
  pendingUpdateBase64?: string;
  /** Org key fingerprint for key epoch enforcement on document writes. */
  orgKeyFingerprint?: string;
  /**
   * Logical document type (e.g. 'markdown', 'excalidraw', 'mindmap'). Used by
   * `CollaborativeTabEditor` to route to the right editor branch (built-in
   * Lexical for markdown, extension component for others).
   *
   * Defaults to 'markdown' when omitted to preserve backward compatibility
   * for existing shared docs created before the type field existed.
   */
  documentType?: string;
  /** Explicit V2 type metadata retained across create/open/restore. */
  metadataVersion?: 2;
  fileExtension?: string;
  editorId?: string;
  /**
   * Factory for creating WebSocket connections.
   * When running in Electron, this proxies WebSocket connections through
   * the main process (Node.js) to work around Cloudflare blocking
   * browser WebSocket upgrades.
   */
  createWebSocket?: (url: string) => WebSocket;
}

/**
 * Module-level registry of collab document configurations.
 * Keyed by collab:// URI. TabContent reads from this when creating
 * CollaborativeTabEditor instances.
 */
const collabConfigRegistry = new Map<string, CollabDocumentConfig>();

/**
 * Get the collab config for a URI. Returns undefined if not registered.
 */
export function getCollabConfig(uri: string): CollabDocumentConfig | undefined {
  return collabConfigRegistry.get(uri);
}

/** Keep the connection config's warm display metadata current across index gaps. */
export function updateCollabConfigDisplayMetadata(
  uri: string,
  metadata: { title?: string | null; displayPath?: string | null },
): void {
  const config = collabConfigRegistry.get(uri);
  if (!config) return;

  const resolvedTitle = getSharedDocumentDisplayName(metadata.title, config.documentId);
  if (resolvedTitle !== UNRESOLVED_SHARED_DOCUMENT_NAME) {
    config.title = resolvedTitle;
  }

  const normalizedPath = normalizeCollabPath(metadata.displayPath);
  if (normalizedPath && normalizedPath !== config.documentId) {
    config.displayPath = normalizedPath;
  }
}

/**
 * Remove a collab config when the tab is closed.
 */
export function removeCollabConfig(uri: string): void {
  collabConfigRegistry.delete(uri);
}

/** Remove every synthetic/real URI alias created for one document. */
export function removeCollabConfigsForDocument(
  workspacePath: string,
  documentId: string,
): void {
  for (const [uri, config] of collabConfigRegistry) {
    if (config.workspacePath === workspacePath && config.documentId === documentId) {
      collabConfigRegistry.delete(uri);
    }
  }
}

/**
 * Register a resolved collab config without opening a tab. Used by headless
 * flows (and the Playwright test helpers) that need a room connection but no
 * editor: the config becomes discoverable by documentId for seed/export/
 * re-upload passes.
 */
export function registerCollabConfig(config: CollabDocumentConfig): string {
  const uri = buildCollabUri(config.orgId, config.documentId);
  collabConfigRegistry.set(uri, config);
  return uri;
}

/**
 * Find an already-resolved config for a document regardless of the URI it was
 * registered under. Seed/export/re-upload flows address rooms as
 * `collab://seed/<documentId>` before they know the orgId; when the document
 * was opened this session its resolved config -- keys, server URL, websocket
 * factory -- is directly reusable.
 */
export function findCollabConfigByDocumentId(
  workspacePath: string,
  documentId: string,
): CollabDocumentConfig | undefined {
  for (const config of collabConfigRegistry.values()) {
    if (config.documentId === documentId && config.workspacePath === workspacePath) {
      return config;
    }
  }
  return undefined;
}

/**
 * Open a collaborative document as a tab.
 *
 * Stores the connection config in the registry and calls addTab()
 * on the provided tab actions. Returns the tab ID.
 *
 * @example
 * const tabId = openCollabDocument({
 *   orgId: 'org-123',
 *   documentId: 'doc-abc',
 *   title: 'Architecture Plan',
 *   documentKey: aesKey,
 *   serverUrl: 'wss://sync.nimbalyst.com',
 *   getJwt: () => stytchClient.getToken(),
 *   userId: 'user-xyz',
 *   addTab: tabsActions.addTab,
 * });
 */
export function openCollabDocument(options: CollabDocumentConfig & {
  addTab: (
    filePath: string,
    content?: string,
    switchToTab?: boolean,
    displayName?: string,
    initialState?: { isPinned: boolean },
  ) => string | null;
  isPinned?: boolean;
}): string {
  const { addTab, isPinned, ...config } = options;
  const uri = buildCollabUri(config.orgId, config.documentId);

  // Store config for TabContent to retrieve
  collabConfigRegistry.set(uri, config);

  try {
    // Add the tab with its display name in the same store transaction. Content
    // is empty because CollaborationPlugin hydrates from Y.Doc.
    const displayName = getSharedDocumentDisplayName(
      config.displayPath || config.title,
      config.documentId,
    );
    const tabId = isPinned === undefined
      ? addTab(uri, '', true, displayName)
      : addTab(uri, '', true, displayName, { isPinned });
    if (!tabId) {
      throw new Error(`Tab creation returned no tab ID for collaborative document ${config.documentId}`);
    }
    return tabId;
  } catch (error) {
    collabConfigRegistry.delete(uri);
    throw error;
  }
}

/**
 * Reconstruct a CryptoKey from raw base64 bytes (sent over IPC).
 */
async function importOrgKeyFromBase64(base64: string): Promise<CryptoKey> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Import every candidate legacy org-key epoch for server-managed reads (NIM-959).
 * Prefers the multi-epoch array; falls back to the singular legacy key for older
 * main-process handlers. Returns [] when none are available.
 */
async function importLegacyOrgKeys(
  legacyOrgKeysBase64: string[] | undefined,
  legacyOrgKeyBase64: string | undefined,
): Promise<CryptoKey[]> {
  const raws = legacyOrgKeysBase64 && legacyOrgKeysBase64.length > 0
    ? legacyOrgKeysBase64
    : (legacyOrgKeyBase64 ? [legacyOrgKeyBase64] : []);
  return Promise.all(raws.map((b64) => importOrgKeyFromBase64(b64)));
}

// ---------------------------------------------------------------------------
// WebSocket proxy: single global IPC listener, dispatches by wsId
// ---------------------------------------------------------------------------

type WsEvent = { wsId: string; type: string; data?: string; code?: number; reason?: string; error?: string };
type WsEventHandler = (event: WsEvent) => void;

/** Map of wsId -> handler. A single IPC listener dispatches to the right handler. */
const wsEventHandlers = new Map<string, WsEventHandler>();
/** Buffer for events that arrive before their wsId handler is registered (IPC race). */
const wsPendingEvents = new Map<string, WsEvent[]>();
let globalWsListenerInstalled = false;

function ensureGlobalWsListener(): void {
  if (globalWsListenerInstalled) return;
  const api = window.electronAPI?.documentSync;
  if (!api?.onWsEvent) return;

  api.onWsEvent((event: WsEvent) => {
    const handler = wsEventHandlers.get(event.wsId);
    if (handler) {
      handler(event);
    } else {
      // Handler not yet registered (wsConnect IPC hasn't resolved yet).
      // Buffer the event for flush when the handler is registered.
      let pending = wsPendingEvents.get(event.wsId);
      if (!pending) {
        pending = [];
        wsPendingEvents.set(event.wsId, pending);
      }
      pending.push(event);
    }
  });
  globalWsListenerInstalled = true;
}

/** Register a handler for a wsId and flush any buffered events. */
function registerWsHandler(id: string, handler: WsEventHandler): void {
  wsEventHandlers.set(id, handler);
  const pending = wsPendingEvents.get(id);
  if (pending) {
    wsPendingEvents.delete(id);
    for (const event of pending) {
      handler(event);
    }
  }
}

/**
 * Create a browser-compatible WebSocket that proxies through the Electron
 * main process via IPC. This works around Cloudflare blocking WebSocket
 * upgrades from browser/Chromium clients.
 *
 * Returns an object that implements the browser WebSocket interface
 * (enough for DocumentSyncProvider to use).
 */
export function createProxiedWebSocket(url: string): WebSocket {
  const api = window.electronAPI?.documentSync;
  if (!api?.wsConnect) {
    throw new Error('WebSocket proxy API not available');
  }

  ensureGlobalWsListener();

  // Create a fake WebSocket that proxies through IPC
  const eventTarget = new EventTarget();
  let wsId: string | null = null;
  let readyState: number = WebSocket.CONNECTING;
  let closedBeforeConnected = false;

  function cleanup(): void {
    if (wsId) {
      wsEventHandlers.delete(wsId);
    }
  }

  function dispatchWsEvent(event: WsEvent): void {
    switch (event.type) {
      case 'open':
        if (readyState === WebSocket.CLOSING || readyState === WebSocket.CLOSED) break;
        readyState = WebSocket.OPEN;
        eventTarget.dispatchEvent(new Event('open'));
        break;
      case 'message':
        if (readyState === WebSocket.CLOSING || readyState === WebSocket.CLOSED) break;
        readyState = WebSocket.OPEN;
        eventTarget.dispatchEvent(new MessageEvent('message', { data: event.data }));
        break;
      case 'close':
        readyState = WebSocket.CLOSED;
        eventTarget.dispatchEvent(new CloseEvent('close', {
          code: event.code ?? 1000,
          reason: event.reason ?? '',
        }));
        cleanup();
        break;
      case 'error':
        eventTarget.dispatchEvent(new Event('error'));
        break;
    }
  }

  const ws = {
    get readyState() { return readyState; },
    get CONNECTING() { return WebSocket.CONNECTING; },
    get OPEN() { return WebSocket.OPEN; },
    get CLOSING() { return WebSocket.CLOSING; },
    get CLOSED() { return WebSocket.CLOSED; },

    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      eventTarget.addEventListener(type, listener);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      eventTarget.removeEventListener(type, listener);
    },

    send(data: string) {
      if (wsId && readyState === WebSocket.OPEN) {
        api.wsSend(wsId, data);
      }
    },

    close() {
      if (readyState === WebSocket.CLOSING || readyState === WebSocket.CLOSED) {
        return;
      }
      readyState = WebSocket.CLOSING;
      if (wsId) {
        api.wsClose(wsId);
      } else {
        // close() called before wsConnect() resolved (e.g., React StrictMode teardown).
        // Flag it so the connect resolution can close the main-process socket.
        closedBeforeConnected = true;
      }
    },
  } as unknown as WebSocket;

  // Initiate the connection asynchronously
  api.wsConnect(url).then((result) => {
    if (result.success && result.wsId) {
      wsId = result.wsId;

      // If close() was called before wsConnect resolved (React StrictMode),
      // register first so the main-process close event reaches the caller.
      if (closedBeforeConnected) {
        registerWsHandler(wsId, dispatchWsEvent);
        api.wsClose(wsId);
        return;
      }

      // Register handler for events on this wsId (flushes any buffered events)
      registerWsHandler(wsId, dispatchWsEvent);
    } else {
      console.error('[createProxiedWebSocket] Failed to connect:', result.error);
      readyState = WebSocket.CLOSED;
      eventTarget.dispatchEvent(new Event('error'));
      eventTarget.dispatchEvent(new CloseEvent('close', { code: 1006, reason: result.error ?? '' }));
    }
  }).catch((err: unknown) => {
    console.error('[createProxiedWebSocket] IPC error:', err);
    readyState = WebSocket.CLOSED;
    eventTarget.dispatchEvent(new Event('error'));
    eventTarget.dispatchEvent(new CloseEvent('close', { code: 1006, reason: String(err) }));
  });

  return ws;
}

/**
 * Resolve a collab config from the main process and populate the registry.
 * Used to restore collab tabs after refresh/HMR when the in-memory registry
 * is empty but the tab URI is still persisted.
 *
 * Returns the config on success, or null if resolution fails.
 */
export async function resolveCollabConfigForUri(
  workspacePath: string,
  uri: string,
  documentId: string,
  title?: string,
  documentType?: string,
  options: {
    forceRefresh?: boolean;
    metadata?: { metadataVersion: 2; fileExtension: string; editorId: string };
    /**
     * Whether to read/write the tab config registry. Nested collaborative
     * embeds use `false` because they own a separate main-process attachment
     * whose open/close refcount must not alias a normal tab.
     */
    cache?: boolean;
  } = {},
): Promise<CollabDocumentConfig | null> {
  if (!window.electronAPI?.documentSync) return null;
  let resolvedMetadata = options.metadata;
  const useCache = options.cache !== false;

  if (options.forceRefresh && useCache) {
    // Key rotation must bypass both URI and document-id aliases. Otherwise a
    // freshly resolved cache key can still be populated with the old CryptoKey.
    for (const [registeredUri, config] of collabConfigRegistry) {
      if (
        config.workspacePath === workspacePath &&
        config.documentId === documentId
      ) {
        if (
          !resolvedMetadata
          && config.metadataVersion === 2
          && config.fileExtension
          && config.editorId
        ) {
          resolvedMetadata = {
            metadataVersion: 2,
            fileExtension: config.fileExtension,
            editorId: config.editorId,
          };
        }
        collabConfigRegistry.delete(registeredUri);
      }
    }
  } else if (useCache) {
    // Already resolved
    const existing = collabConfigRegistry.get(uri);
    if (existing) {
      if (resolvedMetadata) Object.assign(existing, resolvedMetadata);
      return existing;
    }

    // A seed/export/re-upload caller may only know the documentId (its URI is
    // `collab://seed/<documentId>`); reuse the config resolved when the doc was
    // opened rather than re-running the IPC resolution.
    const byDocument = findCollabConfigByDocumentId(workspacePath, documentId);
    if (byDocument) {
      if (resolvedMetadata) Object.assign(byDocument, resolvedMetadata);
      return byDocument;
    }
  }

  try {
    const result = await window.electronAPI.documentSync.open(
      workspacePath,
      documentId,
      title,
      documentType,
    );

    if (!result.success || !result.config) {
      logger.ui.warn('[collabDocumentOpener] Failed to resolve config for:', uri, result.error);
      return null;
    }

    const { orgId, title: resolvedTitle, orgKeyBase64, legacyOrgKeyBase64, legacyOrgKeysBase64, orgKeyFingerprint, serverUrl, accountId, userId, userName, userEmail, pendingUpdateBase64 } = result.config;
    const urlExtraQuery = result.config.urlExtraQuery;
    const resolvedDocumentType = documentType ?? result.config.documentType;
    const serverManaged = result.config.keyCustody === 'server-managed';
    const documentKey = serverManaged ? undefined : await importOrgKeyFromBase64(orgKeyBase64);
    // Server-managed docs may still serve PRE-MIGRATION legacy-e2e rows; import
    // every candidate legacy org-key epoch so old rows (possibly written under a
    // rotated-away key) can be decrypted (NIM-878 / NIM-959).
    const legacyDocumentKeys = serverManaged
      ? await importLegacyOrgKeys(legacyOrgKeysBase64, legacyOrgKeyBase64)
      : [];
    const hasWsProxy = !!window.electronAPI?.documentSync?.wsConnect;

    const config: CollabDocumentConfig = {
      workspacePath,
      orgId,
      documentId,
      title: resolvedTitle,
      documentType: resolvedDocumentType,
      ...resolvedMetadata,
      keyCustody: serverManaged ? 'server-managed' : 'legacy-e2e',
      documentKey,
      legacyDocumentKey: legacyDocumentKeys[0],
      legacyDocumentKeys,
      orgKeyFingerprint,
      serverUrl,
      accountId,
      userId,
      userName,
      userEmail,
      urlExtraQuery,
      pendingUpdateBase64,
      createWebSocket: hasWsProxy
        ? (url: string) => createProxiedWebSocket(
            urlExtraQuery
              ? `${url}${url.includes('?') ? '&' : '?'}${urlExtraQuery}`
              : url,
          )
        : undefined,
      getJwt: async (opts) => {
        const jwtResult = await window.electronAPI.documentSync.getJwt(orgId, opts?.forceRefresh);
        if (!jwtResult.success || !jwtResult.jwt) {
          throw new Error(`Failed to get JWT: ${jwtResult.error}`);
        }
        return jwtResult.jwt;
      },
    };

    // The URI in the tab may use the real orgId already, but double-check
    const realUri = buildCollabUri(orgId, documentId);
    if (useCache) {
      collabConfigRegistry.set(realUri, config);
      // Also set with the passed-in URI in case it differs
      if (uri !== realUri) {
        collabConfigRegistry.set(uri, config);
      }
    }

    return config;
  } catch (err) {
    logger.ui.error('[collabDocumentOpener] Failed to resolve collab config:', err);
    return null;
  }
}

/**
 * Open a collaborative document by calling the main process IPC to resolve
 * auth/encryption, then opening the tab.
 *
 * This is the primary entry point for UI code. It handles:
 * 1. Calling document-sync:open IPC to get org key + auth config
 * 2. Reconstructing the CryptoKey from base64
 * 3. Setting up the getJwt callback via document-sync:get-jwt IPC
 * 4. Calling openCollabDocument() with the full config
 */
export async function openCollabDocumentViaIPC(options: {
  workspacePath: string;
  documentId: string;
  title?: string;
  displayPath?: string;
  initialContent?: string;
  /**
   * Logical document type used by CollaborativeTabEditor to route to the
   * right editor branch (default: 'markdown' if omitted).
   */
  documentType?: string;
  metadataVersion?: 2;
  fileExtension?: string;
  editorId?: string;
  isPinned?: boolean;
  addTab: (
    filePath: string,
    content?: string,
    switchToTab?: boolean,
    displayName?: string,
    initialState?: { isPinned: boolean },
  ) => string | null;
}): Promise<string> {
  if (!window.electronAPI?.documentSync) {
    throw new Error('Document sync API not available. Is the app fully loaded?');
  }

  const result = await window.electronAPI.documentSync.open(
    options.workspacePath,
    options.documentId,
    options.title,
    options.documentType,
  );

  if (!result.success || !result.config) {
    throw new Error(result.error || 'Failed to resolve collaborative document config');
  }

  const { orgId, documentId, title, orgKeyBase64, legacyOrgKeyBase64, legacyOrgKeysBase64, serverUrl, accountId, userId, userName, userEmail, pendingUpdateBase64 } = result.config;
  const documentType = options.documentType ?? result.config.documentType;
  const serverManaged = result.config.keyCustody === 'server-managed';

  // Reconstruct CryptoKey from raw base64 (legacy only; server-managed has none)
  const documentKey = serverManaged ? undefined : await importOrgKeyFromBase64(orgKeyBase64);
  // Every candidate legacy org-key epoch for reading pre-migration rows in
  // server-managed mode -- rows may span rotated epochs (NIM-878 / NIM-959).
  const legacyDocumentKeys = serverManaged
    ? await importLegacyOrgKeys(legacyOrgKeysBase64, legacyOrgKeyBase64)
    : [];

  // Build the real URI now that we have orgId
  const realUri = buildCollabUri(orgId, documentId);
  logger.ui.info('[collabDocumentOpener] Opening collaborative document:', realUri);

  // Use IPC-proxied WebSocket when the proxy API is available
  // (Cloudflare blocks browser WebSocket upgrades to sync.nimbalyst.com)
  const hasWsProxy = !!window.electronAPI?.documentSync?.wsConnect;

  const tabId = openCollabDocument({
    workspacePath: options.workspacePath,
    orgId,
    documentId,
    title: getSharedDocumentDisplayName(options.title || title, documentId),
    displayPath: options.displayPath || (
      options.title && options.title !== documentId ? options.title : undefined
    ),
    documentType,
    metadataVersion: options.metadataVersion,
    fileExtension: options.fileExtension,
    editorId: options.editorId,
    isPinned: options.isPinned,
    keyCustody: serverManaged ? 'server-managed' : 'legacy-e2e',
    documentKey,
    legacyDocumentKey: legacyDocumentKeys[0],
    legacyDocumentKeys,
    serverUrl,
    accountId,
    userId,
    userName,
    userEmail,
    initialContent: options.initialContent,
    pendingUpdateBase64,
    createWebSocket: hasWsProxy ? createProxiedWebSocket : undefined,
    getJwt: async (opts) => {
      const jwtResult = await window.electronAPI.documentSync.getJwt(orgId, opts?.forceRefresh);
      if (!jwtResult.success || !jwtResult.jwt) {
        throw new Error(`Failed to get JWT: ${jwtResult.error}`);
      }
      return jwtResult.jwt;
    },
    addTab: options.addTab,
  });

  if (!tabId) {
    throw new Error(`Failed to open collaborative document ${realUri}`);
  }

  return tabId;
}
