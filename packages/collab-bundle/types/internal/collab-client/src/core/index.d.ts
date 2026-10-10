import type { TeamJwt, TeamMemberId } from '../../../runtime/src/auth/jwtScopes';
import type { ReadReceipt } from '../../../runtime/src/readReceipts/readReceipts';
export type Unsubscribe = () => void;
/** Explicit capability presence; unavailable lanes expose no callable surface. */
export type CollabCapabilityAvailability<TCapability> = {
    status: 'available';
    capability: TCapability;
} | {
    status: 'unavailable';
};
/** Browser-safe connection data for one collaboration index. */
export interface CollabIndexConfig {
    serverUrl: string;
    teamProjectId?: string | null;
    teamMemberId: TeamMemberId;
    userName?: string;
    userEmail?: string;
    /**
     * Extra query the host has already authorized for the team socket, appended
     * verbatim to the room URL. Mirrors `CollabDocumentConfig.urlExtraQuery`;
     * only a host-supplied test identity sets it.
     */
    urlExtraQuery?: string;
}
/**
 * Host-defined collaboration identity.
 *
 * `scopeKey` is intentionally opaque. Hosts may use a route-derived project
 * key, an account/org key, or another stable identifier. It is also the scope
 * component used by per-user personal-state keys.
 */
export interface CollabScope {
    scopeKey: string;
    orgId: string;
    indexConfig: CollabIndexConfig;
}
/** `orgId` of a Personal pages scope: local to this device, no team or account. */
export declare const PERSONAL_COLLAB_ORG_ID = "local";
/** Scope key of a workspace's Personal pages, distinct from its team scope key. */
export declare function personalCollabScopeKey(workspacePath: string): string;
/** The Personal pages scope for a workspace. It never connects to a server. */
export declare function createPersonalCollabScope(workspacePath: string): CollabScope;
/** True for a Personal pages scope, which must never stand in for the team scope. */
export declare function isPersonalCollabScope(scope: CollabScope | null | undefined): boolean;
/** True for a Personal pages scope key; for callers that hold only the key. */
export declare function isPersonalCollabScopeKey(scopeKey: string): boolean;
/** The workspace path a Personal pages scope key belongs to. */
export declare function workspacePathFromPersonalScopeKey(scopeKey: string): string;
/** A scope lookup failure with an explicit retry contract for shared lifecycle code. */
export declare class CollabScopeResolutionError extends Error {
    readonly retryable: boolean;
    constructor(message: string, options: {
        retryable: boolean;
        cause?: unknown;
    });
}
export type CollabConnectionStatus = 'disconnected' | 'connecting' | 'syncing' | 'connected' | 'error';
export interface CollabDataSnapshot<TItem, TContainer> {
    items: TItem[];
    containers: TContainer[];
}
export type CollabDataChange<TItem, TContainer> = {
    type: 'snapshot';
    snapshot: CollabDataSnapshot<TItem, TContainer>;
} | {
    type: 'items-upserted';
    items: TItem[];
} | {
    type: 'items-removed';
    itemIds: string[];
} | {
    type: 'containers-upserted';
    containers: TContainer[];
} | {
    type: 'containers-removed';
    containerIds: string[];
    itemIds: string[];
} | {
    type: 'status';
    status: CollabConnectionStatus;
};
export interface CollabCommand {
    type: string;
}
export interface CollabCommandResult {
    ok: true;
}
/**
 * Projection/command seam between shared state and a host-owned sync engine.
 *
 * A data source may own an in-process provider (desktop documents and the
 * browser) or proxy an engine across a process boundary (desktop trackers).
 */
export interface CollabDataSource<TItem, TContainer, TCommand extends CollabCommand = CollabCommand, TResult extends CollabCommandResult = CollabCommandResult> {
    snapshot(): Promise<CollabDataSnapshot<TItem, TContainer>>;
    subscribe(cb: (change: CollabDataChange<TItem, TContainer>) => void): Unsubscribe;
    command(cmd: TCommand): Promise<TResult>;
    status(): CollabConnectionStatus;
    /** Release a host-owned connection when its scope is explicitly closed. */
    dispose(): void;
}
export interface TeamMemberSummary {
    memberId: TeamMemberId;
    email?: string | null;
    name?: string | null;
    role?: string | null;
}
export type CollabArtifactRef = {
    kind: 'document';
    scope: CollabScope;
    documentId: string;
    /** Owning project from the team document index, not the active-project default. */
    teamProjectId: string | null;
} | {
    kind: 'folder';
    scope: CollabScope;
    folderId: string;
} | {
    kind: 'tracker';
    scope: CollabScope;
    trackerId: string;
}
/** A tracker type placed in the page tree: opens the type's table. */
 | {
    kind: 'type';
    scope: CollabScope;
    typeId: string;
};
export type CollabOpenSource = 'sidebar' | 'home' | 'quick_open' | 'deep_link' | 'restart_restore' | 'history' | 'agent_tool' | 'share_to_team' | 'embedded_document' | 'feedback_request';
/**
 * How a user click asked to open an artifact. A host that navigates in place
 * (desktop Pages) shows it in the current tab, or a new tab when `newTab`
 * (Cmd, or Ctrl off macOS, was held). Without options a host keeps its
 * default: the desktop focuses or adds a tab.
 */
