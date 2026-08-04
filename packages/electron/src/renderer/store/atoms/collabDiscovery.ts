/** Electron compatibility shim for package-owned Shared Docs discovery state. */

import type { CollabScope } from '@nimbalyst/collab-client/core';
import {
  getFavoriteDocumentIdsForScopeKey,
  type CollabDiscoveryState,
} from '@nimbalyst/collab-client/docs';
import { getElectronCollabDocsSession } from './collabDocuments';

export {
  changedDocIdsAtom,
  changedSharedDocsAtom,
  classifyChangedDocs,
  collabFavoritesAtom,
  collabTreeFilterAtom,
  docOpenedAtAtom,
  favoriteSharedDocsAtom,
  recentSharedDocsAtom,
  selectFavoriteDocs,
  selectRecentDocs,
  showUnreadBubblesAtom,
} from '@nimbalyst/collab-client/docs';
export type {
  ChangedSharedDoc,
  CollabDiscoveryState,
  CollabTreeFilter,
  DocFreshness,
} from '@nimbalyst/collab-client/docs';

export function toggleFavoriteDoc(scope: CollabScope, documentId: string): void {
  getElectronCollabDocsSession(scope).toggleFavorite(documentId);
}

export function isDocFavorited(scope: CollabScope, documentId: string): boolean {
  return getFavoriteDocumentIdsForScopeKey(scope.scopeKey).includes(documentId);
}

export function recordDocOpened(scope: CollabScope, documentId: string): void {
  getElectronCollabDocsSession(scope).recordOpened(documentId);
}

export function markAllSharedDocsViewed(scope: CollabScope): Promise<void> {
  return getElectronCollabDocsSession(scope).markAllDocumentsViewed();
}

export function hydrateCollabDiscovery(
  scope: CollabScope,
  state: Partial<CollabDiscoveryState> | undefined | null,
): void {
  getElectronCollabDocsSession(scope).hydrateViewPreferences(state);
}

export function hydrateCollabPersonalState(scope: CollabScope): Promise<void> {
  return getElectronCollabDocsSession(scope).hydratePersonalState();
}

/** Discovery families are pruned with the owning package session. */
export function pruneCollabDiscoveryState(_scopeKey: string): void {}
