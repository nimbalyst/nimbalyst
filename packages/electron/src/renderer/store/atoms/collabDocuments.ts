/**
 * Electron compatibility exports for package-owned collaborative-document state.
 *
 * Atom creation, per-scope state, derivations, and commands live in
 * `@nimbalyst/collab-client/docs`. This module only binds those shared objects
 * to the Electron host and retains desktop deep-link compatibility helpers.
 */

import { atom } from 'jotai';
import type { TeamSyncProvider as TeamSyncProviderType } from '@nimbalyst/runtime/sync';
import type { CollabScope } from '@nimbalyst/collab-client/core';
import {
  createCollabDocsSession,
  getCollabDocsSession,
  getSharedDocumentsForScopeKey,
  getSharedFoldersForScopeKey,
  pruneCollabDocsSession,
  setCollabScopeAvailability,
  type CollabDocsSession,
} from '@nimbalyst/collab-client/docs';
import { ElectronCollabHost } from '../../services/ElectronCollabHost';
import { pendingDocRegistrations } from './pendingDocRegistrations';
import type { CollabDocumentOpenSource } from '../../utils/collabDocumentOpener';
export {
  buildSharedDocumentDeepLink,
  buildSharedFolderDeepLink,
  buildTrackerDeepLink,
  buildTrackerDocumentDeepLink,
  type BuildTrackerDeepLinkOptions,
} from '../../utils/collabArtifactDeepLinks';

export type { SharedDocument, SharedFolder } from '@nimbalyst/collab-client/docs';
export {
  activeCollabScopeAtom,
  activeTeamOrgIdAtom,
  activeTeamUserIdAtom,
  addSharedDocumentAtom,
  allSharedDocumentsAtom,
  buildMigratedFolderRows,
  collectFolderSubtree,
  deriveVirtualFolderStructure,
  isDescendantFolder,
  mergeSharedDocument,
  mergeSharedFolder,
  pendingCollabFolderAtom,
  reconcileSharedDocuments,
  reconcileSharedFolders,
  sharedDocumentsAtom,
  sharedFoldersAtom,
  teamSyncStatusAtom,
  trashedSharedDocumentsAtom,
  workspaceHasTeamAtom,
  getSharedDocumentsForScopeKey,
  getSharedFoldersForScopeKey,
} from '@nimbalyst/collab-client/docs';

const hostsByScope = new Map<string, ElectronCollabHost>();

function getOrCreateElectronHost(scopeKey: string): ElectronCollabHost {
  let host = hostsByScope.get(scopeKey);
  if (!host) {
    host = new ElectronCollabHost({ scopeKey });
    hostsByScope.set(scopeKey, host);
  }
  return host;
}

export function getElectronCollabHostForScopeKey(scopeKey: string): ElectronCollabHost {
  return getOrCreateElectronHost(scopeKey);
}

export function rebindElectronCollabHostScope(host: ElectronCollabHost, scopeKey: string): void {
  for (const [registeredScopeKey, registeredHost] of hostsByScope) {
    if (registeredHost === host && registeredScopeKey !== scopeKey) {
      hostsByScope.delete(registeredScopeKey);
    }
  }
  hostsByScope.set(scopeKey, host);
  host.setScopeKey(scopeKey);
}

export function getElectronCollabHost(scope: CollabScope): ElectronCollabHost {
  return getOrCreateElectronHost(scope.scopeKey);
}

export function getElectronCollabDocsSession(scope: CollabScope): CollabDocsSession {
  const existing = getCollabDocsSession(scope.scopeKey);
  if (existing) return existing;
  const host = getOrCreateElectronHost(scope.scopeKey);
  return createCollabDocsSession(scope, host.documents.dataSource, host);
}

export function getSharedDocumentsForScope(scope: CollabScope) {
  return getSharedDocumentsForScopeKey(scope.scopeKey);
}

export function getSharedFoldersForScope(scope: CollabScope) {
  return getSharedFoldersForScopeKey(scope.scopeKey);
}

