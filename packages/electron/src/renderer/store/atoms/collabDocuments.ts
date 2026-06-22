/**
 * Shared Collaborative Documents Atoms
 *
 * Manages the list of documents shared to team for the current workspace.
 * Backed by the TeamRoom Durable Object for real-time team-wide sync.
 * Falls back gracefully if team/auth is not available.
 *
 * Multi-project keep-warm: provider instances and per-workspace state are
 * stored in maps keyed by workspace path. The active project's data is
 * exposed via derived atoms so existing UI consumers do not need to change.
 */

import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';
import { store } from '@nimbalyst/runtime/store';
import type { TeamSyncProvider as TeamSyncProviderType } from '@nimbalyst/runtime/sync';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import { collabKeyRotationEpochAtom } from './collabEditor';
import { activeWorkspacePathAtom } from './openProjects';

// ============================================================
// Types
// ============================================================

export interface SharedDocument {
  documentId: string;
  title: string;
  documentType: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /**
   * True when the doc index entry's encrypted title could not be decrypted.
   * Rendered as a locked placeholder in the sidebar; not openable.
   */
  decryptFailed?: boolean;
}

type TeamSyncStatus = 'disconnected' | 'connecting' | 'syncing' | 'connected' | 'error';

// ============================================================
// Per-workspace atom families
// ============================================================

const sharedDocumentsAtomFamily = atomFamily((_workspacePath: string) =>
  atom<SharedDocument[]>([])
);

const teamSyncStatusAtomFamily = atomFamily((_workspacePath: string) =>
  atom<TeamSyncStatus>('disconnected')
);

const workspaceHasTeamAtomFamily = atomFamily((_workspacePath: string) =>
  atom<boolean>(false)
);

const teamOrgIdAtomFamily = atomFamily((_workspacePath: string) =>
  atom<string | null>(null)
);

// ============================================================
// Public atoms — derived from the active workspace
// ============================================================

/**
 * List of shared collaborative documents for the active workspace.
 * Populated from TeamRoom on connect, updated via broadcasts.
 */
export const sharedDocumentsAtom = atom<SharedDocument[], [SharedDocument[] | ((current: SharedDocument[]) => SharedDocument[])], void>(
  (get) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return [];
    return get(sharedDocumentsAtomFamily(path));
  },
  (get, set, valueOrUpdater) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return;
    const target = sharedDocumentsAtomFamily(path);
    if (typeof valueOrUpdater === 'function') {
      set(target, valueOrUpdater(get(target)));
    } else {
      set(target, valueOrUpdater);
    }
  }
);

/**
 * Connection status for the active workspace's team sync provider.
 */
export const teamSyncStatusAtom = atom<TeamSyncStatus, [TeamSyncStatus], void>(
  (get) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return 'disconnected';
    return get(teamSyncStatusAtomFamily(path));
  },
  (get, set, value) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return;
    set(teamSyncStatusAtomFamily(path), value);
  }
);

/**
 * Whether the active workspace has an active team configured.
 * Set to true when initSharedDocuments successfully resolves team config,
 * false when no team is found. Used to conditionally show team-only UI
 * (e.g., the collab mode nav button).
 */
export const workspaceHasTeamAtom = atom<boolean, [boolean], void>(
  (get) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return false;
    return get(workspaceHasTeamAtomFamily(path));
  },
  (get, set, value) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return;
    set(workspaceHasTeamAtomFamily(path), value);
  }
);

/**
 * The team org ID currently in use for the active workspace, if it has a team.
 * Populated alongside team sync initialization. Used to build shareable deep
 * links to shared documents.
 */
export const activeTeamOrgIdAtom = atom<string | null>((get) => {
  const path = get(activeWorkspacePathAtom);
  if (!path) return null;
  return get(teamOrgIdAtomFamily(path));
});

/**
 * Build a deep link to a shared document. The recipient's Nimbalyst app uses
 * the orgId to find the matching team workspace and verify access.
 */
