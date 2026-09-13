import React from 'react';
import type { CollabHost, CollabScope } from '../core/index';
import type { CollabDocsSession, SharedDocument, SharedFolder } from '../docs/index';
export type { CollabTreeFilter, CollabDocsUIStatus, PendingCollabFolder } from '../docs/index';
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
    useLocalOrigin?(scopeKey: string, documentId: string | null | undefined, documentType?: string): CollabLocalOriginActions;
    cleanupEmptyDocuments?(scope: CollabScope, documents: SharedDocument[], onProgress: (progress: SharedDocumentCleanupProgress | null) => void): Promise<{
        moved: number;
        failed: number;
    }>;
}
interface CollabDocsUIContextValue {
    scope: CollabScope;
    host: CollabHost;
    session: CollabDocsSession;
    controller: CollabDocsUIController;
}
export interface CollabDocsUIProviderProps {
    session: CollabDocsSession;
    controller?: CollabDocsUIController;
    children: React.ReactNode;
}
export declare function CollabDocsUIProvider({ session, controller, children, }: CollabDocsUIProviderProps): React.JSX.Element;
export declare function useCollabDocsUI(): CollabDocsUIContextValue;
export declare function useSharedDocumentTitles(): Map<string, string>;
/**
 * The project's first-class folders, for a host that files a new item
 * somewhere and has no tree of its own to read them from.
 */
export declare function useSharedFolders(): SharedFolder[];
export interface SharedDocumentBreadcrumb {
    documentTitle: string | null;
    folders: Array<{
        folderId: string;
        name: string;
    }>;
}
/** Resolved first-class folder ancestry for browser/native breadcrumb chrome. */
export declare function useSharedDocumentBreadcrumb(documentId?: string | null, folderId?: string | null): SharedDocumentBreadcrumb;