export async function resolveDesktopCollabScope(scopeKey: string): Promise<{
  scope: CollabScope | null;
  retryable: boolean;
}> {
  if (!window.electronAPI?.documentSync?.resolveIndexConfig) {
    return { scope: null, retryable: false };
  }
  try {
    const scope = await getOrCreateElectronHost(scopeKey).resolveScope();
    setCollabScopeAvailability(scopeKey, true);
    return { scope, retryable: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = !message.includes('Not authenticated') && !message.includes('No team found');
    if (!retryable) setCollabScopeAvailability(scopeKey, false);
    return { scope: null, retryable };
  }
}

export async function initSharedDocuments(scope: CollabScope): Promise<void> {
  const session = getElectronCollabDocsSession(scope);
  try {
    await session.start();
  } catch (error) {
    console.error('[collabDocuments] Failed to initialize team sync:', error);
    return;
  }
  const provider = getTeamSyncProvider(scope);
  if (!provider) return;
  void pendingDocRegistrations.flush(scope.scopeKey, provider)
    .then(({ flushed, failed }) => {
      if (flushed > 0) {
        console.log(`[collabDocuments] Flushed ${flushed} pending doc registration(s) for scope ${scope.scopeKey}`);
      }
      if (failed.length > 0) {
        console.warn(`[collabDocuments] ${failed.length} pending doc registration(s) still unsent for scope ${scope.scopeKey}`);
      }
    })
    .catch((error) => console.warn('[collabDocuments] Failed to flush pending registrations:', error));
}

export function getTeamSyncProvider(scope: CollabScope): TeamSyncProviderType | null {
  return hostsByScope.get(scope.scopeKey)
    ?.peekInProcessDocumentsDataSource()
    ?.getProvider() ?? null;
}

export function getTeamSyncProviderForScopeKey(scopeKey: string): TeamSyncProviderType | null {
  return hostsByScope.get(scopeKey)
    ?.peekInProcessDocumentsDataSource()
    ?.getProvider() ?? null;
}

export async function refreshSharedFolders(scope: CollabScope): Promise<boolean> {
  return getElectronCollabDocsSession(scope).refreshFolders();
}

/**
 * Resolves `true` when the server confirmed the index row is committed, so a
 * caller that is about to seed the document's room knows it is reachable
 * (NIM-2472). A queued/unacked registration resolves `false` rather than
 * throwing — the mutation is idempotent and the offline queue still carries it.
 */
export async function registerDocumentInIndex(
  scope: CollabScope,
  documentId: string,
  title: string,
  documentType = 'markdown',
  parentFolderId: string | null = null,
  metadata?: { metadataVersion: 2; fileExtension: string; editorId: string },
): Promise<boolean> {
  try {
    return await getElectronCollabDocsSession(scope).registerDocument({
      documentId,
      title,
      documentType,
      parentFolderId,
      metadata,
    });
  } catch (error) {
    console.error('[collabDocuments] Failed to register in index:', error);
    pendingDocRegistrations.enqueue(scope.scopeKey, {
      documentId,
      title,
      documentType,
      parentFolderId,
      ...metadata,
    });
    return false;
  }
}

export function updateSharedDocumentTitle(scope: CollabScope, documentId: string, title: string) {
  return getElectronCollabDocsSession(scope).updateDocumentTitle(documentId, title);
}

export function removeSharedDocument(scope: CollabScope, documentId: string): void {
  getElectronCollabDocsSession(scope).removeDocument(documentId);
}

export function trashSharedDocument(scope: CollabScope, documentId: string): void {
  getElectronCollabDocsSession(scope).trashDocument(documentId);
}

export function restoreSharedDocument(scope: CollabScope, documentId: string): void {
  getElectronCollabDocsSession(scope).restoreDocument(documentId);
}

export function emptySharedDocumentTrash(scope: CollabScope): number {
  return getElectronCollabDocsSession(scope).emptyTrash();
}

export function moveSharedDocument(
  scope: CollabScope,
  documentId: string,
  parentFolderId: string | null,
): void {
  getElectronCollabDocsSession(scope).moveDocument(documentId, parentFolderId);
}

export function createSharedFolder(
  scope: CollabScope,
  name: string,
  parentFolderId: string | null = null,
) {
  return getElectronCollabDocsSession(scope).createFolder(name, parentFolderId);
}

export function renameSharedFolder(
  scope: CollabScope,
  folderId: string,
  name: string,
) {
  return getElectronCollabDocsSession(scope).renameFolder(folderId, name);
}

export function renameLegacyCollabFolder(
  scope: CollabScope,
  path: string,
  name: string,
) {
  return getElectronCollabDocsSession(scope).renameLegacyFolder(path, name);
}

export function moveSharedFolder(
  scope: CollabScope,
  folderId: string,
  parentFolderId: string | null,
): void {
  getElectronCollabDocsSession(scope).moveFolder(folderId, parentFolderId);
}

export function removeSharedFolder(scope: CollabScope, folderId: string): void {
  getElectronCollabDocsSession(scope).removeFolder(folderId);
}

export function destroyTeamSync(scope: CollabScope): void {
  getCollabDocsSession(scope.scopeKey)?.dispose();
}

export function pruneCollabDocumentsScopeState(scopeKey: string): void {
  pruneCollabDocsSession(scopeKey);
  hostsByScope.delete(scopeKey);
}

export interface PendingCollabDocument {
  scopeKey: string;
  orgId: string;
  documentId: string;
  initialContent?: string;
  documentType?: string;
  metadataVersion?: 2;
  fileExtension?: string;
  editorId?: string;
  analyticsSource?: CollabDocumentOpenSource;
}

export const pendingCollabDocumentAtom = atom<PendingCollabDocument | null>(null);