export function buildSharedDocumentDeepLink(documentId: string, orgId: string): string {
  return `nimbalyst://doc/${encodeURIComponent(documentId)}?orgId=${encodeURIComponent(orgId)}`;
}

/**
 * Build a deep link to a tracker item. Same routing semantics as shared
 * documents: the recipient's app uses the orgId to find the matching team
 * workspace and opens the tracker in tracker mode.
 */
export function buildTrackerDeepLink(trackerId: string, orgId: string): string {
  return `nimbalyst://tracker/${encodeURIComponent(trackerId)}?orgId=${encodeURIComponent(orgId)}`;
}

/**
 * Pending document to auto-open in CollabMode after switching modes.
 * Set by "Share to Team" action, consumed by CollabMode on activation.
 * Cleared after consumption. Carries initialContent for first-time shares
 * so the collaborative document can be seeded with file content.
 *
 * Single-shot signal; not workspace-scoped.
 */
export interface PendingCollabDocument {
  documentId: string;
  initialContent?: string;
  /**
   * Logical document type for routing. Defaults to 'markdown' for backward
   * compatibility with the original share flow. For non-markdown shares
   * (Excalidraw, Mindmap, etc.) the share callsite supplies the extension
   * so the recipient can route to the right editor on first open.
   */
  documentType?: string;
}
export const pendingCollabDocumentAtom = atom<PendingCollabDocument | null>(null);

// ============================================================
// Provider Instances (per workspace)
// ============================================================

const providersByPath = new Map<string, TeamSyncProviderType>();
const pendingRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Get the TeamSyncProvider instance for a workspace.
 *
 * @param workspacePath When omitted, returns the provider for the active
 *   workspace. Pass an explicit path to address an inactive (warm) project.
 */
export function getTeamSyncProvider(workspacePath?: string): TeamSyncProviderType | null {
  const path = workspacePath ?? store.get(activeWorkspacePathAtom);
  if (!path) return null;
  return providersByPath.get(path) ?? null;
}

// ============================================================
// Write Atoms
// ============================================================

/**
 * Add a shared document to the local list (optimistic update).
 * Use registerDocumentInIndex() to also register on the server.
 */
export const addSharedDocumentAtom = atom(
  null,
  (_get, set, doc: SharedDocument) => {
    set(sharedDocumentsAtom, (current) => {
      const filtered = current.filter(d => d.documentId !== doc.documentId);
      return [doc, ...filtered];
    });
  }
);

// ============================================================
// Server Registration
// ============================================================

/**
 * Register a document in the server-side doc index.
 * If connected to TeamRoom, encrypts the title and sends to server.
 * Also adds to local atom optimistically.
 */
export async function registerDocumentInIndex(
  documentId: string,
  title: string,
  documentType: string = 'markdown'
): Promise<void> {
  const now = Date.now();
  store.set(sharedDocumentsAtom, (current) => {
    const filtered = current.filter(d => d.documentId !== documentId);
    return [{
      documentId,
      title,
      documentType,
      createdBy: '',
      createdAt: now,
      updatedAt: now,
    }, ...filtered];
  });

  const provider = getTeamSyncProvider();
  if (provider) {
    try {
      await provider.registerDocument(documentId, title, documentType);
    } catch (err) {
      console.error('[collabDocuments] Failed to register in index:', err);
    }
  }
}

/**
 * Update a shared document title/path in the server-side index and local atom.
 * Used for rename and tree move operations.
 */
export async function updateSharedDocumentTitle(
  documentId: string,
  title: string
): Promise<void> {
  const now = Date.now();

  store.set(sharedDocumentsAtom, (current) => {
    const existing = current.find(doc => doc.documentId === documentId);
    if (!existing) {
      return current;
    }

    const filtered = current.filter(doc => doc.documentId !== documentId);
    return [{
      ...existing,
      title,
      updatedAt: now,
    }, ...filtered];
  });

  const provider = getTeamSyncProvider();
  if (provider) {
    try {
      await provider.updateDocumentTitle(documentId, title);
    } catch (err) {
      console.error('[collabDocuments] Failed to update document title:', err);
    }
  }
}

