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

/**
 * Configuration for opening a collaborative document.
 * Stored in the registry and passed to CollaborativeTabEditor.
 */
export interface CollabDocumentConfig {
  workspacePath: string;
  orgId: string;
  documentId: string;
  title: string;
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
  serverUrl: string;
  getJwt: () => Promise<string>;
  /** Optional extra query appended to revision-history HTTP requests. */
  urlExtraQuery?: string;
  userId: string;
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

/**
 * Remove a collab config when the tab is closed.
 */
export function removeCollabConfig(uri: string): void {
  collabConfigRegistry.delete(uri);
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
  addTab: (filePath: string, content?: string, switchToTab?: boolean) => string | null;
}): string {
  const { addTab, ...config } = options;
  const uri = buildCollabUri(config.orgId, config.documentId);

  // Store config for TabContent to retrieve
  collabConfigRegistry.set(uri, config);

  try {
    // Add the tab. Content is empty -- CollaborationPlugin hydrates from Y.Doc.
    // The fileName will be overridden in the tab display layer using the title.
    const tabId = addTab(uri, '', true);
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
        readyState = WebSocket.OPEN;
        eventTarget.dispatchEvent(new Event('open'));
        break;
      case 'message':
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
      readyState = WebSocket.CLOSED;
      if (wsId) {
        api.wsClose(wsId);
        cleanup();
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
      // immediately close the main-process socket and bail.
      if (closedBeforeConnected) {
        api.wsClose(wsId);
        wsPendingEvents.delete(wsId);
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
): Promise<CollabDocumentConfig | null> {
  if (!window.electronAPI?.documentSync) return null;

  // Already resolved
  const existing = collabConfigRegistry.get(uri);
  if (existing) return existing;

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

    const { orgId, title: resolvedTitle, orgKeyBase64, legacyOrgKeyBase64, orgKeyFingerprint, serverUrl, userId, userName, userEmail, pendingUpdateBase64 } = result.config;
    const resolvedDocumentType = documentType ?? result.config.documentType;
    const serverManaged = result.config.keyCustody === 'server-managed';
    const documentKey = serverManaged ? undefined : await importOrgKeyFromBase64(orgKeyBase64);
    // Server-managed docs may still serve PRE-MIGRATION legacy-e2e rows; import
    // the legacy org key (when provided) so those old rows can be decrypted (NIM-878).
    const legacyDocumentKey = serverManaged && legacyOrgKeyBase64
      ? await importOrgKeyFromBase64(legacyOrgKeyBase64)
      : undefined;
    const hasWsProxy = !!window.electronAPI?.documentSync?.wsConnect;

    const config: CollabDocumentConfig = {
      workspacePath,
      orgId,
      documentId,
      title: resolvedTitle,
      documentType: resolvedDocumentType,
      keyCustody: serverManaged ? 'server-managed' : 'legacy-e2e',
      documentKey,
      legacyDocumentKey,
      orgKeyFingerprint,
      serverUrl,
      userId,
      userName,
      userEmail,
      pendingUpdateBase64,
      createWebSocket: hasWsProxy ? createProxiedWebSocket : undefined,
      getJwt: async () => {
        const jwtResult = await window.electronAPI.documentSync.getJwt(orgId);
        if (!jwtResult.success || !jwtResult.jwt) {
          throw new Error(`Failed to get JWT: ${jwtResult.error}`);
        }
        return jwtResult.jwt;
      },
    };

    // The URI in the tab may use the real orgId already, but double-check
    const realUri = buildCollabUri(orgId, documentId);
    collabConfigRegistry.set(realUri, config);
    // Also set with the passed-in URI in case it differs
    if (uri !== realUri) {
      collabConfigRegistry.set(uri, config);
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
  initialContent?: string;
  /**
   * Logical document type used by CollaborativeTabEditor to route to the
   * right editor branch (default: 'markdown' if omitted).
   */
  documentType?: string;
  addTab: (filePath: string, content?: string, switchToTab?: boolean) => string | null;
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

  const { orgId, documentId, title, orgKeyBase64, legacyOrgKeyBase64, serverUrl, userId, userName, userEmail, pendingUpdateBase64 } = result.config;
  const documentType = options.documentType ?? result.config.documentType;
  const serverManaged = result.config.keyCustody === 'server-managed';

  // Reconstruct CryptoKey from raw base64 (legacy only; server-managed has none)
  const documentKey = serverManaged ? undefined : await importOrgKeyFromBase64(orgKeyBase64);
  // Legacy org key for reading pre-migration rows in server-managed mode (NIM-878).
  const legacyDocumentKey = serverManaged && legacyOrgKeyBase64
    ? await importOrgKeyFromBase64(legacyOrgKeyBase64)
    : undefined;

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
    title,
    documentType,
    keyCustody: serverManaged ? 'server-managed' : 'legacy-e2e',
    documentKey,
    legacyDocumentKey,
    serverUrl,
    userId,
    userName,
    userEmail,
    initialContent: options.initialContent,
    pendingUpdateBase64,
    createWebSocket: hasWsProxy ? createProxiedWebSocket : undefined,
    getJwt: async () => {
      const jwtResult = await window.electronAPI.documentSync.getJwt(orgId);
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
