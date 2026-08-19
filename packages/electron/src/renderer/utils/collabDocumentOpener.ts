/**
 * Collaborative Document Opener
 *
 * Entry point for opening collaborative documents as tabs.
 * Future UI (shared file tree, tracker sidebar) calls openCollabDocument()
 * which stores the connection config and adds a tab with a collab:// URI.
 *
 * The collab config registry is a module-level Map that TabContent reads
 * when creating a CollaborativeTabEditor instance. Every key includes the
 * host scope so identical document URIs in two mounted scopes cannot alias.
 */

import { buildCollabUri } from '@nimbalyst/collab-protocol';
import { logger } from './logger';
import { appendCollabUrlQuery, createProxiedWebSocket } from './proxiedWebSocket';
import {
  getSharedDocumentDisplayName,
  normalizeCollabPath,
  UNRESOLVED_SHARED_DOCUMENT_NAME,
} from '../components/CollabMode/collabTree';
import { toStableAnalyticsCategory } from '../../shared/analytics/teamAnalytics';
import { trackTeamAnalyticsEvent } from './teamAnalytics';
import type { CollabOpenSource, CollabScope } from '@nimbalyst/collab-client/core';
import type { TeamJwt, TeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import { resolveDesktopCollabScope } from '../store/atoms/collabDocuments';

/**
 * Configuration for opening a collaborative document.
 * Stored in the registry and passed to CollaborativeTabEditor.
 */
export interface CollabDocumentConfig {
  scope: CollabScope;
  orgId: string;
  documentId: string;
  title: string;
  /** Last-known logical path used while the shared index resolves. */
  displayPath?: string;
  serverUrl: string;
  getJwt: (opts?: { forceRefresh?: boolean }) => Promise<TeamJwt>;
  /** Optional extra query appended to revision-history HTTP requests. */
  urlExtraQuery?: string;
  teamMemberId: TeamMemberId;
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
  analyticsSource?: CollabDocumentOpenSource;
  analyticsActorType?: 'user' | 'agent';
  analyticsWasUnread?: boolean;
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
 * Keyed by opaque host scope plus collab:// URI. TabContent reads from this
 * when creating CollaborativeTabEditor instances.
 */
const collabConfigRegistry = new Map<string, CollabDocumentConfig>();

function collabConfigRegistryKey(scopeKey: string, uri: string): string {
  return `${scopeKey.length}:${scopeKey}${uri}`;
}

/**
 * Get the collab config for a URI. Returns undefined if not registered.
 */
export function getCollabConfig(scope: CollabScope, uri: string): CollabDocumentConfig | undefined {
  return getCollabConfigForScopeKey(scope.scopeKey, uri);
}

/** Host bridge for tab containers that already carry their opaque scope key. */
export function getCollabConfigForScopeKey(
  scopeKey: string,
  uri: string,
): CollabDocumentConfig | undefined {
  return collabConfigRegistry.get(collabConfigRegistryKey(scopeKey, uri));
}

/** Keep the connection config's warm display metadata current across index gaps. */
export function updateCollabConfigDisplayMetadata(
  scope: CollabScope,
  uri: string,
  metadata: { title?: string | null; displayPath?: string | null },
): void {
  const config = getCollabConfig(scope, uri);
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
export function removeCollabConfig(scope: CollabScope, uri: string): void {
  collabConfigRegistry.delete(collabConfigRegistryKey(scope.scopeKey, uri));
}

/** Remove every synthetic/real URI alias created for one document. */
export function removeCollabConfigsForDocument(
  scope: CollabScope,
  documentId: string,
): void {
  for (const [registryKey, config] of collabConfigRegistry) {
    if (config.scope.scopeKey === scope.scopeKey && config.documentId === documentId) {
      collabConfigRegistry.delete(registryKey);
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
  collabConfigRegistry.set(collabConfigRegistryKey(config.scope.scopeKey, uri), config);
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
  scope: CollabScope,
  documentId: string,
): CollabDocumentConfig | undefined {
  for (const config of collabConfigRegistry.values()) {
    if (config.documentId === documentId && config.scope.scopeKey === scope.scopeKey) {
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
 *   teamMemberId: asTeamMemberId('user-xyz'),
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
  const registryKey = collabConfigRegistryKey(config.scope.scopeKey, uri);
  collabConfigRegistry.set(registryKey, config);

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
    collabConfigRegistry.delete(registryKey);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// WebSocket proxy
// ---------------------------------------------------------------------------

// Re-exported for existing callers; the implementation lives in its own module
// so collab providers can use it without importing this file (import cycle).
export { appendCollabUrlQuery, createProxiedWebSocket };

/**
 * Resolve a collab config from the main process and populate the registry.
 * Used to restore collab tabs after refresh/HMR when the in-memory registry
 * is empty but the tab URI is still persisted.
 *
 * Returns the config on success, or null if resolution fails.
 */
export async function resolveCollabConfigForUri(
  scope: CollabScope,
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
    for (const [registeredKey, config] of collabConfigRegistry) {
      if (
        config.scope.scopeKey === scope.scopeKey &&
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
        collabConfigRegistry.delete(registeredKey);
      }
    }
  } else if (useCache) {
    // Already resolved
    const existing = getCollabConfig(scope, uri);
    if (existing) {
      if (resolvedMetadata) Object.assign(existing, resolvedMetadata);
      return existing;
    }

    // A seed/export/re-upload caller may only know the documentId (its URI is
    // `collab://seed/<documentId>`); reuse the config resolved when the doc was
    // opened rather than re-running the IPC resolution.
    const byDocument = findCollabConfigByDocumentId(scope, documentId);
    if (byDocument) {
      if (resolvedMetadata) Object.assign(byDocument, resolvedMetadata);
      return byDocument;
    }
  }

  try {
    const result = await window.electronAPI.documentSync.open(
      scope.scopeKey,
      documentId,
      title,
      documentType,
    );

    if (!result.success || !result.config) {
      logger.ui.warn('[collabDocumentOpener] Failed to resolve config for:', uri, result.error);
      return null;
    }

    const { orgId, title: resolvedTitle, serverUrl, accountId, teamMemberId, userName, userEmail, pendingUpdateBase64 } = result.config;
    if (orgId !== scope.orgId) {
      logger.ui.error('[collabDocumentOpener] Resolved document org does not match scope:', {
        documentId,
        expectedOrgId: scope.orgId,
        resolvedOrgId: orgId,
      });
      return null;
    }
    const urlExtraQuery = result.config.urlExtraQuery;
    const resolvedDocumentType = documentType ?? result.config.documentType;
    const hasWsProxy = !!window.electronAPI?.documentSync?.wsConnect;

    const config: CollabDocumentConfig = {
      scope,
      orgId,
      documentId,
      title: resolvedTitle,
      documentType: resolvedDocumentType,
      ...resolvedMetadata,
      serverUrl,
      accountId,
      teamMemberId,
      userName,
      userEmail,
      urlExtraQuery,
      pendingUpdateBase64,
      createWebSocket: hasWsProxy
        ? (url: string) => createProxiedWebSocket(appendCollabUrlQuery(url, urlExtraQuery))
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
      collabConfigRegistry.set(collabConfigRegistryKey(scope.scopeKey, realUri), config);
      // Also set with the passed-in URI in case it differs
      if (uri !== realUri) {
        collabConfigRegistry.set(collabConfigRegistryKey(scope.scopeKey, uri), config);
      }
    }

    return config;
  } catch (err) {
    logger.ui.error('[collabDocumentOpener] Failed to resolve collab config:', err);
    return null;
  }
}

/** Electron host bridge for legacy surfaces that begin with a project path. */
export async function resolveDesktopCollabConfigForUri(
  workspacePath: string,
  uri: string,
  documentId: string,
  title?: string,
  documentType?: string,
  options: {
    forceRefresh?: boolean;
    metadata?: { metadataVersion: 2; fileExtension: string; editorId: string };
    cache?: boolean;
  } = {},
): Promise<CollabDocumentConfig | null> {
  const { scope } = await resolveDesktopCollabScope(workspacePath);
  if (!scope) return null;
  return resolveCollabConfigForUri(scope, uri, documentId, title, documentType, options);
}

/** Electron host bridge for open requests originating outside Shared Docs. */
export async function openCollabDocumentViaIPCForDesktop(options: Omit<
  Parameters<typeof openCollabDocumentViaIPC>[0],
  'scope'
> & { workspacePath: string }): Promise<string> {
  const { workspacePath, ...rest } = options;
  const { scope } = await resolveDesktopCollabScope(workspacePath);
  if (!scope) throw new Error('Could not resolve collaboration scope for this project');
  return openCollabDocumentViaIPC({ ...rest, scope });
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
/**
 * Every route that can open a shared document. Required at the public open
 * seam so a new caller cannot silently land in the `home` bucket -- an
 * unattributed open used to default to `home` and inflate the Shared Docs
 * adoption numbers.
 */
export type CollabDocumentOpenSource = CollabOpenSource;

export async function openCollabDocumentViaIPC(options: {
  scope: CollabScope;
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
  /** Required: how the user reached this document. See CollabDocumentOpenSource. */
  analyticsSource: CollabDocumentOpenSource;
  analyticsActorType?: 'user' | 'agent';
  analyticsWasUnread?: boolean;
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
    options.scope.scopeKey,
    options.documentId,
    options.title,
    options.documentType,
  );

  if (!result.success || !result.config) {
    throw new Error(result.error || 'Failed to resolve collaborative document config');
  }

  const {
    orgId,
    documentId,
    title,
    serverUrl,
    accountId,
    teamMemberId,
    userName,
    userEmail,
    urlExtraQuery,
    pendingUpdateBase64,
  } = result.config;
  if (orgId !== options.scope.orgId) {
    throw new Error('Resolved collaborative document belongs to a different scope');
  }
  const documentType = options.documentType ?? result.config.documentType;

  // Build the real URI now that we have orgId
  const realUri = buildCollabUri(orgId, documentId);
  logger.ui.info('[collabDocumentOpener] Opening collaborative document:', realUri);

  // Use IPC-proxied WebSocket when the proxy API is available
  // (Cloudflare blocks browser WebSocket upgrades to sync.nimbalyst.com)
  const hasWsProxy = !!window.electronAPI?.documentSync?.wsConnect;

  const tabId = openCollabDocument({
    scope: options.scope,
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
    analyticsSource: options.analyticsSource,
    analyticsActorType: options.analyticsActorType,
    analyticsWasUnread: options.analyticsWasUnread,
    isPinned: options.isPinned,
    serverUrl,
    accountId,
    teamMemberId,
    userName,
    userEmail,
    urlExtraQuery,
    initialContent: options.initialContent,
    pendingUpdateBase64,
    createWebSocket: hasWsProxy
      ? (url: string) => createProxiedWebSocket(appendCollabUrlQuery(url, urlExtraQuery))
      : undefined,
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

  trackTeamAnalyticsEvent('collab_document_opened', {
    surface: 'desktop',
    source: options.analyticsSource,
    actorType: options.analyticsActorType ?? 'user',
    documentType: toStableAnalyticsCategory(documentType),
    editorCategory: options.editorId?.startsWith('builtin.monaco')
      ? 'monaco'
      : options.editorId?.startsWith('builtin.lexical') || documentType === 'markdown'
        ? 'lexical'
        : 'extension',
    wasUnread: options.analyticsWasUnread ?? false,
    connectionPath: 'initial',
  });

  return tabId;
}