// ============================================================
// Removal
// ============================================================

/**
 * Remove a shared document from the server-side index and local atom.
 * Sends a docIndexRemove message to the TeamRoom via the provider.
 */
export function removeSharedDocument(documentId: string): void {
  store.set(sharedDocumentsAtom, (current) =>
    current.filter(d => d.documentId !== documentId)
  );

  const provider = getTeamSyncProvider();
  if (provider) {
    try {
      provider.removeDocument(documentId);
    } catch (err) {
      console.error('[collabDocuments] Failed to remove document from index:', err);
    }
  }
}

// ============================================================
// Initialization
// ============================================================

/**
 * Initialize shared documents by connecting to the TeamRoom.
 * Resolves auth/keys via IPC, then creates and connects a TeamSyncProvider.
 * The TeamRoom provides both team state and document index in a single WebSocket.
 *
 * Multi-project: a provider is created per workspace path. Calling this for
 * a workspace that already has a connected provider is a no-op. Switching
 * the active project does not tear down inactive providers.
 */
export async function initSharedDocuments(workspacePath: string, retryCount = 0): Promise<void> {
  if (providersByPath.has(workspacePath)) {
    return;
  }

  const existingRetry = pendingRetryTimers.get(workspacePath);
  if (existingRetry) {
    clearTimeout(existingRetry);
    pendingRetryTimers.delete(workspacePath);
  }

  if (!window.electronAPI?.documentSync?.resolveIndexConfig) {
    return;
  }

  try {
    const result = await window.electronAPI.documentSync.resolveIndexConfig(workspacePath);
    if (!result.success || !result.config) {
      const isNotAuthenticated = result.error?.includes('Not authenticated');
      const isNoTeam = result.error?.includes('No team found');
      const isTransient = result.error && !isNotAuthenticated && !isNoTeam;
      if (!isTransient) {
        store.set(workspaceHasTeamAtomFamily(workspacePath), false);
      }
      const maxRetries = 5;
      if (isTransient && retryCount < maxRetries) {
        const delayMs = Math.min(3000 * Math.pow(2, retryCount), 30000);
        const timer = setTimeout(() => {
          pendingRetryTimers.delete(workspacePath);
          initSharedDocuments(workspacePath, retryCount + 1);
        }, delayMs);
        pendingRetryTimers.set(workspacePath, timer);
      }
      return;
    }

    store.set(workspaceHasTeamAtomFamily(workspacePath), true);
    const { orgId, teamProjectId, keyCustody, orgKeyBase64, orgKeyFingerprint, serverUrl, userId, personalOrgId } = result.config;
    store.set(teamOrgIdAtomFamily(workspacePath), orgId);

    const { TeamSyncProvider } = await import('@nimbalyst/runtime/sync');

    // Epic H2: server-managed teams sync doc-index titles as plaintext (the
    // server encrypts at rest with the team DEK), so there is no org key to
    // import.
    const serverManaged = keyCustody === 'server-managed';
    const encryptionKey = serverManaged
      ? undefined
      : await crypto.subtle.importKey(
          'raw',
          Uint8Array.from(atob(orgKeyBase64), c => c.charCodeAt(0)),
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        );

    const provider = new TeamSyncProvider({
      serverUrl,
      orgId,
      // Epic H3 P0/A: tag doc-index registers with the resolved project so the
      // server's project-partitioned index attributes docs to the right project.
      teamProjectId,
      userId,
      // Announced to the TeamRoom on connect so inbox-event fanout can reach
      // this member's PersonalIndexRoom. Undefined when personal sync is not
      // yet configured locally.
      personalOrgId,
      keyCustody: serverManaged ? 'server-managed' : 'legacy-e2e',
      encryptionKey,
      orgKeyFingerprint,
      getJwt: async () => {
        const jwtResult = await window.electronAPI.documentSync.getJwt(orgId);
        if (!jwtResult.success || !jwtResult.jwt) {
          throw new Error(jwtResult.error || 'Failed to get JWT');
        }
        return jwtResult.jwt;
      },

      onTeamStateLoaded: (state) => {
        if (state.documents.length > 0) {
          store.set(sharedDocumentsAtomFamily(workspacePath), state.documents.map(d => ({
            documentId: d.documentId,
            title: d.title,
            documentType: d.documentType,
            createdBy: d.createdBy,
            createdAt: d.createdAt,
            updatedAt: d.updatedAt,
            decryptFailed: d.decryptFailed,
          })));
        }
      },

      onDocumentsLoaded: (documents) => {
        store.set(sharedDocumentsAtomFamily(workspacePath), documents.map(d => ({
          documentId: d.documentId,
          title: d.title,
          documentType: d.documentType,
          createdBy: d.createdBy,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
          decryptFailed: d.decryptFailed,
        })));
      },

      onDocumentChanged: (document) => {
        store.set(sharedDocumentsAtomFamily(workspacePath), (current) => {
          const filtered = current.filter(d => d.documentId !== document.documentId);
          return [{
            documentId: document.documentId,
            title: document.title,
            documentType: document.documentType,
            createdBy: document.createdBy,
            createdAt: document.createdAt,
            updatedAt: document.updatedAt,
            decryptFailed: document.decryptFailed,
          }, ...filtered];
        });
      },

      onDocumentRemoved: (documentId) => {
        store.set(sharedDocumentsAtomFamily(workspacePath), (current) =>
          current.filter(d => d.documentId !== documentId)
        );
      },

      onMemberAdded: (member) => {
        (window as any).electronAPI.team.autoWrapNewMembers(orgId).catch((err: unknown) => {
          console.error('[collabDocuments] auto-wrap after memberAdded failed:', err);
        });
        // Epic H1: keep the local org_members projection live.
        (window as any).electronAPI.org
          .applyMemberUpserted(orgId, member.userId, member.email ?? null, member.role)
          .catch((err: unknown) => {
            console.error('[collabDocuments] applyMemberUpserted failed:', err);
          });
      },

      onMemberRoleChanged: (userId, role) => {
        (window as any).electronAPI.org
          .applyMemberRoleChanged(orgId, userId, role)
          .catch((err: unknown) => {
            console.error('[collabDocuments] applyMemberRoleChanged failed:', err);
          });
      },

      onMemberRemoved: (userId) => {
        (window as any).electronAPI.org
          .applyMemberRemoved(orgId, userId)
          .catch((err: unknown) => {
            console.error('[collabDocuments] applyMemberRemoved failed:', err);
          });
      },

      onProjectAccessChanged: (projectId, userId, projectRole) => {
        (window as any).electronAPI.org
          .applyProjectAccess(projectId, userId, projectRole)
          .catch((err: unknown) => {
            console.error('[collabDocuments] applyProjectAccess failed:', err);
          });
      },

      onIdentityKeyUploaded: (_userId) => {
        (window as any).electronAPI.team.autoWrapNewMembers(orgId).catch((err: unknown) => {
          console.error('[collabDocuments] auto-wrap after identityKeyUploaded failed:', err);
        });
      },

      onOrgKeyRotated: (fingerprint) => {
        // The org encryption key was rotated. ALL providers holding the old
        // key must be torn down and recreated with the new key.
        errorNotificationService.showInfo(
          'Team encryption key updated',
          'Reconnecting with the new key...',
          { duration: 5000 }
        );

        (window as any).electronAPI.invoke('team:handle-org-key-rotated', orgId, fingerprint)
          .then(async (result: { success: boolean; keyRefreshed?: boolean; error?: string }) => {
            if (result?.success && result.keyRefreshed) {
              destroyTeamSync(workspacePath);
              await initSharedDocuments(workspacePath);

              try {
                (window as any).electronAPI.invoke('tracker-sync:restart-for-workspace', workspacePath);
              } catch (trackerErr) {
                console.error('[collabDocuments] Failed to restart tracker sync:', trackerErr);
              }

              store.set(collabKeyRotationEpochAtom, (prev: number) => prev + 1);

              errorNotificationService.showInfo(
                'Encryption key updated',
                'All sync providers reconnected with the new key.',
                { duration: 5000 }
              );
            } else if (result?.success && !result.keyRefreshed) {
              errorNotificationService.showWarning(
                'Waiting for updated key',
                'An admin needs to share the updated encryption key with you. Some items may be temporarily unreadable.',
                { duration: 10000 }
              );
            }
          })
          .catch((err: unknown) => {
            console.error('[collabDocuments] Failed to handle org key rotation:', err);
            errorNotificationService.showWarning(
              'Key rotation failed',
              'Failed to fetch the updated encryption key. Try reopening the workspace.',
              { duration: 10000 }
            );
          });
      },

      onStatusChange: (status) => {
        store.set(teamSyncStatusAtomFamily(workspacePath), status);
      },
    });

    // Connect first; only cache the provider once it has actually attached.
    // Caching before connect leaves a dead provider in the map if connect()
    // throws, and `initSharedDocuments` short-circuits on subsequent calls
    // for that path because `providersByPath.has(...)` returns true. The
    // user is then unable to retry team sync for that workspace without
    // reopening it.
    try {
      await provider.connect();
      providersByPath.set(workspacePath, provider);
    } catch (connectErr) {
      provider.destroy();
      throw connectErr;
    }
  } catch (err) {
    console.error('[collabDocuments] Failed to initialize team sync:', err);
    store.set(teamSyncStatusAtomFamily(workspacePath), 'error');
  }
}

