import React from 'react';
import type { CollabHost, CollabScope } from '../core/index';
import type { CollabDocsSession, SharedDocument } from '../docs/index';
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
export declare function useSharedDocumentTitles(): Map<string, string>;
export interface SharedDocumentBreadcrumb {
    documentTitle: string | null;
    folders: Array<{
        folderId: string;
        name: string;
    }>;
}
/** Resolved first-class folder ancestry for browser/native breadcrumb chrome. */
export declare function useSharedDocumentBreadcrumb(documentId?: string | null, folderId?: string | null): SharedDocumentBreadcrumb;
