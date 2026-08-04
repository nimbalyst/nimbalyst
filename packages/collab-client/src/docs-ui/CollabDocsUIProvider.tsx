import React, { createContext, useContext, useMemo } from 'react';
import { Provider as JotaiProvider, atom, useAtomValue, type Atom } from 'jotai';
import { getSharedDocumentDisplayName } from '@nimbalyst/collab-client/docs';
import type { CollabHost, CollabScope } from '@nimbalyst/collab-client/core';
import type {
  CollabDocsSession,
  SharedDocument,
  SharedFolder,
} from '@nimbalyst/collab-client/docs';
import { store } from '@nimbalyst/runtime/store';

export type { CollabTreeFilter, CollabDocsUIStatus, PendingCollabFolder } from '@nimbalyst/collab-client/docs';

export interface CollabLocalOriginActions {
  available: boolean;
  binding: unknown | null;
  busyAction: string | null;
  hasResolvedBinding: boolean;
  openLocalSource(): Promise<boolean>;
  relinkLocalSource(): Promise<boolean>;
  clearLocalSource(): Promise<boolean>;
  reuploadFromLocalSource(): Promise<boolean>;
}

export interface SharedDocumentCleanupProgress {
  checked: number;
  total: number;
}

export interface CollabDocsUIController {
  /** Desktop-only local-file actions; omitted by browser/mobile hosts. */
  useLocalOrigin?(
    scopeKey: string,
    documentId: string | null | undefined,
    documentType?: string,
  ): CollabLocalOriginActions;
  cleanupEmptyDocuments?(
    scope: CollabScope,
    documents: SharedDocument[],
    onProgress: (progress: SharedDocumentCleanupProgress | null) => void,
  ): Promise<{ moved: number; failed: number }>;
}

interface CollabDocsUIContextValue {
  scope: CollabScope;
  host: CollabHost;
  session: CollabDocsSession;
  controller: CollabDocsUIController;
}

const CollabDocsUIContext = createContext<CollabDocsUIContextValue | null>(null);

export interface CollabDocsUIProviderProps {
  session: CollabDocsSession;
  controller?: CollabDocsUIController;
  children: React.ReactNode;
}

export function CollabDocsUIProvider({
  session,
  controller,
  children,
}: CollabDocsUIProviderProps) {
  return (
    <JotaiProvider store={store}>
      <CollabDocsUIContext.Provider value={{
        scope: session.scope,
        host: session.host,
        session,
        controller: controller ?? {},
      }}>
        {children}
      </CollabDocsUIContext.Provider>
    </JotaiProvider>
  );
}

export function useCollabDocsUI(): CollabDocsUIContextValue {
  const value = useContext(CollabDocsUIContext);
  if (!value) {
    throw new Error('Shared Docs UI must be rendered inside CollabDocsUIProvider');
  }
  return value;
}

const noSharedDocuments: Atom<SharedDocument[]> = atom<SharedDocument[]>([]);

/**
 * Display names for every shared document in the session, keyed by document id.
 *
 * For hosts that render their own tab strip or breadcrumb outside this package.
 * It exists here rather than in the host because the session's atoms belong to
 * the Jotai instance bundled with this package: a host reading them through its
 * own `jotai` import gets a second store and an empty result.
 *
 * Unlike `useCollabDocsUI` this does not throw without a provider. Callers use
 * it for labels, and an unnamed tab is a far better failure than an editor
 * route that will not render at all.
 */
export function useSharedDocumentTitles(): Map<string, string> {
  const value = useContext(CollabDocsUIContext);
  const documents = useAtomValue(value?.session.atoms.allSharedDocuments ?? noSharedDocuments);
  return useMemo(
    () => new Map(documents.map((document) => [
      document.documentId,
      getSharedDocumentDisplayName(document.title, document.documentId),
    ])),
    [documents],
  );
}

export interface SharedDocumentBreadcrumb {
  documentTitle: string | null;
  folders: Array<{ folderId: string; name: string }>;
}

const noSharedFolders: Atom<SharedFolder[]> = atom<SharedFolder[]>([]);

/** Resolved first-class folder ancestry for browser/native breadcrumb chrome. */
export function useSharedDocumentBreadcrumb(
  documentId?: string | null,
  folderId?: string | null,
): SharedDocumentBreadcrumb {
  const value = useContext(CollabDocsUIContext);
  const documents = useAtomValue(value?.session.atoms.allSharedDocuments ?? noSharedDocuments);
  const folders = useAtomValue(value?.session.atoms.sharedFolders ?? noSharedFolders);
  return useMemo(() => {
    const document = documentId
      ? documents.find(candidate => candidate.documentId === documentId) ?? null
      : null;
    const folderById = new Map(folders.map(folder => [folder.folderId, folder]));
    const ancestry: Array<{ folderId: string; name: string }> = [];
    const visited = new Set<string>();
    let currentId = document?.parentFolderId ?? folderId ?? null;
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const folder = folderById.get(currentId);
      if (!folder) break;
      ancestry.unshift({
        folderId: folder.folderId,
        name: folder.decryptFailed ? 'Locked folder' : folder.name,
      });
      currentId = folder.parentFolderId ?? null;
    }
    return {
      documentTitle: document
        ? getSharedDocumentDisplayName(document.title, document.documentId)
        : null,
      folders: ancestry,
    };
  }, [documentId, documents, folderId, folders]);
}