/**
 * Disconnect and clean up a workspace's team sync provider.
 *
 * @param workspacePath When omitted, destroys the active workspace's
 *   provider. Pass an explicit path to tear down a warm (inactive) project,
 *   for example when removing it from the project rail.
 */
export function destroyTeamSync(workspacePath?: string): void {
  const path = workspacePath ?? store.get(activeWorkspacePathAtom);
  if (!path) return;

  const provider = providersByPath.get(path);
  if (!provider) return;

  provider.destroy();
  providersByPath.delete(path);

  const retryTimer = pendingRetryTimers.get(path);
  if (retryTimer) {
    clearTimeout(retryTimer);
    pendingRetryTimers.delete(path);
  }

  store.set(teamSyncStatusAtomFamily(path), 'disconnected');
  store.set(workspaceHasTeamAtomFamily(path), false);
  store.set(teamOrgIdAtomFamily(path), null);
}

/**
 * Drop every cached collab/team-sync slot for `workspacePath`. Use when a
 * project is closed from the rail so we don't leak atom-family entries or
 * a connected provider after `destroyTeamSync` has run.
 */
export function pruneCollabDocumentsWorkspaceState(workspacePath: string): void {
  // Provider should already have been torn down via destroyTeamSync; if it
  // is still around, clean it up now.
  const provider = providersByPath.get(workspacePath);
  if (provider) {
    try {
      provider.destroy();
    } catch (err) {
      console.error('[collabDocuments] destroy during prune failed:', err);
    }
    providersByPath.delete(workspacePath);
  }
  const retryTimer = pendingRetryTimers.get(workspacePath);
  if (retryTimer) {
    clearTimeout(retryTimer);
    pendingRetryTimers.delete(workspacePath);
  }
  sharedDocumentsAtomFamily.remove(workspacePath);
  teamSyncStatusAtomFamily.remove(workspacePath);
  workspaceHasTeamAtomFamily.remove(workspacePath);
}