export interface CollabOpenOptions {
    newTab: boolean;
}
/** The open options a click carries. */
export declare function collabOpenOptions(event: {
    metaKey: boolean;
    ctrlKey: boolean;
}): CollabOpenOptions;
/** Browser-safe projection of a host's document/editor catalog. */
export interface CollabDocumentTypeDescriptor {
    documentType: string;
    displayName: string;
    fileExtensions: string[];
    defaultExtension: string;
    icon: string;
    editor: {
        kind: 'lexical' | 'monaco' | 'extension' | 'opaque';
        extensionId?: string;
        componentName?: string;
    };
    content: {
        strategy: 'lexical' | 'text' | 'structured-yjs' | 'opaque-versioned';
        codecId: string;
    };
    creation?: {
        defaultContent: string | Uint8Array;
        source: 'builtin' | 'newFileMenu';
    };
    capabilities: {
        localCreate: boolean;
        shareToTeam: boolean;
        sharedCreate: boolean;
        history: boolean;
        export: boolean;
        disabledReason?: string;
    };
}
export interface CollabDocsViewPreferences {
    treeFilter: 'all' | 'favorites' | 'updated';
    showUnreadBubbles: boolean;
}
export interface CollabDocsTreeState {
    expandedFolders: string[];
    userTouched: boolean;
}
export interface CollabDocsReadReceiptCapability {
    snapshot(scope: CollabScope): Promise<Array<ReadReceipt & {
        entityId: string;
    }>>;
    subscribe?(scope: CollabScope, cb: (row: ReadReceipt & {
        entityId: string;
    }) => void): Unsubscribe;
    markViewed(input: {
        scope: CollabScope;
        documentId: string;
        lastViewedAt: number;
    }): Promise<void>;
}
export interface CollabDocsCreateInput {
    scope: CollabScope;
    descriptor: CollabDocumentTypeDescriptor;
    requestedName: string;
    parentFolderId: string | null;
    /** What `parentFolderId` names: a page (default) or a typed page (tracker item id). */
    parentKind?: 'page' | 'item';
    sourceContent: string | Uint8Array;
}
export interface CollabDocsCapability<TItem = unknown, TContainer = unknown, TCommand extends CollabCommand = CollabCommand, TResult extends CollabCommandResult = CollabCommandResult> {
    dataSource: CollabDataSource<TItem, TContainer, TCommand, TResult>;
    loadViewPreferences(scopeKey: string): Promise<CollabDocsViewPreferences | null>;
    saveViewPreferences(scopeKey: string, prefs: CollabDocsViewPreferences): Promise<void>;
    /** Optional shell-local tree expansion persistence. */
    loadTreeState?(scopeKey: string): Promise<CollabDocsTreeState | null>;
    saveTreeState?(scopeKey: string, state: CollabDocsTreeState): Promise<void>;
    documentTypes(): readonly CollabDocumentTypeDescriptor[];
    /** Notify mounted shells when the host's document-type registry changes. */
    onDocumentTypesChanged?(cb: () => void): Unsubscribe;
    /** Host-owned content initialization beyond the document index command. */
    createDocument(input: CollabDocsCreateInput): Promise<void>;
    /** Host persistence/transport for document read watermarks. */
    readReceipts: CollabCapabilityAvailability<CollabDocsReadReceiptCapability>;
}
export interface CollabPersonalStateRow {
    scope: string;
    itemId: string;
    isFavorite: boolean;
    favoriteUpdatedAt: number;
    lastOpenedAt: number | null;
    updatedAt: number;
}
export interface CollabPersonalStateSnapshot {
    /** Stable scope returned by the host-owned persistence/sync lane. */
    scope: string;
    rows: CollabPersonalStateRow[];
}
/**
 * Shared LWW personal state. Identity is resolved by the host; callers never
 * supply a member id or email, preventing renderer-side identity mix-ups.
 */
export interface CollabPersonalStateCapability {
    snapshot(scope: CollabScope): Promise<CollabPersonalStateSnapshot>;
    subscribe(scope: CollabScope, cb: (row: CollabPersonalStateRow) => void): Unsubscribe;
    setFavorite(input: {
        scope: CollabScope;
        itemId: string;
        isFavorite: boolean;
        favoriteUpdatedAt: number;
    }): Promise<CollabPersonalStateRow | null>;
    recordOpened(input: {
        scope: CollabScope;
        itemId: string;
        lastOpenedAt: number;
    }): Promise<CollabPersonalStateRow | null>;
}
/** Artifact-agnostic host base plus optional per-artifact capability slices. */
export interface CollabHost<TDocuments extends CollabDocsCapability = CollabDocsCapability> {
    /** Analytics surface identity. Omitted by hosts that do not emit analytics. */
    surface?: 'desktop' | 'web_console' | 'ios';
    resolveScope(): Promise<CollabScope>;
    /** Emits `null` while a previously active scope is being replaced. */
    onScopeChanged(cb: (scope: CollabScope | null) => void): Unsubscribe;
    getTeamJwt(orgId: string): Promise<TeamJwt>;
    getMembers(orgId: string): Promise<TeamMemberSummary[]>;
    /**
     * Fires whenever the member directory changes, so a UI that resolves author
     * ids to names can re-read it.
     *
     * A one-shot `getMembers()` at mount is not enough: the directory arrives
     * with the team room's sync reply, which lands well after the first render,
     * and members are then added/removed/re-roled over the session's life.
     * Optional — a host with a directory that is ready before it hands out a
     * scope may omit it, and callers fall back to fetching once (#3716).
     */
    onMembersChanged?(cb: () => void): Unsubscribe;
    openArtifact(ref: CollabArtifactRef, source: CollabOpenSource, options?: CollabOpenOptions): void;
    /** Host-native durable URL/deep link for copy-link affordances. */
    artifactUrl?(ref: CollabArtifactRef): string | null;
    personalState: CollabCapabilityAvailability<CollabPersonalStateCapability>;
    reportError?(error: unknown, context: string): void;
    notify?(notification: {
        level: 'info' | 'warning' | 'error';
        title: string;
        message: string;
        duration?: number;
    }): void;
    trackEvent?(name: string, props: Record<string, unknown>): void;
    documents?: TDocuments;
}
