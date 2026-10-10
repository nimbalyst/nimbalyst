import { type Atom, type WritableAtom } from 'jotai';
import { type ReadReceipt, type UnreadEntitySnapshot } from '../../../runtime/src/readReceipts/readReceipts';
import { type CollabDocsCapability, type CollabHost, type CollabScope } from '../core/index';
import { type ChangedSharedDoc } from './collabDiscovery';
import type { CollabDocsDataSource } from './dataSource';
import type { PageSearchRequest, PageSearchResponse } from '@nimbalyst/collab-protocol';
import type { SharedDocument, SharedFolder, SharedItemPlacement, SharedParentKind, SharedTypePlacement } from './types';
/** Where a page moves: its parent's kind and its order there (absent = no order). */
export interface CollabPageMoveOptions {
    parentKind?: SharedParentKind;
    sortOrder?: number | null;
}
export type CollabTreeFilter = 'all' | 'favorites' | 'updated';
/**
 * Outcome of a tree write (a placement, move, rename or removal), once the
 * data source answered: `ok: false` when the store refused it or the send
 * failed. The optimistic local state is never the answer.
 */
export type CollabPlacementWriteResult = {
    ok: true;
} | {
    ok: false;
    error: string;
};
/** A restore from Trash: how many pages came back, and whether the page had to go to the section root. */
export type CollabRestoreResult = CollabPlacementWriteResult & {
    restored: number;
    movedToRoot: boolean;
};
export type CollabDocsUIStatus = 'disconnected' | 'connecting' | 'syncing' | 'connected' | 'error';
export interface CollabDiscoveryState {
    favorites?: string[];
    openedAt?: Record<string, number>;
    treeFilter: CollabTreeFilter;
    showUnreadBubbles: boolean;
    personalStateMigrationStartedAt?: number;
    personalStateMigratedAt?: number;
}
export interface PendingCollabFolder {
    scopeKey: string;
    orgId: string;
    folderId: string;
}
type DocsCapability = CollabDocsCapability<SharedDocument, SharedFolder, import('./dataSource').CollabDocsCommand, import('./dataSource').CollabDocsCommandResult>;
type DocsHost = CollabHost<DocsCapability> & {
    documents: DocsCapability;
};
type ListUpdate<T> = T[] | ((current: T[]) => T[]);
type ListAtom<T> = WritableAtom<T[], [ListUpdate<T>], void>;
/** Stable desktop compatibility selector over the package-owned active scope. */
export declare const activeCollabScopeAtom: WritableAtom<CollabScope | null, [CollabScope | null], void>;
export declare const allSharedDocumentsAtom: ListAtom<SharedDocument>;
export declare const sharedDocumentsAtom: WritableAtom<SharedDocument[], [ListUpdate<SharedDocument>], void>;
export declare const trashedSharedDocumentsAtom: Atom<SharedDocument[]>;
/**
 * The readable documents a reference in one scope can name, whether or not it
 * is the active scope: its own project's and, after them, the other projects'
 * in the same org, since a link may point at another project's page.
 *
 * `sharedDocumentsAtom` answers for the scope the window is *browsing*, which
 * a window that never mounts a Shared Docs surface never sets -- the
 * organization window is exactly that, so the active list is permanently empty
 * there. A window that holds a scope key of its own and needs the list for
 * something other than browsing it, such as resolving a document reference
 * inside a message, addresses the scope directly through this.
 *
 * Reactive, unlike `getSharedDocumentsForScopeKey`, so a document shared after
 * a reference was rendered still reaches the reference.
 */
