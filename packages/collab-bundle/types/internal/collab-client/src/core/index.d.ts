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
};
export type CollabOpenSource = 'sidebar' | 'home' | 'quick_open' | 'deep_link' | 'restart_restore' | 'history' | 'agent_tool' | 'share_to_team' | 'embedded_document' | 'feedback_request';
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
    openArtifact(ref: CollabArtifactRef, source: CollabOpenSource): void;
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