export declare const sharedDocumentsForScopeAtom: import("jotai-family").AtomFamily<string, Atom<SharedDocument[]>>;
/** `sharedDocumentsForScopeAtom` for the active scope: what a link can open and name. */
export declare const linkableSharedDocumentsAtom: Atom<SharedDocument[]>;
export declare const sharedFoldersAtom: ListAtom<SharedFolder>;
/** Tracker types placed in the active scope's page tree, one per type. */
export declare const sharedTypePlacementsAtom: ListAtom<SharedTypePlacement>;
export declare const teamSyncStatusAtom: WritableAtom<CollabDocsUIStatus, [CollabDocsUIStatus], void>;
export declare const workspaceHasTeamAtom: WritableAtom<boolean, [boolean], void>;
export declare const activeTeamOrgIdAtom: Atom<string | null>;
export declare const activeTeamUserIdAtom: Atom<string | null>;
export declare const pendingCollabFolderAtom: import("jotai").PrimitiveAtom<PendingCollabFolder | null> & {
    init: PendingCollabFolder | null;
};
export declare const addSharedDocumentAtom: WritableAtom<null, [document: SharedDocument], void> & {
    init: null;
};
export declare const collabFavoritesAtom: Atom<string[]>;
export declare const docOpenedAtAtom: Atom<Record<string, number>>;
export declare const collabTreeFilterAtom: WritableAtom<CollabTreeFilter, [CollabTreeFilter], void>;
export declare const showUnreadBubblesAtom: WritableAtom<boolean, [boolean], void>;
export declare const docUnreadAtom: import("jotai-family").AtomFamily<string, WritableAtom<boolean, [value: boolean], void>>;
export declare const docUnreadByOrgAtom: import("jotai").PrimitiveAtom<Map<string, Set<string>>> & {
    init: Map<string, Set<string>>;
};
export declare const docReceiptsAtom: WritableAtom<Map<string, ReadReceipt>, [Map<string, ReadReceipt> | ((current: Map<string, ReadReceipt>) => Map<string, ReadReceipt>)], void>;
export declare function docSnapshot(document: SharedDocument): UnreadEntitySnapshot;
export declare const setDocUnreadAtom: WritableAtom<null, [input: {
    scopeKey?: string;
    documentId: string;
    orgId: string;
    unread: boolean;
}], void> & {
    init: null;
};
export declare const recomputeDocUnreadAtom: WritableAtom<null, [input: {
    orgId: string;
    docs: SharedDocument[];
    receipts: Map<string, ReadReceipt>;
    currentUserId: string | null;
    scopeKey?: string;
}], void> & {
    init: null;
};
export declare const applyDocReceiptAtom: WritableAtom<null, [input: {
    scopeKey?: string;
    documentId: string;
    orgId: string;
    receipt: ReadReceipt;
}], void> & {
    init: null;
};
/** Route a personal-sync document receipt by its wire-level organization scope. */
export declare const applyRemoteDocReceiptAtom: WritableAtom<null, [input: {
    documentId: string;
    orgId: string;
    receipt: ReadReceipt;
}], void> & {
    init: null;
};
export declare const favoriteSharedDocsAtom: Atom<SharedDocument[]>;
export declare const recentSharedDocsAtom: Atom<SharedDocument[]>;
export declare const changedSharedDocsAtom: Atom<ChangedSharedDoc[]>;
export declare const changedDocIdsAtom: Atom<Set<string>>;
export interface CollabDocsSessionAtoms {
    sharedDocuments: ListAtom<SharedDocument>;
    allSharedDocuments: ListAtom<SharedDocument>;
    trashedSharedDocuments: Atom<SharedDocument[]>;
    sharedFolders: ListAtom<SharedFolder>;
    typePlacements: ListAtom<SharedTypePlacement>;
    itemPlacements: ListAtom<SharedItemPlacement>;
    /** True when the tree is the one page tree (documents nest in documents). */
    pageTree: Atom<boolean>;
    /** True when this section keeps a plain page's own fields (`pageFields.ts`). */
    pageFields: Atom<boolean>;
    syncStatus: WritableAtom<CollabDocsUIStatus, [CollabDocsUIStatus], void>;
    hasTeam: WritableAtom<boolean, [boolean], void>;
    activeTeamUserId: Atom<string | null>;
    favorites: Atom<string[]>;
    changedDocumentIds: Atom<Set<string>>;
    openedAt: Atom<Record<string, number>>;
    receipts: Atom<Map<string, ReadReceipt>>;
    favoriteDocuments: Atom<SharedDocument[]>;
    recentDocuments: Atom<SharedDocument[]>;
    changedDocuments: Atom<ChangedSharedDoc[]>;
    treeFilter: WritableAtom<CollabTreeFilter, [CollabTreeFilter], void>;
    showUnreadBubbles: WritableAtom<boolean, [boolean], void>;
    pendingFolder: Atom<PendingCollabFolder | null>;
    unreadDocument(documentId: string): Atom<boolean>;
}
export interface CollabDocsUICapabilities {
    personalState: boolean;
    readReceipts: boolean;
}
export declare function mergeSharedDocument(existing: SharedDocument, incoming: SharedDocument): SharedDocument;
export declare function mergeSharedFolder(existing: SharedFolder, incoming: SharedFolder): SharedFolder;
export declare function reconcileSharedDocuments(existing: SharedDocument[], incoming: SharedDocument[]): SharedDocument[];
export declare function reconcileSharedFolders(existing: SharedFolder[], incoming: SharedFolder[]): SharedFolder[];
export declare function deriveVirtualFolderStructure(documents: SharedDocument[]): {
    folderPaths: string[];
    docParent: Map<string, string>;
};
export declare function buildMigratedFolderRows(sortedFolderPaths: string[], idByPath: Map<string, string>, createdBy: string, now: number): SharedFolder[];
export interface CollabDocsSession {
    readonly scope: CollabScope;
    readonly host: DocsHost;
    readonly dataSource: CollabDocsDataSource;
    readonly atoms: CollabDocsSessionAtoms;
    readonly uiCapabilities: CollabDocsUICapabilities;
    activate(): void;
    start(): Promise<void>;
    dispose(): void;
    persistViewPreferences(): void;
    hydrateViewPreferences(state?: Partial<CollabDiscoveryState> | null): void;
    hydratePersonalState(): Promise<void>;
    /**
     * Resolves `true` when the server confirmed the index row is committed.
     * `false` means unconfirmed, not failed — see `TeamSync.registerDocument`.
     */
    registerDocument(input: {
        documentId: string;
        title: string;
        documentType: string;
        parentFolderId: string | null;
        /** What `parentFolderId` names; absent means a page. */
        parentKind?: SharedParentKind;
        /** Absent: the end of a reordered group, or no order in a group nobody reordered. */
        sortOrder?: number | null;
        metadata?: {
            metadataVersion: 2;
            fileExtension: string;
            editorId: string;
        };
    }): Promise<boolean>;
    updateDocumentTitle(documentId: string, title: string): Promise<CollabPlacementWriteResult>;
    updateDocumentFields(documentId: string, patch: Record<string, unknown>): Promise<CollabPlacementWriteResult>;
    /**
     * Removes the index row. Only with `purge` (Trash's "Delete permanently" and
     * "Empty Trash") does a page already in Trash go for good; a server that
     * knows the flag never permanently deletes without it.
     */
    removeDocument(documentId: string, options?: {
        purge?: true;
    }): Promise<CollabPlacementWriteResult>;
    /** Recoverable: the page leaves the tree for Trash, keeping its body and place. */
    trashDocument(documentId: string): Promise<CollabPlacementWriteResult>;
    /**
     * Back from Trash with the pages that went with it, each in its place. A
     * page whose parent is gone (deleted for good, or still in Trash) goes to
     * the section root instead, and the result says so.
     */
    restoreDocument(documentId: string): Promise<CollabRestoreResult>;
    emptyTrash(): number;
    moveDocument(documentId: string, parentFolderId: string | null, options?: CollabPageMoveOptions): Promise<CollabPlacementWriteResult>;
    createFolder(name: string, parentFolderId: string | null): Promise<string>;
    renameFolder(folderId: string, name: string): Promise<void>;
    renameLegacyFolder(path: string, name: string): Promise<number>;
    moveFolder(folderId: string, parentFolderId: string | null): void;
    removeFolder(folderId: string): void;
    refreshFolders(): Promise<boolean>;
    /** Place a tracker type in the page tree; an already placed type moves. */
    placeType(typeId: string, parentFolderId: string | null, parentKind?: SharedParentKind): Promise<CollabPlacementWriteResult>;
    moveTypePlacement(typeId: string, parentFolderId: string | null, sortOrder?: number, parentKind?: SharedParentKind): Promise<CollabPlacementWriteResult>;
    removeTypePlacement(typeId: string): Promise<void>;
    /** True once the snapshot said the tree is the one page tree. */
    isPageTree(): boolean;
    /**
     * Page tree: move a page under a page or a typed page (null = root). Refuses
     * a cycle through pages and placed typed pages with `false`; otherwise the
     * move is applied and the store's outcome follows.
     */
    movePage(documentId: string, parentId: string | null, options?: CollabPageMoveOptions): false | Promise<CollabPlacementWriteResult>;
    /**
     * Page tree: move a page and every page below it to Trash, where each can be
     * restored to its place. Types and typed pages placed under them show in
     * their usual place meanwhile. The prose of a type placed outside the
     * subtree is moved out first.
     */
    removePage(documentId: string): Promise<CollabPlacementWriteResult>;
    /** How many documents besides the page itself `removePage` would move to Trash. */
    pageRemovalCount(documentId: string): number;
    /**
     * Place a typed page (tracker item) under a page, or at root with null.
     * Resolves `{ ok: true }` only once the store confirmed the placement (the
     * server's broadcast for this item, or the local write for Personal), and
     * `{ ok: false, error }` on a refusal or timeout, after rolling back.
     */
    setItemPlacement(itemId: string, parentId: string | null, sortOrder?: number, parentKind?: SharedParentKind): Promise<CollabPlacementWriteResult>;
    /** Send a typed page back under its type. Same outcome contract as `setItemPlacement`. */
    removeItemPlacement(itemId: string): Promise<CollabPlacementWriteResult>;
    getItemPlacements(): SharedItemPlacement[];
    toggleFavorite(documentId: string): void;
    recordOpened(documentId: string): void;
    markDocumentViewed(documentId: string, updatedAt: number | null): Promise<void>;
    markAllDocumentsViewed(): Promise<void>;
    createDocument(input: Parameters<DocsHost['documents']['createDocument']>[0]): Promise<void>;
    clearPendingFolder(): void;
    getDocuments(): SharedDocument[];
    getFolders(): SharedFolder[];
    /**
     * Pages whose body or title matches (`pageSearch.ts`). Typed-page hits have
     * a null title for the caller to name from its tree (`nameTypedHits`). Null
     * when the section cannot search now.
     */
    searchPages(request: PageSearchRequest): Promise<PageSearchResponse | null>;
}
export declare function createCollabDocsSession(scope: CollabScope, dataSource: CollabDocsDataSource, host: DocsHost): CollabDocsSession;
export interface CollabDocsScopeLifecycleOptions {
    onSessionChanged(session: CollabDocsSession | null): void;
    onError?(error: unknown): void;
    retryDelaysMs?: readonly number[];
}
export interface CollabDocsScopeLifecycle {
    start(): void;
    dispose(): void;
}
/** Resolve, activate, retry, replace, and tear down the session behind one host. */
export declare function createCollabDocsScopeLifecycle(host: DocsHost, options: CollabDocsScopeLifecycleOptions): CollabDocsScopeLifecycle;
export declare function getCollabDocsSession(scopeKey: string): CollabDocsSession | null;
export declare function getSharedDocumentsForScopeKey(scopeKey: string): SharedDocument[];
/**
 * The documents a link in this scope can open: the scope's own project's,
 * then other projects' in the org. For opening and naming an existing link
 * only; pickers and lists use `getSharedDocumentsForScopeKey`.
 */
export declare function getLinkableSharedDocumentsForScopeKey(scopeKey: string): SharedDocument[];
/**
 * Another project's page, when `documentId` names one and not one of this
 * scope's own: the page and its project (a null project resolved to the
 * primary). Writes to it are refused; reads go through that project.
 */
export declare function findOtherProjectDocument(scopeKey: string, documentId: string): {
    document: SharedDocument;
    projectId: string | null;
} | null;
export declare function getSharedFoldersForScopeKey(scopeKey: string): SharedFolder[];
export declare function getFavoriteDocumentIdsForScopeKey(scopeKey: string): string[];
export declare function setCollabScopeAvailability(scopeKey: string, available: boolean): void;
export declare function pruneCollabDocsSession(scopeKey: string): void;
export {};
